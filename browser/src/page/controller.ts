import { BrowserUploads } from "../agent/uploads";
import { registerDownloadSource, waitForDownloadStart, type BrowserDownloads } from "../agent/downloads";
import { BrowserWindow, screen } from "electron";
import { BrowserDialogs } from "../agent/dialogs";
import type {
  EngineKeyEvent,
  PastedImage,
  PointerEvent,
  Surface,
  WheelEvent,
} from "pixel-react";
import { normalizeUrl, urlHost } from "../url";
import { allowClipboardRead, persistentPartition } from "./browser-session";
import { cursorShapeFor } from "./cursor";
import { DevtoolsWindow } from "./devtools";
import type { DevtoolsAction } from "./devtools";
import type { DevtoolsDock } from "pixel-store";
import { FaviconCache } from "./favicon";
import { frameRate } from "./frame-rate";
import type { AgentKey } from "../agent/key";
import { PageInput } from "./input";
import type { ProgrammaticPointerEvent } from "./input";
import { offscreenPreferences } from "./offscreen";
import { BitmapPresenter, presentPaint, shmFrameOf } from "./paint";
import { PopupWindow } from "./popup";
import { cssSize, initialBrowserState } from "./types";
import type { BrowserState, BrowserSurfaceLayout } from "./types";
import { scaleZoom, stepZoom } from "./zoom";
import type { ZoomDirection } from "./zoom";

const MAX_CAPTURE_DIMENSION = 1_600;
const MAX_CAPTURE_BYTES = 2 * 1024 * 1024;

export interface ControllerOptions {
  cwd: string;
  background: string;
  visible: boolean;
  partition: string | null;
  tabsAsPopups: boolean;
  clipboardRead: boolean;
  sessionKey: string;
  appTabId: number | null;
}

export class BrowserController {
  readonly surface: Surface;
  readonly dialogs: BrowserDialogs;
  readonly uploads: BrowserUploads;
  onPopupCreated: ((popup: PopupWindow, openerContentsId: number) => void) | null = null;
  onPopupClosed: ((popup: PopupWindow) => void) | null = null;
  private readonly popupSurface: Surface;
  private readonly devtoolsSurface: Surface;
  private readonly window: BrowserWindow;
  private readonly onState: (state: BrowserState) => void;
  private renderScale: number;
  private layout: BrowserSurfaceLayout;
  private state: BrowserState;
  private stopped = false;
  private contentFocused = false;
  private readonly input: PageInput;
  private readonly partition: string | null;
  private readonly tabsAsPopups: boolean;
  private readonly clipboardRead: boolean;
  private readonly sessionKey: string;
  private readonly appTabId: number | null;
  private readonly cwd: string;
  private background: string;
  private pendingPopupSize: { width: number; height: number } | null = null;
  private findText = "";
  private readonly favicons = new FaviconCache();
  private faviconSeq = 0;
  private cdpAttached = false;
  private cachedTargetId: string | null = null;
  private emitHandlers = new Map<string, (data: unknown) => void>();
  private cdpEventHandlers = new Map<string, (params: unknown) => void>();
  private framePinned = false;
  private readonly onDisplayChange = () => {
    if (this.stopped) return;
    this.applyFrameRate();
  };
  private visible = true;
  private wholeSurfaceNext = true;
  private readonly bitmaps: BitmapPresenter;
  private lastFrameSize: { width: number; height: number } | null = null;
  onFrameSubmitted: (() => void) | null = null;
  cursorShape = "default";
  onCursorChange: ((shape: string) => void) | null = null;
  onOpenTab: ((url: string, activate: boolean) => void) | null = null;
  private readonly popups: PopupWindow[] = [];
  onPopupChange: (() => void) | null = null;
  private selectedPopup: PopupWindow | null = null;
  get popup(): PopupWindow | null { return this.selectedPopup; }
  devtools: DevtoolsWindow | null = null;
  devtoolsFocused = false;
  onDevtoolsChange: (() => void) | null = null;
  onDevtoolsAction: ((action: DevtoolsAction) => void) | null = null;
  onContextMenu: ((params: Electron.ContextMenuParams) => void) | null = null;
  onClosed: (() => void) | null = null;
  onMainFrameNavigationStart: (() => void) | null = null;

  constructor(
    surface: Surface,
    popupSurface: Surface,
    devtoolsSurface: Surface,
    layout: BrowserSurfaceLayout,
    initialUrl: string,
    options: ControllerOptions,
    onState: (state: BrowserState) => void,
  ) {
    this.partition = options.partition ? persistentPartition(options.partition) : null;
    this.tabsAsPopups = options.tabsAsPopups;
    this.clipboardRead = options.clipboardRead;
    this.sessionKey = options.sessionKey;
    this.appTabId = options.appTabId;
    this.cwd = options.cwd;
    this.surface = surface;
    this.bitmaps = new BitmapPresenter(surface);
    this.popupSurface = popupSurface;
    this.devtoolsSurface = devtoolsSurface;
    this.background = options.background;
    this.visible = options.visible;
    this.layout = layout;
    this.onState = onState;
    this.renderScale = browserRenderScale(layout);
    this.state = initialBrowserState(initialUrl);
    const size = this.contentSize(layout);
    this.window = new BrowserWindow({
      width: size.width,
      height: size.height,
      useContentSize: true,
      show: false,
      frame: false,
      paintWhenInitiallyHidden: true,
      acceptFirstMouse: true,
      skipTaskbar: true,
      fullscreenable: false,
      resizable: false,
      webPreferences: {
        ...(this.partition ? { partition: this.partition } : {}),
        offscreen: offscreenPreferences(this.renderScale),
        sandbox: true,
        nodeIntegration: false,
        // with sandbox true this is safe, we enable so a users preload script runs inside iframes/webviews
        nodeIntegrationInSubFrames: true,
        contextIsolation: true,
        disableDialogs: false,
        backgroundThrottling: false,
        additionalArguments: this.preloadArgv(),
      },
    });
    this.dialogs = new BrowserDialogs(this.window.webContents, (method, params) => this.cdp(method, params));
    this.uploads = new BrowserUploads(this.window.webContents, (method, params) => this.cdp(method, params));
    if (this.clipboardRead) allowClipboardRead(this.window.webContents);
    this.input = new PageInput({
      contents: () => this.window.webContents,
      scale: () => this.layout.scale,
      focus: () => this.focusContent(),
      cdp: async (method, params) => {
        await this.attachCdp();
        return this.cdp(method, params);
      },
    });
    this.window.webContents.setFrameRate(frameRate());
    this.window.on("closed", this.onWindowClosed);
    this.window.webContents.on("will-navigate", (event, url) => {
      if (this.quitLink(url)) event.preventDefault();
    });
    screen.on("display-added", this.onDisplayChange);
    screen.on("display-removed", this.onDisplayChange);
    screen.on("display-metrics-changed", this.onDisplayChange);
    this.window.webContents.on("paint", (event, dirtyRect, image) => {
      const shmFrame = shmFrameOf(event);
      const size = event.texture
        ? {
            width: event.texture.textureInfo.codedSize.width,
            height: event.texture.textureInfo.codedSize.height,
          }
        : shmFrame
          ? {
              width: shmFrame.frameInfo.contentRect.width,
              height: shmFrame.frameInfo.contentRect.height,
            }
          : image.getSize();
      const presented =
        event.texture || shmFrame
          ? presentPaint(
              this.surface,
              event.texture,
              shmFrame,
              image,
              dirtyRect,
              this.wholeSurfaceNext,
            )
          : this.bitmaps.push(image, dirtyRect, this.wholeSurfaceNext);
      if (!presented) return;
      this.wholeSurfaceNext = false;
      this.lastFrameSize = size;
      this.onFrameSubmitted?.();
    });
    this.window.webContents.on(
      "did-start-navigation",
      (_event, _url, isInPlace, isMainFrame) => {
        if (!isMainFrame || isInPlace) return;
        this.onMainFrameNavigationStart?.();
        this.updateState({ loading: true });
      },
    );
    this.window.webContents.on("did-stop-loading", () => this.updateNavigation(false));
    this.window.webContents.on("did-navigate", (_event, url) => {
      if (urlHost(url) !== urlHost(this.state.url)) this.updateState({ favicon: null });
      this.updateNavigation(this.state.loading, url);
    });
    this.window.webContents.on("page-favicon-updated", (_event, favicons) => {
      void this.loadFavicon(favicons);
    });
    this.window.webContents.on("did-navigate-in-page", (_event, url, mainFrame) => {
      if (!mainFrame) return;
      this.onMainFrameNavigationStart?.();
      this.updateNavigation(this.state.loading, url);
    });
    this.window.webContents.on("page-title-updated", (_event, title) => {
      this.updateState({ title });
    });
    this.window.webContents.on("cursor-changed", (_event, type) => {
      const shape = cursorShapeFor(type);
      if (shape === this.cursorShape) return;
      this.cursorShape = shape;
      this.onCursorChange?.(shape);
    });
    this.window.webContents.on("context-menu", (_event, params) => {
      this.onContextMenu?.(params);
    });
    this.window.webContents.on("found-in-page", (_event, result) => {
      this.updateState({
        findMatches: { active: result.activeMatchOrdinal, total: result.matches },
      });
    });
    this.window.webContents.setWindowOpenHandler((details) =>
      this.handleWindowOpen(details, this.window.webContents),
    );
    this.window.webContents.on("did-create-window", (child) => this.adoptPopup(child));
    void this.initialize(initialUrl).catch(() => this.updateState({ loading: false }));
    this.onState(this.state);
  }

  private async initialize(initialUrl: string) {
    await this.window.loadURL("about:blank");
    await this.attachCdp();
    await this.dialogs.initialize();
    if (!this.stopped) await this.window.loadURL(normalizeUrl(initialUrl, this.cwd));
  }

  selectPopup(popup: PopupWindow | null) {
    for (const child of this.popups) child.setVisible(child === popup);
    this.selectedPopup = popup;
    this.onPopupChange?.();
  }

  private acceptedDownloadStarts = 0;

  get downloadStartSequence(): number { return this.acceptedDownloadStarts; }

  waitForDownloadStart(sequence: number, signal: AbortSignal): Promise<boolean> {
    return waitForDownloadStart(this.window.webContents, () => this.acceptedDownloadStarts > sequence, signal);
  }

  trackDownloads(tracker: BrowserDownloads, contextId: number) {
    registerDownloadSource(this.window.webContents, tracker, contextId, () => { this.acceptedDownloadStarts += 1; });
  }

  get contentsId(): number { return this.window.webContents.id; }

  requestClose() {
    this.dialogs.runIntent({ type: "close" }, () => this.window.close(), () => this.window.close());
  }

  resize(layout: BrowserSurfaceLayout, options?: { keepFrame?: boolean }) {
    if (this.stopped) return;
    if (
      this.layout.x === layout.x &&
      this.layout.y === layout.y &&
      this.layout.width === layout.width &&
      this.layout.height === layout.height &&
      this.layout.scale === layout.scale
    ) {
      return;
    }
    this.layout = layout;
    this.renderScale = browserRenderScale(layout);
    // why keep frame?
    if (!options?.keepFrame) this.surface.clear();
    const size = this.contentSize(layout);
    this.window.setContentSize(size.width, size.height, false);
  }

  navigate(value: string) {
    void this.agentNavigate(value).catch(() => {});
  }

  async agentNavigate(value: string): Promise<string> {
    if (this.stopped) throw new Error("browser is stopped");
    const url = normalizeUrl(value, this.cwd);
    await this.dialogs.runIntent({ type: "navigate", url }, () => { void this.window.webContents.loadURL(url).catch(() => {}); }, () => this.window.webContents.loadURL(url));
    return this.currentUrl();
  }

  back() {
    if (this.window.webContents.navigationHistory.canGoBack()) {
      const history = this.window.webContents.navigationHistory;
      const index = history.getActiveIndex() - 1;
      this.dialogs.runIntent({ type: "history", url: history.getEntryAtIndex(index).url }, () => history.goToIndex(index), () => history.goToIndex(index));
    }
  }

  forward() {
    if (this.window.webContents.navigationHistory.canGoForward()) {
      const history = this.window.webContents.navigationHistory;
      const index = history.getActiveIndex() + 1;
      this.dialogs.runIntent({ type: "history", url: history.getEntryAtIndex(index).url }, () => history.goToIndex(index), () => history.goToIndex(index));
    }
  }

  reload() {
    if (this.state.loading) this.window.webContents.stop();
    else this.dialogs.runIntent({ type: "reload", url: this.currentUrl() }, () => this.window.webContents.reload(), () => this.window.webContents.reload());
  }

  zoom(direction: ZoomDirection): number {
    const factor = stepZoom(this.window.webContents, direction);
    this.updateState({ zoom: factor });
    return factor;
  }

  scaleZoom(ratio: number): number {
    const factor = scaleZoom(this.window.webContents, ratio);
    this.updateState({ zoom: factor });
    return factor;
  }

  osPid(): number {
    return this.window.webContents.getOSProcessId();
  }

  async fingerprint(): Promise<number | null> {
    if (this.stopped) return null;
    try {
      await this.attachCdp();
      const result = (await this.cdp("Runtime.evaluate", {
        expression: "performance.timeOrigin",
        returnByValue: true,
      })) as { result?: { value?: number } };
      return typeof result.result?.value === "number" ? result.result.value : null;
    } catch {
      return null;
    }
  }

  async targetId(): Promise<string | null> {
    if (this.cachedTargetId) return this.cachedTargetId;
    if (this.stopped) return null;
    try {
      await this.attachCdp();
      const info = (await this.cdp("Target.getTargetInfo")) as {
        targetInfo?: { targetId?: string };
      };
      this.cachedTargetId = info.targetInfo?.targetId ?? null;
    } catch {
      this.cachedTargetId = null;
    }
    return this.cachedTargetId;
  }

  async attachCdp(): Promise<void> {
    if (this.cdpAttached) return;
    this.window.webContents.debugger.attach("1.3");
    this.cdpAttached = true;
    this.window.webContents.debugger.on("message", (_event, method, params) => {
      this.cdpEventHandlers.get(method)?.(params);
      if (method !== "Runtime.bindingCalled") return;
      const call = params as { name: string; payload: string };
      if (call.name !== "__pixelEmit") return; // eh? 
      try {
        const message = JSON.parse(call.payload) as { channel: string; data: unknown }; // whats going on here
        this.emitHandlers.get(message.channel)?.(message.data);
      } catch {}
    });
    await this.cdp("Runtime.enable");
    await this.cdp("Runtime.addBinding", { name: "__pixelEmit" });
    await this.cdp("Page.enable");
    await this.emulateColorScheme();
  }

  async setBackground(background: string): Promise<void> {
    this.background = background;
    await this.emulateColorScheme();
  }

  private async emulateColorScheme(): Promise<void> {
    if (!this.cdpAttached) return;
    const n = parseInt(this.background.slice(1), 16);
    const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    const dark = 0.2126 * r + 0.7152 * g + 0.0722 * b < 128;
    await this.cdp("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-color-scheme", value: dark ? "dark" : "light" }],
    });
  }

  cdp(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>> {
    try {
      if (this.stopped) throw new Error("browser is stopped");
      return this.window.webContents.debugger.sendCommand(method, params) as Promise<Record<string, unknown>>;
    } catch (error) { return Promise.reject(error); }
  }

  onEmit(channel: string, handler: ((data: unknown) => void) | null) {
    if (handler) this.emitHandlers.set(channel, handler);
    else this.emitHandlers.delete(channel);
  }

  onCdpEvent(method: string, handler: ((params: unknown) => void) | null) {
    if (handler) this.cdpEventHandlers.set(method, handler);
    else this.cdpEventHandlers.delete(method);
  }

  pinFrameRate(pinned: boolean) {
    if (this.framePinned === pinned || this.stopped) return;
    this.framePinned = pinned;
    this.applyFrameRate();
  }

  private applyFrameRate() {
    this.window.webContents.setFrameRate(this.visible || this.framePinned ? frameRate() : 4);
  }

  runJs(source: string): Promise<unknown> {
    return this.window.webContents.executeJavaScript(source, true);
  }

  currentUrl(): string {
    return this.window.webContents.getURL();
  }

  async capturePage(rect?: { x: number; y: number; width: number; height: number }): Promise<Buffer> {
    if (this.stopped) throw new Error("browser is stopped");
    const viewport = this.viewportSize();
    const captureRect = rect ? boundedCaptureRect(rect, viewport) : undefined;
    let image = await this.window.webContents.capturePage(captureRect);
    let size = image.getSize();
    const initialScale = Math.min(1, MAX_CAPTURE_DIMENSION / size.width, MAX_CAPTURE_DIMENSION / size.height);
    if (initialScale < 1) {
      image = image.resize({
        width: Math.max(1, Math.floor(size.width * initialScale)),
        height: Math.max(1, Math.floor(size.height * initialScale)),
        quality: "best",
      });
      size = image.getSize();
    }
    let png = image.toPNG();
    while (png.byteLength > MAX_CAPTURE_BYTES && size.width > 1 && size.height > 1) {
      const scale = Math.max(0.5, Math.min(0.9, Math.sqrt(MAX_CAPTURE_BYTES / png.byteLength) * 0.9));
      image = image.resize({
        width: Math.max(1, Math.floor(size.width * scale)),
        height: Math.max(1, Math.floor(size.height * scale)),
        quality: "best",
      });
      size = image.getSize();
      png = image.toPNG();
    }
    if (png.byteLength > MAX_CAPTURE_BYTES) throw new Error("visual observation exceeds the safe image limit");
    return png;
  }

  viewportSize(): { width: number; height: number } {
    return this.contentSize(this.layout);
  }

  find(text: string) {
    this.findText = text;
    if (!text) {
      this.stopFind();
      return;
    }
    this.window.webContents.findInPage(text);
  }

  findNext(forward: boolean) {
    if (!this.findText) return;
    this.window.webContents.findInPage(this.findText, { forward, findNext: true });
  }

  stopFind() {
    this.findText = "";
    this.window.webContents.stopFindInPage("clearSelection");
    this.updateState({ findMatches: null });
  }

  focusContent(): Promise<void> | undefined {
    if (this.stopped) return;
    this.blurDevtools();
    if (this.contentFocused) return;
    this.window.focus();
    /**
     * web contents, oh
     */
    this.window.webContents.focus();
    this.contentFocused = true;
    return this.setFocusEmulation(true).catch(() => {});
  }

  openDevtools(layout: BrowserSurfaceLayout, dock: DevtoolsDock) {
    if (this.devtools) return;
    const devtools = new DevtoolsWindow(
      this.window.webContents,
      this.devtoolsSurface,
      layout,
      dock,
      this.background,
      this.renderScale,
      (action) => this.onDevtoolsAction?.(action),
      () => {
        if (this.devtools !== devtools) return;
        this.devtools = null;
        this.devtoolsFocused = false;
        this.onDevtoolsChange?.();
      },
    );
    devtools.onCursorChange = () => this.onCursorChange?.(devtools.cursorShape);
    devtools.setVisible(this.visible);
    this.devtools = devtools;
    this.onDevtoolsChange?.();
  }

  closeDevtools() {
    this.devtools?.close();
  }

  focusDevtools() {
    if (this.devtoolsFocused || !this.devtools) return;
    this.blurContent();
    this.devtoolsFocused = true;
    this.devtools.focus();
  }

  blurDevtools() {
    if (!this.devtoolsFocused) return;
    this.devtoolsFocused = false;
    this.devtools?.blur();
  }

  inspect(x: number, y: number) {
    this.window.webContents.inspectElement(Math.round(x), Math.round(y));
  }

  selectionText() {
    return this.input.selectionText();
  }

  blurContent() {
    if (!this.contentFocused) return;
    this.input.releasePhysicalInput();
    this.window.blurWebView();
    this.contentFocused = false;
    void this.setFocusEmulation(false).catch(() => {});
  }

  private async setFocusEmulation(enabled: boolean) {
    await this.attachCdp();
    await this.cdp("Emulation.setFocusEmulationEnabled", { enabled });
  }

  pointer(event: PointerEvent) {
    if (this.stopped) return;
    this.input.pointer(event);
  }

  agentPointer(event: ProgrammaticPointerEvent) {
    if (this.stopped) return;
    if (event.kind === "down" && event.button === "left") this.uploads.acceptChooserFromClick();
    this.input.programmaticPointer(event);
  }

  agentKeyDown(key: AgentKey): Promise<void> {
    if (this.stopped) return Promise.reject(new Error("browser is stopped"));
    return this.input.programmaticKeyDown(key);
  }

  agentKeyChar(key: AgentKey): Promise<void> {
    if (this.stopped) return Promise.resolve();
    return this.input.programmaticKeyChar(key);
  }

  agentKeyUp(key: AgentKey): void {
    if (this.stopped) return;
    this.input.programmaticKeyUp(key);
  }

  agentSelectAll(): Promise<void> {
    if (this.stopped) return Promise.reject(new Error("browser is stopped"));
    return this.input.selectAllProgrammatic();
  }

  agentInsertText(text: string): Promise<void> {
    if (this.stopped) return Promise.reject(new Error("browser is stopped"));
    return this.input.insertTextProgrammatic(text);
  }

  agentWheel(x: number, y: number, deltaX: number, deltaY: number): Promise<void> {
    if (this.stopped) return Promise.reject(new Error("browser is stopped"));
    return this.input.programmaticWheel(x, y, deltaX, deltaY);
  }

  releaseAgentInput() {
    if (this.stopped) return;
    this.input.releaseProgrammaticInput();
    for (const popup of this.popups) popup.input.releaseProgrammaticInput();
    this.devtools?.input.releaseProgrammaticInput();
  }

  releasePhysicalInput() {
    this.input.releasePhysicalInput();
    for (const popup of this.popups) popup.input.releasePhysicalInput();
    this.devtools?.input.releasePhysicalInput();
  }

  releaseAllInput() {
    this.input.releaseAllInput();
    for (const popup of this.popups) popup.input.releaseAllInput();
    this.devtools?.input.releaseAllInput();
  }

  releaseAgentPointer() {
    if (this.stopped) return;
    this.input.releaseProgrammaticButtons();
    for (const popup of this.popups) popup.input.releaseProgrammaticButtons();
    this.devtools?.input.releaseProgrammaticButtons();
  }

  wheel(event: WheelEvent) {
    if (this.stopped) return;
    this.input.wheel(event);
  }

  key(event: EngineKeyEvent) {
    if (this.stopped) return;
    this.input.key(event);
  }

  sendToPage(channel: string, payload: unknown): void {
    try {
      this.window.webContents.send(channel, payload);
    } catch {}
  }

  hasContents(id: number): boolean {
    return this.window.webContents.id === id;
  }

  paste(text: string) {
    this.input.paste(text);
  }

  pasteImage(image: PastedImage) {
    this.input.pasteImage(image);
  }

  setActive(active: boolean) {
    if (!active) {
      this.releasePhysicalInput();
      this.blurContent();
      this.input.releaseModifiers();
    }
  }

  stop() {
    if (this.stopped) return;
    this.releaseAllInput();
    this.stopped = true;
    this.teardown();
    this.window.destroy();
  }

  private teardown() {
    this.dialogs.dispose();
    for (const popup of [...this.popups]) popup.destroy();
    this.devtools?.close();
    screen.off("display-added", this.onDisplayChange);
    screen.off("display-removed", this.onDisplayChange);
    screen.off("display-metrics-changed", this.onDisplayChange);
    this.surface.close();
  }

  private readonly onWindowClosed = () => {
    if (this.stopped) return;
    this.releaseAllInput();
    this.stopped = true;
    this.teardown();
    this.onClosed?.();
  };

  setVisible(visible: boolean) {
    if (this.stopped) return;
    if (this.visible === visible) return;
    this.visible = visible;
    this.popup?.setVisible(visible);
    this.devtools?.setVisible(visible);
    this.applyFrameRate();
    if (visible) this.window.webContents.invalidate();
  }

  private preloadArgv(): string[] {
    const argv = [`--terminal-browser-session=${this.sessionKey}`];
    if (this.appTabId != null) argv.push(`--terminal-browser-app-tab=${this.appTabId}`);
    return argv;
  }

  private contentSize(layout: BrowserSurfaceLayout) {
    return cssSize(layout.width, layout.height, layout.scale);
  }

  frameSize(): { width: number; height: number } | null {
    return this.lastFrameSize;
  }

  invalidate(): void {
    if (this.stopped) return;
    this.wholeSurfaceNext = true;
    this.window.webContents.invalidate();
  }

  private async loadFavicon(urls: string[]) {
    const seq = ++this.faviconSeq;
    const file = await this.favicons
      .resolve(urls, this.window.webContents.session)
      .catch(() => null);
    if (file && seq === this.faviconSeq) this.updateState({ favicon: file });
  }

  private updateNavigation(loading: boolean, url = this.window.webContents.getURL()) {
    this.updateState({
      url,
      loading,
      canGoBack: this.window.webContents.navigationHistory.canGoBack(),
      canGoForward: this.window.webContents.navigationHistory.canGoForward(),
      zoom: this.window.webContents.getZoomFactor(),
    });
  }

  private updateState(update: Partial<BrowserState>) {
    this.state = { ...this.state, ...update };
    this.onState(this.state);
  }

  private quitLink(url: string): boolean {
    if (!url.startsWith("terminal-browser://quit")) return false;
    setImmediate(() => {
      if (!this.stopped) this.requestClose();
    });
    return true;
  }

  private handleWindowOpen(
    { url, disposition, features }: Electron.HandlerDetails,
    opener: Electron.WebContents,
  ): Electron.WindowOpenHandlerResponse {
    if (this.quitLink(url)) return { action: "deny" };
    const wantsTab = disposition === "foreground-tab" || disposition === "background-tab";
    if (disposition === "new-window" || wantsTab || disposition === "default") {
      const size = wantsTab ? this.tabPopupSize() : this.popupSize(features);
      this.pendingPopupSize = size;
      return {
        action: "allow",
        createWindow: (options) => {
          const child = new BrowserWindow(options);
          this.adoptPopup(child, opener.id);
          return child.webContents;
        },
        overrideBrowserWindowOptions: {
          width: size.width,
          height: size.height,
          useContentSize: true,
          show: false,
          frame: false,
          skipTaskbar: true,
          fullscreenable: false,
          resizable: false,
          webPreferences: {
            ...(this.partition ? { partition: this.partition } : {}),
            offscreen: { useSharedTexture: false, deviceScaleFactor: this.renderScale },
            sandbox: true,
            nodeIntegration: false,
            nodeIntegrationInSubFrames: true,
            contextIsolation: true,
            disableDialogs: false,
            backgroundThrottling: false,
            additionalArguments: this.preloadArgv(),
          },
        },
      };
    }
    void opener.loadURL(url);
    return { action: "deny" };
  }

  private adoptPopup(child: Electron.BrowserWindow, openerContentsId = this.window.webContents.id) {
    if (this.clipboardRead) allowClipboardRead(child.webContents);
    const size = this.pendingPopupSize ?? { width: 480, height: 360 };
    this.pendingPopupSize = null;
    const popup = new PopupWindow(
      child,
      this.popupSurface,
      size,
      this.renderScale,
      () => this.layout.scale,
      () => this.onPopupChange?.(),
      () => {
        const at = this.popups.indexOf(popup);
        if (at < 0) return;
        const wasTop = at === this.popups.length - 1;
        this.popups.splice(at, 1);
        if (this.selectedPopup === popup) this.selectedPopup = null;
        this.onPopupClosed?.(popup);
        if (wasTop && this.visible) this.popup?.setVisible(true);
        this.onPopupChange?.();
      },
      (details) => this.handleWindowOpen(details, child.webContents),
    );
    popup.onCursorChange = () => {
      if (this.popup === popup) this.onCursorChange?.(popup.cursorShape);
    };
    this.popup?.setVisible(false);
    this.popups.push(popup);
    this.selectedPopup = popup;
    this.onPopupCreated?.(popup, openerContentsId);
    this.onPopupChange?.();
  }

  private tabPopupSize(): { width: number; height: number } {
    const content = this.contentSize(this.layout);
    return {
      width: Math.max(280, Math.round(content.width * 0.9)),
      height: Math.max(280, Math.round(content.height * 0.9)),
    };
  }

  private popupSize(features: string): { width: number; height: number } {
    const requested = (name: string) => {
      const match = features.match(new RegExp(`${name}=(\\d+)`));
      return match ? Number(match[1]) : 0;
    };
    const content = this.contentSize(this.layout);
    const clamp = (value: number, fallback: number, max: number) =>
      Math.max(280, Math.min(value || fallback, max));
    return {
      width: clamp(requested("width"), Math.round(content.width * 0.62), Math.round(content.width * 0.85)),
      height: clamp(requested("height"), Math.round(content.height * 0.68), Math.round(content.height * 0.8)),
    };
  }
}

function boundedCaptureRect(
  rect: { x: number; y: number; width: number; height: number },
  viewport: { width: number; height: number },
): Electron.Rectangle {
  if (![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) || rect.width <= 0 || rect.height <= 0) {
    throw new Error("visual observation has an invalid element rectangle");
  }
  const left = Math.max(0, Math.floor(rect.x));
  const top = Math.max(0, Math.floor(rect.y));
  const right = Math.min(viewport.width, Math.ceil(rect.x + rect.width));
  const bottom = Math.min(viewport.height, Math.ceil(rect.y + rect.height));
  if (right <= left || bottom <= top) throw new Error("element is outside the current viewport");
  return { x: left, y: top, width: right - left, height: bottom - top };
}

function browserRenderScale(layout: BrowserSurfaceLayout) {
  const explicit = Number(process.env.TERMINAL_BROWSER_RENDER_SCALE);
  if (Number.isFinite(explicit) && explicit > 0) {
    return Math.max(0.5, Math.min(layout.scale, explicit));
  }
  const maxPixels = Number(process.env.TERMINAL_BROWSER_MAX_PIXELS ?? 0);
  if (!Number.isFinite(maxPixels) || maxPixels <= 0) return layout.scale;
  const cssPixels = layout.width * layout.height / (layout.scale * layout.scale);
  return Math.max(0.5, Math.min(layout.scale, Math.sqrt(maxPixels / cssPixels)));
}

