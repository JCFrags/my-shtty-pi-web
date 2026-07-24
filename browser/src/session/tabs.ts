import type { BrowserController } from "../page/controller";
import type { DevtoolsAction } from "../page/devtools";
import { initialBrowserState } from "../page/types";
import type { BrowserState, DeviceSpec } from "../page/types";
import type { TabRow } from "../ui/types";

export interface Tab {
  readonly id: number;
  state: BrowserState;
  controller: BrowserController;
}


export interface TabHost {
  createController(
    url: string,
    visible: boolean,
    onState: (state: BrowserState) => void,
  ): BrowserController;
  deviceSpec(): DeviceSpec | null;
  onActivated(): void;
  onActiveState(state: BrowserState, urlChanged: boolean): void;
  onCursorChanged(): void;
  onDevtoolsChanged(): void;
  onDevtoolsAction(action: DevtoolsAction): void;
  onPageMenu(params: Electron.ContextMenuParams): void;
  requestRender(): void;
}

export class TabManager {
  private tabs: Tab[] = [];
  private activeId = 0;
  private seq = 1;

  constructor(
    private readonly host: TabHost,
    private readonly fallbackUrl: string,
  ) {

  }

  get active(): Tab | null {
    return this.tabs.find((tab) => tab.id === this.activeId) ?? null;
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

  
  create(url: string, activate = true): Tab {
    const tab = { id: this.seq++, state: initialBrowserState(url) } as Tab;
    tab.controller = this.host.createController(url, activate, (state) => {
      const urlChanged = state.url !== tab.state.url;
      tab.state = state;
      if (tab.id === this.activeId) this.host.onActiveState(state, urlChanged);
      this.host.requestRender();
    });
    tab.controller.onCursorChange = () => {
      if (tab.id === this.activeId) this.host.onCursorChanged();
    };
    tab.controller.onOpenTab = (openUrl, activateNew) => {
      this.create(openUrl, activateNew);
    };
    tab.controller.onPopupChange = () => this.host.requestRender();
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
    this.tabs.push(tab);
    if (activate) this.activate(tab.id);
    return tab;
  }

  activate(id: number) {
    const tab = this.tabs.find((t) => t.id === id);
    if (!tab) return;
    if (this.activeId !== id) {
      const previous = this.tabs.find((t) => t.id === this.activeId);
      previous?.controller.setVisible(false);
    }
    this.activeId = id;
    tab.controller.setDevice(this.host.deviceSpec());
    tab.controller.setVisible(true);
    tab.controller.focusContent();
    this.host.onActivated();
    this.host.requestRender();
  }

  close(id: number) {
    const at = this.tabs.findIndex((t) => t.id === id);
    if (at < 0) return;
    const [closed] = this.tabs.splice(at, 1);
    closed.controller.stop();
    if (this.activeId === id) {
      const fallback = this.tabs[Math.min(at, this.tabs.length - 1)];
      if (fallback) this.activate(fallback.id);
      else this.create(this.fallbackUrl);
    }
    this.host.requestRender();
  }

  view(): TabRow[] {
    return this.tabs.map((tab) => ({
      id: tab.id,
      title: tab.state.title || tab.state.url.replace(/^https?:\/\//, ""),
      favicon: tab.state.favicon,
      active: tab.id === this.activeId,
      loading: tab.state.loading,
    }));
  }

  registryView() {
    return this.tabs.map((tab) => ({
      id: tab.id,
      url: tab.state.url,
      title: tab.state.title,
      active: tab.id === this.activeId,
    }));
  }

  eachController(fn: (controller: BrowserController) => void) {
    for (const tab of this.tabs) fn(tab.controller);
  }

  stopAll() {
    for (const tab of this.tabs) tab.controller.stop();
    this.tabs = [];
    this.activeId = 0;
  }
}
