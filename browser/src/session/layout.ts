import type { EngineInfo } from "pixel-react";
import type { BrowserSurfaceLayout, DeviceSpec } from "../page/types";
import type { ChromeLayout, DeviceView } from "../ui/types";

export type DeviceMode = "desktop" | "phone" | "tablet";

export const DEVICES: Record<Exclude<DeviceMode, "desktop">, DeviceSpec> = {
  phone: {
    width: 393,
    height: 852,
    userAgent:
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
  },
  tablet: {
    width: 820,
    height: 1180,
    userAgent:
      "Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
  },
};

export function deviceSpec(mode: DeviceMode): DeviceSpec | null {
  return mode === "desktop" ? null : DEVICES[mode];
}

export interface SessionLayout {
  chrome: ChromeLayout;
  surface: BrowserSurfaceLayout;
  device: DeviceView | null;
}

export function computeLayout(
  info: EngineInfo,
  scale: number,
  mode: DeviceMode,
  hideToolbar: boolean,
): SessionLayout {
  const toolbarHeight = hideToolbar
    ? 0
    : Math.min(info.height - info.cellHeight, Math.round(info.basePx * 2.1));
  const pad = Math.round(info.basePx * 0.45);
  const padLeft = Math.round(info.basePx * 0.2);
  const padBottom = Math.round(info.basePx * 0.2);
  const chrome: ChromeLayout = {
    width: info.width,
    height: info.height,
    toolbarHeight,
    contentHeight: Math.max(1, info.height - toolbarHeight),
    page: {
      x: padLeft,
      y: toolbarHeight,
      width: Math.max(1, info.width - padLeft - pad),
      height: Math.max(1, info.height - toolbarHeight - padBottom),
    },
    rem: info.basePx,
  };
  if (mode === "desktop") {
    return {
      chrome,
      surface: {
        x: chrome.page.x,
        y: chrome.page.y,
        width: chrome.page.width,
        height: chrome.page.height,
        scale,
      },
      device: null,
    };
  }
  const spec = DEVICES[mode];
  const margin = info.basePx * 1.1;
  const availW = Math.max(40, info.width - margin * 2);
  const availH = Math.max(40, chrome.contentHeight - margin * 2);
  const bezel = mode === "phone" ? 0.035 : 0.05;
  const aspect = spec.width / spec.height;
  const screenW = Math.min(availW / (1 + 2 * bezel), availH / (1 / aspect + 2 * bezel));
  const screenH = screenW / aspect;
  const bezelPx = screenW * bezel;
  const frameW = screenW + 2 * bezelPx;
  const frameH = screenH + 2 * bezelPx;
  const frameX = (info.width - frameW) / 2;
  const frameY = toolbarHeight + (chrome.contentHeight - frameH) / 2;
  const screen = { x: frameX + bezelPx, y: frameY + bezelPx, w: screenW, h: screenH };
  const s = screenW / spec.width;
  return {
    chrome,
    surface: {
      x: screen.x,
      y: screen.y,
      width: screenW,
      height: screenH,
      scale: s,
    },
    device: {
      mode,
      frame: {
        x: frameX,
        y: frameY,
        w: frameW,
        h: frameH,
        radius: mode === "phone" ? screenW * 0.16 : screenW * 0.06,
      },
      screen,
      island:
        mode === "phone"
          ? {
              x: screen.x + (screenW - 125 * s) / 2,
              y: screen.y + 11 * s,
              w: 125 * s,
              h: 37 * s,
            }
          : null,
    },
  };
}
