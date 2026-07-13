import { Box } from "pixel-react";
import type { Rgba } from "pixel-react";

import { useCtx } from "../theme";

export function Dot({ color }: { color: Rgba }) {
  const { rem } = useCtx();
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
