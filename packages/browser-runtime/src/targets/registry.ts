import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { BrowserProtocolError, type TabAddress, type TabDescriptor } from "@webx/browser-protocol";
import type { CdpEvent } from "../cdp/connection.js";
import type { ChromeHost } from "../chrome/host.js";

export type TabState = "open" | "closed" | "crashed" | "detached";
export interface TabRecord {
  readonly browserSessionId: string;
  readonly tabId: string;
  targetId: string;
  cdpSessionId: string;
  topFrameId?: string;
  documentGeneration: number;
  viewportGeneration: number;
  state: TabState;
  latestFrameSequence: number;
  url: string;
  title: string;
}

export interface TerminalTabEvent {
  readonly tabId: string;
  readonly targetId: string;
  readonly cdpSessionId: string;
  readonly browserSessionId: string;
  readonly state: Exclude<TabState, "open">;
  readonly tab: Readonly<TabRecord>;
}

export class TargetRegistry extends EventEmitter {
  private readonly tabs = new Map<string, TabRecord>();
  private readonly targetToTab = new Map<string, string>();
  private readonly autoSessions = new Map<string, string>();
  private readonly attachingTargets = new Set<string>();
  private readonly destroyedDuringAttach = new Set<string>();
  private readonly rolledBackTargets = new Set<string>();
  private readonly maxTabs = 8;
  private closed = false;

  private constructor(readonly browserSessionId: string, private readonly host: ChromeHost) {
    super();
    host.cdp.on("event", this.onEvent);
    host.cdp.once("disconnect", this.onDisconnect);
  }

  static async create(browserSessionId: string, host: ChromeHost): Promise<TargetRegistry> {
    const registry = new TargetRegistry(browserSessionId, host);
    await host.cdp.send("Target.setDiscoverTargets", { discover: true });
    await host.cdp.send("Target.setAutoAttach", { autoAttach: false, waitForDebuggerOnStart: false, flatten: true });
    await registry.closeBootstrapTargets();
    return registry;
  }

  list(controlEpoch: number): TabDescriptor[] {
    return [...this.tabs.values()].filter((tab) => tab.state === "open").map((tab) => ({
      kind: "tab",
      address: { browserSessionId: this.browserSessionId, tabId: tab.tabId, targetId: tab.targetId, controlEpoch },
      documentGeneration: tab.documentGeneration,
      viewportGeneration: tab.viewportGeneration,
      state: "ready",
      url: tab.url,
      title: tab.title,
      frameSequence: tab.latestFrameSequence,
    }));
  }

  async createTab(url = "about:blank", options: { signal?: AbortSignal; markDispatched?: () => void } = {}): Promise<TabRecord> {
    this.assertOpen();
    this.assertTabCapacity();
    options.signal?.throwIfAborted();
    const created = await this.host.cdp.send<{ targetId: string }>("Target.createTarget", { url }, undefined, { ...(options.signal ? { signal: options.signal } : {}), ...(options.markDispatched ? { onDispatch: options.markDispatched } : {}) });
    this.attachingTargets.add(created.targetId);
    let cdpSessionId: string | undefined;
    try {
      options.signal?.throwIfAborted();
      cdpSessionId = await this.obtainSession(created.targetId, options.signal);
      const tab: TabRecord = {
        browserSessionId: this.browserSessionId, tabId: opaqueId("tab"), targetId: created.targetId, cdpSessionId,
        documentGeneration: 1, viewportGeneration: 1, state: "open", latestFrameSequence: 0, url: pageUrl(url), title: "",
      };
      await this.enableTab(tab, options.signal);
      options.signal?.throwIfAborted();
      if (this.destroyedDuringAttach.has(created.targetId)) throw new BrowserProtocolError("TARGET_CRASHED", "Browser target closed during registration.");
      this.tabs.set(tab.tabId, tab);
      this.targetToTab.set(tab.targetId, tab.tabId);
      return tab;
    } catch (error) {
      await this.rollbackTarget(created.targetId, cdpSessionId);
      throw error;
    } finally {
      this.attachingTargets.delete(created.targetId);
      this.destroyedDuringAttach.delete(created.targetId);
    }
  }

  resolve(address: TabAddress): TabRecord {
    const tab = this.tabs.get(address.tabId);
    if (tab === undefined || tab.state !== "open" || tab.browserSessionId !== address.browserSessionId || tab.targetId !== address.targetId) {
      throw new BrowserProtocolError("TAB_NOT_FOUND", "Tab not found.");
    }
    return tab;
  }

  getById(tabId: string): TabRecord | undefined { return this.tabs.get(tabId); }

  async rollbackRegisteredTab(tab: TabRecord): Promise<void> {
    if (this.tabs.get(tab.tabId) === tab) {
      this.tabs.delete(tab.tabId);
      this.targetToTab.delete(tab.targetId);
      this.autoSessions.delete(tab.targetId);
      this.markTerminal(tab, "closed");
    }
    await this.rollbackTarget(tab.targetId, tab.cdpSessionId);
  }

  async focus(address: TabAddress, signal?: AbortSignal, markDispatched?: () => void): Promise<void> {
    const tab = this.resolve(address);
    signal?.throwIfAborted();
    await this.host.cdp.send("Target.activateTarget", { targetId: tab.targetId }, undefined, { ...(signal ? { signal } : {}), ...(markDispatched ? { onDispatch: markDispatched } : {}) });
  }

  async closeTab(address: TabAddress, signal?: AbortSignal, markDispatched?: () => void): Promise<void> {
    const tab = this.resolve(address);
    signal?.throwIfAborted();
    let dispatched = false;
    try {
      await this.host.cdp.send("Target.closeTarget", { targetId: tab.targetId }, undefined, { ...(signal ? { signal } : {}), onDispatch: () => { dispatched = true; markDispatched?.(); } });
    } finally { if (dispatched || !this.host.connected) this.markTerminal(tab, "closed"); }
  }

  incrementFrame(tab: TabRecord): number { return ++tab.latestFrameSequence; }
  incrementViewport(tab: TabRecord): void { tab.viewportGeneration++; }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.host.cdp.off("event", this.onEvent);
    this.host.cdp.off("disconnect", this.onDisconnect);
    for (const tab of this.tabs.values()) if (tab.state === "open") this.markTerminal(tab, "closed");
  }

  private async obtainSession(targetId: string, signal?: AbortSignal): Promise<string> {
    const existing = this.autoSessions.get(targetId);
    if (existing !== undefined) return existing;
    const attached = await this.host.cdp.send<{ sessionId: string }>("Target.attachToTarget", { targetId, flatten: true }, undefined, signal ? { signal } : {});
    this.autoSessions.set(targetId, attached.sessionId);
    return attached.sessionId;
  }

  private async enableTab(tab: TabRecord, signal?: AbortSignal): Promise<void> {
    await Promise.all([
      this.command(tab, "Page.enable", {}, signal), this.command(tab, "Runtime.enable", {}, signal), this.command(tab, "DOM.enable", {}, signal), this.command(tab, "Accessibility.enable", {}, signal),
    ]);
  }

  private async registerPopup(targetId: string, openerId: string, url: string): Promise<void> {
    if (this.closed || this.targetToTab.has(targetId) || this.attachingTargets.has(targetId) || !this.targetToTab.has(openerId)) return;
    try { this.assertTabCapacity(); } catch { await this.rollbackTarget(targetId); return; }
    this.attachingTargets.add(targetId);
    let cdpSessionId: string | undefined;
    try {
      cdpSessionId = await this.obtainSession(targetId);
      const tab: TabRecord = {
        browserSessionId: this.browserSessionId, tabId: opaqueId("tab"), targetId, cdpSessionId,
        documentGeneration: 1, viewportGeneration: 1, state: "open", latestFrameSequence: 0, url: pageUrl(url), title: "",
      };
      await this.enableTab(tab);
      if (this.closed || this.destroyedDuringAttach.has(targetId) || !this.targetToTab.has(openerId)) throw new BrowserProtocolError("TARGET_CRASHED", "Popup closed during registration.");
      this.tabs.set(tab.tabId, tab);
      this.targetToTab.set(targetId, tab.tabId);
      this.emit("tabRegistered", tab);
    } catch { await this.rollbackTarget(targetId, cdpSessionId); }
    finally { this.attachingTargets.delete(targetId); this.destroyedDuringAttach.delete(targetId); }
  }

  private readonly onEvent = (event: CdpEvent): void => {
    if (event.method === "Target.attachedToTarget") {
      const sessionId = typeof event.params.sessionId === "string" ? event.params.sessionId : undefined;
      const targetInfo = isRecord(event.params.targetInfo) ? event.params.targetInfo : undefined;
      const targetId = targetInfo && typeof targetInfo.targetId === "string" ? targetInfo.targetId : undefined;
      if (sessionId && targetId && this.rolledBackTargets.has(targetId)) { void this.host.cdp.send("Target.detachFromTarget", { sessionId }).catch(() => undefined); return; }
      if (sessionId && targetId) this.autoSessions.set(targetId, sessionId);
      return;
    }
    if (event.method === "Target.targetCreated" && isRecord(event.params.targetInfo)) {
      const info = event.params.targetInfo;
      if (info.type === "page" && typeof info.targetId === "string" && typeof info.openerId === "string") {
        void this.registerPopup(info.targetId, info.openerId, typeof info.url === "string" ? info.url : "about:blank");
      }
      return;
    }
    if (event.method === "Target.targetInfoChanged" && isRecord(event.params.targetInfo)) {
      const info = event.params.targetInfo;
      const targetId = typeof info.targetId === "string" ? info.targetId : undefined;
      const tabId = targetId === undefined ? undefined : this.targetToTab.get(targetId);
      const tab = tabId === undefined ? undefined : this.tabs.get(tabId);
      if (tab !== undefined) { if (typeof info.url === "string") tab.url = info.url; if (typeof info.title === "string") tab.title = info.title; }
      return;
    }
    if (event.method === "Target.targetDestroyed" || event.method === "Target.targetCrashed") {
      const targetId = typeof event.params.targetId === "string" ? event.params.targetId : undefined;
      if (targetId !== undefined && this.attachingTargets.has(targetId)) this.destroyedDuringAttach.add(targetId);
      if (targetId !== undefined) this.rolledBackTargets.delete(targetId);
      const tabId = targetId ? this.targetToTab.get(targetId) : undefined;
      const tab = tabId ? this.tabs.get(tabId) : undefined;
      if (tab) this.markTerminal(tab, event.method === "Target.targetCrashed" ? "crashed" : "closed");
      return;
    }
    if (event.sessionId === undefined) return;
    const tab = [...this.tabs.values()].find((candidate) => candidate.cdpSessionId === event.sessionId);
    if (tab === undefined) return;
    if (event.method === "Page.frameNavigated" && isRecord(event.params.frame) && event.params.frame.parentId === undefined) {
      tab.documentGeneration++;
      if (typeof event.params.frame.id === "string") tab.topFrameId = event.params.frame.id;
      if (typeof event.params.frame.url === "string") tab.url = event.params.frame.url;
    } else if (event.method === "Page.navigatedWithinDocument" && typeof event.params.url === "string") tab.url = event.params.url;
    else if (event.method === "Page.frameResized") tab.viewportGeneration++;
    else if (event.method === "Inspector.targetCrashed") this.markTerminal(tab, "crashed");
  };

  private readonly onDisconnect = (): void => { for (const tab of this.tabs.values()) if (tab.state === "open") this.markTerminal(tab, "detached"); };

  private markTerminal(tab: TabRecord, state: Exclude<TabState, "open">): void {
    if (tab.state !== "open" && !this.tabs.has(tab.tabId)) return;
    tab.state = state;
    const terminalTab = Object.freeze({ ...tab, state });
    this.tabs.delete(tab.tabId);
    this.targetToTab.delete(tab.targetId);
    this.autoSessions.delete(tab.targetId);
    const event: TerminalTabEvent = {
      tabId: terminalTab.tabId,
      targetId: terminalTab.targetId,
      cdpSessionId: terminalTab.cdpSessionId,
      browserSessionId: terminalTab.browserSessionId,
      state,
      tab: terminalTab,
    };
    this.emit("tabTerminal", event);
  }

  private assertTabCapacity(): void {
    const open = [...this.tabs.values()].filter((tab) => tab.state === "open").length;
    if (open + this.attachingTargets.size >= this.maxTabs) throw new BrowserProtocolError("LIMIT_EXCEEDED", "Browser tab limit reached.", true);
  }

  private async rollbackTarget(targetId: string, cdpSessionId?: string): Promise<void> {
    this.autoSessions.delete(targetId);
    this.targetToTab.delete(targetId);
    this.rolledBackTargets.add(targetId);
    while (this.rolledBackTargets.size > 32) { const oldest = this.rolledBackTargets.values().next().value; if (typeof oldest !== "string") break; this.rolledBackTargets.delete(oldest); }
    if (cdpSessionId !== undefined) await this.host.cdp.send("Target.detachFromTarget", { sessionId: cdpSessionId }, undefined, { timeoutMs: 1_000 }).catch(() => undefined);
    await this.host.cdp.send("Target.closeTarget", { targetId }, undefined, { timeoutMs: 1_000 }).catch(() => undefined);
  }

  private async closeBootstrapTargets(): Promise<void> {
    const targets = await this.host.cdp.send<{ targetInfos: Array<{ targetId: string; type: string; url: string; openerId?: string }> }>("Target.getTargets");
    for (const target of targets.targetInfos) {
      if (target.type === "page" && target.url === "about:blank" && target.openerId === undefined) {
        try { await this.host.cdp.send("Target.closeTarget", { targetId: target.targetId }); } catch { /* Bootstrap already closed. */ }
      }
    }
  }

  private async command(tab: TabRecord, method: string, params: Readonly<Record<string, unknown>> = {}, signal?: AbortSignal): Promise<unknown> {
    return await this.host.cdp.send(method, params, tab.cdpSessionId, signal ? { signal } : {});
  }

  private assertOpen(): void { if (this.closed || !this.host.connected) throw new BrowserProtocolError("CDP_DISCONNECTED", "Target registry is unavailable.", true); }
}

function pageUrl(value: string): string { return /^(?:https?:\/\/|about:blank|chrome-error:\/\/)/.test(value) ? value : "about:blank"; }
function opaqueId(prefix: string): string { return `${prefix}_${randomBytes(18).toString("base64url")}`; }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
