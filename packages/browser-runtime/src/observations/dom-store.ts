import { randomBytes } from "node:crypto";
import type { DomObservation, TabAddress } from "@webx/browser-protocol";
import type { TargetRegistry, TabRecord } from "../targets/registry.js";

interface AxValue { value?: string | number | boolean }
interface AxNode { nodeId: string; backendDOMNodeId?: number; ignored?: boolean; role?: AxValue; name?: AxValue; value?: AxValue; properties?: Array<{ name: string; value: AxValue }> }
interface HandleRecord { handle: string; address: TabAddress; backendNodeId: number; documentGeneration: number; expiresAtMs: number }
export interface ResolvedHandle { tab: TabRecord; bounds: { x: number; y: number; width: number; height: number }; center: { x: number; y: number } }

export class DomObservationStore {
  private readonly handles = new Map<string, HandleRecord>();
  private readonly observations = new Map<string, { address: TabAddress; documentGeneration: number; handles: string[]; expiresAtMs: number }>();

  constructor(private readonly registry: TargetRegistry, private readonly maxHandles = 512, private readonly retentionMs = 60_000) {}

  get handleCount(): number { return this.handles.size; }

  async observe(address: TabAddress, maxNodes: number): Promise<DomObservation> {
    const tab = this.registry.resolve(address);
    this.prune();
    const tree = await this.command<{ nodes: AxNode[] }>(tab, "Accessibility.getFullAXTree", { depth: 12 });
    const interactive = new Set(["button", "checkbox", "combobox", "link", "listbox", "menuitem", "radio", "searchbox", "slider", "spinbutton", "switch", "tab", "textbox"]);
    const candidates = tree.nodes.filter((node) => !node.ignored && interactive.has(String(node.role?.value ?? "")) && typeof node.backendDOMNodeId === "number");
    const nodes: DomObservation["nodes"] = [];
    const issued: string[] = [];
    for (const node of candidates.slice(0, Math.min(maxNodes, 200))) {
      const backendNodeId = node.backendDOMNodeId;
      if (backendNodeId === undefined) continue;
      const handle = opaqueId("handle");
      const bounds = await this.bounds(tab, backendNodeId).catch(() => undefined);
      const state: Record<string, string | number | boolean> = {};
      for (const property of node.properties ?? []) if (["checked", "disabled", "expanded", "focused", "required", "selected"].includes(property.name) && property.value.value !== undefined) state[property.name] = property.value.value;
      this.handles.set(handle, { handle, address: { ...address }, backendNodeId, documentGeneration: tab.documentGeneration, expiresAtMs: Date.now() + this.retentionMs });
      issued.push(handle);
      const role = String(node.role?.value ?? "unknown");
      const name = String(node.name?.value ?? "").slice(0, 4096);
      nodes.push({ handle, role, name, ...(node.value?.value !== undefined ? { value: String(node.value.value).slice(0, 8192) } : {}), state, ...(bounds ? { bounds } : {}), locatorDescription: `AX role=${JSON.stringify(role)} name=${JSON.stringify(name)}`.slice(0, 1024) });
    }
    const observationId = opaqueId("domObservation");
    this.observations.set(observationId, { address: { ...address }, documentGeneration: tab.documentGeneration, handles: issued, expiresAtMs: Date.now() + this.retentionMs });
    while (this.handles.size > this.maxHandles) { const id = this.handles.keys().next().value; if (typeof id !== "string") break; this.handles.delete(id); }
    return { kind: "domObservation", observationId, address: { ...address }, documentGeneration: tab.documentGeneration, observedAt: new Date().toISOString(), truncated: candidates.length > nodes.length, nodes };
  }

  async resolve(address: TabAddress, observationId: string, handle: string): Promise<ResolvedHandle> {
    this.prune();
    const tab = this.registry.resolve(address);
    const observation = this.observations.get(observationId);
    const record = this.handles.get(handle);
    if (observation === undefined || record === undefined || !observation.handles.includes(handle) || !sameAddress(observation.address, address) || !sameAddress(record.address, address) || observation.documentGeneration !== tab.documentGeneration || record.documentGeneration !== tab.documentGeneration) throw new Error("DOM handle is stale.");
    const bounds = await this.bounds(tab, record.backendNodeId).catch(() => { throw new Error("DOM handle is stale."); });
    return { tab, bounds, center: { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 } };
  }

  invalidateTab(tabId: string): void {
    for (const [id, record] of this.handles) if (record.address.tabId === tabId) this.handles.delete(id);
    for (const [id, record] of this.observations) if (record.address.tabId === tabId) this.observations.delete(id);
  }

  private prune(): void {
    const now = Date.now();
    for (const [id, record] of this.handles) if (record.expiresAtMs <= now) this.handles.delete(id);
    for (const [id, record] of this.observations) if (record.expiresAtMs <= now) this.observations.delete(id);
  }

  private async bounds(tab: TabRecord, backendNodeId: number): Promise<{ x: number; y: number; width: number; height: number }> {
    const result = await this.command<{ model: { border: number[] } }>(tab, "DOM.getBoxModel", { backendNodeId });
    const quad = result.model.border;
    if (!Array.isArray(quad) || quad.length < 8 || !quad.every((value) => typeof value === "number" && Number.isFinite(value))) throw new Error("DOM handle is stale.");
    const xs = quad.filter((_, index) => index % 2 === 0).slice(0, 4);
    const ys = quad.filter((_, index) => index % 2 === 1).slice(0, 4);
    return { x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) };
  }

  private async command<T>(tab: TabRecord, method: string, params: Readonly<Record<string, unknown>>): Promise<T> { return await domConnection(tab).send<T>(method, params, tab.cdpSessionId); }
}

const connections = new WeakMap<TabRecord, { send<T>(method: string, params: Readonly<Record<string, unknown>>, sessionId: string): Promise<T> }>();
export function bindDomTab(tab: TabRecord, connection: { send<T>(method: string, params: Readonly<Record<string, unknown>>, sessionId: string): Promise<T> }): void { connections.set(tab, connection); }
function domConnection(tab: TabRecord) { const connection = connections.get(tab); if (connection === undefined) throw new Error("Tab has no CDP connection."); return connection; }
function opaqueId(prefix: string): string { return `${prefix}_${randomBytes(18).toString("base64url")}`; }
function sameAddress(left: TabAddress, right: TabAddress): boolean { return left.browserSessionId === right.browserSessionId && left.tabId === right.tabId && left.targetId === right.targetId && left.controlEpoch === right.controlEpoch; }
