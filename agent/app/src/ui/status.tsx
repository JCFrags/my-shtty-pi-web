import { useEffect, useState } from "react";
import { Box, Text } from "pixel-react";

import type { Ask, Session } from "../session";
import { useCtx } from "../theme";

export function AskBox({ ask }: { ask: Ask }) {
  const { theme, rem } = useCtx();
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
      <Text style={{ color: theme.muted }}>enter allow · esc deny</Text>
    </Box>
  );
}

export function WorkingStatus({ session }: { session: Session }) {
  const { theme, rem } = useCtx();
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
          wrap: false,
          flexShrink: 0,
        }}
      >
        {status}
      </Text>
    </Box>
  );
}
