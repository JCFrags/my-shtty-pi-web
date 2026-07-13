import { createElement, Profiler as ReactProfiler, type ReactNode } from "react";
import { ConcurrentRoot } from "react-reconciler/constants";

import {
  APP_VIEW,
  ChangeSource,
  Container,
  DEVTOOLS_VIEW,
  getBridge,
  MarkRef,
  reconciler,
} from "./host-config";
import type { EngineInfo } from "./native";
import { handleDevtoolsKey } from "./devtools/app";
import { installConsoleCapture } from "./devtools/console-capture";
import {
  closeDevtools,
  onEngineProfile,
  openDevtools,
  selectNode,
  toggleDevtools,
  unmountDevtools,
} from "./devtools/controller";
import { installFiberHook } from "./devtools/fiber-hook";
import {
  devtoolsStore,
  engineLogs,
  inspectorStore,
  layoutStore,
  LayoutRect,
  profilerStore,
  recordSpan,
} from "./devtools/stores";
import type { LogLevel } from "./devtools/store";

export { Box, Text, Input, Image } from "./components";
export type { NodeHandle } from "./components";
export type {
  BoxProps,
  TextProps,
  TextSpan,
  InputProps,
  MarkRef,
  PastedImage,
  CaretInfo,
  ChangeInfo,
  ChangeSource,
  ImageProps,
  ClickEvent,
  ScrollEvent,
  WheelEvent,
} from "./host-config";
export type { Color, Edges, InsetEdges, InsetValue, ScrollbarStyle, Style } from "./styles";
export type { DiffEmphasis, DiffRow, EngineInfo, HighlightSpan, Rgba } from "./native";
export { HIGHLIGHT_CAPTURES, diff, highlight } from "./native";
export { openDevtools, closeDevtools, toggleDevtools };

/**
 * 
 * i think this api exists to support capturing a click to focus the input, 
 * this is dumb we can abstract this with a more cannonical capture/bubble phase
 */
export function setKeyCapture(keys: string[]): void {
  const bridge = getBridge();
  bridge.push(APP_VIEW, { op: "setKeyCapture", keys });
  bridge.flush();
}

export interface KeyMods {
  shift: boolean;
  alt: boolean;
  ctrl: boolean;
  super: boolean;
}

export interface EngineKeyEvent {
  key: string;
  mods: KeyMods;
}

export interface RootOptions {
  onKey?: (event: EngineKeyEvent) => void;
  onRightClick?: (event: { x: number; y: number }) => void;
  onPaste?: (text: string) => void;
  onEngineExit?: (error: string | null) => void;
  onResize?: (size: { width: number; height: number; basePx: number }) => void;
  devtools?: boolean;
}

export interface PixelRoot {
  info: EngineInfo;
  render(element: ReactNode): void;
  registerFont(path: string): Promise<number>;
  stop(): void;
  openDevtools(): void;
  closeDevtools(): void;
}

/**
 * this looks like a really sus data type to me (probably should be a discriminated union over type?)
 */
interface EngineEventJson {
  type: string;
  atMs?: number;
  view?: number;
  node?: number;
  x?: number;
  y?: number;
  text?: string;
  key?: string;
  mods?: KeyMods;
  offset?: number;
  max?: number;
  width?: number;
  height?: number;
  basePx?: number;
  message?: string;
  error?: string | null;
  path?: string;
  id?: number;
  cursor?: number;
  caret?: { x: number; y: number; w: number; h: number };
  source?: string;
  font?: number;
  seq?: number;
  epochMs?: number;
  deltaX?: number;
  deltaY?: number;
  precise?: boolean;
  level?: string;
  target?: string;
  stats?: { frameMs: number; fps: number };
  nodes?: LayoutRect[];
  spans?: Array<{
    name: string;
    start: number;
    dur: number;
    depth: number;
    view: number;
    arg?: number | null;
  }>;
  counters?: Array<{ name: string; at: number; value: number }>;
  // input mark refs on change/submit; profiler marks on profile
  marks?: unknown[];
}

export function createRoot(options: RootOptions = {}): PixelRoot {
  const devtoolsEnabled = options.devtools !== false;
  if (devtoolsEnabled) {
    installConsoleCapture();
    installFiberHook();
  }
  const bridge = getBridge();
  const info = JSON.parse(bridge.engine.info()) as EngineInfo;
  const container: Container = { view: APP_VIEW, children: [] };
  bridge.containers[APP_VIEW] = container;
  const root = reconciler.createContainer(
    container,
    ConcurrentRoot,
    null,
    false,
    null,
    "pixel",
    (error: unknown) => {
      engineLogs.push("error", "react", String(error));
    },
    null
  );
  if (devtoolsEnabled) {
    reconciler.injectIntoDevTools({
      bundleType: 0,
      version: "18.3.1",
      rendererPackageName: "pixel-react",
    });
    bridge.onFlush = (sample) => {
      recordSpan({
        name: `ops flush (${sample.ops} ops)`,
        start: sample.start,
        dur: sample.dur,
        depth: 0,
        lane: "bridge",
        arg: sample.seq,
      });
    };
  }

  const fontIds = new Map<string, number>();
  const fontRequests = new Map<
    string,
    Array<{ resolve: (font: number) => void; reject: (error: Error) => void }>
  >();

  const dispatch = (event: EngineEventJson) => {
    const view = event.view ?? APP_VIEW;
    switch (event.type) {
      case "click": {
        const props = bridge.propsById[view]?.get(event.node!);
        props?.onClick?.({ x: event.x!, y: event.y! });
        break;
      }
      case "clickOutside": {
        const props = bridge.propsById[view]?.get(event.node!);
        props?.onClickOutside?.({ x: event.x!, y: event.y! });
        break;
      }
      case "change": {
        const props = bridge.propsById[view]?.get(event.node!);
        props?.onChange?.(event.text!, {
          cursor: event.cursor ?? 0,
          ...(event.caret ?? { x: 0, y: 0, w: 0, h: 0 }),
          source: (event.source as ChangeSource) ?? "edit",
          marks: (event.marks as MarkRef[] | undefined) ?? [],
        });
        break;
      }
      case "caret": {
        const props = bridge.propsById[view]?.get(event.node!);
        props?.onCaret?.({
          cursor: event.cursor ?? 0,
          ...(event.caret ?? { x: 0, y: 0, w: 0, h: 0 }),
        });
        break;
      }
      case "submit": {
        const props = bridge.propsById[view]?.get(event.node!);
        props?.onSubmit?.(event.text!, (event.marks as MarkRef[] | undefined) ?? []);
        break;
      }
      case "pasteImage": {
        const props = bridge.propsById[view]?.get(event.node!);
        props?.onPasteImage?.({
          path: event.path!,
          width: event.width!,
          height: event.height!,
        });
        break;
      }
      case "scroll": {
        const props = bridge.propsById[view]?.get(event.node!);
        props?.onScroll?.({ offset: event.offset!, max: event.max! });
        break;
      }
      case "hoverEnter": {
        const props = bridge.propsById[view]?.get(event.node!);
        props?.onMouseEnter?.();
        break;
      }
      case "hoverLeave": {
        const props = bridge.propsById[view]?.get(event.node!);
        props?.onMouseLeave?.();
        break;
      }
      case "wheel": {
        const props = bridge.propsById[view]?.get(event.node!);
        props?.onWheel?.({
          x: event.x!,
          y: event.y!,
          deltaX: event.deltaX ?? 0,
          deltaY: event.deltaY ?? 0,
          precise: !!event.precise,
        });
        break;
      }
      case "resize": {
        const size = {
          width: event.width!,
          height: event.height!,
          basePx: event.basePx!,
        };
        if (view === APP_VIEW) {
          info.width = size.width;
          info.height = size.height;
          info.basePx = size.basePx;
          options.onResize?.(size);
        } else {
          devtoolsStore.update((s) => ({ ...s, ...size }));
        }
        break;
      }
      case "key": {
        if (view === DEVTOOLS_VIEW) {
          handleDevtoolsKey(event.key!);
        } else {
          options.onKey?.({ key: event.key!, mods: event.mods! });
        }
        break;
      }
      case "rightClick":
        if (view === APP_VIEW) {
          options.onRightClick?.({ x: event.x!, y: event.y! });
        }
        break;
      case "paste":
        if (view === APP_VIEW) options.onPaste?.(event.text!);
        break;
      case "inspect":
        if (devtoolsEnabled && view === APP_VIEW && event.node != null) {
          openDevtools(event.node);
          selectNode(event.node, true);
        }
        break;
      case "log":
        engineLogs.push(
          (event.level as LogLevel) ?? "info",
          event.target ?? "engine",
          event.message ?? event.text ?? "",
          event.epochMs
        );
        break;
      case "layout": {
        const rects = new Map<number, LayoutRect>();
        for (const node of event.nodes ?? []) rects.set(node.id, node);
        layoutStore.set({
          rects,
          stats: event.stats ?? { frameMs: 0, fps: 0 },
          width: event.width ?? 0,
          height: event.height ?? 0,
          at: Date.now(),
        });
        break;
      }
      case "profile":
        onEngineProfile({
          epochMs: event.epochMs ?? 0,
          spans: event.spans ?? [],
          counters: event.counters ?? [],
          marks: (event.marks as Array<{
            name: string;
            label: string;
            start: number;
            dur: number;
            view: number;
          }> | undefined) ?? [],
        });
        break;
      case "error":
        engineLogs.push("error", "bridge", event.message ?? "unknown bridge error");
        break;
      case "fontRegistered": {
        const pending = fontRequests.get(event.path!) ?? [];
        fontRequests.delete(event.path!);
        if (event.font != null) {
          fontIds.set(event.path!, event.font);
          for (const p of pending) p.resolve(event.font);
        } else {
          const error = new Error(event.error ?? "font failed to load");
          for (const p of pending) p.reject(error);
        }
        break;
      }
      case "exit":
        if (options.onEngineExit) {
          options.onEngineExit(event.error ?? null);
        } else {
          if (event.error) {
            process.stderr.write(`pixel-react: engine exited: ${event.error}\n`);
          }
          process.exit(event.error ? 1 : 0);
        }
        break;
    }
  };

  bridge.engine.start((err, json) => {
    if (err) return;
    const event = JSON.parse(json) as EngineEventJson;
    dispatch(event);
    // Spans the whole engine-emit → handler-done window, so time an event
    // spends queued behind a busy node event loop is visible in the profile.
    if (event.atMs && event.type !== "profile" && profilerStore.get().recording) {
      const now = performance.timeOrigin + performance.now();
      recordSpan({
        name: `event ${event.type}`,
        start: event.atMs,
        dur: Math.max(now - event.atMs, 0.01),
        depth: 0,
        lane: "bridge",
      });
    }
  });

  if (!devtoolsEnabled || options.onRightClick) {
    bridge.push(APP_VIEW, { op: "setDefaultMenu", on: false });
    bridge.flush();
  }

  const forwardResize = () => bridge.engine.applyOps(JSON.stringify({ view: 0, ops: [] }));
  process.stdout.on("resize", forwardResize);

  const restore = () => bridge.engine.stop();
  process.on("exit", restore);

  const onAppRender = (
    _id: string,
    phase: "mount" | "update" | "nested-update",
    actualDuration: number,
    _baseDuration: number,
    startTime: number,
    commitTime: number
  ) => {
    recordSpan({
      name: `react ${phase}`,
      start: performance.timeOrigin + startTime,
      dur: Math.max(commitTime - startTime, actualDuration),
      depth: 0,
      lane: "react",
      self: actualDuration,
    });
  };

  return {
    info,
    render(element: ReactNode) {
      const wrapped = devtoolsEnabled
        ? createElement(ReactProfiler, { id: "pixel-app", onRender: onAppRender }, element)
        : element;
      reconciler.updateContainer(wrapped, root, null, null);
    },
    registerFont(path: string) {
      const known = fontIds.get(path);
      if (known != null) return Promise.resolve(known);
      return new Promise<number>((resolve, reject) => {
        const pending = fontRequests.get(path);
        if (pending) {
          pending.push({ resolve, reject });
          return;
        }
        fontRequests.set(path, [{ resolve, reject }]);
        bridge.push(APP_VIEW, { op: "registerFont", path });
        bridge.flush();
      });
    },
    stop() {
      reconciler.flushSync(() => {
        reconciler.updateContainer(null, root, null, null);
      });
      unmountDevtools();
      bridge.engine.stop();
      process.stdout.off("resize", forwardResize);
      process.off("exit", restore);
    },
    openDevtools() {
      openDevtools();
    },
    closeDevtools() {
      closeDevtools();
    },
  };
}

export { inspectorStore };
