import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import type { TabAddress, TabDescriptor } from "@webx/browser-protocol";
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

export class TargetRegistry extends EventEmitter {
  private readonly tabs = new Map<string, TabRecord>();
  private readonly targetToTab = new Map<string, string>();
  private readonly autoSessions = new Map<string, string>();
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

  async createTab(url = "about:blank"): Promise<TabRecord> {
    this.assertOpen();
    const created = await this.host.cdp.send<{ targetId: string }>("Target.createTarget", { url });
    const cdpSessionId = await this.obtainSession(created.targetId);
    const tab: TabRecord = {
      browserSessionId: this.browserSessionId, tabId: opaqueId("tab"), targetId: created.targetId, cdpSessionId,
      documentGeneration: 1, viewportGeneration: 1, state: "open", latestFrameSequence: 0, url: pageUrl(url), title: "",
    };
    this.tabs.set(tab.tabId, tab);
    this.targetToTab.set(tab.targetId, tab.tabId);
    await this.enableTab(tab);
    return tab;
  }

  resolve(address: TabAddress): TabRecord {
    const tab = this.tabs.get(address.tabId);
    if (tab === undefined || tab.state !== "open" || tab.browserSessionId !== address.browserSessionId || tab.targetId !== address.targetId) {
      throw new Error("Tab not found.");
    }
    return tab;
  }

  getById(tabId: string): TabRecord | undefined { return this.tabs.get(tabId); }

  async focus(address: TabAddress): Promise<void> {
    const tab = this.resolve(address);
    await this.host.cdp.send("Target.activateTarget", { targetId: tab.targetId });
  }

  async closeTab(address: TabAddress): Promise<void> {
    const tab = this.resolve(address);
    try { await this.host.cdp.send("Target.closeTarget", { targetId: tab.targetId }); } finally { this.markTerminal(tab, "closed"); }
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

  private async obtainSession(targetId: string): Promise<string> {
    const existing = this.autoSessions.get(targetId);
    if (existing !== undefined) return existing;
    const attached = await this.host.cdp.send<{ sessionId: string }>("Target.attachToTarget", { targetId, flatten: true });
    return attached.sessionId;
  }

  private async enableTab(tab: TabRecord): Promise<void> {
    await Promise.all([
      this.command(tab, "Page.enable"), this.command(tab, "Runtime.enable"), this.command(tab, "DOM.enable"), this.command(tab, "Accessibility.enable"),
    ]);
  }

  private async registerPopup(targetId: string, openerId: string, url: string): Promise<void> {
    if (this.closed || this.targetToTab.has(targetId) || !this.targetToTab.has(openerId)) return;
    try {
      const cdpSessionId = await this.obtainSession(targetId);
      const tab: TabRecord = {
        browserSessionId: this.browserSessionId, tabId: opaqueId("tab"), targetId, cdpSessionId,
        documentGeneration: 1, viewportGeneration: 1, state: "open", latestFrameSequence: 0, url: pageUrl(url), title: "",
      };
      this.tabs.set(tab.tabId, tab);
      this.targetToTab.set(targetId, tab.tabId);
      await this.enableTab(tab);
      this.emit("tabRegistered", tab);
    } catch { /* Popup failed closed and remains unowned. */ }
  }

  private readonly onEvent = (event: CdpEvent): void => {
    if (event.method === "Target.attachedToTarget") {
      const sessionId = typeof event.params.sessionId === "string" ? event.params.sessionId : undefined;
      const targetInfo = isRecord(event.params.targetInfo) ? event.params.targetInfo : undefined;
      const targetId = targetInfo && typeof targetInfo.targetId === "string" ? targetInfo.targetId : undefined;
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
    if (event.method === "Target.targetDestroyed" || event.method === "Target.targetCrashed") {
      const targetId = typeof event.params.targetId === "string" ? event.params.targetId : undefined;
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
    } else if (event.method === "Page.frameResized") tab.viewportGeneration++;
    else if (event.method === "Inspector.targetCrashed") this.markTerminal(tab, "crashed");
  };

  private readonly onDisconnect = (): void => { for (const tab of this.tabs.values()) if (tab.state === "open") this.markTerminal(tab, "detached"); };

  private markTerminal(tab: TabRecord, state: Exclude<TabState, "open">): void {
    tab.state = state;
    this.emit("tabTerminal", { tabId: tab.tabId, targetId: tab.targetId, state });
    this.targetToTab.delete(tab.targetId);
    this.autoSessions.delete(tab.targetId);
  }

  private async closeBootstrapTargets(): Promise<void> {
    const targets = await this.host.cdp.send<{ targetInfos: Array<{ targetId: string; type: string; url: string; openerId?: string }> }>("Target.getTargets");
    for (const target of targets.targetInfos) {
      if (target.type === "page" && target.url === "about:blank" && target.openerId === undefined) {
        try { await this.host.cdp.send("Target.closeTarget", { targetId: target.targetId }); } catch { /* Bootstrap already closed. */ }
      }
    }
  }

  private async command(tab: TabRecord, method: string, params: Readonly<Record<string, unknown>> = {}): Promise<unknown> {
    return await this.host.cdp.send(method, params, tab.cdpSessionId);
  }

  private assertOpen(): void { if (this.closed || !this.host.connected) throw new Error("Target registry is unavailable."); }
}

function pageUrl(value: string): string { return /^(?:https?:\/\/|about:blank|chrome-error:\/\/)/.test(value) ? value : "about:blank"; }
function opaqueId(prefix: string): string { return `${prefix}_${randomBytes(18).toString("base64url")}`; }
function sleep(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
