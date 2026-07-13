import { Box, Text } from "pixel-react";
import type { EngineInfo } from "pixel-react";

import { menus } from "../menu";
import type { Ctx } from "../theme";

const VISIBLE_ROWS = 8;

export function TriggerMenuOverlay({ ctx, info }: { ctx: Ctx; info: EngineInfo }) {
  const { theme, rem } = ctx;
  const view = menus.view();
  if (!view) return null;

  const inset = rem * 0.5;
  const gap = rem * 0.35;
  const width = Math.min(rem * 26, info.width - inset * 2);
  const left = Math.min(Math.max(view.anchor.x, inset), info.width - width - inset);
  const bottom = info.height - view.anchor.y + gap;
  const maxHeight = Math.max(view.anchor.y - inset - gap, rem * 2);

  const count = view.items.length;
  const start = Math.max(
    0,
    Math.min(view.at - Math.floor(VISIBLE_ROWS / 2), count - VISIBLE_ROWS),
  );
  const rows = view.items.slice(start, start + VISIBLE_ROWS);
  const above = start;
  const below = count - start - rows.length;
  const itemPad = { left: rem * 0.6, right: rem * 0.6, top: rem * 0.25, bottom: rem * 0.25 };

  return (
    <Box
      style={{
        position: "absolute",
        inset: { left, bottom },
        width,
        maxHeight,
        flexDirection: "column",
        padding: rem * 0.25,
        background: theme.menuBg,
        border: { width: Math.max(rem / 16, 1), color: theme.hairline },
        cornerRadius: rem * 0.4,
        overflow: "hidden",
        selectable: false,
      }}
    >
      {view.loading && (
        <Text style={{ padding: itemPad, color: theme.muted, wrap: false }}>
          loading…
        </Text>
      )}
      {above > 0 && <MoreRow ctx={ctx} count={above} />}
      {rows.map((item, i) => {
        const selected = start + i === view.at;
        return (
          <Box
            key={item.value}
            style={{
              padding: itemPad,
              cornerRadius: rem * 0.25,
              background: selected ? theme.itemHover : undefined,
              hoverBackground: theme.itemHover,
              gap: rem * 0.6,
              alignItems: "center",
            }}
            onClick={() => menus.accept(item)}
          >
            <Text
              style={{
                color: selected ? theme.accent : theme.fg,
                wrap: false,
                flexShrink: 0,
              }}
            >
              {item.label}
            </Text>
            {item.hint ? (
              <Text
                style={{
                  color: theme.muted,
                  wrap: false,
                  overflow: "hidden",
                }}
              >
                {item.hint}
              </Text>
            ) : null}
          </Box>
        );
      })}
      {below > 0 && <MoreRow ctx={ctx} count={below} />}
    </Box>
  );
}

function MoreRow({ ctx: { theme, rem }, count }: { ctx: Ctx; count: number }) {
  return (
    <Text
      style={{
        padding: { left: rem * 0.6, right: rem * 0.6, top: rem * 0.1, bottom: rem * 0.1 },
        color: theme.muted,
        wrap: false,
      }}
    >
      {`${count} more`}
    </Text>
  );
}
