import { memo, useMemo } from "react";
import { Box, Image, Markdown, MarkedText, Text } from "pixel-react";

import { openLink } from "../links";
import { store } from "../session";
import type { Item, RichMark } from "../session";
import { AttachmentPill, SelectionPill } from "./composer";
import { ToolRow } from "./tool";
import { markdownTheme, useCtx } from "../theme";

// Assistant items are replaced (never mutated) by the transcript fold, so
// identity comparison is safe; tool calls mutate in place and must re-render.
export const Message = memo(
  MessageImpl,
  (a, b) => a.item.kind === "assistant" && a.item === b.item && a.streaming === b.streaming
);

function MessageImpl({ item, streaming = false }: { item: Item; streaming?: boolean }) {
  const { theme, rem } = useCtx();
  const md = useMemo(() => markdownTheme(theme), [theme]);
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
                placeholder={<Box style={{ background: theme.bgAlt }} />}
                advanced={{ confirmedEqualTo: store.attachmentAliases(src) }}
              />
            ))}
          </Box>
        )}
        {item.marks?.length ? (
          <UserRichText text={item.text} marks={item.marks} />
        ) : (
          (item.text || !item.images) && <Text>&gt; {item.text}</Text>
        )}
      </Box>
    );
  }
  if (item.kind === "tool") {
    return <ToolRow call={item.call} />;
  }
  return (
    <Markdown text={item.text} streaming={streaming} theme={md} rem={rem} onLinkClick={openLink} />
  );
}

function UserRichText({ text, marks }: { text: string; marks: RichMark[] }) {
  const prefix = "> ";
  return (
    <MarkedText
      text={prefix + text}
      marks={marks.map((mark, i) => ({ id: i, offset: mark.offset + prefix.length }))}
      serializeMark={(id) => marks[id]?.data}
      renderMark={(id) => {
        const mark = marks[id];
        if (!mark) return null;
        try {
          const data = JSON.parse(mark.data) as {
            kind: string;
            path?: string;
            title?: string;
            doc?: string;
            start?: number;
            end?: number;
          };
          if (data.kind === "image" && data.path) {
            return <AttachmentPill src={data.path} equalTo={store.attachmentAliases(data.path)} />;
          }
          if (
            data.kind === "selection" &&
            typeof data.doc === "string" &&
            typeof data.title === "string" &&
            typeof data.start === "number" &&
            typeof data.end === "number"
          ) {
            return (
              <SelectionPill
                refData={{ title: data.title, doc: data.doc, start: data.start, end: data.end }}
              />
            );
          }
        } catch {
          return null;
        }
        return null;
      }}
    />
  );
}

