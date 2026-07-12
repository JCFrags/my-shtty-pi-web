import { useEffect, useState } from "react";
import { Box, Text } from "pixel-react";

import type { Ask, Session } from "../session";
import type { Ctx } from "../theme";

export function AskBox({ ctx: { theme, rem }, ask }: { ctx: Ctx; ask: Ask }) {
  return (
    <Box
      style={{
        flexDirection: "column",
        gap: rem * 0.25,
        margin: { left: rem, right: rem, bottom: rem * 0.5 },
        padding: rem * 0.6,
        border: { width: Math.max(rem / 16, 1), color: theme.accent },
        cornerRadius: rem * 0.4,
      }}
    >
      <Box style={{ gap: rem * 0.5, overflow: "hidden" }}>
        <Text style={{ color: theme.accent, flexShrink: 0 }}>{ask.tool}</Text>
        <Text style={{ color: theme.muted, wrap: false }}>{ask.detail}</Text>
      </Box>
      <Text style={{ color: theme.muted, fontSize: rem * 0.85 }}>enter allow · esc deny</Text>
    </Box>
  );
}

export function WorkingStatus({ ctx, session }: { ctx: Ctx; session: Session }) {
  const { theme, rem } = ctx;
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setFrame((f) => f + 1), 250);
    return () => clearInterval(timer);
  }, []);

  const status = `${session.activity || "working"}${".".repeat(1 + (frame % 3))}`;

  return (
    <Box
      style={{
        alignItems: "center",
        gap: rem * 0.5,
        padding: { left: rem, right: rem, bottom: rem * 0.5 },
      }}
    >
      <Text
        style={{
          color: theme.accent,
          fontSize: rem * 0.85,
          wrap: false,
          flexShrink: 0,
        }}
      >
        {status}
      </Text>
    </Box>
  );
}
