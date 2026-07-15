import { Box, Text } from "pixel-react";

import { MARKDOWN_TOOL, markdownToolInput } from "../markdown-tool";
import { store } from "../session";
import type { ToolCall } from "../session";
import { DiffCard, diffSources } from "./diff";
import { Dot } from "./dot";
import { useCtx } from "../theme";

function MarkdownToolRow({ call }: { call: ToolCall }) {
  const { theme, rem } = useCtx();
  const { title, markdown } = markdownToolInput(call.input);
  const open = store.markdownDoc?.text === markdown;
  return (
    <Box style={{ alignItems: "start" }}>
      <Box
        style={{
          gap: rem * 0.5,
          alignItems: "center",
          padding: { left: rem * 0.6, right: rem * 0.6, top: rem * 0.3, bottom: rem * 0.3 },
          background: open ? theme.itemActive : theme.chipBg,
          hoverBackground: open ? theme.itemActive : theme.itemHover,
          cornerRadius: rem * 0.35,
          overflow: "hidden",
        }}
        onClick={() => (open ? store.closeMarkdown() : store.openMarkdown(title, markdown))}
      >
        <Dot color={call.status === "running" ? theme.accent : theme.green} />
        <Text style={{ flexShrink: 0, wrap: false }}>markdown</Text>
        <Text style={{ color: theme.muted, wrap: false }}>{title}</Text>
        <Text style={{ color: theme.muted, flexShrink: 0 }}>{open ? "‹ open" : "›"}</Text>
      </Box>
    </Box>
  );
}

export function ToolRow({ call }: { call: ToolCall }) {
  const { theme, rem } = useCtx();
  if (call.name === MARKDOWN_TOOL) {
    return <MarkdownToolRow call={call} />;
  }
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
