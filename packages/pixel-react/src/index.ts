import type { ReactNode } from "react";
import { ConcurrentRoot } from "react-reconciler/constants";

import { CONTAINER_ID, getBridge, reconciler } from "./hostConfig";
import type { EngineInfo } from "./native";

export { Box, Text, Input } from "./components";
export type { NodeHandle } from "./components";
export type {
  BoxProps,
  TextProps,
  InputProps,
  ClickEvent,
  ScrollEvent,
} from "./hostConfig";
export type { Color, Edges, ScrollbarStyle, Style } from "./styles";
export type { EngineInfo, Rgba } from "./native";

export interface KeyMods {
  shift: boolean;
  alt: boolean;
  ctrl: boolean;
  super: boolean;
}

export interface EngineKeyEvent {
  /** Single character, or "enter", "escape", "up", "backspace", ... */
  key: string;
  mods: KeyMods;
}

export interface RootOptions {
  /** Keys no focused input consumed. */
  onKey?: (event: EngineKeyEvent) => void;
  onRightClick?: (event: { x: number; y: number }) => void;
  /** Pasted text arriving while no input is focused. */
  onPaste?: (text: string) => void;
  /** The terminal is already restored when this fires; default exits. */
  onEngineExit?: (error: string | null) => void;
  /** The window changed; `root.info` is already updated. */
  onResize?: (size: { width: number; height: number; basePx: number }) => void;
}

export interface PixelRoot {
  info: EngineInfo;
  render(element: ReactNode): void;
  stop(): void;
}

interface EngineEventJson {
  type:
    | "click"
    | "rightClick"
    | "change"
    | "scroll"
    | "resize"
    | "key"
    | "paste"
    | "error"
    | "exit";
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
}

export function createRoot(options: RootOptions = {}): PixelRoot {
  const bridge = getBridge();
  const info = JSON.parse(bridge.engine.info()) as EngineInfo;
  const container = reconciler.createContainer(
    { id: CONTAINER_ID },
    ConcurrentRoot,
    null,
    false,
    null,
    "pixel",
    (error: unknown) => console.error(error),
    null
  );

  const dispatch = (event: EngineEventJson) => {
    switch (event.type) {
      case "click": {
        const props = bridge.propsById.get(event.node!);
        props?.onClick?.({ x: event.x!, y: event.y! });
        break;
      }
      case "change": {
        const props = bridge.propsById.get(event.node!);
        props?.onChange?.(event.text!);
        break;
      }
      case "scroll": {
        const props = bridge.propsById.get(event.node!);
        props?.onScroll?.({ offset: event.offset!, max: event.max! });
        break;
      }
      case "resize":
        info.width = event.width!;
        info.height = event.height!;
        info.basePx = event.basePx!;
        options.onResize?.({
          width: event.width!,
          height: event.height!,
          basePx: event.basePx!,
        });
        break;
      case "key":
        options.onKey?.({ key: event.key!, mods: event.mods! });
        break;
      case "rightClick":
        options.onRightClick?.({ x: event.x!, y: event.y! });
        break;
      case "paste":
        options.onPaste?.(event.text!);
        break;
      case "error":
        console.error(`pixel-react: ${event.message}`);
        break;
      case "exit":
        if (options.onEngineExit) {
          options.onEngineExit(event.error ?? null);
        } else {
          if (event.error) console.error(`pixel-react: engine exited: ${event.error}`);
          process.exit(event.error ? 1 : 0);
        }
        break;
    }
  };

  bridge.engine.start((err, json) => {
    if (err) return;
    dispatch(JSON.parse(json) as EngineEventJson);
  });

  // Node owns SIGWINCH; an empty op batch wakes the engine, whose pump
  // re-checks the window size on every wake.
  const forwardResize = () => bridge.engine.applyOps("[]");
  process.stdout.on("resize", forwardResize);

  const restore = () => bridge.engine.stop();
  process.on("exit", restore);

  return {
    info,
    render(element: ReactNode) {
      reconciler.updateContainer(element, container, null, null);
    },
    stop() {
      // A deferred unmount commit would send ops to a torn-down engine.
      reconciler.flushSync(() => {
        reconciler.updateContainer(null, container, null, null);
      });
      bridge.engine.stop();
      process.stdout.off("resize", forwardResize);
      process.off("exit", restore);
    },
  };
}
