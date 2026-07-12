import { Box, Text } from "pixel-react";
import type { Rgba } from "pixel-react";

import type { Theme } from "../theme";

export const FONT_MONO = 1;

export interface Ctx {
  theme: Theme;
  rem: number;
}

export function Dot({ ctx: { rem }, color }: { ctx: Ctx; color: Rgba }) {
  return (
    <Box
      style={{
        width: rem * 0.45,
        height: rem * 0.45,
        cornerRadius: 999,
        background: color,
        flexShrink: 0,
      }}
    />
  );
}

export function PickerChip({
  ctx: { theme, rem },
  color,
  children,
  onClick,
}: {
  ctx: Ctx;
  color: Rgba;
  children: string;
  onClick: () => void;
}) {
  return (
    <Text
      style={{
        padding: { left: rem * 0.6, right: rem * 0.6, top: rem * 0.15, bottom: rem * 0.15 },
        cornerRadius: 999,
        hoverBackground: theme.itemHover,
        color,
        fontSize: rem * 0.85,
        font: FONT_MONO,
        flexShrink: 0,
        wrap: false,
      }}
      onClick={onClick}
    >
      {children}
    </Text>
  );
}
