import { Box } from "pixel-react";
import type { Rgba } from "pixel-react";

import type { Ctx } from "../theme";

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
