import { cloneElement, createElement, Fragment, type ReactElement } from "react";
import { Box, Text, type Style } from "pixel-react";
import type { Point } from "agentcursor" with { "resolution-mode": "import" };
import type { BrowserSurfaceLayout } from "../page/types";
import type { AgentActivity } from "../agent/types";
import type { AgentControlSnapshot } from "../agent/control";
import { Icon } from "./icons";
import { usePulse } from "./pulse";
import type { Theme } from "./theme";
import { withAlpha } from "./theme";

export interface SurfacePoint {
  x: number;
  y: number;
}

export interface AgentOverlayGeometry {
  cursor: SurfacePoint | null;
  target: SurfacePoint | null;
}

export function mapAgentCssPoint(point: Point, layout: BrowserSurfaceLayout): SurfacePoint {
  return {
    x: Math.round(layout.x + point.x * layout.scale),
    y: Math.round(layout.y + point.y * layout.scale),
  };
}

export function agentOverlayEnabled(noOverlays: boolean): boolean {
  return !noOverlays;
}

export function clipAgentSurfacePoint(
  point: SurfacePoint,
  layout: BrowserSurfaceLayout,
): SurfacePoint {
  return {
    x: Math.max(layout.x, Math.min(layout.x + layout.width, point.x)),
    y: Math.max(layout.y, Math.min(layout.y + layout.height, point.y)),
  };
}

export function agentOverlayGeometry(
  activity: AgentActivity | null,
  layout: BrowserSurfaceLayout,
): AgentOverlayGeometry {
  return {
    cursor: activity?.cursor
      ? clipAgentSurfacePoint(mapAgentCssPoint(activity.cursor, layout), layout)
      : null,
    target: activity?.target
      ? clipAgentSurfacePoint(mapAgentCssPoint(activity.target, layout), layout)
      : null,
  };
}

function clipOverlayNode(node: ReactElement<{ style?: Style }> | null, layout: BrowserSurfaceLayout) {
  if (!node) return null;
  const style = node.props.style!;
  const x = Number(style.inset?.left);
  const y = Number(style.inset?.top);
  const width = Number(style.width);
  const height = Number(style.height);
  const left = Math.max(layout.x, x);
  const top = Math.max(layout.y, y);
  const right = Math.min(layout.x + layout.width, x + width);
  const bottom = Math.min(layout.y + layout.height, y + height);
  if (right <= left || bottom <= top) return null;
  if (left === x && top === y && right === x + width && bottom === y + height) return node;
  return createElement(Box, {
    style: {
      position: "absolute",
      inset: { left, top },
      width: right - left,
      height: bottom - top,
      overflow: "hidden",
    },
  }, cloneElement(node, { style: { ...style, inset: { left: x - left, top: y - top } } }));
}

export class AgentOverlayRenderCoalescer {
  private scheduled = false;
  private disposed = false;

  constructor(
    private readonly schedule: (callback: () => void) => void,
    private readonly render: () => void,
  ) {}

  request() {
    if (this.scheduled || this.disposed) return;
    this.scheduled = true;
    this.schedule(() => {
      this.scheduled = false;
      if (!this.disposed) this.render();
    });
  }

  dispose() {
    this.disposed = true;
  }
}

export function AgentActivityOverlay({
  activity,
  control,
  layout,
  noOverlays,
  rem,
  theme,
}: {
  activity: AgentActivity | null;
  control: AgentControlSnapshot;
  layout: BrowserSurfaceLayout;
  noOverlays: boolean;
  rem: number;
  theme: Theme;
}) {
  const pulse = usePulse(!noOverlays && !!activity?.pulse);
  if (!agentOverlayEnabled(noOverlays)) return null;
  const geometry = agentOverlayGeometry(activity, layout);
  const unit = Math.max(1, rem);
  const cursorSize = Math.max(12, Math.round(unit * 1.5));
  const targetSize = Math.max(12, Math.round(unit * 1.45));
  const target = geometry.target;
  const cursor = geometry.cursor;
  const stateColor =
    control.state === "human"
      ? theme.yellow
      : control.state === "paused"
        ? theme.muted
        : theme.accent;
  const label = `${control.state}${control.busy ? " · busy" : ""}`;
  const pillWidth = Math.round(unit * (control.busy ? 7.5 : 5.5));
  const targetRing = target
    ? createElement(Box, {
        style: {
          position: "absolute",
          inset: {
            top: target.y - targetSize / 2,
            left: target.x - targetSize / 2,
          },
          width: targetSize,
          height: targetSize,
          cornerRadius: targetSize / 2,
          border: { width: Math.max(1, Math.round(unit * 0.12)), color: stateColor },
        },
      })
    : null;
  const targetPulse = target && activity?.pulse
    ? createElement(Box, {
        style: {
          position: "absolute",
          inset: {
            top: target.y - targetSize * (0.7 + pulse * 0.35),
            left: target.x - targetSize * (0.7 + pulse * 0.35),
          },
          width: targetSize * (1.4 + pulse * 0.7),
          height: targetSize * (1.4 + pulse * 0.7),
          cornerRadius: targetSize * (1.4 + pulse * 0.7) / 2,
          border: {
            width: Math.max(1, Math.round(unit * 0.1)),
            color: withAlpha(stateColor, Math.round(180 * (1 - pulse * 0.45))),
          },
        },
      })
    : null;
  const cursorNode = cursor
    ? createElement(
        Box,
        {
          style: {
            position: "absolute",
            inset: {
              top: cursor.y - cursorSize * 0.22,
              left: cursor.x - cursorSize * 0.18,
            },
            width: cursorSize,
            height: cursorSize,
          },
        },
        createElement(Icon, { icon: "cursor", size: cursorSize, color: stateColor, weight: 1.7 }),
      )
    : null;
  const pill = createElement(
    Box,
    {
      style: {
        position: "absolute",
        inset: {
          top: layout.y + Math.max(4, Math.round(unit * 0.55)),
          left: layout.x + layout.width - pillWidth - Math.round(unit * 0.55),
        },
        width: pillWidth,
        height: Math.max(16, Math.round(unit * 1.65)),
        alignItems: "center",
        justifyContent: "center",
        padding: { left: Math.round(unit * 0.55), right: Math.round(unit * 0.55) },
        background: withAlpha(theme.bg, 232),
        cornerRadius: Math.round(unit * 0.45),
        border: { width: 1, color: withAlpha(stateColor, 210) },
      },
    },
    createElement(
      Text,
      {
        style: {
          color: stateColor,
          fontSize: Math.max(8, Math.round(unit * 0.72)),
          wrap: false,
          selectable: false,
        },
      },
      label,
    ),
  );

  return createElement(
    Box,
    {
      style: {
        position: "absolute",
        inset: { top: 0, left: 0 },
        width: layout.x + layout.width,
        height: layout.y + layout.height,
        overflow: "hidden",
      },
    },
    createElement(Fragment, null, clipOverlayNode(targetRing, layout), clipOverlayNode(targetPulse, layout)),
    clipOverlayNode(cursorNode, layout),
    clipOverlayNode(pill, layout),
  );
}
