import { useEffect, useRef } from "react";
import { Box, Text } from "pixel-react";
import type { NodeHandle } from "pixel-react";

import { applyFont, fontRows } from "../fonts";
import { store } from "../session";
import type { Ctx } from "../theme";

export function Settings({ ctx }: { ctx: Ctx }) {
  const { theme, rem } = ctx;
  const rows = fontRows(store.settingsQuery);
  const list = useRef<NodeHandle | null>(null);
  const rowHeight = rem * 1.85;
  const listHeight = rem * 16;

  useEffect(() => {
    list.current?.scrollTo(Math.max(0, rowHeight * store.settingsAt - listHeight / 2));
  }, [store.settingsAt, store.settingsQuery]);

  return (
    <Box
      style={{
        position: "absolute",
        inset: { left: 0, right: 0, top: 0, bottom: 0 },
        flexDirection: "column",
        alignItems: "center",
        padding: { top: rem * 4 },
      }}
      onClick={() => store.closeSettings()}
    >
      <Box
        style={{
          flexDirection: "column",
          width: rem * 28,
          background: theme.bgAlt,
          border: { width: Math.max(rem / 16, 1), color: theme.hairline },
          cornerRadius: rem * 0.5,
          overflow: "hidden",
        }}
        onClick={() => {}}
      >
        <Box
          style={{
            alignItems: "center",
            gap: rem * 0.1,
            padding: { left: rem * 0.8, right: rem * 0.8, top: rem * 0.6, bottom: rem * 0.6 },
            border: { bottom: [Math.max(rem / 16, 1), theme.hairline] },
          }}
        >
          {store.settingsQuery ? <Text style={{ wrap: false }}>{store.settingsQuery}</Text> : null}
          <Box style={{ width: rem * 0.1, height: rem * 1.1, background: theme.accent }} />
          {!store.settingsQuery && (
            <Text style={{ color: theme.muted, wrap: false }}>search fonts</Text>
          )}
        </Box>
        <Box
          ref={list}
          style={{
            flexDirection: "column",
            height: listHeight,
            padding: rem * 0.4,
            gap: rem * 0.15,
            overflow: "scroll",
          }}
        >
          {rows.length === 0 && (
            <Text style={{ color: theme.muted, padding: rem * 0.5 }}>
              no fonts match
            </Text>
          )}
          {rows.map((row, i) => (
            <Box
              key={row.path ?? "default"}
              style={{
                flexShrink: 0,
                padding: { left: rem * 0.5, right: rem * 0.5, top: rem * 0.25, bottom: rem * 0.25 },
                cornerRadius: rem * 0.25,
                background: i === store.settingsAt ? theme.itemActive : undefined,
                hoverBackground: i === store.settingsAt ? undefined : theme.itemHover,
              }}
              onClick={() => void applyFont(row.path)}
            >
              <Text
                style={{
                  color: row.path === store.fontPath ? theme.accent : theme.fg,
                  wrap: false,
                }}
              >
                {row.label}
              </Text>
            </Box>
          ))}
        </Box>
      </Box>
    </Box>
  );
}
