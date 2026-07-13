import { useMemo } from "react";
import { Box, HIGHLIGHT_CAPTURES, highlight, Image, Text } from "pixel-react";

import { parseInline } from "../markdown";
import type { Item } from "../session";
import { ToolRow } from "./tool";
import type { Ctx } from "../theme";

export function Message({ ctx, item }: { ctx: Ctx; item: Item }) {
  const { theme, rem } = ctx;
  if (item.kind === "user") {
    return (
      <Box
        style={{
          flexDirection: "column",
          gap: rem * 0.5,
          margin: { left: -rem, right: -rem },
          padding: { left: rem, right: rem, top: rem * 0.5, bottom: rem * 0.5 },
          background: theme.userBg,
          border: { top: [1, theme.separator], bottom: [1, theme.separator] },
        }}
      >
        {item.images && (
          <Box style={{ gap: rem * 0.5, alignItems: "start" }}>
            {item.images.map((src, i) => (
              <Image
                key={i}
                src={src}
                style={{ height: rem * 5, cornerRadius: rem * 0.4 }}
              />
            ))}
          </Box>
        )}
        {(item.text || !item.images) && <Text>&gt; {item.text}</Text>}
      </Box>
    );
  }
  if (item.kind === "tool") {
    return <ToolRow ctx={ctx} call={item.call} />;
  }
  const parts = segments(item.text);
  if (parts.length === 1 && !parts[0].code) {
    return <Prose ctx={ctx} text={parts[0].text} />;
  }
  return (
    <Box style={{ flexDirection: "column", gap: rem * 0.5 }}>
      {parts.map((part, i) =>
        part.code ? (
          <CodeBlock key={i} ctx={ctx} language={part.language} code={part.text} />
        ) : (
          <Prose key={i} ctx={ctx} text={part.text} />
        )
      )}
    </Box>
  );
}

function Prose({ ctx, text }: { ctx: Ctx; text: string }) {
  const { theme } = ctx;
  const { text: clean, spans } = useMemo(() => parseInline(text), [text]);
  const textSpans = useMemo(
    () =>
      spans.map((s) => ({
        start: s.start,
        end: s.end,
        color: s.code ? theme.accent : theme.fg,
        bold: s.bold,
      })),
    [spans, theme]
  );
  if (textSpans.length === 0) return <Text>{clean}</Text>;
  return <Text spans={textSpans}>{clean}</Text>;
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
      <Text style={{ wrap: false }} spans={spans}>
        {code}
      </Text>
    </Box>
  );
}
