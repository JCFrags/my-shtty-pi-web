import { Box, Text } from "pixel-react";

import { store } from "../session";
import type { Session } from "../session";
import { Dot } from "./dot";
import { useCtx } from "../theme";

export function Sidebar() {
  const { theme, rem } = useCtx();
  const hairlineWidth = Math.max(rem / 16, 1);
  const radius = rem * 0.5;
  const innerRadius = radius - hairlineWidth;
  return (
    <Box
      style={{
        width: rem * 13,
        flexShrink: 0,
        margin: { left: rem * 0.4, top: rem * 0.4 },
        background: theme.hairline,
        cornerRadius: radius,
        padding: hairlineWidth,
      }}
    >
      <Box
        style={{
          flexDirection: "column",
          flexGrow: 1,
          padding: { top: rem * 0.4 },
          background: theme.sidebarBg,
          cornerRadius: innerRadius,
        }}
      >
        <Text
          style={{
            padding: { left: rem * 0.6, right: rem * 0.6, top: rem * 0.45, bottom: rem * 0.45 },
            border: { bottom: [hairlineWidth, theme.hairline] },
            color: theme.accent,
            hoverBackground: theme.itemHover,
            cornerRadius: innerRadius,
          }}
          onClick={() => store.add()}
        >
          + new session
        </Text>
        {store.sessions.map((session, i) => (
          <SidebarItem key={i} session={session} at={i} />
        ))}
      </Box>
    </Box>
  );
}

function SidebarItem({ session, at }: { session: Session; at: number }) {
  const { theme, rem } = useCtx();
  const active = at === store.at;
  return (
    <Box
      style={{
        alignItems: "center",
        gap: rem * 0.5,
        padding: { left: rem * 0.6, right: rem * 0.6, top: rem * 0.35, bottom: rem * 0.35 },
        background: active ? theme.itemActive : undefined,
        hoverBackground: active ? undefined : theme.itemHover,
        overflow: "hidden",
      }}
      onClick={() => store.select(at)}
    >
      <Text
        style={{
          color: active ? theme.fg : theme.muted,
          flexGrow: 1,
          flexBasis: 0,
          wrap: false,
        }}
      >
        {session.title()}
      </Text>
      {session.working && <Dot color={theme.accent} />}
    </Box>
  );
}
