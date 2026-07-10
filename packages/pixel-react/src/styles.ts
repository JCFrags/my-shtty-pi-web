import type { Rgba } from "./native";

export type Color = Rgba | [number, number, number] | string;

export interface Edges {
  left?: number;
  right?: number;
  top?: number;
  bottom?: number;
}

export interface ScrollbarStyle {
  width?: number;
  hoverWidth?: number;
  margin?: number;
  minThumb?: number;
  thumbColor?: Color;
  thumbHoverColor?: Color;
  trackColor?: Color;
}

export interface Style {
  flexDirection?: "row" | "column";
  flexGrow?: number;
  flexShrink?: number;
  flexBasis?: number | `${number}%` | "auto";
  width?: number | `${number}%` | "auto";
  height?: number | `${number}%` | "auto";
  padding?: number | Edges;
  margin?: number | Edges;
  gap?: number;
  position?: "flow" | "absolute";
  inset?: Edges;
  overflow?: "visible" | "hidden" | "scroll";
  justifyContent?: "start" | "center" | "end" | "space-between";
  alignItems?: "start" | "center" | "end" | "stretch";
  background?: Color;
  cornerRadius?: number;
  border?: { width: number; color: Color };
  color?: Color;
  fontSize?: number;
  font?: number;
  hoverBackground?: Color;
  hoverColor?: Color;
  scrollbar?: ScrollbarStyle;
  wrap?: boolean;
}

export function parseColor(color: Color | undefined): Rgba | undefined {
  if (color == null) return undefined;
  if (Array.isArray(color)) {
    const [r, g, b, a] = color;
    return [r, g, b, a ?? 255];
  }
  let hex = color.startsWith("#") ? color.slice(1) : color;
  if (hex.length === 3 || hex.length === 4) {
    hex = [...hex].map((c) => c + c).join("");
  }
  if (!/^[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(hex)) {
    throw new Error(`unsupported color: ${color}`);
  }
  const int = (i: number) => parseInt(hex.slice(i, i + 2), 16);
  return [int(0), int(2), int(4), hex.length === 8 ? int(6) : 255];
}

export function serializeStyle(style: Style): Record<string, unknown> {
  return {
    flexDirection: style.flexDirection,
    flexGrow: style.flexGrow,
    flexShrink: style.flexShrink,
    flexBasis: style.flexBasis,
    width: style.width,
    height: style.height,
    padding: style.padding,
    margin: style.margin,
    gap: style.gap,
    position: style.position,
    inset: style.inset,
    overflow: style.overflow,
    justifyContent: style.justifyContent,
    alignItems: style.alignItems,
    background: parseColor(style.background),
    cornerRadius: style.cornerRadius,
    border: style.border && {
      width: style.border.width,
      color: parseColor(style.border.color),
    },
    color: parseColor(style.color),
    fontSize: style.fontSize,
    font: style.font,
    hoverBackground: parseColor(style.hoverBackground),
    hoverColor: parseColor(style.hoverColor),
    wrap: style.wrap,
    scrollbar: style.scrollbar && {
      width: style.scrollbar.width,
      hoverWidth: style.scrollbar.hoverWidth,
      margin: style.scrollbar.margin,
      minThumb: style.scrollbar.minThumb,
      thumbColor: parseColor(style.scrollbar.thumbColor),
      thumbHoverColor: parseColor(style.scrollbar.thumbHoverColor),
      trackColor: parseColor(style.scrollbar.trackColor),
    },
  };
}
