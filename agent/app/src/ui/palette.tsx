import { Box, Text } from "pixel-react";

import { PALETTE_ACTIONS } from "../palette";
import { store } from "../session";
import { useCtx } from "../theme";

export function Palette() {
  const { theme, rem } = useCtx();
  return (
    <Box
      style={{
        position: "absolute",
        inset: { left: 0, right: 0, top: 0, bottom: 0 },
        flexDirection: "column",
        alignItems: "center",
        padding: { top: rem * 4 },
      }}
      onClick={() => store.closePalette()}
    >
      <Box
        style={{
          flexDirection: "column",
          width: rem * 24,
          background: theme.bgAlt,
          border: { width: Math.max(rem / 16, 1), color: theme.hairline },
          cornerRadius: rem * 0.5,
          padding: rem * 0.3,
        }}
        onClick={() => {}}
      >
        {PALETTE_ACTIONS.map((action, i) => (
          <Text
            key={action.label}
            style={{
              padding: { left: rem * 0.6, right: rem * 0.6, top: rem * 0.35, bottom: rem * 0.35 },
              cornerRadius: rem * 0.3,
              background: i === store.paletteAt ? theme.itemActive : undefined,
              hoverBackground: i === store.paletteAt ? undefined : theme.itemHover,
              wrap: false,
            }}
            onClick={() => {
              action.run();
              store.closePalette();
            }}
          >
            {action.label}
          </Text>
        ))}
      </Box>
    </Box>
  );
}
