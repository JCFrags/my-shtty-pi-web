import { BrowserDownloads } from "../agent/downloads";
import type { BrowserOwner } from "pixel-store";
import type { BrowserDialog, BrowserDialogs, DialogResponse } from "../agent/dialogs";
import type { PopupWindow } from "../page/popup";
import { BrowserAgentRuntime } from "../agent/runtime";
import type { BrowserControl } from "../agent/control";
import {
  createSlowNaturalPersonaProvider,
  type AgentPersonaProvider,
} from "../agent/interaction-profile";
import type {
  AgentActionOutcome,
  AgentActivity,
  AgentBrowserTarget,
  AgentClickRequest,
  AgentUploadRequest,
  AgentClickResult,
  AgentDragRequest,
  AgentDragResult,
  AgentGetUrlRequest,
  AgentGetUrlResult,
  AgentHoverRequest,
  AgentHoverResult,
  AgentNavigateRequest,
  AgentNavigateResult,
  AgentObservation,
  AgentObserveRequest,
  AgentPressKeyRequest,
  AgentPressKeyResult,
  AgentScrollRequest,
  AgentScrollResult,
  AgentTypeRequest,
  AgentTypeResult,
  AgentWaitForRequest,
  AgentWaitForResult,
} from "../agent/types";
import type { BrowserController } from "../page/controller";
import type { DevtoolsAction } from "../page/devtools";
import { initialBrowserState } from "../page/types";
import type { BrowserState } from "../page/types";
import type { TabRow } from "../ui/types";
import { displayUrl } from "../url";

export interface TabApp {
  name: string | null;
  id: string;
}

export interface TabOptions {
  app?: TabApp;
  partition?: string | null;
}

export interface Tab {
  readonly id: number;
  state: BrowserState;
  controller: BrowserController;
  agentRuntime: BrowserAgentRuntime;
  targetId: string | null;
  app: TabApp | null;
  agentControlAt: number | null;
}

interface PopupContext {
  id: number;
  openerId: number;
  rootId: number;
  controller: PopupWindow;
  agentRuntime: BrowserAgentRuntime;
}

export interface TabTarget {
  contextId: number;
  openerId: number | null;
  kind: "tab" | "popup";
  id: number;
  url: string;
  title: string;
  active: boolean;
  targetId: string | null;
  app?: TabApp | null;
  timeOrigin?: number | null;
  agentControlled: boolean;
}


export interface TabHost {
  owner?: BrowserOwner | null;
  projectRoot?: string | null;
  onDownload?: (value: import("../agent/downloads").BrowserDownload) => void;
  createController(
    url: string,
    visible: boolean,
    onState: (state: BrowserState) => void,
    options: TabOptions & { tabId: number },
  ): BrowserController;
  onActivated(): void;
  onActiveState(state: BrowserState, urlChanged: boolean): void;
  onCursorChanged(): void;
  onDevtoolsChanged(): void;
  onDevtoolsAction(action: DevtoolsAction): void;
  onPageMenu(params: Electron.ContextMenuParams): void;
  onTabsChanged(): void;
  requestAgentRender(): void;
  onTabOpened(opener: BrowserController, url: string): void;
  onTabClosed(id: number): void;
  tabSwitchAllowed(): boolean;
  agentTabSwitchAllowed(): boolean;
  requestRender(): void;
}

const parsedTtl = Number(process.env.TERMINAL_BROWSER_AGENT_CONTROL_MS);
const AGENT_CONTROL_TTL_MS = Number.isFinite(parsedTtl) && parsedTtl > 0 ? parsedTtl : 10_000;
const AGENT_CONTROL_SWEEP_MS = 500;

export class TabManager {
  readonly downloads: BrowserDownloads;
  private tabs: Tab[] = [];
  private activeId = 0;
  private activeContextId = 0;
  private readonly popups = new Map<number, PopupContext>();
  private readonly contextListeners = new Set<() => void>();
  private seq = 1;
  private agentSweep: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly host: TabHost,
    private readonly fallbackUrl: string,
    private readonly control: BrowserControl,
    private readonly personaProvider: AgentPersonaProvider = createSlowNaturalPersonaProvider(),
  ) { this.downloads = new BrowserDownloads(host.projectRoot ?? null, host.owner ?? null, host.onDownload); }

  get active(): Tab | null {
    return this.tabs.find((tab) => tab.id === this.activeId) ?? null;
  }

  get activeAgentActivity(): AgentActivity | null {
    return this.context(this.activeContextId)?.agentRuntime.activity ?? null;
  }

  get activeController(): BrowserController | null {
    return this.active?.controller ?? null;
  }

  get activeState(): BrowserState | null {
    return this.active?.state ?? null;
  }

  get count(): number {
    return this.tabs.length;
  }

  
  create(url: string, activate = true, options: TabOptions = {}): Tab {
    if (this.pendingDialog) throw new Error("a browser dialog is pending");
    const tab = {
      id: this.seq++,
      state: initialBrowserState(url),
      targetId: null,
      app: options.app ?? null,
      agentControlAt: null,
    } as Tab;
    this.attachController(tab, url, activate, options);
    this.tabs.push(tab);
    if (activate) this.activate(tab.id);
    this.host.onTabsChanged();
    return tab;
  }

  private attachController(tab: Tab, url: string, visible: boolean, options: TabOptions) {
    tab.controller = this.host.createController(url, visible, (state) => {
      const urlChanged = state.url !== tab.state.url;
      tab.state = state;
      if (tab.id === this.activeId) this.host.onActiveState(state, urlChanged);
      this.host.requestRender();
    }, { ...options, tabId: tab.id });
    tab.agentRuntime = new BrowserAgentRuntime(tab.controller, {
      control: this.control,
      personaProvider: this.personaProvider,
      onActivityChange: () => this.host.requestAgentRender(),
    });
    tab.controller.trackDownloads(this.downloads, tab.id);
    this.bindDialogs(tab.id, tab.controller.dialogs, tab.agentRuntime);
    tab.controller.onPopupCreated = (popup, opener) => this.adoptPopup(tab, popup, opener);
    tab.controller.onPopupClosed = (popup) => this.removePopup(popup);
    tab.controller.onMainFrameNavigationStart = () => tab.agentRuntime.invalidateDocument();
    tab.controller.onCursorChange = () => {
      if (tab.id === this.activeId) this.host.onCursorChanged();
    };
    tab.controller.onOpenTab = (openUrl, activateNew) => {
      this.create(openUrl, activateNew);
      this.host.onTabOpened(tab.controller, openUrl);
    };
    tab.controller.onPopupChange = () => { this.contextChanged(); this.host.requestRender(); };
    tab.controller.onClosed = () => this.host.onTabClosed(tab.id);
    tab.controller.onDevtoolsChange = () => {
      if (tab.id === this.activeId) this.host.onDevtoolsChanged();
      else this.host.requestRender();
    };
    tab.controller.onDevtoolsAction = (action) => {
      if (tab.id === this.activeId) this.host.onDevtoolsAction(action);
    };
    tab.controller.onContextMenu = (params) => {
      if (tab.id === this.activeId) this.host.onPageMenu(params);
    };
    tab.targetId = null;
    void tab.controller.targetId().then((targetId) => {
      tab.targetId = targetId;
      this.host.onTabsChanged();
    });
  }

  activate(id: number): boolean {
    const tab = this.tabs.find((t) => t.id === id);
    if (!tab || this.pendingDialog || (id !== this.activeId && !this.host.tabSwitchAllowed())) return false;
    if (this.activeId !== id) {
      const previous = this.tabs.find((t) => t.id === this.activeId);
      previous?.controller.setVisible(false);
    }
    if (this.activeContextId !== id) {
      this.context(this.activeContextId)?.agentRuntime.invalidateControl();
      tab.agentRuntime.invalidateControl();
    }
    this.activeId = id;
    this.activeContextId = id;
    tab.controller.selectPopup(null);
    tab.controller.setVisible(true);
    tab.controller.focusContent();
    this.contextChanged();
    this.host.onActivated();
    this.host.requestRender();
    return true;
  }

  async agentObserve(id: number, request: AgentObserveRequest): Promise<AgentActionOutcome<AgentObservation>> {
    const tab = this.context(id);
    if (!tab) throw new Error(`no context ${id}`);
    this.control.assertAgent();
    const dialog = this.pendingDialog;
    if (dialog) return { contextId: dialog.contextId, dialog, completed: false };
    if (!this.agentActivate(id)) throw new Error("cannot activate context");
    return { ...await tab.agentRuntime.observe(request), contextId: id };
  }

  agentActivate(id: number): boolean {
    const context = this.context(id);
    if (!context || this.control.state !== "agent" || !this.host.agentTabSwitchAllowed() || this.pendingDialog) return false;
    const popup = this.popups.get(id);
    if (!popup) return this.activate(id);
    if (this.activeContextId === id) return true;
    this.context(this.activeContextId)?.agentRuntime.invalidateControl();
    popup.agentRuntime.invalidateControl();
    if (this.activeId !== popup.rootId && !this.activate(popup.rootId)) return false;
    this.activeContextId = id;
    this.activeController?.selectPopup(popup.controller);
    popup.controller.focus();
    this.contextChanged();
    return true;
  }

  async agentClick(id: number, request: AgentClickRequest): Promise<AgentActionOutcome<AgentClickResult>> {
    const tab = this.context(id);
    if (!tab) throw new Error(`no tab ${id}`);
    return this.mutate(id, request.expectedControlEpoch, async () => {
      if (!this.agentActivate(id)) {
        throw new Error("cannot activate a tab while terminal-browser is in a modal state");
      }
      try {
        return await tab.agentRuntime.click(request);
      } finally {
        tab.controller.releaseAgentInput();
      }
    });
  }

  async agentUpload(id: number, request: AgentUploadRequest): Promise<AgentActionOutcome<AgentClickResult>> {
    const tab = this.context(id);
    if (!tab) throw new Error(`no tab ${id}`);
    return this.mutate(id, request.expectedControlEpoch, async () => {
      if (!this.agentActivate(id)) {
        throw new Error("cannot activate a tab while terminal-browser is in a modal state");
      }
      try {
        return await tab.agentRuntime.upload(request, this.host.projectRoot ?? null);
      } finally {
        tab.controller.releaseAgentInput();
      }
    });
  }

  async agentHover(id: number, request: AgentHoverRequest): Promise<AgentActionOutcome<AgentHoverResult>> {
    const tab = this.context(id);
    if (!tab) throw new Error(`no tab ${id}`);
    return this.mutate(id, request.expectedControlEpoch, async () => {
      if (!this.agentActivate(id)) {
        throw new Error("cannot activate a tab while terminal-browser is in a modal state");
      }
      try {
        return await tab.agentRuntime.hover(request);
      } finally {
        tab.controller.releaseAgentInput();
      }
    });
  }

  async agentDrag(id: number, request: AgentDragRequest): Promise<AgentActionOutcome<AgentDragResult>> {
    const tab = this.context(id);
    if (!tab) throw new Error(`no tab ${id}`);
    return this.mutate(id, request.expectedControlEpoch, async () => {
      if (!this.agentActivate(id)) {
        throw new Error("cannot activate a tab while terminal-browser is in a modal state");
      }
      try {
        return await tab.agentRuntime.drag(request);
      } finally {
        tab.controller.releaseAgentInput();
      }
    });
  }

  async agentType(id: number, request: AgentTypeRequest): Promise<AgentActionOutcome<AgentTypeResult>> {
    const tab = this.context(id);
    if (!tab) throw new Error(`no tab ${id}`);
    return this.mutate(id, request.expectedControlEpoch, async () => {
      if (!this.agentActivate(id)) {
        throw new Error("cannot activate a tab while terminal-browser is in a modal state");
      }
      try {
        return await tab.agentRuntime.type(request);
      } finally {
        tab.controller.releaseAgentInput();
      }
    });
  }

  async agentPressKey(id: number, request: AgentPressKeyRequest): Promise<AgentActionOutcome<AgentPressKeyResult>> {
    const tab = this.context(id);
    if (!tab) throw new Error(`no tab ${id}`);
    return this.mutate(id, request.expectedControlEpoch, async () => {
      if (!this.agentActivate(id)) {
        throw new Error("cannot activate a tab while terminal-browser is in a modal state");
      }
      try {
        return await tab.agentRuntime.pressKey(request);
      } finally {
        tab.controller.releaseAgentInput();
      }
    });
  }

  async agentScroll(id: number, request: AgentScrollRequest): Promise<AgentActionOutcome<AgentScrollResult>> {
    const tab = this.context(id);
    if (!tab) throw new Error(`no tab ${id}`);
    return this.mutate(id, request.expectedControlEpoch, async () => {
      if (!this.agentActivate(id)) {
        throw new Error("cannot activate a tab while terminal-browser is in a modal state");
      }
      try {
        return await tab.agentRuntime.scroll(request);
      } finally {
        tab.controller.releaseAgentInput();
      }
    });
  }

  async agentNavigate(id: number, request: AgentNavigateRequest): Promise<AgentActionOutcome<AgentNavigateResult>> {
    const tab = this.context(id);
    if (!tab) throw new Error(`no tab ${id}`);
    return this.mutate(id, request.expectedControlEpoch, async () => {
      if (!this.agentActivate(id)) {
        throw new Error("cannot activate a tab while terminal-browser is in a modal state");
      }
      try {
        return await tab.agentRuntime.navigate(request);
      } finally {
        tab.controller.releaseAgentInput();
      }
    });
  }

  async agentGetUrl(id: number, request: AgentGetUrlRequest): Promise<AgentActionOutcome<AgentGetUrlResult>> {
    const tab = this.context(id);
    if (!tab) throw new Error(`no tab ${id}`);
    return this.mutate(id, request.expectedControlEpoch, async () => {
      if (!this.agentActivate(id)) {
        throw new Error("cannot activate a tab while terminal-browser is in a modal state");
      }
      try {
        return await tab.agentRuntime.getUrl(request);
      } finally {
        tab.controller.releaseAgentInput();
      }
    });
  }

  async agentWaitFor(id: number, request: AgentWaitForRequest): Promise<AgentActionOutcome<AgentWaitForResult>> {
    const tab = this.context(id);
    if (!tab) throw new Error(`no context ${id}`);
    this.control.assertAgent(request.expectedControlEpoch);
    if (this.pendingDialog) throw new Error("a browser dialog is pending");
    return this.interruptible(id, () => tab.agentRuntime.waitFor(request));
  }

  get pendingDialog(): BrowserDialog | null {
    for (const tab of this.tabs) if (tab.controller.dialogs.pending) return tab.controller.dialogs.pending;
    for (const popup of this.popups.values()) if (popup.controller.dialogs.pending) return popup.controller.dialogs.pending;
    return null;
  }

  async agentContext(action: "open" | "activate" | "close", id: number | undefined, url: string | undefined, epoch: number) {
    return this.mutate(id ?? this.activeContextId, epoch, async () => {
      if (action === "open") this.create(url ?? this.fallbackUrl);
      else {
        if (!id || !this.has(id)) throw new Error(`no context ${id}`);
        if (action === "activate" && !this.agentActivate(id)) throw new Error("cannot activate context");
        if (action === "close") this.close(id);
      }
      return { tabs: this.registryView() };
    });
  }

  async respondDialog(id: number, request: DialogResponse) {
    const context = this.context(id);
    if (!context) throw new Error(`no context ${id}`);
    await context.controller.dialogs.respond(request);
    return { contextId: id, completed: true };
  }

  async answerHumanDialog(id: string, accept: boolean, text?: string) {
    const dialog = this.pendingDialog;
    if (!dialog || dialog.id !== id) throw new Error("stale or unknown dialog");
    await this.context(dialog.contextId)!.controller.dialogs.answer(id, accept, text);
  }

  async waitContexts(afterId: number, timeoutMs: number, expectedEpoch: number) {
    this.control.assertAgent(expectedEpoch);
    return new Promise<{ tabs: TabTarget[]; matched: boolean }>((resolve, reject) => {
      const finish = (matched: boolean, error?: unknown) => {
        clearTimeout(timer);
        this.contextListeners.delete(check);
        unsubscribe();
        if (error) reject(error);
        else resolve({ tabs: this.registryView(), matched });
      };
      const check = () => {
        try {
          this.control.assertAgent(expectedEpoch);
          if (this.registryView().some(tab => tab.id > afterId)) finish(true);
        } catch (error) { finish(false, error); }
      };
      const timer = setTimeout(() => finish(false), timeoutMs);
      const unsubscribe = this.control.subscribe(check);
      this.contextListeners.add(check);
      check();
    });
  }

  private context(id: number): { id: number; controller: AgentBrowserTarget & { dialogs: BrowserDialogs }; agentRuntime: BrowserAgentRuntime } | undefined {
    return this.tabs.find(tab => tab.id === id) ?? this.popups.get(id);
  }

  private bindDialogs(id: number, dialogs: BrowserDialogs, runtime: BrowserAgentRuntime) {
    dialogs.configure(id, this.control);
    dialogs.subscribe(() => {
      if (dialogs.pending) runtime.invalidateControl();
      this.contextChanged();
      this.host.requestRender();
    });
  }

  private adoptPopup(root: Tab, controller: PopupWindow, openerContentsId: number) {
    const id = this.seq++;
    const openerId = [...this.popups.values()].find(popup => popup.controller.contentsId === openerContentsId)?.id ?? root.id;
    const agentRuntime = new BrowserAgentRuntime(controller, {
      control: this.control, personaProvider: this.personaProvider,
      onActivityChange: () => this.host.requestAgentRender(),
    });
    this.popups.set(id, { id, openerId, rootId: root.id, controller, agentRuntime });
    controller.onMainFrameNavigationStart = () => agentRuntime.invalidateDocument();
    controller.trackDownloads(this.downloads, id);
    this.bindDialogs(id, controller.dialogs, agentRuntime);
    this.context(this.activeContextId)?.agentRuntime.invalidateControl();
    if (this.activeId !== root.id) this.activeController?.setVisible(false);
    this.activeContextId = id;
    this.activeId = root.id;
    root.controller.setVisible(true);
    root.controller.selectPopup(controller);
    this.contextChanged();
    this.host.onTabsChanged();
  }

  private removePopup(controller: PopupWindow) {
    const popup = [...this.popups.values()].find(item => item.controller === controller);
    if (!popup) return;
    popup.agentRuntime.invalidateControl();
    this.downloads.interruptContext(popup.id);
    this.popups.delete(popup.id);
    if (this.activeContextId === popup.id) {
      this.activeContextId = popup.rootId;
      this.context(popup.rootId)?.agentRuntime.invalidateControl();
    }
    this.contextChanged();
    this.host.onTabsChanged();
  }

  private contextChanged() { for (const listener of this.contextListeners) listener(); }

  private mutate<T>(id: number, epoch: number, operation: () => Promise<T>): Promise<AgentActionOutcome<T>> {
    if (this.pendingDialog) return Promise.reject(new Error("a browser dialog is pending"));
    return this.interruptible(id, () => this.control.runMutation(epoch, () => {
      if (this.pendingDialog) throw new Error("a browser dialog is pending");
      return operation();
    }));
  }

  private async interruptible<T>(id: number, operation: () => Promise<T>): Promise<AgentActionOutcome<T>> {
    let listener: () => void = () => {};
    const dialog = new Promise<AgentActionOutcome<T>>(resolve => {
      listener = () => {
        const pending = this.pendingDialog;
        if (pending) resolve({ contextId: id, dialog: pending, completed: false });
        else if (this.activeContextId !== id && this.popups.has(this.activeContextId)) resolve({ contextId: id, openedContextId: this.activeContextId, completed: false });
      };
      this.contextListeners.add(listener);
    });
    try { return await Promise.race([operation(), dialog]); }
    finally { this.contextListeners.delete(listener); }
  }

  close(id: number) {
    if (this.pendingDialog) throw new Error("a browser dialog is pending");
    const popup = this.popups.get(id);
    if (popup) { popup.controller.close(); return; }
    const tab = this.tabs.find(item => item.id === id);
    tab?.controller.requestClose();
  }

  removeClosed(id: number) {
    const at = this.tabs.findIndex((t) => t.id === id);
    if (at < 0) return;
    const [closed] = this.tabs.splice(at, 1);
    this.downloads.interruptContext(id);
    closed.agentRuntime.invalidateControl();
    closed.controller.stop();
    if (this.activeId === id) {
      const fallback = this.tabs[Math.min(at, this.tabs.length - 1)];
      if (fallback) this.activate(fallback.id);
      else this.create(this.fallbackUrl);
    }
    this.host.onTabsChanged();
    this.host.requestRender();
  }

  has(id: number): boolean {
    return !!this.context(id);
  }

  touchAgentControl(id: number): boolean {
    const tab = this.tabs.find((t) => t.id === id);
    if (!tab) return false;
    const fresh = tab.agentControlAt == null;
    tab.agentControlAt = Date.now();
    this.startAgentSweep();
    if (fresh) {
      this.host.onTabsChanged();
      this.host.requestRender();
    }
    return true;
  }

  releaseAgentControl() {
    this.invalidateAgentControl();
    this.stopAgentSweep();
    let changed = false;
    for (const tab of this.tabs) {
      if (tab.agentControlAt == null) continue;
      tab.agentControlAt = null;
      changed = true;
    }
    if (!changed) return;
    this.host.onTabsChanged();
    this.host.requestRender();
  }

  private startAgentSweep() {
    if (this.agentSweep) return;
    this.agentSweep = setInterval(() => {
      const cutoff = Date.now() - AGENT_CONTROL_TTL_MS;
      let changed = false;
      let remaining = false;
      for (const tab of this.tabs) {
        if (tab.agentControlAt == null) continue;
        if (tab.agentControlAt < cutoff) {
          tab.agentControlAt = null;
          changed = true;
        } else {
          remaining = true;
        }
      }
      if (!remaining) this.stopAgentSweep();
      if (changed) {
        this.host.onTabsChanged();
        this.host.requestRender();
      }
    }, AGENT_CONTROL_SWEEP_MS);
  }

  private stopAgentSweep() {
    if (!this.agentSweep) return;
    clearInterval(this.agentSweep);
    this.agentSweep = null;
  }

  soleAppTab(): boolean {
    return this.tabs.length === 1 && this.tabs[0].app != null;
  }

  findByContents(contentsId: number): Tab | null {
    return this.tabs.find((tab) => tab.controller.hasContents(contentsId)) ?? null;
  }

  stateFor(controller: BrowserController): BrowserState | null {
    return this.tabs.find((tab) => tab.controller === controller)?.state ?? null;
  }

  private label(tab: Tab): string {
    if (tab.app?.name) return tab.app.name;
    return tab.state.title || displayUrl(tab.state.url);
  }

  view(): TabRow[] {
    return this.tabs.map((tab) => ({
      id: tab.id,
      title: this.label(tab),
      favicon: tab.app ? null : tab.state.favicon,
      active: tab.id === this.activeId,
      app: tab.app != null,
      agentControlled: tab.agentControlAt != null,
    }));
  }

  registryView(): TabTarget[] {
    return [
      ...this.tabs.map(tab => ({
        id: tab.id, contextId: tab.id, openerId: null, kind: "tab" as const,
        url: tab.state.url.slice(0, 8192), title: tab.state.title.slice(0, 512),
        active: tab.id === this.activeContextId, targetId: tab.targetId,
        app: tab.app, agentControlled: tab.agentControlAt != null,
      })),
      ...[...this.popups.values()].map(popup => ({
        id: popup.id, contextId: popup.id, openerId: popup.openerId, kind: "popup" as const,
        url: popup.controller.state.url.slice(0, 8192), title: popup.controller.state.title.slice(0, 512),
        active: popup.id === this.activeContextId, targetId: null,
        agentControlled: this.control.state === "agent",
      })),
    ];
  }

  async targets(): Promise<TabTarget[]> { return this.registryView(); }

  eachController(fn: (controller: BrowserController) => void) {
    for (const tab of this.tabs) fn(tab.controller);
  }

  invalidateAgentControl() {
    for (const popup of this.popups.values()) {
      popup.controller.releaseAllInput();
      popup.agentRuntime.invalidateControl();
    }
    for (const tab of this.tabs) {
      tab.controller.releaseAllInput();
      tab.agentRuntime.invalidateControl();
    }
  }

  stopAll() {
    this.downloads.stop();
    this.stopAgentSweep();
    for (const tab of this.tabs) {
      tab.agentRuntime.invalidateControl();
      tab.controller.stop();
    }
    this.popups.clear();
    this.contextChanged();
    this.tabs = [];
    this.activeId = 0;
  }
}
