import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { app, screen } from "electron";
import { createRoot } from "pixel-react";
import type { EngineKeyEvent, PixelRoot, Surface } from "pixel-react";
import { detectBackend } from "pixel-terminals";
import type { Backend } from "pixel-terminals";

import { BrowserController } from "../page/controller";
import { initialBrowserState } from "../page/types";
import type { BrowserState, BrowserSurfaceLayout } from "../page/types";
import { zoomDirection } from "../page/zoom";
import type { ZoomDirection } from "../page/zoom";
import { LAST_URL_FILE } from "../paths";
import { Registry } from "../registry";
import { Chrome } from "../ui/chrome";
import type { ChromeActions, ChromeLayout, DeviceView, PopupView } from "../ui/types";
import { searchOrUrl } from "../url";
import { bindingGlyphs, matchesBinding, parseKeyBinding } from "./keybindings";
import type { KeyBinding } from "./keybindings";
import { computeLayout, deviceSpec } from "./layout";
import type { DeviceMode } from "./layout";
import { fetchSuggestions } from "./suggest";
import { TabManager } from "./tabs";

export interface SessionContext {
  /** tty path to render on; undefined drives this process's own stdio */
  tty?: string;
  /** unique per pane: the pid for dedicated processes, pid-N for daemon sessions */
  key: string;
  argv: string[];
  env: NodeJS.ProcessEnv;
  cdpPort: number | null;
  onClose(code: number): void;
}

export interface SessionHandle {
  ready: Promise<void>;
  close(code?: number): void;
  nudgeResize(): void;
}

export function createSession(ctx: SessionContext): SessionHandle {
  const session = new Session(ctx);
  const ready = session.start().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    session.shutdown(1);
  });
  return {
    ready,
    close: (code = 0) => session.shutdown(code),
    nudgeResize: () => session.nudgeResize(),
  };
}

const DEFAULT_URL = "https://github.com/zenbu-labs";

const FONT_CANDIDATES = [
  path.join(os.homedir(), "Library/Fonts/JetBrainsMono-Regular.ttf"),
  "/Library/Fonts/JetBrainsMono-Regular.ttf",
];

interface NewTabState {
  query: string;
  suggestions: string[];
  /** -1 targets the typed query; 0.. target a suggestion */
  index: number;
  seq: number;
  timer: ReturnType<typeof setTimeout> | null;
}

/** One pane's worth of browser: the engine root rendering the chrome, the
 * tabs (each an offscreen chromium window), and the modal/overlay ui state.
 * The daemon runs many of these in one process, so everything lives on the
 * instance. */
class Session {
  private readonly ctx: SessionContext;
  private readonly backend: Backend | null;
  private readonly marker: string;
  private readonly hideToolbar: boolean;
  private readonly partition: string | null;
  private readonly paletteBinding: KeyBinding | null;
  private readonly findBinding: KeyBinding | null;
  private readonly tabs: TabManager;
  /** rendered until the first tab reports state */
  private readonly fallbackState: BrowserState;

  private root: PixelRoot | null = null;
  private pageSurface: Surface | null = null;
  private popupSurface: Surface | null = null;
  private registry: Registry | null = null;

  private layout: ChromeLayout | null = null;
  private surfaceLayout: BrowserSurfaceLayout | null = null;
  private deviceView: DeviceView | null = null;
  private deviceMode: DeviceMode = "desktop";
  private displayScale = 1;
  private fontId = 0;
  private windowBg = "#1e2026";

  private browserFocused = false;
  private shuttingDown = false;
  private pageHover = false;
  private sentCursor: string | null = null;

  private findOpen = false;
  private urlEditOpen = false;
  private closeConfirmOpen = false;
  private palette: { query: string; index: number } | null = null;
  private newTab: NewTabState | null = null;
  private zoomHud: number | null = null;
  private zoomHudTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(ctx: SessionContext) {
    this.ctx = ctx;
    this.backend = terminalBackend();
    this.marker = `pixel-browser:${ctx.key}`;
    this.hideToolbar = ctx.argv.includes("--no-toolbar");
    this.partition = flagValue(ctx.argv, "--partition");
    this.paletteBinding = parseKeyBinding(flagValue(ctx.argv, "--palette-key") ?? "super+p");
    this.findBinding = parseKeyBinding(flagValue(ctx.argv, "--find-key") ?? "super+shift+f");
    this.fallbackState = initialBrowserState(this.initialUrl());
    this.tabs = new TabManager(
      {
        createController: (url, visible, onState) =>
          new BrowserController(
            this.pageSurface!,
            this.popupSurface!,
            this.surfaceLayout!,
            url,
            this.windowBg,
            visible,
            this.partition,
            onState,
          ),
        deviceSpec: () => deviceSpec(this.deviceMode),
        onActivated: () => {
          this.browserFocused = true;
          this.syncCursor();
          this.registry?.update();
        },
        onActiveState: (state, urlChanged) => {
          if (urlChanged) rememberUrl(state.url);
          this.registry?.update();
        },
        onCursorChanged: () => this.syncCursor(),
        requestRender: () => this.render(),
      },
      DEFAULT_URL,
    );
  }

  async start(): Promise<void> {
    if (process.platform === "darwin") app.dock?.hide();
    if (!this.ctx.tty) process.stdout.write(`\x1b]2;${this.marker}\x07`);
    this.displayScale = this.hostDisplayScale();
    this.root = createRoot({
      tty: this.ctx.tty,
      keyEventTypes: true,
      devtools: false,
      onKey: (event) => this.handleKey(event),
      onPaste: (text) => {
        const browser = this.tabs.activeController;
        if (browser?.popup) browser.popup.input.paste(text);
        else if (this.browserFocused) browser?.paste(text);
      },
      onFocus: (focused) => this.tabs.activeController?.setActive(focused),
      onResize: () => {
        this.recalculateLayout();
        if (this.surfaceLayout) this.tabs.activeController?.resize(this.surfaceLayout);
        this.render();
      },
      onEngineExit: (error) => {
        if (error) process.stderr.write(`pixel browser engine: ${error}\n`);
        this.shutdown(error ? 1 : 0);
      },
    });
    if (!this.root.sharedTextures) {
      throw new Error("pixel-browser requires the patched Electron with shared texture support");
    }
    this.pageSurface = this.root.createSurface();
    this.popupSurface = this.root.createSurface();
    this.recalculateLayout();
    this.loadFont();
    this.root.setPointerShape("default");
    const themeBg = this.root.info.colors.background ?? [30, 32, 38, 255];
    this.windowBg = `#${themeBg.slice(0, 3).map((c) => c.toString(16).padStart(2, "0")).join("")}`;
    this.tabs.create(this.fallbackState.url);
    this.registry = new Registry({
      key: this.ctx.key,
      tty: this.ctx.tty ?? null,
      state: () => this.tabs.activeState ?? this.fallbackState,
      openTab: (url) => void this.tabs.create(url ?? DEFAULT_URL),
      viewport: () =>
        this.root ? { width: this.root.info.width, height: this.root.info.height } : null,
      tabs: () => this.tabs.registryView(),
    });
    this.registry.setCdpPort(this.ctx.cdpPort);
    this.render();
  }

  shutdown(code = 0) {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    try {
      this.root?.setPointerShape("text");
    } catch {}
    this.registry?.dispose();
    this.registry = null;
    this.tabs.stopAll();
    try {
      this.pageSurface?.close();
      this.popupSurface?.close();
    } catch {}
    this.root?.stop();
    this.ctx.onClose(code);
  }

  nudgeResize() {
    this.root?.nudgeResize();
  }

  private render() {
    if (!this.root || !this.layout || !this.pageSurface || !this.popupSurface) return;
    this.root.render(
      <Chrome
        state={this.tabs.activeState ?? this.fallbackState}
        actions={this.actions}
        layout={this.layout}
        colors={this.root.info.colors}
        font={this.fontId}
        findOpen={this.findOpen}
        device={this.deviceView}
        tabs={this.tabs.view()}
        newTab={
          this.newTab
            ? { suggestions: this.newTab.suggestions, index: this.newTab.index }
            : null
        }
        closeConfirm={this.closeConfirmOpen}
        urlEdit={this.urlEditOpen}
        popup={this.popupView()}
        zoomHud={this.zoomHud}
        palette={
          this.palette
            ? {
                index: Math.min(this.palette.index, Math.max(0, this.filteredPalette().length - 1)),
                items: this.filteredPalette().map(({ id, label, shortcut }) => ({
                  id,
                  label,
                  shortcut,
                })),
              }
            : null
        }
        pageSurface={this.pageSurface}
        popupSurface={this.popupSurface}
      />,
    );
  }

  private readonly actions: ChromeActions = {
    back: () => this.tabs.activeController?.back(),
    forward: () => this.tabs.activeController?.forward(),
    reload: () => this.tabs.activeController?.reload(),
    urlEdit: () => this.openUrlEdit(),
    urlEditCancel: () => this.closeUrlEdit(),
    urlSubmit: (text) => {
      this.closeUrlEdit();
      if (text.trim()) this.tabs.activeController?.navigate(searchOrUrl(text));
    },
    pointer: (event) => {
      this.browserFocused = true;
      this.tabs.activeController?.pointer(event);
    },
    wheel: (event) => {
      this.browserFocused = true;
      this.tabs.activeController?.wheel(event);
    },
    pageHover: (hovering) => {
      this.pageHover = hovering;
      this.syncCursor();
    },
    findChange: (text) => this.tabs.activeController?.find(text),
    findNext: (forward) => this.tabs.activeController?.findNext(forward),
    findClose: () => this.closeFind(),
    paletteQuery: (text) => {
      if (!this.palette) return;
      this.palette.query = text;
      this.palette.index = 0;
      this.render();
    },
    paletteRun: (index) => this.runPalette(index),
    paletteClose: () => this.closePalette(),
    tabSwitch: (id) => this.tabs.activate(id),
    tabClose: (id) => (this.tabs.count <= 1 ? this.openCloseConfirm() : this.tabs.close(id)),
    tabNew: () => this.openNewTabModal(),
    newTabQuery: (text) => this.newTabQuery(text),
    newTabSubmit: (text) => {
      this.closeNewTabModal();
      if (text.trim()) this.tabs.create(searchOrUrl(text));
    },
    newTabCancel: () => this.closeNewTabModal(),
    closeConfirmChoose: (closePane) => void this.resolveCloseConfirm(closePane),
    closeConfirmCancel: () => this.cancelCloseConfirm(),
    popupPointer: (event) => this.tabs.activeController?.popup?.input.pointer(event),
    popupWheel: (event) => this.tabs.activeController?.popup?.input.wheel(event),
    popupClose: () => this.tabs.activeController?.popup?.close(),
    zoomReset: () => this.applyZoom(0),
  };

  private handleKey(event: EngineKeyEvent) {
    const browser = this.tabs.activeController;
    if (browser?.popup) {
      if (event.kind !== "release" && event.key === "escape") {
        browser.popup.close();
        return;
      }
      if (event.kind !== "release" && event.mods.ctrl && event.key === "q") {
        this.shutdown();
        return;
      }
      if (event.kind !== "release" && event.mods.super) {
        const direction = zoomDirection(event.key);
        if (direction !== null) {
          this.applyZoom(direction);
          return;
        }
      }
      browser.popup.input.key(event);
      return;
    }
    if (event.kind !== "release") {
      if (event.mods.ctrl && event.key === "q") {
        this.shutdown();
        return;
      }
      if (this.palette) {
        const down = event.key === "down" || (event.mods.ctrl && event.key === "n");
        const up = event.key === "up" || (event.mods.ctrl && event.key === "p");
        if (event.key === "escape" || matchesBinding(event, this.paletteBinding)) {
          this.closePalette();
        } else if (down || up) {
          const count = this.filteredPalette().length;
          if (count > 0) {
            this.palette.index = (this.palette.index + (down ? 1 : -1) + count) % count;
            this.render();
          }
        } else if (event.key === "enter") this.runPalette();
        return;
      }
      if (this.closeConfirmOpen) {
        if (event.key === "escape") this.cancelCloseConfirm();
        else if (event.key === "y") void this.resolveCloseConfirm(true);
        else if (event.key === "n") void this.resolveCloseConfirm(false);
        return;
      }
      if (this.newTab) {
        const session = this.newTab;
        const down = event.key === "down" || (event.mods.ctrl && event.key === "n");
        const up = event.key === "up" || (event.mods.ctrl && event.key === "p");
        if (event.key === "escape") this.closeNewTabModal();
        else if (down || up) {
          const count = session.suggestions.length;
          if (count > 0) {
            session.index = down
              ? session.index >= count - 1
                ? -1
                : session.index + 1
              : session.index <= -1
                ? count - 1
                : session.index - 1;
            this.render();
          }
        } else if (event.key === "enter") {
          const text = session.index >= 0 ? session.suggestions[session.index] : session.query;
          this.actions.newTabSubmit(text);
        }
        return;
      }
      if (this.urlEditOpen) {
        if (event.key === "escape") this.closeUrlEdit();
        return;
      }
      if ((event.mods.super || event.mods.ctrl) && event.key === "t") {
        this.openNewTabModal();
        return;
      }
      if (matchesBinding(event, this.paletteBinding)) {
        this.openPalette();
        return;
      }
      if (event.mods.super && event.key === "l") {
        this.openUrlEdit();
        return;
      }
      if (matchesBinding(event, this.findBinding)) {
        this.openFind();
        return;
      }
      if (event.key === "escape" && this.findOpen) {
        this.closeFind();
        return;
      }
      if (event.key === "enter" && this.findOpen) {
        browser?.findNext(!event.mods.shift);
        return;
      }
      if (event.mods.super && event.key === "r") {
        browser?.reload();
        return;
      }
      if ((event.mods.super || event.mods.ctrl) && event.key === "[") {
        browser?.back();
        return;
      }
      if ((event.mods.super || event.mods.ctrl) && event.key === "]") {
        browser?.forward();
        return;
      }
      if (event.mods.super) {
        const direction = zoomDirection(event.key);
        if (direction !== null) {
          this.applyZoom(direction);
          return;
        }
      }
    }
    if (event.kind === "release") {
      browser?.key(event);
      return;
    }
    if (this.browserFocused) browser?.key(event);
  }

  private applyZoom(direction: ZoomDirection) {
    const browser = this.tabs.activeController;
    const factor = browser?.popup ? browser.popup.zoom(direction) : browser?.zoom(direction);
    if (factor == null) return;
    this.zoomHud = factor;
    if (this.zoomHudTimer) clearTimeout(this.zoomHudTimer);
    this.zoomHudTimer = setTimeout(() => {
      this.zoomHud = null;
      this.zoomHudTimer = null;
      this.render();
    }, 1500);
    this.render();
  }

  /** mirror the page's css cursor onto the terminal pointer while the mouse is
   * over the page surface; anywhere else in the chrome shows a plain arrow */
  private syncCursor() {
    const shape = this.pageHover
      ? (this.tabs.activeController?.cursorShape ?? "default")
      : "default";
    if (shape === this.sentCursor) return;
    this.sentCursor = shape;
    this.root?.setPointerShape(shape);
  }

  private blurToOverlay() {
    this.browserFocused = false;
    this.tabs.activeController?.blurContent();
  }

  private refocusPage() {
    this.browserFocused = true;
    this.tabs.activeController?.focusContent();
  }

  private openUrlEdit() {
    if (this.urlEditOpen) return;
    this.urlEditOpen = true;
    this.blurToOverlay();
    this.render();
  }

  private closeUrlEdit() {
    if (!this.urlEditOpen) return;
    this.urlEditOpen = false;
    this.refocusPage();
    this.render();
  }

  private openNewTabModal() {
    if (this.newTab) return;
    this.newTab = { query: "", suggestions: [], index: -1, seq: 0, timer: null };
    this.blurToOverlay();
    this.root?.setKeyCapture(["enter", "up", "down"]);
    this.render();
  }

  private closeNewTabModal() {
    if (!this.newTab) return;
    if (this.newTab.timer) clearTimeout(this.newTab.timer);
    this.newTab = null;
    this.root?.setKeyCapture(this.findOpen ? ["enter"] : []);
    this.refocusPage();
    this.render();
  }

  private newTabQuery(text: string) {
    const session = this.newTab;
    if (!session) return;
    session.query = text;
    session.index = -1;
    if (session.timer) clearTimeout(session.timer);
    session.timer = null;
    if (!text.trim()) {
      session.seq++;
      session.suggestions = [];
      this.render();
      return;
    }
    session.timer = setTimeout(() => this.requestSuggestions(text), 120);
    this.render();
  }

  private requestSuggestions(query: string) {
    const session = this.newTab;
    if (!session) return;
    const seq = ++session.seq;
    fetchSuggestions(query)
      .then((suggestions) => {
        if (this.newTab !== session || session.seq !== seq) return;
        session.suggestions = suggestions;
        if (session.index >= session.suggestions.length) session.index = -1;
        this.render();
      })
      .catch(() => {});
  }

  private openCloseConfirm() {
    if (this.closeConfirmOpen) return;
    this.closeConfirmOpen = true;
    this.blurToOverlay();
    this.render();
  }

  private cancelCloseConfirm() {
    if (!this.closeConfirmOpen) return;
    this.closeConfirmOpen = false;
    this.refocusPage();
    this.render();
  }

  private async resolveCloseConfirm(closePane: boolean) {
    this.closeConfirmOpen = false;
    if (closePane) await this.backend?.closePane?.(this.marker).catch(() => false);
    this.shutdown();
  }

  private openFind() {
    if (this.findOpen) return;
    this.findOpen = true;
    this.blurToOverlay();
    this.root?.setKeyCapture(["enter"]);
    this.render();
  }

  private closeFind() {
    if (!this.findOpen) return;
    this.findOpen = false;
    this.tabs.activeController?.stopFind();
    this.root?.setKeyCapture([]);
    this.refocusPage();
    this.render();
  }

  private openPalette() {
    if (this.palette) return;
    this.palette = { query: "", index: 0 };
    this.blurToOverlay();
    this.root?.setKeyCapture(["enter", "up", "down"]);
    this.render();
  }

  private closePalette() {
    if (!this.palette) return;
    this.palette = null;
    this.root?.setKeyCapture(this.findOpen ? ["enter"] : []);
    this.refocusPage();
    this.render();
  }

  private runPalette(index?: number) {
    const items = this.filteredPalette();
    const chosen = items[index ?? this.palette?.index ?? 0];
    this.closePalette();
    chosen?.run();
  }

  private paletteActions(): PaletteAction[] {
    return [
      {
        id: "url-edit",
        label: "edit url",
        shortcut: "⌘L",
        run: () => this.openUrlEdit(),
      },
      {
        id: "new-tab",
        label: "new tab",
        shortcut: "⌃T",
        run: () => this.openNewTabModal(),
      },
      {
        id: "find",
        label: "find in page",
        shortcut: `${bindingGlyphs(this.findBinding)}${(this.findBinding?.key ?? "").toUpperCase()}`,
        run: () => this.openFind(),
      },
      {
        id: "zoom-in",
        label: "zoom in",
        shortcut: "⌘+",
        run: () => this.applyZoom(1),
      },
      {
        id: "zoom-out",
        label: "zoom out",
        shortcut: "⌘−",
        run: () => this.applyZoom(-1),
      },
      {
        id: "zoom-reset",
        label: "reset zoom",
        shortcut: "⌘0",
        run: () => this.applyZoom(0),
      },
      {
        id: "device-phone",
        label: this.deviceMode === "phone" ? "exit mobile emulation" : "mobile emulation",
        shortcut: "",
        run: () => this.setDeviceMode(this.deviceMode === "phone" ? "desktop" : "phone"),
      },
      {
        id: "device-tablet",
        label: this.deviceMode === "tablet" ? "exit tablet emulation" : "tablet emulation",
        shortcut: "",
        run: () => this.setDeviceMode(this.deviceMode === "tablet" ? "desktop" : "tablet"),
      },
      ...(this.backend?.zoomPane
        ? [
            {
              id: "zoom-split",
              label: "full screen (zoom split)",
              shortcut: "⇧⌘↩",
              run: () => void this.backend!.zoomPane!(this.marker).catch(() => false),
            },
          ]
        : []),
      ...(this.backend?.closePane
        ? [
            {
              id: "close-pane",
              label: "close pane",
              shortcut: "",
              run: () => void this.resolveCloseConfirm(true),
            },
          ]
        : []),
    ];
  }

  private filteredPalette(): PaletteAction[] {
    if (!this.palette) return [];
    const query = this.palette.query.toLowerCase();
    return this.paletteActions().filter((action) => action.label.toLowerCase().includes(query));
  }

  private setDeviceMode(mode: DeviceMode) {
    if (mode === this.deviceMode) return;
    this.deviceMode = mode;
    this.recalculateLayout();
    const browser = this.tabs.activeController;
    browser?.setDevice(deviceSpec(mode));
    if (this.surfaceLayout) browser?.resize(this.surfaceLayout);
    this.render();
  }

  private recalculateLayout() {
    if (!this.root) return;
    const result = computeLayout(
      this.root.info,
      this.displayScale,
      this.deviceMode,
      this.hideToolbar,
    );
    this.layout = result.chrome;
    this.surfaceLayout = result.surface;
    this.deviceView = result.device;
  }

  private popupView(): PopupView | null {
    const popup = this.tabs.activeController?.popup;
    if (!popup || !this.layout || !this.surfaceLayout) return null;
    const scale = this.surfaceLayout.scale;
    const headerPx = Math.round(this.layout.rem * 1.7);
    const maxW = Math.round(this.layout.page.width * 0.94);
    const maxH = Math.round(this.layout.page.height * 0.94) - headerPx;
    let host = "";
    try {
      host = new URL(popup.state.url).host;
    } catch {}
    return {
      title: popup.state.title,
      host,
      loading: popup.state.loading,
      width: Math.max(60, Math.min(Math.round(popup.state.width * scale), maxW)),
      height: Math.max(60, Math.min(Math.round(popup.state.height * scale), maxH)),
    };
  }

  private loadFont() {
    const fontPath = FONT_CANDIDATES.find((candidate) => fs.existsSync(candidate));
    if (!fontPath || !this.root) return;
    this.root
      .registerFont(fontPath)
      .then((id) => {
        this.fontId = id;
        this.render();
      })
      .catch(() => {});
  }

  // Pane pixel sizes come from the host terminal, which native terminals
  // report in device pixels but web-based ones (e.g. localterm) report in CSS
  // pixels. The override lets those hosts force scale 1 so the page isn't
  // zoomed 2x.
  private hostDisplayScale() {
    const explicit = Number(this.ctx.env.PIXEL_BROWSER_DISPLAY_SCALE);
    if (Number.isFinite(explicit) && explicit > 0) return explicit;
    return screen.getPrimaryDisplay().scaleFactor;
  }

  private initialUrl(): string {
    const arg = this.ctx.argv.find((argument) => !argument.startsWith("-"));
    if (arg) return arg;
    try {
      const last = fs.readFileSync(LAST_URL_FILE, "utf8").trim();
      if (/^https?:\/\//.test(last)) return last;
    } catch {}
    return DEFAULT_URL;
  }
}

interface PaletteAction {
  id: string;
  label: string;
  shortcut: string;
  run(): void;
}

function flagValue(argv: string[], flag: string): string | null {
  return (
    argv.find((argument) => argument.startsWith(`${flag}=`))?.slice(flag.length + 1) ?? null
  );
}

function rememberUrl(url: string) {
  if (!/^https?:\/\//.test(url)) return;
  try {
    fs.writeFileSync(LAST_URL_FILE, url);
  } catch {}
}

function terminalBackend(): Backend | null {
  try {
    return detectBackend();
  } catch {
    return null;
  }
}
