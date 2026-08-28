import { WebxClient } from "./client.js";
import { nodeNdjsonConnectionFactory } from "./node-unix.js";
import { UnixSocketTransport } from "./transport.js";
import { defaultExportRoot, saveReadMarkdown, validateRelativeMarkdownPath } from "./save-markdown.js";
import type { BoundedContent, BrowserAction, BrowserPathId, BrowserVisualFrame, ContentRequest, ReadRequest, ReadSaveOptions, RequestOptions, VisualGuard } from "./types.js";

export const FACADE_OPERATION_INVENTORY = {
  "web.search": "search",
  "web.read": "read",
  "web.content": "content; stored normalized content only",
  "browser.open": "createBrowserSession",
  "browser.tabs": "list/closeBrowserTab/closeBrowserSession; discard and restore unavailable",
  "browser.observe": "observeBrowser plus getBrowserVisualFrame for visual binding",
  "browser.act": "actBrowser with semantic or bound visual actions",
  "browser.cancel": "cancelBrowserOperation",
  "browser.debug": "debugBrowser; secret-bearing operations refused",
  "browser.workspace": "manageBrowserWorkspace",
} as const;

export interface FacadeRequestOptions { readonly signal: AbortSignal; readonly idempotencyKey: string; readonly ownerId: string; readonly cwd: string }
export interface FacadeResult {
  readonly title?: string; readonly url?: string; readonly summary: string; readonly data?: unknown;
  readonly artifacts?: readonly { readonly id: string; readonly kind?: string }[];
  readonly artifactPayload?: { readonly artifactId: string; readonly mediaType: string; readonly dataBase64: string; readonly size: number; readonly complete: boolean; readonly mode: "image" | "raw"; readonly offset?: number; readonly nextOffset?: number | null; readonly eof?: boolean };
  readonly trust?: "untrusted-external" | "local";
}
export interface FacadeCapabilities { readonly apiVersion: string; readonly daemon: "ready" | "unavailable"; readonly groups: { readonly search: boolean; readonly read: boolean; readonly browser: boolean; readonly browserDebug: boolean }; readonly browserPathIds: readonly string[] }
interface ObservationBinding { readonly ownerId: string; readonly sessionId: string; readonly frame: BrowserVisualFrame }

/** SDK adapter for the singular Pi facade operation names. */
export class WebxFacadeClient {
  #ownerId?: string;
  #client?: WebxClient;
  readonly #observations = new Map<string, ObservationBinding>();
  #observationSequence = 0;

  constructor(private readonly socketPath: string, private readonly exportRoot = defaultExportRoot()) {}

  async start(options: { signal: AbortSignal; ownerId: string; cwd: string }): Promise<void> {
    if (options.signal.aborted) throw new DOMException("startup was cancelled", "AbortError");
    validateId(options.ownerId, "ownerId");
    this.#ownerId = options.ownerId;
    this.#client = new WebxClient(new UnixSocketTransport(this.socketPath, nodeNdjsonConnectionFactory));
    await this.#client.bind(options.ownerId, options.signal);
    await this.#client.negotiate(options.signal);
  }

  async capabilities(options: { signal: AbortSignal; ownerId: string }): Promise<FacadeCapabilities> {
    const client = this.client(options.ownerId);
    try {
      const catalog = await client.capabilities({ signal: options.signal });
      const paths = catalog.browserPaths.map((path) => path.pathId);
      const healthy = (id: "search" | "read" | "browser") => catalog.capabilities.some((capability) => capability.id === id && capability.enabled && capability.healthy);
      const browser = healthy("browser") && paths.includes("agent-browser/chrome");
      return { apiVersion: catalog.apiVersion, daemon: "ready", groups: { search: healthy("search"), read: healthy("read"), browser, browserDebug: browser }, browserPathIds: paths };
    } catch (error) {
      if (options.signal.aborted) throw error;
      return { apiVersion: "2.0.0", daemon: "unavailable", groups: { search: false, read: false, browser: false, browserDebug: false }, browserPathIds: [] };
    }
  }

  async request(operation: string, input: unknown, options: FacadeRequestOptions): Promise<FacadeResult> {
    const client = this.client(options.ownerId);
    const value = object(input);
    const requestOptions: RequestOptions = { signal: options.signal, idempotencyKey: options.idempotencyKey };
    if (operation === "web.search") {
      rejectPresent(value, ["operation", "effort", "freshness", "limit", "crawlPages", "crawlDepth"], operation);
      return external("Search results", await client.search({ query: requiredString(value.query, "query"), output: optionalSearchOutput(value.output), domains: optionalStringArray(value.domains, "domains") }, requestOptions));
    }
    if (operation === "web.read") return this.read(client, value, requestOptions);
    if (operation === "web.content") return external("Stored content", await client.content(contentRequest(value), requestOptions));
    if (operation === "browser.open") { rejectPresent(value, ["newTab"], operation); return local("Browser session opened", await client.createBrowserSession({ pathId: browserPath(value.pathId), url: optionalString(value.url), visible: optionalBoolean(value.visible), label: optionalString(value.label) }, requestOptions)); }
    if (operation === "browser.tabs") return this.browserTabs(client, value, requestOptions);
    if (operation === "browser.observe") return this.observe(client, value, options, requestOptions);
    if (operation === "browser.act") return local("Browser action completed", await client.actBrowser(requiredString(value.browserSessionId, "browserSessionId"), this.browserAction(value.action, options.ownerId, requiredString(value.browserSessionId, "browserSessionId")), requestOptions));
    if (operation === "browser.cancel") return local("Browser cancellation requested", await client.cancelBrowserOperation(requiredString(value.operationId, "operationId"), requestOptions));
    if (operation === "browser.debug") return local("Browser diagnostic completed", await client.debugBrowser(requiredString(value.browserSessionId, "browserSessionId"), { operation: debugOperation(value.operation), args: optionalObject(value.args), maxChars: optionalNumber(value.maxChars) }, requestOptions));
    if (operation === "browser.workspace") return this.workspace(client, value, requestOptions);
    throw unavailable(operation, "operation is not in the facade inventory");
  }

  async decideApproval(): Promise<FacadeResult> { throw unavailable("approval.decide", "this runtime never returns approval placeholders"); }
  async stop(options: { ownerId: string }): Promise<void> { if (this.#ownerId !== options.ownerId) throw new Error("WebX facade owner mismatch"); this.#observations.clear(); this.#client = undefined; this.#ownerId = undefined; }

  /** Import one visual binding only for deterministic cross-owner refusal tests. */
  importObservationBindingForTest(observationId: string, ownerId: string, sessionId: string, frame: BrowserVisualFrame): void { this.#observations.set(observationId, { ownerId, sessionId, frame }); }

  private client(ownerId: string): WebxClient { if (this.#client === undefined || this.#ownerId !== ownerId) throw new Error("WebX facade client is not started for this owner"); return this.#client; }

  private async read(client: WebxClient, value: Record<string, unknown>, options: RequestOptions): Promise<FacadeResult> {
    rejectPresent(value, ["browserSessionId", "tabId"], "web.read");
    const requestedUrl = requiredString(value.url, "url");
    const save = readSaveOptions(value.save);
    if (save !== undefined) rejectPresent(value, ["fields", "itemOffset", "itemLimit", "maxPages", "maxDepth", "sameDomain"], "web.read save");
    const request: ReadRequest = {
      url: requestedUrl,
      query: optionalString(value.query),
      view: optionalReadView(value.view),
      fields: optionalStringArray(value.fields, "fields"),
      itemOffset: optionalNumber(value.itemOffset),
      itemLimit: optionalNumber(value.itemLimit),
      maxChars: optionalNumber(value.maxChars),
      contentOffset: optionalNumber(value.contentOffset),
      maxPages: optionalNumber(value.maxPages),
      maxDepth: optionalNumber(value.maxDepth),
      sameDomain: optionalBoolean(value.sameDomain),
    };
    const content = await client.read(request, options);
    if (save === undefined) return external("Read result", content);
    const completeContent = await this.completeStoredContentForSave(client, content, options);
    return local("Web content saved as Markdown", await saveReadMarkdown(completeContent, requestedUrl, save, this.exportRoot));
  }

  private async completeStoredContentForSave(client: WebxClient, content: BoundedContent, options: RequestOptions): Promise<BoundedContent> {
    const metadata = typeof content.metadata === "object" && content.metadata !== null ? content.metadata as Record<string, unknown> : {};
    const contentId = typeof metadata.contentId === "string" ? metadata.contentId : undefined;
    if (contentId === undefined) return content;
    const chunks: string[] = [];
    let offset = 0;
    for (;;) {
      const part = await client.content({ contentId, offset, limit: 30_000 }, { ...options, idempotencyKey: `${options.idempotencyKey}:save:${offset}` });
      chunks.push(part.untrustedContent);
      const next = part.metadata.nextOffset;
      if (next === null || next === undefined) break;
      offset = next;
    }
    const reader = typeof metadata.reader === "object" && metadata.reader !== null ? metadata.reader as Record<string, unknown> : {};
    const sourceComplete = reader.sourceComplete;
    const truncated = sourceComplete === true ? false : sourceComplete === false ? true : reader.complete !== true;
    return { ...content, untrustedContent: chunks.join(""), truncated, metadata };
  }

  private async browserTabs(client: WebxClient, input: Record<string, unknown>, options: RequestOptions): Promise<FacadeResult> {
    const action = requiredString(input.action, "action");
    if (action === "list") return local("Owned browser sessions", await client.listBrowserSessions({ signal: options.signal }));
    if (action === "close-session") { await client.closeBrowserSession(requiredString(input.browserSessionId, "browserSessionId"), options); return local("Browser session closed", { closed: true }); }
    if (action === "close-tab") { await client.closeBrowserTab(requiredString(input.browserSessionId, "browserSessionId"), requiredString(input.tabId, "tabId"), options); return local("Browser tab closed", { closed: true }); }
    throw unavailable("browser.tabs", `${action} has no safe Pi 0.84.1 equivalent in this product`);
  }

  private async observe(client: WebxClient, value: Record<string, unknown>, options: FacadeRequestOptions, requestOptions: RequestOptions): Promise<FacadeResult> {
    rejectPresent(value, ["selector", "includeBounds"], "browser.observe");
    const sessionId = requiredString(value.browserSessionId, "browserSessionId");
    const view = observationView(value.view);
    const observation = await client.observeBrowser(sessionId, view, optionalNumber(value.maxChars) ?? 16_384, requestOptions);
    if (view !== "visual") return external("Browser observation", observation);
    const frame = await client.getBrowserVisualFrame(sessionId, { signal: options.signal, idempotencyKey: `${options.idempotencyKey}:frame` });
    const observationId = `observation-${++this.#observationSequence}`;
    this.#observations.set(observationId, { ownerId: options.ownerId, sessionId, frame });
    return external("Browser visual observation", { ...observation, observationId, viewportId: frame.viewportId, screenshot: { mediaType: frame.mediaType, width: frame.width, height: frame.height, payloadBase64: frame.payloadBase64, screenshotSha256: frame.screenshotSha256, screenshotSequence: frame.screenshotSequence, viewportGeneration: frame.viewportGeneration } });
  }

  private browserAction(value: unknown, ownerId: string, sessionId: string): BrowserAction {
    const action = object(value);
    const kind = requiredString(action.kind, "action.kind");
    if (kind === "mouse-move" || kind === "mouse-click" || kind === "mouse-double-click" || kind === "mouse-down" || kind === "mouse-up" || kind === "mouse-wheel" || kind === "coordinate-drag") {
      const guard = this.resolveGuard(action, ownerId, sessionId);
      if (kind === "mouse-move") return { kind, x: requiredNumber(action.x, "action.x"), y: requiredNumber(action.y, "action.y"), visualGuard: guard };
      if (kind === "mouse-wheel") return { kind: "wheel", deltaX: requiredNumber(action.deltaX, "action.deltaX"), deltaY: requiredNumber(action.deltaY, "action.deltaY"), visualGuard: guard };
      if (kind === "coordinate-drag") return { kind: "drag", from: { x: requiredNumber(action.startX, "action.startX"), y: requiredNumber(action.startY, "action.startY") }, to: { x: requiredNumber(action.endX, "action.endX"), y: requiredNumber(action.endY, "action.endY") }, visualGuard: guard };
      const mapped = kind === "mouse-click" ? "click" : kind === "mouse-double-click" ? "double-click" : kind;
      return { kind: mapped, x: requiredNumber(action.x, "action.x"), y: requiredNumber(action.y, "action.y"), button: pointerButton(action.button), visualGuard: guard };
    }
    if (kind === "navigate") return { kind, url: requiredString(action.url, "action.url") };
    if (kind === "click") return { kind, ref: optionalString(action.ref), selector: optionalString(action.selector) };
    if (kind === "fill" || kind === "type") return { kind, ref: optionalString(action.ref), selector: optionalString(action.selector), text: requiredString(action.text, "action.text") };
    if (kind === "press") return { kind, key: requiredString(action.key, "action.key") };
    if (kind === "hover") return { kind, ref: optionalString(action.ref), selector: optionalString(action.selector) };
    if (kind === "scroll") return { kind, direction: scrollDirection(action.direction), amount: optionalNumber(action.amount) };
    if (kind === "drag") return { kind: "semantic-drag", ref: requiredString(action.ref, "action.ref"), targetRef: requiredString(action.targetRef, "action.targetRef") };
    if (kind === "select") return { kind, ref: optionalString(action.ref), selector: optionalString(action.selector), values: stringArray(action.values, "action.values") };
    if (kind === "wait") return { kind, milliseconds: optionalNumber(action.milliseconds), selector: optionalString(action.selector), text: optionalString(action.text) };
    if (kind === "tab-new") return { kind, url: optionalString(action.url) };
    if (kind === "tab-close") return { kind, tabId: optionalString(action.tabId) };
    if (kind === "tab-focus") return { kind, tabId: requiredString(action.tabId, "action.tabId") };
    if (kind === "back" || kind === "forward" || kind === "reload") return { kind };
    throw unavailable("browser.act", `${kind} is not supported by the frozen daemon action shape`);
  }

  private resolveGuard(action: Record<string, unknown>, ownerId: string, sessionId: string): VisualGuard {
    const observationId = requiredString(action.observationId, "action.observationId");
    const binding = this.#observations.get(observationId);
    if (binding === undefined) throw unavailable("browser.act", "visual observation binding is stale or unknown");
    if (binding.ownerId !== ownerId || binding.sessionId !== sessionId) throw unavailable("browser.act", "visual observation binding belongs to another owner or session");
    if (requiredString(action.viewportId, "action.viewportId") !== binding.frame.viewportId) throw unavailable("browser.act", "visual observation viewport is stale");
    this.#observations.delete(observationId);
    return { viewportId: binding.frame.viewportId, viewportGeneration: binding.frame.viewportGeneration, screenshotSha256: binding.frame.screenshotSha256, screenshotSequence: binding.frame.screenshotSequence };
  }

  private async workspace(client: WebxClient, input: Record<string, unknown>, options: RequestOptions): Promise<FacadeResult> {
    const action = workspaceAction(input.action);
    const values = Array.isArray(input.values) ? input.values : [];
    const sessionId = optionalString(input.browserSessionId) ?? optionalString(values[0]);
    const tabId = optionalString(input.tabId) ?? optionalString(values[1]);
    return local(`Browser workspace ${action}`, await client.manageBrowserWorkspace({ action, sessionId, tabId }, options));
  }
}

function external(summary: string, data: unknown): FacadeResult { return { summary, data, trust: "untrusted-external" }; }
function local(summary: string, data: unknown): FacadeResult { return { summary, data, trust: "local" }; }
function unavailable(operation: string, reason: string): Error { const error = new Error(`${operation} is unavailable: ${reason}`); error.name = "WebxUnavailableError"; return error; }
function object(value: unknown): Record<string, unknown> { if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TypeError("operation input must be an object"); return value as Record<string, unknown>; }
function optionalObject(value: unknown): Readonly<Record<string, unknown>> | undefined { return value === undefined ? undefined : object(value); }
function contentRequest(value: Record<string, unknown>): ContentRequest {
  for (const key of Object.keys(value)) if (!["contentId", "offset", "limit", "findText", "query"].includes(key)) throw new TypeError(`${key} is not supported by web.content`);
  const offset = boundedOptionalInteger(value.offset, "offset", 0, 100_000_000);
  const limit = boundedOptionalInteger(value.limit, "limit", 1, 30_000);
  const findText = optionalString(value.findText);
  const query = optionalString(value.query);
  if (findText !== undefined && query !== undefined || offset !== undefined && (findText !== undefined || query !== undefined)) throw new TypeError("offset mode and focused mode are mutually exclusive");
  if (findText !== undefined && (findText.length < 1 || findText.length > 8_192)) throw new TypeError("findText must contain 1 to 8192 characters");
  if (query !== undefined && (query.trim().length < 1 || query.length > 8_192)) throw new TypeError("query must contain 1 to 8192 characters");
  return { contentId: requiredString(value.contentId, "contentId"), offset, limit, findText, query };
}
function boundedOptionalInteger(value: unknown, name: string, minimum: number, maximum: number): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) throw new TypeError(`${name} must be an integer from ${minimum} to ${maximum}`);
  return value;
}
function readSaveOptions(value: unknown): ReadSaveOptions | undefined {
  if (value === undefined) return undefined;
  const save = object(value);
  for (const key of Object.keys(save)) if (key !== "path" && key !== "overwrite") throw new TypeError(`save.${key} is not supported`);
  const path = validateRelativeMarkdownPath(requiredString(save.path, "save.path"));
  const overwrite = optionalBoolean(save.overwrite);
  if (save.overwrite !== undefined && overwrite === undefined) throw new TypeError("save.overwrite must be a boolean");
  return { path, overwrite };
}
function requiredString(value: unknown, name: string): string { if (typeof value !== "string" || value.length === 0) throw new TypeError(`${name} is required`); return value; }
function optionalString(value: unknown): string | undefined { return typeof value === "string" ? value : undefined; }
function requiredNumber(value: unknown, name: string): number { if (typeof value !== "number" || !Number.isFinite(value)) throw new TypeError(`${name} is required`); return value; }
function optionalNumber(value: unknown): number | undefined { return typeof value === "number" ? value : undefined; }
function optionalBoolean(value: unknown): boolean | undefined { return typeof value === "boolean" ? value : undefined; }
function optionalStringArray(value: unknown, name: string): readonly string[] | undefined { return value === undefined ? undefined : stringArray(value, name); }
function optionalSearchOutput(value: unknown): "links" | "extracts" | undefined { if (value === undefined) return undefined; if (value === "links" || value === "extracts") return value; throw new TypeError("output must be links or extracts"); }
function optionalReadView(value: unknown): "main" | "outline" | "raw" | undefined { if (value === undefined) return undefined; if (value === "main" || value === "outline" || value === "raw") return value; throw new TypeError("view is invalid"); }
function validateId(value: string, name: string): void { if (!/^[A-Za-z0-9._:-]{1,256}$/u.test(value)) throw new TypeError(`${name} is invalid`); }
function browserPath(value: unknown): BrowserPathId { if (value === undefined || value === "agent-browser/chrome") return "agent-browser/chrome"; if (value === "pinchtab/chrome") return value; throw new TypeError("pathId is unsupported"); }
function observationView(value: unknown): "main" | "interactive" | "visual" | "full" | "diff" { if (value === undefined || value === "main") return "main"; if (value === "interactive" || value === "visual" || value === "full" || value === "diff") return value; throw unavailable("browser.observe", `${String(value)} view has no daemon route`); }
function debugOperation(value: unknown): "console" | "network" | "html" | "pdf" | "record-start" | "record-stop" { if (value === "console" || value === "network" || value === "html" || value === "pdf" || value === "record-start" || value === "record-stop") return value; throw unavailable("browser.debug", "secret-bearing or unknown debug operation is refused"); }
function workspaceAction(value: unknown): "show" | "hide" | "list" | "attach" | "takeover" | "return" { if (value === "show" || value === "hide" || value === "list" || value === "attach" || value === "takeover" || value === "return") return value; throw unavailable("browser.workspace", `${String(value)} is unsupported`); }
function rejectPresent(value: Record<string, unknown>, names: readonly string[], operation: string): void { for (const name of names) if (value[name] !== undefined) throw unavailable(operation, `${name} is not supported by the daemon route`); }
function pointerButton(value: unknown): "left" | "middle" | "right" { if (value === undefined || value === "left") return "left"; if (value === "middle" || value === "right") return value; throw new TypeError("action.button is invalid"); }
function scrollDirection(value: unknown): "up" | "down" | "left" | "right" { if (value === "up" || value === "down" || value === "left" || value === "right") return value; throw new TypeError("action.direction is invalid"); }
function stringArray(value: unknown, name: string): readonly string[] { if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw new TypeError(`${name} is invalid`); return value as string[]; }
