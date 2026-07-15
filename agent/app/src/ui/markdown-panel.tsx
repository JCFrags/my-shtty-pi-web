import { useRef } from "react";
import { Box, Markdown, Text } from "pixel-react";

import { openLink } from "../links";
import { menus } from "../menu";
import { store } from "../session";
import { markdownTheme, useCtx } from "../theme";

const FONT_MONO = 1;

export function MarkdownPanel({ totalWidth }: { totalWidth: number }) {
  const { theme, rem } = useCtx();
  const grab = useRef(0);
  const doc = store.markdownDoc;
  if (!doc) return null;
  const panelWidth = store.panelFraction * totalWidth;
  return (
    <>
      <Box
        style={{
          width: Math.max(10, rem * 0.8),
          flexShrink: 0,
          justifyContent: "center",
          hoverBackground: theme.itemHover,
        }}
        onDrag={(e) => {
          const at = 1 - e.x / totalWidth;
          if (e.phase === "start") {
            grab.current = store.panelFraction - at;
            return;
          }
          if (e.phase === "end") return;
          store.setPanelFraction(at + grab.current);
        }}
      >
        <Box style={{ width: 2, background: theme.hairline }} />
      </Box>
      <Box
        style={{
          width: `${store.panelFraction * 100}%`,
          flexShrink: 0,
          flexDirection: "column",
          background: theme.bg,
        }}
      >
        <Box
          style={{
            alignItems: "center",
            gap: rem * 0.5,
            padding: { left: rem, right: rem, top: rem * 0.5, bottom: rem * 0.5 },
            border: { bottom: [1, theme.hairline] },
          }}
        >
          <Text
            style={{ flexGrow: 1, wrap: false, overflow: "hidden" }}
            spans={[
              {
                start: 0,
                end: Buffer.byteLength(doc.title),
                color: theme.fg,
                bold: true,
              },
            ]}
          >
            {doc.title}
          </Text>
          <Text
            style={{
              flexShrink: 0,
              color: theme.muted,
              hoverColor: theme.fg,
              padding: { left: rem * 0.4, right: rem * 0.4 },
            }}
            onClick={() => store.closeMarkdown()}
          >
            ×
          </Text>
        </Box>
        <Box style={{ flexGrow: 1, flexBasis: 0, flexDirection: "column" }}>
          <Box
            style={{
              flexGrow: 1,
              flexBasis: 0,
              overflow: "scroll",
              flexDirection: "column",
              padding: rem,
              selectionMode: "unified",
            }}
            onSelection={(selection) =>
              store.setPanelSelection(selection.parts.length > 0 ? selection : null)
            }
          >
            <Markdown
              text={doc.text}
              theme={markdownTheme(theme)}
              rem={rem}
              monoFont={FONT_MONO}
              onLinkClick={openLink}
              highlight={doc.highlight}
              highlightBg={theme.selection}
            />
          </Box>
          {store.panelSelection && <AddToChat panelWidth={panelWidth} />}
        </Box>
      </Box>
    </>
  );
}

function AddToChat({ panelWidth }: { panelWidth: number }) {
  const { theme, rem } = useCtx();
  const selection = store.panelSelection;
  if (!selection) return null;
  const left = Math.min(Math.max(selection.x, rem * 0.5), Math.max(panelWidth - rem * 11, 0));
  const top = Math.max(selection.y - rem * 2.1, rem * 0.25);
  return (
    <Box
      style={{
        position: "absolute",
        inset: { left, top },
        alignItems: "center",
        gap: rem * 0.45,
        padding: { left: rem * 0.6, right: rem * 0.6, top: rem * 0.3, bottom: rem * 0.3 },
        background: theme.menuBg,
        border: { width: 1, color: theme.hairline },
        cornerRadius: rem * 0.35,
        hoverBackground: theme.itemHover,
      }}
      onClick={() => {
        const id = store.addPanelSelectionToChat();
        if (id == null) return;
        menus.input?.addMark(id);
        menus.input?.focus();
      }}
    >
      <Text style={{ wrap: false }}>Add to chat</Text>
      <Text style={{ wrap: false, color: theme.muted, fontSize: rem * 0.8 }}>⌘L</Text>
    </Box>
  );
}
