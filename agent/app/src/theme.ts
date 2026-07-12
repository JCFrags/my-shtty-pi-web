import type { EngineInfo, Rgba } from "pixel-react";

export interface Theme {
  bg: Rgba;
  bgAlt: Rgba;
  fg: Rgba;
  muted: Rgba;
  accent: Rgba;
  green: Rgba;
  red: Rgba;
  chipBg: Rgba;
  menuBg: Rgba;
  hairline: Rgba;
  selection: Rgba;
  sidebarBg: Rgba;
  itemHover: Rgba;
  itemActive: Rgba;
  syntax: Record<string, Rgba>;
  diffAddedBg: Rgba;
  diffRemovedBg: Rgba;
  diffAddedEmphasisBg: Rgba;
  diffRemovedEmphasisBg: Rgba;
}

function mix(base: Rgba, toward: Rgba, t: number): Rgba {
  const channel = (b: number, w: number) => Math.round(b + (w - b) * t);
  return [
    channel(base[0], toward[0]),
    channel(base[1], toward[1]),
    channel(base[2], toward[2]),
    255,
  ];
}

export function makeTheme(colors: EngineInfo["colors"]): Theme {
  const bg = colors.background ?? [22, 22, 30, 255];
  const fg = colors.foreground ?? [222, 220, 235, 255];
  const accent = colors.palette[13] ?? colors.palette[12] ?? [159, 134, 235, 255];
  const muted = mix(fg, bg, 0.45);
  const palette = (at: number, fallback: Rgba) => colors.palette[at] ?? fallback;
  const keyword = palette(13, [198, 120, 221, 255]);
  const fn = palette(12, [97, 175, 239, 255]);
  const type = palette(11, [229, 192, 123, 255]);
  const string = palette(10, [152, 195, 121, 255]);
  const number = palette(3, [209, 154, 102, 255]);
  const special = palette(14, [86, 182, 194, 255]);
  const green = palette(2, [140, 200, 140, 255]);
  const red = palette(1, [220, 120, 120, 255]);
  return {
    bg,
    bgAlt: mix(bg, fg, 0.05),
    fg,
    muted,
    accent,
    green,
    red,
    chipBg: mix(bg, fg, 0.09),
    menuBg: mix(bg, fg, 0.08),
    hairline: mix(bg, fg, 0.15),
    selection: mix(bg, accent, 0.35),
    sidebarBg: mix(bg, fg, 0.05),
    itemHover: mix(bg, fg, 0.11),
    itemActive: mix(bg, accent, 0.3),
    diffAddedBg: mix(bg, green, 0.16),
    diffRemovedBg: mix(bg, red, 0.16),
    diffAddedEmphasisBg: mix(bg, green, 0.38),
    diffRemovedEmphasisBg: mix(bg, red, 0.38),
    syntax: {
      attribute: type,
      comment: muted,
      constant: number,
      constructor: type,
      embedded: fg,
      escape: special,
      function: fn,
      keyword,
      number,
      operator: mix(fg, bg, 0.25),
      property: special,
      punctuation: mix(fg, bg, 0.3),
      string,
      tag: palette(9, [224, 108, 117, 255]),
      type,
      variable: fg,
    },
  };
}
