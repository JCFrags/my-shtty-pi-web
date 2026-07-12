import { Box, Text } from "pixel-react";

import { store } from "../session";
import type { Ctx } from "../theme";

export function Settings({ ctx }: { ctx: Ctx }) {
  const { theme, rem } = ctx;
  return (
    <Box
      style={{
        position: "absolute",
        inset: { left: 0, right: 0, top: 0, bottom: 0 },
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
      }}
      onClick={() => store.closeSettings()}
    >
      <Box
        style={{
          flexDirection: "column",
          width: rem * 28,
          maxHeight: "80%",
          background: theme.bgAlt,
          border: { width: Math.max(rem / 16, 1), color: theme.hairline },
          cornerRadius: rem * 0.5,
          overflow: "hidden",
        }}
        onClick={() => {}}
      >
        <Box
          style={{
            padding: { left: rem * 0.8, right: rem * 0.8, top: rem * 0.6, bottom: rem * 0.6 },
            border: { bottom: [Math.max(rem / 16, 1), theme.hairline] },
          }}
        >
          <Text style={{ fontSize: rem * 1.1 }}>settings</Text>
        </Box>
        <Box
          style={{
            flexDirection: "column",
            padding: rem * 0.8,
            overflow: "scroll",
          }}
        >
          <Text style={{ color: theme.muted, fontSize: rem * 0.85 }}>general</Text>
        </Box>
      </Box>
    </Box>
  );
}
