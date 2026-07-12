import { Box, Text } from "pixel-react";

import type { ToolCall } from "../session";
import { DiffCard, diffSources } from "./diff";
import { Dot } from "./dot";
import type { Ctx } from "../theme";

export function ToolRow({ ctx, call }: { ctx: Ctx; call: ToolCall }) {
  const { theme, rem } = ctx;
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
        <Dot ctx={ctx} color={color} />
        <Text style={{ fontSize: rem * 0.9, flexShrink: 0, wrap: false }}>{call.name}</Text>
        <Text style={{ color: theme.muted, fontSize: rem * 0.9, wrap: false }}>
          {call.detail}
        </Text>
      </Box>
      {sources && (
        <Box style={{ margin: { left: rem } }}>
          <DiffCard ctx={ctx} sources={sources} />
        </Box>
      )}
      {call.kids.length > 0 && (
        <Box style={{ flexDirection: "column", gap: rem * 0.25, margin: { left: rem } }}>
          {call.kids.map((kid) => (
            <ToolRow key={kid.id} ctx={ctx} call={kid} />
          ))}
        </Box>
      )}
    </Box>
  );
}
