import { randomBytes } from "node:crypto";
import { BrowserProtocolError, type DomObservation, type TabAddress } from "@webx/browser-protocol";
import type { TargetRegistry, TabRecord } from "../targets/registry.js";

interface AxValue { value?: string | number | boolean }
interface AxNode { nodeId: string; backendDOMNodeId?: number; ignored?: boolean; role?: AxValue; name?: AxValue; value?: AxValue; properties?: Array<{ name: string; value: AxValue }> }
interface FrameTreeNode { frame: { id: string }; childFrames?: FrameTreeNode[] }
interface HandleRecord { handle: string; address: TabAddress; backendNodeId: number; documentGeneration: number; expiresAtMs: number }
interface DomObservationRecord { address: TabAddress; documentGeneration: number; handles: string[]; expiresAtMs: number }
export interface ResolvedHandle { tab: TabRecord; bounds: { x: number; y: number; width: number; height: number }; center: { x: number; y: number } }
export interface DomObservationStoreOptions {
  maxObservations?: number;
  maxHandles?: number;
  maxHandlesPerObservation?: number;
  retentionMs?: number;
  now?: () => number;
}

export class DomObservationStore {
  private readonly handles = new Map<string, HandleRecord>();
  private readonly observations = new Map<string, DomObservationRecord>();
  private readonly maxObservations: number;
  private readonly maxHandles: number;
  private readonly maxHandlesPerObservation: number;
  private readonly retentionMs: number;
  private readonly now: () => number;

  constructor(private readonly registry: TargetRegistry, options: DomObservationStoreOptions = {}) {
    this.maxObservations = options.maxObservations ?? 64;
    this.maxHandles = options.maxHandles ?? 512;
    this.maxHandlesPerObservation = Math.min(options.maxHandlesPerObservation ?? 200, this.maxHandles);
    this.retentionMs = options.retentionMs ?? 60_000;
    this.now = options.now ?? Date.now;
  }

  get handleCount(): number { return this.handles.size; }
  get observationCount(): number { return this.observations.size; }
  hasUsable(observationId: string): boolean { this.prune(); return this.observations.has(observationId); }

  async observe(address: TabAddress, maxNodes: number, signal?: AbortSignal): Promise<DomObservation> {
    signal?.throwIfAborted();
    this.prune();
    const tab = this.registry.resolve(address);
    const documentGeneration = tab.documentGeneration;
    const trees: Array<{ nodes: AxNode[] }> = [await this.command<{ nodes: AxNode[] }>(tab, "Accessibility.getFullAXTree", { depth: 12 }, signal)];
    signal?.throwIfAborted();
    try {
      const frames = await this.command<{ frameTree: FrameTreeNode }>(tab, "Page.getFrameTree", {}, signal);
      for (const frameId of childFrameIds(frames.frameTree)) {
        signal?.throwIfAborted();
        try { trees.push(await this.command<{ nodes: AxNode[] }>(tab, "Accessibility.getFullAXTree", { depth: 12, frameId }, signal)); }
        catch (error) { if (signal?.aborted) signal.throwIfAborted(); void error; /* Out-of-process frames are outside this target session. */ }
      }
    } catch (error) { if (signal?.aborted) signal.throwIfAborted(); void error; }
    const interactive = new Set(["button", "checkbox", "combobox", "link", "listbox", "menuitem", "radio", "searchbox", "slider", "spinbutton", "switch", "tab", "textbox"]);
    const candidates = trees.flatMap((tree) => tree.nodes).filter((node) => !node.ignored && interactive.has(String(node.role?.value ?? "")) && typeof node.backendDOMNodeId === "number");
    const limit = Math.min(maxNodes, this.maxHandlesPerObservation, this.maxHandles);
    const nodes: DomObservation["nodes"] = [];
    const pending: HandleRecord[] = [];
    const expiresAtMs = this.now() + this.retentionMs;
    for (const node of candidates) {
      if (nodes.length >= limit) break;
      signal?.throwIfAborted();
      const backendNodeId = node.backendDOMNodeId;
      if (backendNodeId === undefined) continue;
      let bounds: ResolvedHandle["bounds"];
      try { bounds = await this.bounds(tab, backendNodeId, signal); }
      catch (error) {
        if (signal?.aborted) signal.throwIfAborted();
        if (error instanceof BrowserProtocolError && error.code === "HANDLE_STALE") continue;
        throw error;
      }
      const handle = opaqueId("handle");
      const state: Record<string, string | number | boolean> = {};
      for (const property of node.properties ?? []) if (["checked", "disabled", "expanded", "focused", "required", "selected"].includes(property.name) && property.value.value !== undefined) state[property.name] = property.value.value;
      pending.push({ handle, address: { ...address }, backendNodeId, documentGeneration, expiresAtMs });
      const role = String(node.role?.value ?? "unknown");
      const name = String(node.name?.value ?? "").slice(0, 4096);
      nodes.push({ handle, role, name, ...(node.value?.value !== undefined ? { value: String(node.value.value).slice(0, 8192) } : {}), state, bounds, locatorDescription: `AX role=${JSON.stringify(role)} name=${JSON.stringify(name)}`.slice(0, 1024) });
    }
    signal?.throwIfAborted();
    const current = this.registry.resolve(address);
    if (current !== tab || current.cdpSessionId !== tab.cdpSessionId || current.documentGeneration !== documentGeneration) throw stale("Document changed during DOM observation.");
    while (this.observations.size >= this.maxObservations || this.handles.size + pending.length > this.maxHandles) {
      if (!this.removeOldestObservation()) throw new BrowserProtocolError("LIMIT_EXCEEDED", "DOM observation store is full.", true);
    }
    const observationId = opaqueId("domObservation");
    for (const record of pending) this.handles.set(record.handle, record);
    this.observations.set(observationId, { address: { ...address }, documentGeneration, handles: pending.map((record) => record.handle), expiresAtMs });
    return { kind: "domObservation", observationId, address: { ...address }, documentGeneration, observedAt: new Date(this.now()).toISOString(), truncated: candidates.length > nodes.length, nodes };
  }

  async resolve(address: TabAddress, observationId: string, handle: string, signal?: AbortSignal): Promise<ResolvedHandle> {
    signal?.throwIfAborted();
    this.prune();
    const tab = this.registry.resolve(address);
    const observation = this.observations.get(observationId);
    const record = this.handles.get(handle);
    if (observation === undefined || record === undefined || !observation.handles.includes(handle) || !sameAddress(observation.address, address) || !sameAddress(record.address, address)) throw stale();
    if (observation.documentGeneration !== tab.documentGeneration || record.documentGeneration !== tab.documentGeneration) throw stale("Document generation changed.");
    const bounds = await this.bounds(tab, record.backendNodeId, signal);
    signal?.throwIfAborted();
    if (tab.documentGeneration !== record.documentGeneration) throw stale("Document generation changed.");
    return { tab, bounds, center: { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 } };
  }

  invalidateTab(tabId: string): void {
    for (const [id, record] of this.handles) if (record.address.tabId === tabId) this.handles.delete(id);
    for (const [id, record] of this.observations) if (record.address.tabId === tabId) this.observations.delete(id);
  }

  private prune(): void {
    const now = this.now();
    for (const [id, record] of this.observations) if (record.expiresAtMs <= now) this.deleteObservation(id);
    for (const [id, record] of this.handles) if (record.expiresAtMs <= now) this.handles.delete(id);
  }

  private removeOldestObservation(): boolean {
    const id = this.observations.keys().next().value;
    if (typeof id !== "string") return false;
    this.deleteObservation(id);
    return true;
  }

  private deleteObservation(id: string): void {
    const observation = this.observations.get(id);
    if (observation === undefined) return;
    this.observations.delete(id);
    for (const handle of observation.handles) this.handles.delete(handle);
  }

  private async bounds(tab: TabRecord, backendNodeId: number, signal?: AbortSignal): Promise<{ x: number; y: number; width: number; height: number }> {
    let result: { model: { border: number[] } };
    try { result = await this.command(tab, "DOM.getBoxModel", { backendNodeId }, signal); }
    catch (error) {
      if (signal?.aborted) signal.throwIfAborted();
      if (error instanceof BrowserProtocolError && error.code === "CDP_DISCONNECTED") throw error;
      throw stale("DOM node is detached.");
    }
    const quad = result.model.border;
    if (!Array.isArray(quad) || quad.length < 8 || !quad.every((value) => typeof value === "number" && Number.isFinite(value))) throw stale("DOM node bounds are unavailable.");
    const xs = quad.filter((_, index) => index % 2 === 0).slice(0, 4);
    const ys = quad.filter((_, index) => index % 2 === 1).slice(0, 4);
    // CDP DOM box-model quads use top-level viewport CSS coordinates, including frame offsets.
    return { x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) };
  }

  private async command<T>(tab: TabRecord, method: string, params: Readonly<Record<string, unknown>>, signal?: AbortSignal): Promise<T> {
    return await domConnection(tab).send<T>(method, params, tab.cdpSessionId, signal ? { signal } : undefined);
  }
}

interface DomConnection { send<T>(method: string, params: Readonly<Record<string, unknown>>, sessionId: string, options?: { signal?: AbortSignal }): Promise<T> }
const connections = new WeakMap<TabRecord, DomConnection>();
export function bindDomTab(tab: TabRecord, connection: DomConnection): void { connections.set(tab, connection); }
function domConnection(tab: TabRecord): DomConnection { const connection = connections.get(tab); if (connection === undefined) throw new BrowserProtocolError("CDP_DISCONNECTED", "Tab has no CDP connection."); return connection; }
function stale(message = "DOM handle is stale."): BrowserProtocolError { return new BrowserProtocolError("HANDLE_STALE", message); }
function opaqueId(prefix: string): string { return `${prefix}_${randomBytes(18).toString("base64url")}`; }
function sameAddress(left: TabAddress, right: TabAddress): boolean { return left.browserSessionId === right.browserSessionId && left.tabId === right.tabId && left.targetId === right.targetId && left.controlEpoch === right.controlEpoch; }
function childFrameIds(root: FrameTreeNode): string[] { const result: string[] = []; const visit = (node: FrameTreeNode): void => { for (const child of node.childFrames ?? []) { result.push(child.frame.id); visit(child); } }; visit(root); return result; }
