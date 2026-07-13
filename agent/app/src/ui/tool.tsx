import { Box, Text } from "pixel-react";

import type { ToolCall } from "../session";
import { DiffCard, diffSources } from "./diff";
import { Dot } from "./dot";
import { useCtx } from "../theme";

export function ToolRow({ call }: { call: ToolCall }) {
  const { theme, rem } = useCtx();
  const color =
    call.status === "running"
      ? theme.accent
      : call.status === "ok"
        ? theme.green
        : theme.red;

  const sources = diffSources(call);

  return (
    <Box style={{ flexDirection: "column", gap: rem * 0.25 }}>
      <Box style={{ gap: rem * 0.5, alignItems: "center", overflow: "hidden" }}>
        <Dot color={color} />
        <Text style={{ flexShrink: 0, wrap: false }}>{call.name}</Text>
        <Text style={{ color: theme.muted, wrap: false }}>
          {call.detail}
        </Text>
      </Box>
      {sources && (
        <Box style={{ margin: { left: rem } }}>
          <DiffCard sources={sources} />
        </Box>
      )}
      {call.kids.length > 0 && (
        <Box style={{ flexDirection: "column", gap: rem * 0.25, margin: { left: rem } }}>
          {call.kids.map((kid) => (
            <ToolRow key={kid.id} call={kid} />
          ))}
        </Box>
      )}
    </Box>
  );
}
