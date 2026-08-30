import { createHash } from "node:crypto";
import { signNavigationAuthorization, type DomObservation, type ScreenshotObservation, type SessionDescriptor, type TabDescriptor } from "../../../packages/browser-protocol/src/index.js";
import type {
  BrowserAction, BrowserControlResult, BrowserDebugResult, BrowserObservation, BrowserOperationResult,
  BrowserPathCapability, BrowserSession, BrowserSessionRequest, BrowserVisualFrame, BrowserWorkspaceResult,
} from "../../../packages/sdk/src/index.js";
import { BrowserdClientError, BrowserdClientPool, type BrowserdDescriptor, type BrowserdRequestFields } from "./browserd-client.js";
import type { BrowserDestinationAuthority, BrowserDestinationOperation } from "./destination-authority.js";
import { BrowserPortError, type AuthorityActor, type BrowserDaemonPort } from "./ports.js";

const PATH: BrowserPathCapability = Object.freeze({
  pathId: "agentcursor/chrome",
  actions: Object.freeze(["move", "click", "doubleClick", "drag", "wheel", "text", "key", "navigate", "dom.click", "dom.doubleClick", "dom.hover", "dom.type", "dom.press", "tab.create", "tab.list", "tab.focus", "tab.close", "session.close"]),
  observations: Object.freeze(["screenshot", "dom"]),
  visual: true, touch: false, uploads: false, downloads: false,
});

interface SessionBinding {
  readonly principalId: string;
  readonly agentId: string;
  readonly runtimeInstanceId: string;
  descriptor: SessionDescriptor;
}
interface ObservationBinding {
  readonly principalId: string;
  readonly agentId: string;
  readonly runtimeInstanceId: string;
  readonly browserSessionId: string;
  readonly tabId: string;
  readonly observation: ScreenshotObservation & { image: { kind: "artifact"; artifactId: string } };
  readonly expiresAtMs: number;
  readonly metadataBytes: number;
}
const MAX_OBSERVATION_METADATA = 1_024;
const MAX_OBSERVATION_METADATA_BYTES = 1024 * 1024;
const MAX_OBSERVATIONS_PER_ACTOR = 256;
const MAX_OBSERVATIONS_PER_SESSION = 128;
const MAX_OBSERVATIONS_PER_TAB = 64;

export class AgentCursorBrowserPort implements BrowserDaemonPort {
  readonly #sessions = new Map<string, SessionBinding>();
  readonly #observations = new Map<string, ObservationBinding>();
  #observationMetadataBytes = 0;

  constructor(
    private readonly client: BrowserdClientPool,
    private readonly destinationAuthority: BrowserDestinationAuthority,
  ) {}

  async capabilities(signal?: AbortSignal): Promise<readonly BrowserPathCapability[]> {
    try {
      const result = record(await this.client.request(healthActor(), operationId("capabilities"), { kind: "capabilities.get" }, signal));
      return result.available === true ? [PATH] : [];
    } catch (error) { if (signal?.aborted) throw error; return []; }
  }

  async createSession(actor: AuthorityActor, request: BrowserSessionRequest, operationIdValue: string, signal?: AbortSignal): Promise<BrowserSession> {
    if (request.pathId !== "agentcursor/chrome") throw new BrowserPortError("unsupported", "selected browser backend supports only agentcursor/chrome", 400);
    await this.destinationAuthority.assertReady(signal);
    const descriptor = await this.client.descriptor();
    const authorization = request.url === undefined ? undefined : await this.authorize(actor, descriptor, operationIdValue, "initial", request.url, signal);
    const raw = sessionDescriptor(await this.request(actor, operationIdValue, { kind: "session.create", ...(authorization === undefined ? {} : { initialUrl: authorization.normalizedUrl, navigationAuthorization: authorization.token }) }, signal));
    const binding: SessionBinding = { principalId: actor.principalId, agentId: actor.agentId, runtimeInstanceId: descriptor.runtimeInstanceId, descriptor: raw };
    this.#sessions.set(raw.browserSessionId, binding);
    return publicSession(raw);
  }

  async listSessions(actor: AuthorityActor, signal?: AbortSignal): Promise<readonly BrowserSession[]> {
    const runtime = await this.currentRuntime(signal);
    const result = record(await this.request(actor, operationId("sessionList"), { kind: "session.list" }, signal));
    const sessions = array(result.sessions).map(sessionDescriptor);
    const currentIds = new Set<string>();
    for (const descriptor of sessions) {
      currentIds.add(descriptor.browserSessionId);
      const prior = this.#sessions.get(descriptor.browserSessionId);
      if (prior !== undefined && sameOwner(prior, actor) && prior.runtimeInstanceId === runtime) prior.descriptor = descriptor;
    }
    for (const [id, binding] of this.#sessions) if (sameOwner(binding, actor) && binding.runtimeInstanceId === runtime && !currentIds.has(id)) { this.#sessions.delete(id); this.clearSessionObservations(id); }
    return sessions.map((descriptor) => publicSession(descriptor));
  }

  async getSession(actor: AuthorityActor, sessionId: string, signal?: AbortSignal): Promise<BrowserSession> {
    const binding = await this.owned(actor, sessionId, signal);
    const sessions = await this.listSessions(actor, signal);
    const value = sessions.find((session) => session.browserSessionId === sessionId);
    if (value === undefined) { this.#sessions.delete(sessionId); throw notFound(); }
    binding.descriptor = sessionDescriptorFromPublic(value, binding.descriptor);
    return value;
  }

  async observe(actor: AuthorityActor, sessionId: string, view: string, maxChars: number, operationIdValue: string, signal?: AbortSignal, tabId?: string): Promise<BrowserObservation> {
    const binding = await this.owned(actor, sessionId, signal);
    const tab = selectedTab(binding.descriptor, tabId);
    if (view === "dom") {
      const raw = domObservation(await this.request(actor, operationIdValue, { kind: "observe.domFallback", address: tab.address, maxNodes: Math.min(200, Math.max(1, maxChars)) }, signal));
      return { kind: "dom", operationId: operationIdValue, domObservationId: raw.observationId, browserSessionId: raw.address.browserSessionId, tabId: raw.address.tabId, documentGeneration: raw.documentGeneration, observedAt: raw.observedAt, validUntil: raw.validUntil, truncated: raw.truncated, nodes: raw.nodes.map((node) => ({ handle: node.handle, role: node.role, name: node.name, ...(node.value === undefined ? {} : { value: node.value }), state: node.state, ...(node.bounds === undefined ? {} : { bounds: node.bounds }) })) };
    }
    const raw = screenshotObservation(await this.request(actor, operationIdValue, { kind: "observe.screenshot", address: tab.address, delivery: "artifact" }, signal));
    if (raw.image.kind !== "artifact") throw new BrowserPortError("backend-failure", "browser service did not return an artifact observation", 502);
    this.rememberObservation(actor, binding, raw as ScreenshotObservation & { image: { kind: "artifact"; artifactId: string } });
    binding.descriptor = replaceTab(binding.descriptor, raw.address.tabId, { documentGeneration: raw.documentGeneration, viewportGeneration: raw.viewportGeneration, frameSequence: raw.frameSequence, url: raw.url, title: raw.title });
    return { kind: "screenshot", operationId: operationIdValue, observationId: raw.observationId, browserSessionId: raw.address.browserSessionId, tabId: raw.address.tabId, url: raw.url, title: raw.title, capturedAt: raw.capturedAt, documentGeneration: raw.documentGeneration, viewportGeneration: raw.viewportGeneration, frameSequence: raw.frameSequence, cssViewportWidth: raw.viewport.width, cssViewportHeight: raw.viewport.height, imagePixelWidth: raw.imagePixelWidth, imagePixelHeight: raw.imagePixelHeight, devicePixelRatio: raw.viewport.devicePixelRatio, captureScale: raw.captureScale, scroll: raw.scroll, digest: raw.sha256, mediaType: raw.mediaType, cursor: publicCursor(raw.cursor), validUntil: raw.validUntil, artifactId: raw.image.artifactId };
  }

  async captureFrame(actor: AuthorityActor, sessionId: string, tabId: string, observationId: string, signal?: AbortSignal): Promise<BrowserVisualFrame> {
    const session = await this.owned(actor, sessionId, signal);
    this.pruneObservations();
    const binding = this.#observations.get(observationId);
    if (binding === undefined || !sameOwner(binding, actor) || binding.browserSessionId !== sessionId || binding.tabId !== tabId || binding.runtimeInstanceId !== session.runtimeInstanceId) throw new BrowserPortError("OBSERVATION_STALE", "screenshot observation is stale", 409);
    const observation = binding.observation;
    const bytes = await this.readArtifact(actor, observation.image.artifactId, observation, signal);
    const dimensions = imageDimensions(bytes, observation.mediaType);
    if (dimensions.width !== observation.imagePixelWidth || dimensions.height !== observation.imagePixelHeight) throw new BrowserPortError("backend-failure", "browser artifact dimensions changed during read", 502);
    return { browserSessionId: observation.address.browserSessionId, tabId: observation.address.tabId, observationId: observation.observationId, mediaType: observation.mediaType, imagePixelWidth: observation.imagePixelWidth, imagePixelHeight: observation.imagePixelHeight, payloadBase64: bytes.toString("base64"), digest: observation.sha256, frameSequence: observation.frameSequence, viewportGeneration: observation.viewportGeneration };
  }

  async act(actor: AuthorityActor, sessionId: string, action: BrowserAction, operationIdValue: string, signal?: AbortSignal, tabId?: string): Promise<BrowserOperationResult> {
    const binding = await this.owned(actor, sessionId, signal);
    const tab = selectedTab(binding.descriptor, tabId);
    if (action.kind === "navigate") {
      const descriptor = await this.client.descriptor();
      this.assertRuntime(binding, descriptor.runtimeInstanceId);
      const authorization = await this.authorize(actor, descriptor, operationIdValue, "navigate", action.url, signal);
      await this.request(actor, operationIdValue, { kind: "navigate", address: tab.address, url: authorization.normalizedUrl, navigationAuthorization: authorization.token }, signal);
    } else if (action.kind === "key-press") await this.request(actor, operationIdValue, { kind: "input.key", address: tab.address, key: action.key }, signal);
    else if (action.kind === "text-input") await this.request(actor, operationIdValue, { kind: "input.text", address: tab.address, text: action.text, ...(action.replace === undefined ? {} : { replace: action.replace }) }, signal);
    else if (action.kind === "dom-click" || action.kind === "dom-double-click" || action.kind === "dom-hover" || action.kind === "dom-type" || action.kind === "dom-fill" || action.kind === "dom-key-press") {
      await this.request(actor, operationIdValue, { kind: "action.domFallback", address: tab.address, domObservationId: action.domObservationId, handle: action.handle, action: internalDomAction(action) }, signal);
    } else if (isCoordinate(action)) {
      await this.request(actor, operationIdValue, { kind: "action.coordinate", address: tab.address, observationId: action.observationId, coordinateSpace: action.coordinateSpace ?? "imagePixels", action: internalCoordinate(action) }, signal);
    } else throw new BrowserPortError("unsupported", "browser action is not supported by agentcursor/chrome", 400);
    await this.refresh(actor, binding, signal);
    return { operationId: operationIdValue, state: "succeeded" };
  }

  async cancel(actor: AuthorityActor, targetOperationId: string, signal?: AbortSignal): Promise<BrowserOperationResult> {
    const raw = record(await this.request(actor, operationId("cancel"), { kind: "operation.cancel", targetOperationId }, signal));
    return { operationId: targetOperationId, state: operationState(raw.state) };
  }

  async createTab(actor: AuthorityActor, sessionId: string, url: string | undefined, operationIdValue: string, signal?: AbortSignal): Promise<BrowserSession> {
    const binding = await this.owned(actor, sessionId, signal);
    const descriptor = await this.client.descriptor(); this.assertRuntime(binding, descriptor.runtimeInstanceId);
    const authorization = url === undefined ? undefined : await this.authorize(actor, descriptor, operationIdValue, "new-tab", url, signal);
    await this.request(actor, operationIdValue, { kind: "tab.create", browserSessionId: sessionId, controlEpoch: binding.descriptor.controlEpoch, ...(authorization === undefined ? {} : { url: authorization.normalizedUrl, navigationAuthorization: authorization.token }) }, signal);
    await this.refresh(actor, binding, signal);
    return publicSession(binding.descriptor);
  }

  async focusTab(actor: AuthorityActor, sessionId: string, tabId: string, operationIdValue: string, signal?: AbortSignal): Promise<BrowserSession> {
    const binding = await this.owned(actor, sessionId, signal);
    const tab = selectedTab(binding.descriptor, tabId);
    await this.request(actor, operationIdValue, { kind: "tab.focus", address: tab.address }, signal);
    await this.refresh(actor, binding, signal);
    return publicSession(binding.descriptor);
  }

  async closeTab(actor: AuthorityActor, sessionId: string, tabId: string, signal?: AbortSignal): Promise<void> {
    const binding = await this.owned(actor, sessionId, signal);
    const tab = binding.descriptor.tabs.find((item) => item.address.tabId === tabId);
    if (tab === undefined) throw notFound();
    await this.request(actor, operationId("tabClose"), { kind: "tab.close", address: tab.address }, signal);
    this.clearTabObservations(sessionId, tabId);
    await this.refresh(actor, binding, signal);
  }

  async close(actor: AuthorityActor, sessionId: string, signal?: AbortSignal): Promise<void> {
    const binding = await this.owned(actor, sessionId, signal);
    await this.request(actor, operationId("sessionClose"), { kind: "session.close", browserSessionId: sessionId, controlEpoch: binding.descriptor.controlEpoch }, signal);
    this.#sessions.delete(sessionId);
    this.clearSessionObservations(sessionId);
  }

  async shutdown(): Promise<void> { this.#sessions.clear(); this.#observations.clear(); this.#observationMetadataBytes = 0; await this.client.close(); }
  async debug(): Promise<BrowserDebugResult> { throw new BrowserPortError("unsupported", "browser diagnostics are not supported by agentcursor/chrome", 400); }
  async workspace(): Promise<BrowserWorkspaceResult> { throw new BrowserPortError("unsupported", "browser workspace is not supported by agentcursor/chrome", 400); }
  async setControl(): Promise<BrowserControlResult> { throw new BrowserPortError("unsupported", "human takeover is not supported by agentcursor/chrome", 400); }

  private async owned(actor: AuthorityActor, sessionId: string, signal?: AbortSignal): Promise<SessionBinding> {
    const binding = this.#sessions.get(sessionId);
    if (binding === undefined || !sameOwner(binding, actor)) throw notFound();
    this.assertRuntime(binding, await this.currentRuntime(signal));
    const listed = record(await this.request(actor, operationId("ownerLookup"), { kind: "session.list" }, signal));
    const descriptor = array(listed.sessions).map(sessionDescriptor).find((item) => item.browserSessionId === sessionId);
    if (descriptor === undefined) throw notFound();
    binding.descriptor = descriptor;
    return binding;
  }

  private async refresh(actor: AuthorityActor, binding: SessionBinding, signal?: AbortSignal): Promise<void> {
    const result = record(await this.request(actor, operationId("tabList"), { kind: "tab.list", browserSessionId: binding.descriptor.browserSessionId, controlEpoch: binding.descriptor.controlEpoch }, signal));
    binding.descriptor = { ...binding.descriptor, tabs: array(result.tabs).map(tabDescriptor) };
  }

  private async authorize(actor: AuthorityActor, descriptor: BrowserdDescriptor, operationIdValue: string, operation: BrowserDestinationOperation, url: string, signal?: AbortSignal): Promise<{ readonly normalizedUrl: string; readonly token: string }> {
    const authorized = await this.destinationAuthority.authorize({ actor, operationId: operationIdValue, operation, url }, signal);
    if (authorized.egressBindingId === undefined) throw new BrowserPortError("WEBX_POLICY_EGRESS_REQUIRED", "browser navigation requires a bound egress route", 503, true);
    return { normalizedUrl: authorized.normalizedUrl, token: signNavigationAuthorization({ runtimeInstanceId: descriptor.runtimeInstanceId, principalId: actor.principalId, agentSessionId: actor.agentId, operationId: operationIdValue, normalizedUrl: authorized.normalizedUrl, egressBindingId: authorized.egressBindingId, expiresAt: new Date(Date.now() + 15_000).toISOString() }, descriptor.brokerSigningSecret) };
  }

  private rememberObservation(actor: AuthorityActor, session: SessionBinding, observation: ScreenshotObservation & { image: { kind: "artifact"; artifactId: string } }): void {
    this.pruneObservations();
    const expiresAtMs = Date.parse(observation.validUntil);
    if (!Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now()) throw new BrowserPortError("OBSERVATION_STALE", "screenshot observation is stale", 409);
    const metadataBytes = Buffer.byteLength(JSON.stringify(observation), "utf8");
    if (metadataBytes > MAX_OBSERVATION_METADATA_BYTES) throw new BrowserPortError("LIMIT_EXCEEDED", "screenshot observation metadata exceeds its bound", 503, true);
    const owner = (item: ObservationBinding): boolean => sameOwner(item, actor);
    const inSession = (item: ObservationBinding): boolean => owner(item) && item.browserSessionId === observation.address.browserSessionId;
    const inTab = (item: ObservationBinding): boolean => inSession(item) && item.tabId === observation.address.tabId;
    while (this.#observations.size >= MAX_OBSERVATION_METADATA || this.#observationMetadataBytes + metadataBytes > MAX_OBSERVATION_METADATA_BYTES || [...this.#observations.values()].filter(owner).length >= MAX_OBSERVATIONS_PER_ACTOR || [...this.#observations.values()].filter(inSession).length >= MAX_OBSERVATIONS_PER_SESSION || [...this.#observations.values()].filter(inTab).length >= MAX_OBSERVATIONS_PER_TAB) {
      const removable = [...this.#observations].find(([, item]) => owner(item));
      if (removable === undefined) throw new BrowserPortError("LIMIT_EXCEEDED", "screenshot observation metadata capacity is full", 503, true);
      this.removeObservation(removable[0], removable[1]);
    }
    const prior = this.#observations.get(observation.observationId);
    if (prior !== undefined) this.removeObservation(observation.observationId, prior);
    const value: ObservationBinding = { principalId: actor.principalId, agentId: actor.agentId, runtimeInstanceId: session.runtimeInstanceId, browserSessionId: observation.address.browserSessionId, tabId: observation.address.tabId, observation, expiresAtMs, metadataBytes };
    this.#observations.set(observation.observationId, value); this.#observationMetadataBytes += metadataBytes;
  }

  private pruneObservations(): void { for (const [id, item] of this.#observations) if (item.expiresAtMs <= Date.now()) this.removeObservation(id, item); }
  private removeObservation(id: string, expected: ObservationBinding): void { if (this.#observations.get(id) !== expected) return; this.#observations.delete(id); this.#observationMetadataBytes -= expected.metadataBytes; }
  private clearSessionObservations(sessionId: string): void { for (const [id, item] of this.#observations) if (item.browserSessionId === sessionId) this.removeObservation(id, item); }
  private clearTabObservations(sessionId: string, tabId: string): void { for (const [id, item] of this.#observations) if (item.browserSessionId === sessionId && item.tabId === tabId) this.removeObservation(id, item); }

  private async readArtifact(actor: AuthorityActor, artifactId: string, observation: ScreenshotObservation, signal?: AbortSignal): Promise<Buffer> {
    const chunks: Buffer[] = []; let offset = 0;
    while (offset < observation.byteLength) {
      const raw = record(await this.request(actor, operationId(`artifact${offset}`), { kind: "artifact.read", artifactId, offset, maxBytes: Math.min(1024 * 1024, observation.byteLength - offset) }, signal));
      if (raw.kind !== "artifact" || raw.artifactId !== artifactId || raw.mediaType !== observation.mediaType || raw.sha256 !== observation.sha256 || raw.offset !== offset || raw.totalBytes !== observation.byteLength || typeof raw.base64 !== "string") throw new BrowserPortError("backend-failure", "browser artifact metadata changed during read", 502);
      const bytes = canonicalBase64(raw.base64); if (bytes.byteLength !== raw.byteLength) throw new BrowserPortError("backend-failure", "browser artifact chunk length is invalid", 502);
      chunks.push(bytes); offset += bytes.byteLength;
      if (raw.eof === true) break;
      if (bytes.byteLength === 0) throw new BrowserPortError("backend-failure", "browser artifact read made no progress", 502);
    }
    const bytes = Buffer.concat(chunks);
    if (bytes.byteLength !== observation.byteLength || createHash("sha256").update(bytes).digest("hex") !== observation.sha256) throw new BrowserPortError("backend-failure", "browser artifact integrity verification failed", 502);
    return bytes;
  }

  private async request(actor: AuthorityActor, operationIdValue: string, fields: BrowserdRequestFields, signal?: AbortSignal): Promise<unknown> {
    try { return await this.client.request(actor, operationIdValue, fields, signal); }
    catch (error) { throw mapClientError(error); }
  }
  private async currentRuntime(signal?: AbortSignal): Promise<string> { try { return (await this.client.descriptor()).runtimeInstanceId; } catch (error) { if (signal?.aborted) throw error; throw mapClientError(error); } }
  private assertRuntime(binding: SessionBinding, runtime: string): void { if (binding.runtimeInstanceId !== runtime) throw new BrowserPortError("BROWSER_INSTANCE_REPLACED", "browser service restarted; open a new browser session", 409, true); }
}

function publicSession(value: SessionDescriptor): BrowserSession { return { browserSessionId: value.browserSessionId, pathId: "agentcursor/chrome", controlEpoch: value.controlEpoch, state: value.state === "starting" ? "creating" : value.state, personaId: value.personaId, cursor: publicCursor(value.cursor), tabs: value.tabs.map((tab) => ({ tabId: tab.address.tabId, url: tab.url, title: tab.title, state: tab.state, documentGeneration: tab.documentGeneration, viewportGeneration: tab.viewportGeneration, frameSequence: tab.frameSequence })) }; }
function publicCursor(cursor: SessionDescriptor["cursor"]): NonNullable<BrowserSession["cursor"]> { return { x: cursor.x, y: cursor.y, coordinateSpace: "cssViewport", pathSequence: cursor.pathSequence, sampleSequence: cursor.sampleSequence, visible: cursor.visible }; }
function sessionDescriptorFromPublic(_value: BrowserSession, prior: SessionDescriptor): SessionDescriptor { return prior; }
function primaryTab(value: SessionDescriptor): TabDescriptor { const tab = value.tabs[0]; if (tab === undefined) throw new BrowserPortError("not-found", "browser tab was not found", 404); return tab; }
function selectedTab(value: SessionDescriptor, tabId?: string): TabDescriptor { if (tabId === undefined) return primaryTab(value); const tab = value.tabs.find((item) => item.address.tabId === tabId); if (tab === undefined) throw notFound(); return tab; }
function replaceTab(session: SessionDescriptor, tabId: string, patch: Partial<Pick<TabDescriptor, "documentGeneration" | "viewportGeneration" | "frameSequence" | "url" | "title">>): SessionDescriptor { return { ...session, tabs: session.tabs.map((tab) => tab.address.tabId === tabId ? { ...tab, ...patch } : tab) }; }
function sessionDescriptor(value: unknown): SessionDescriptor { const item = record(value); if (item.kind !== "session" || typeof item.browserSessionId !== "string" || typeof item.controlEpoch !== "number" || !Array.isArray(item.tabs)) throw invalid(); return item as unknown as SessionDescriptor; }
function tabDescriptor(value: unknown): TabDescriptor { const item = record(value); if (item.kind !== "tab" || !isRecord(item.address)) throw invalid(); return item as unknown as TabDescriptor; }
function screenshotObservation(value: unknown): ScreenshotObservation { const item = record(value); if (item.kind !== "screenshotObservation" || typeof item.observationId !== "string") throw invalid(); return item as unknown as ScreenshotObservation; }
function domObservation(value: unknown): DomObservation { const item = record(value); if (item.kind !== "domObservation" || typeof item.observationId !== "string") throw invalid(); return item as unknown as DomObservation; }
type CoordinateBrowserAction = Extract<BrowserAction, { kind: "move" | "click" | "double-click" | "wheel" | "drag" }>;
function isCoordinate(action: BrowserAction): action is CoordinateBrowserAction { return action.kind === "move" || action.kind === "click" || action.kind === "double-click" || action.kind === "wheel" || action.kind === "drag"; }
function internalCoordinate(action: CoordinateBrowserAction): { kind: "move"; to: { x: number; y: number } } | { kind: "click" | "doubleClick"; at: { x: number; y: number }; button: "left" | "middle" | "right" } | { kind: "wheel"; at: { x: number; y: number }; deltaX: number; deltaY: number } | { kind: "drag"; from: { x: number; y: number }; to: { x: number; y: number } } {
  if (action.kind === "move") return { kind: "move", to: { x: action.x, y: action.y } };
  if (action.kind === "click" || action.kind === "double-click") return { kind: action.kind === "click" ? "click" : "doubleClick", at: { x: action.x, y: action.y }, button: action.button ?? "left" };
  if (action.kind === "wheel") return { kind: "wheel", at: { x: action.x, y: action.y }, deltaX: action.deltaX, deltaY: action.deltaY };
  if (action.kind === "drag") return { kind: "drag", from: action.from, to: action.to };
  throw invalid();
}
function internalDomAction(action: Extract<BrowserAction, { kind: "dom-click" | "dom-double-click" | "dom-hover" | "dom-type" | "dom-fill" | "dom-key-press" }>): { kind: "click" | "doubleClick"; button?: "left" | "middle" | "right" } | { kind: "hover" } | { kind: "type"; text: string; replace?: boolean } | { kind: "press"; key: string } {
  const value = action as unknown as { kind: string; button?: "left" | "middle" | "right"; text?: string; key?: string };
  if (value.kind === "dom-click" || value.kind === "dom-double-click") return { kind: value.kind === "dom-click" ? "click" : "doubleClick", ...(value.button === undefined ? {} : { button: value.button }) };
  if (value.kind === "dom-hover") return { kind: "hover" };
  if (value.kind === "dom-key-press") return { kind: "press", key: value.key as string };
  return { kind: "type", text: value.text as string, replace: value.kind === "dom-fill" };
}
function canonicalBase64(value: string): Buffer { if (value.length % 4 !== 0) throw invalid(); const bytes = Buffer.from(value, "base64"); if (bytes.toString("base64") !== value) throw invalid(); return bytes; }
function imageDimensions(bytes: Buffer, mediaType: "image/png" | "image/jpeg"): { width: number; height: number } {
  if (mediaType === "image/png") {
    if (bytes.byteLength < 24 || bytes.subarray(0, 8).compare(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) !== 0 || bytes.toString("ascii", 12, 16) !== "IHDR") throw invalid();
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  }
  if (bytes.byteLength < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) throw invalid();
  let offset = 2;
  while (offset + 8 < bytes.byteLength) {
    if (bytes[offset] !== 0xff) { offset++; continue; }
    while (bytes[offset] === 0xff) offset++;
    const marker = bytes[offset++];
    if (marker === undefined || marker === 0xd8 || marker === 0xd9 || marker === 0x01 || marker >= 0xd0 && marker <= 0xd7) continue;
    if (offset + 2 > bytes.byteLength) break;
    const length = bytes.readUInt16BE(offset);
    if (length < 2 || offset + length > bytes.byteLength) break;
    if ((marker >= 0xc0 && marker <= 0xc3 || marker >= 0xc5 && marker <= 0xc7 || marker >= 0xc9 && marker <= 0xcb || marker >= 0xcd && marker <= 0xcf) && length >= 7) return { height: bytes.readUInt16BE(offset + 3), width: bytes.readUInt16BE(offset + 5) };
    offset += length;
  }
  throw invalid();
}
function operationState(value: unknown): BrowserOperationResult["state"] { if (value === "queued" || value === "running") return value; if (value === "cancelled") return "cancelled"; if (value === "committed") return "succeeded"; return "failed"; }
function operationId(prefix: string): string { return `${prefix}:${Date.now().toString(36)}:${Math.random().toString(36).slice(2)}`; }
function healthActor(): AuthorityActor { return { principalId: "webxd.health", agentId: "webxd.health", scopes: new Set(["browser.read"]) }; }
function sameOwner(binding: Pick<SessionBinding, "principalId" | "agentId">, actor: AuthorityActor): boolean { return binding.principalId === actor.principalId && binding.agentId === actor.agentId; }
function notFound(): BrowserPortError { return new BrowserPortError("not-found", "browser session or tab was not found", 404); }
function invalid(): BrowserPortError { return new BrowserPortError("backend-failure", "browser service returned an invalid result", 502); }
function mapClientError(error: unknown): BrowserPortError { if (error instanceof BrowserPortError) return error; if (error instanceof BrowserdClientError) { const status = error.code === "INVALID_REQUEST" ? 400 : error.code.includes("NOT_FOUND") || error.code === "ARTIFACT_NOT_FOUND" ? 404 : error.code.includes("STALE") || error.code === "OPERATION_CONFLICT" || error.code === "DOCUMENT_CHANGED" || error.code === "VIEWPORT_CHANGED" || error.code === "CONTROL_EPOCH_STALE" || error.code === "BROWSER_INSTANCE_REPLACED" ? 409 : error.code === "OPERATION_CANCELLED" ? 499 : error.code === "CAPABILITY_UNAVAILABLE" || error.code === "LIMIT_EXCEEDED" ? 503 : 502; return new BrowserPortError(error.code, error.message, status, error.retryable); } if (error instanceof DOMException && error.name === "AbortError") return new BrowserPortError("cancelled", "browser operation was cancelled", 499); return new BrowserPortError("backend-failure", "browser service request failed", 502, true); }
function record(value: unknown): Record<string, unknown> { if (!isRecord(value)) throw invalid(); return value; }
function array(value: unknown): readonly unknown[] { if (!Array.isArray(value)) throw invalid(); return value; }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
