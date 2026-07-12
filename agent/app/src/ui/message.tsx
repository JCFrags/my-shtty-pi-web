import { useMemo } from "react";
import { Box, HIGHLIGHT_CAPTURES, highlight, Text } from "pixel-react";

import type { Item } from "../session";
import { ToolRow } from "./tool";
import { FONT_MONO, type Ctx } from "../theme";

export function Message({ ctx, item }: { ctx: Ctx; item: Item }) {
  const { theme, rem } = ctx;
  if (item.kind === "user") {
    return (
      <Box
        style={{
          margin: { left: -rem, right: -rem },
          padding: { left: rem, right: rem, top: rem * 0.5, bottom: rem * 0.5 },
          background: theme.bgAlt,
          border: { top: [1, theme.hairline], bottom: [1, theme.hairline] },
        }}
      >
        <Text>&gt; {item.text}</Text>
      </Box>
    );
  }
  if (item.kind === "tool") {
    return <ToolRow ctx={ctx} call={item.call} />;
  }
  const parts = segments(item.text);
  if (parts.length === 1 && !parts[0].code) {
    return <Text>{parts[0].text}</Text>;
  }
  return (
    <Box style={{ flexDirection: "column", gap: rem * 0.5 }}>
      {parts.map((part, i) =>
        part.code ? (
          <CodeBlock key={i} ctx={ctx} language={part.language} code={part.text} />
        ) : (
          <Text key={i}>{part.text}</Text>
        )
      )}
    </Box>
  );
}

interface Segment {
  code: boolean;
  language: string;
  text: string;
}

function segments(text: string): Segment[] {
  const out: Segment[] = [];
  let plain: string[] = [];
  let code: string[] | null = null;
  let language = "";
  const flushPlain = () => {
    const joined = plain.join("\n").trim();
    if (joined) out.push({ code: false, language: "", text: joined });
    plain = [];
  };
  for (const line of text.split("\n")) {
    const fence = /^\s{0,3}```(.*)$/.exec(line);
    if (fence && code === null) {
      flushPlain();
      code = [];
      language = fence[1].trim();
    } else if (fence && code !== null) {
      out.push({ code: true, language, text: code.join("\n") });
      code = null;
    } else if (code !== null) {
      code.push(line);
    } else {
      plain.push(line);
    }
  }
  if (code !== null) out.push({ code: true, language, text: code.join("\n") });
  else flushPlain();
  return out;
}

function CodeBlock({ ctx, language, code }: { ctx: Ctx; language: string; code: string }) {
  const { theme, rem } = ctx;
  const spans = useMemo(
    () =>
      highlight(code, language).map((s) => ({
        start: s.start,
        end: s.end,
        color: theme.syntax[HIGHLIGHT_CAPTURES[s.capture]] ?? theme.fg,
      })),
    [code, language, theme]
  );
  return (
    <Box
      style={{ overflow: "hidden" }}>
      <Text style={{ font: FONT_MONO, fontSize: rem * 0.9, wrap: false }} spans={spans}>
        {code}
      </Text>
    </Box>
  );
}
