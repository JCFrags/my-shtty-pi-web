import { BrowserUploads } from "../agent/uploads";
import { registerDownloadSource, type BrowserDownloads } from "../agent/downloads";
import { nativeImage } from "electron";
import { BrowserDialogs } from "../agent/dialogs";
import type { AgentBrowserTarget } from "../agent/types";
import type { AgentKey } from "../agent/key";
import type { ProgrammaticPointerEvent } from "./input";
import { normalizeUrl } from "../url";
import type { BrowserWindow } from "electron";
import type { Surface } from "pixel-react";
import { cursorShapeFor } from "./cursor";
import { PageInput } from "./input";
import { scaleZoom, stepZoom } from "./zoom";
import type { ZoomDirection } from "./zoom";

export interface PopupState {
  url: string;
  title: string;
  loading: boolean;
  width: number;
  height: number;
}

export class PopupWindow implements AgentBrowserTarget {
  readonly dialogs: BrowserDialogs;
  readonly uploads: BrowserUploads;
  onMainFrameNavigationStart: (() => void) | null = null;
  readonly input: PageInput;
  cursorShape = "default";
  onCursorChange: (() => void) | null = null;
  private readonly window: BrowserWindow;
  private readonly surface: Surface;
  private readonly onChange: () => void;
  private readonly renderScale: number;
  private stateValue: PopupState;
  private visible = true;
  private focused = false;
  private cdpAttached = false;
  private destroyed = false;

  constructor(
    window: BrowserWindow,
    surface: Surface,
    size: { width: number; height: number },
    renderScale: number,
    scale: () => number,
    onChange: () => void,
    onClosed: () => void,
    openWindow?: (details: Electron.HandlerDetails) => Electron.WindowOpenHandlerResponse,
  ) {
    this.window = window;
    this.dialogs = new BrowserDialogs(window.webContents, (method, params) => this.cdp(method, params));
    this.uploads = new BrowserUploads(this.window.webContents, (method, params) => this.cdp(method, params));
    this.surface = surface;
    this.onChange = onChange;
    this.renderScale = renderScale;
    this.stateValue = {
      url: window.webContents.getURL(),
      title: "",
      loading: true,
      width: size.width,
      height: size.height,
    };
    this.input = new PageInput({
      contents: () => this.window.webContents,
      scale,
      focus: () => this.focus(),
      cdp: (method, params) => this.cdp(method, params),
    });
    const contents = window.webContents;
    contents.on("page-title-updated", (_event, title) => this.update({ title }));
    contents.on("did-navigate", (_event, url) => this.update({ url }));
    contents.on("did-navigate-in-page", (_event, url, mainFrame) => {
      if (mainFrame) this.update({ url });
    });
    contents.on("did-start-navigation", (_event, _url, inPlace, mainFrame) => {
      if (mainFrame && !inPlace) this.onMainFrameNavigationStart?.();
    });
    contents.on("did-start-loading", () => this.update({ loading: true }));
    contents.on("did-stop-loading", () => this.update({ loading: false }));
    contents.on("cursor-changed", (_event, type) => {
      const shape = cursorShapeFor(type);
      if (shape === this.cursorShape) return;
      this.cursorShape = shape;
      this.onCursorChange?.();
    });
    contents.setWindowOpenHandler(
      openWindow ??
        (({ url }) => {
          void contents.loadURL(url);
          return { action: "deny" };
        }),
    );
    window.on("closed", () => {
      this.dialogs.dispose();
      this.destroyed = true;
      this.surface.clear();
      onClosed();
    });
    void this.dialogs.initialize().catch(() => {});
    contents.once("did-finish-load", () => { void this.startStreaming(size, renderScale).catch(() => {}); });
    this.focus();
  }

  get state(): PopupState {
    return this.stateValue;
  }

  close() {
    if (this.destroyed) return;
    this.releaseAgentInput();
    this.dialogs.runIntent({ type: "close" }, () => this.window.close(), () => this.window.close());
  }

  destroy() {
    if (this.destroyed) return;
    this.input.releaseAllInput();
    this.dialogs.dispose();
    this.window.destroy();
  }

  zoom(direction: ZoomDirection): number {
    return stepZoom(this.window.webContents, direction);
  }

  scaleZoom(ratio: number): number {
    return scaleZoom(this.window.webContents, ratio);
  }

  setVisible(visible: boolean) {
    if (this.visible === visible || this.destroyed) return;
    this.visible = visible;
    void this.cdp(visible ? "Page.startScreencast" : "Page.stopScreencast", {
      ...(visible ? this.screencastParams() : {}),
    }).catch(() => {});
  }

  private screencastParams() {
    return {
      format: "png" as const,
      everyNthFrame: 1,
      maxWidth: Math.ceil(this.stateValue.width * this.renderScale),
      maxHeight: Math.ceil(this.stateValue.height * this.renderScale),
    };
  }

  private async startStreaming(size: { width: number; height: number }, renderScale: number) {
    await this.attachCdp();
    this.window.webContents.debugger.on("message", (_event, method, params) => {
      if (method !== "Page.screencastFrame") return;
      const frame = params as { data: string; sessionId: number };
      void this.cdp("Page.screencastFrameAck", { sessionId: frame.sessionId }).catch(() => {});
      if (!this.visible || this.destroyed) return;
      const image = nativeImage.createFromBuffer(Buffer.from(frame.data, "base64"));
      if (image.isEmpty()) return;
      const dims = image.getSize();
      this.surface.present({ bgra: image.toBitmap(), width: dims.width, height: dims.height });
    });
    await this.cdp("Page.enable");
    await this.cdp("Emulation.setDeviceMetricsOverride", {
      width: size.width,
      height: size.height,
      deviceScaleFactor: renderScale,
      mobile: false,
    });
    await this.cdp("Page.startScreencast", this.screencastParams());
  }

  focus(): Promise<void> | undefined {
    if (this.focused || this.destroyed) return;
    this.focused = true;
    this.window.focus();
    this.window.webContents.focus();
    return this.cdp("Emulation.setFocusEmulationEnabled", { enabled: true }).then(
      () => undefined,
      () => undefined,
    );
  }

  private attachCdp() {
    if (this.cdpAttached) return;
    this.window.webContents.debugger.attach("1.3");
    this.cdpAttached = true;
  }

  private cdp(method: string, params?: Record<string, unknown>): Promise<unknown> {
    try {
      if (this.destroyed) throw new Error("popup is closed");
      this.attachCdp();
      return this.window.webContents.debugger.sendCommand(method, params);
    } catch (error) { return Promise.reject(error); }
  }

  trackDownloads(tracker: BrowserDownloads, contextId: number) { registerDownloadSource(this.window.webContents, tracker, contextId); }

  get contentsId(): number { return this.window.webContents.id; }
  runJs(source: string): Promise<unknown> { return this.window.webContents.executeJavaScript(source, true); }
  currentUrl(): string { return this.window.webContents.getURL(); }
  viewportSize() { return { width: this.state.width, height: this.state.height }; }
  agentPointer(event: ProgrammaticPointerEvent) {
    if (event.kind === "down" && event.button === "left") this.uploads.acceptChooserFromClick();
    this.input.programmaticPointer(event);
  }
  releaseAgentPointer() { this.input.releaseProgrammaticButtons(); }
  releaseAgentInput() { this.input.releaseProgrammaticInput(); }
  releaseAllInput() { this.input.releaseAllInput(); }
  agentKeyDown(key: AgentKey) { return this.input.programmaticKeyDown(key); }
  agentKeyChar(key: AgentKey) { return this.input.programmaticKeyChar(key); }
  agentKeyUp(key: AgentKey) { this.input.programmaticKeyUp(key); }
  agentSelectAll() { return this.input.selectAllProgrammatic(); }
  agentInsertText(text: string) { return this.input.insertTextProgrammatic(text); }
  agentWheel(x: number, y: number, dx: number, dy: number) { return this.input.programmaticWheel(x, y, dx, dy); }
  async agentNavigate(value: string) {
    const url = normalizeUrl(value);
    await this.dialogs.runIntent({ type: "navigate", url }, () => { void this.window.loadURL(url).catch(() => {}); }, () => this.window.loadURL(url));
    return this.currentUrl();
  }
  async capturePage(rect?: Electron.Rectangle) {
    let bounded: Electron.Rectangle | undefined;
    if (rect) {
      if (![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) || rect.width <= 0 || rect.height <= 0) throw new Error("invalid capture rectangle");
      const x = Math.max(0, Math.floor(rect.x));
      const y = Math.max(0, Math.floor(rect.y));
      const width = Math.min(this.state.width, Math.ceil(rect.x + rect.width)) - x;
      const height = Math.min(this.state.height, Math.ceil(rect.y + rect.height)) - y;
      if (width <= 0 || height <= 0) throw new Error("element is outside the current viewport");
      bounded = { x, y, width, height };
    }
    let image = await this.window.webContents.capturePage(bounded);
    const size = image.getSize();
    const scale = Math.min(1, 1600 / size.width, 1600 / size.height);
    if (scale < 1) image = image.resize({ width: Math.max(1, Math.floor(size.width * scale)), height: Math.max(1, Math.floor(size.height * scale)) });
    const png = image.toPNG();
    if (png.byteLength > 2 * 1024 * 1024) throw new Error("visual observation exceeds the safe image limit");
    return png;
  }
  async targetId(): Promise<string | null> {
    const result = await this.cdp("Target.getTargetInfo") as { targetInfo?: { targetId?: string } };
    return result.targetInfo?.targetId ?? null;
  }

  private update(change: Partial<PopupState>) {
    this.stateValue = { ...this.stateValue, ...change };
    this.onChange();
  }
}
