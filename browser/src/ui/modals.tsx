import { useEffect, useRef, useState } from "react";
import { Box, Input, Text } from "pixel-react";
import type { NodeHandle } from "pixel-react";
import type { BrowserState } from "../page/types";
import { Icon } from "./icons";
import type { Theme } from "./theme";
import type { ChromeActions, ChromeLayout, NewTabView, PaletteView } from "./types";

function Backdrop({ layout, onClose }: { layout: ChromeLayout; onClose(): void }) {
  /**
   * does the layout tree generated get transformed into pain order? hm
   */
  return (
    <Box
      style={{
        position: "absolute",
        inset: { top: 0, left: 0 },
        width: layout.width,
        height: layout.height,
      }}
      onClick={onClose}
    />
  );
}

/** shared shell for the centered cards that drop below the toolbar */
function ModalCard({
  layout,
  theme,
  width,
  onClose,
  children,
}: {
  layout: ChromeLayout;
  theme: Theme;
  width: number;
  onClose(): void;
  children: React.ReactNode;
}) {
  return (
    <>
      <Backdrop layout={layout} onClose={onClose} />
      <Box
        style={{
          position: "absolute",
          inset: { top: layout.toolbarHeight + layout.rem * 1.2, left: (layout.width - width) / 2 },
          width,
          flexDirection: "column",
          background: theme.bg,
          cornerRadius: layout.rem * 0.55,
          border: { width: 1, color: theme.fieldBorder },
          overflow: "hidden",
        }}
      >
        {children}
      </Box>
    </>
  );
}

export function PaletteCard({
  view,
  actions,
  layout,
  theme,
}: {
  view: PaletteView;
  actions: ChromeActions;
  layout: ChromeLayout;
  theme: Theme;
}) {
  const rem = layout.rem;
  const cardW = Math.min(rem * 26, layout.width - rem * 4);
  const rowH = rem * 2;
  const input = useRef<NodeHandle | null>(null);
  useEffect(() => {
    input.current?.focus();
  }, []);
  return (
    <ModalCard layout={layout} theme={theme} width={cardW} onClose={actions.paletteClose}>
      <Box
        style={{
          height: rem * 2.4,
          alignItems: "center",
          padding: { left: rem * 0.85, right: rem * 0.85 },
          border: { bottom: [1, theme.hairline] },
        }}
      >
        <Input
          ref={input}
          autoFocus
          style={{ flexGrow: 1, flexBasis: 0, wrap: false, fontSize: rem }}
          caretColor={theme.accent}
          selectionColor={theme.selection}
          onChange={(text) => actions.paletteQuery(text)}
        />
      </Box>
      <Box style={{ flexDirection: "column", padding: { bottom: rem * 0.25 } }}>
        {view.items.length === 0 && (
          <Text
            style={{
              padding: { left: rem * 0.85, top: rem * 0.35, bottom: rem * 0.35 },
              fontSize: rem * 0.92,
              color: theme.muted,
              selectable: false,
            }}
          >
            no matching actions
          </Text>
        )}
        {view.items.map((item, i) => (
          <Box
            key={item.id}
            style={{
              height: rowH,
              alignItems: "center",
              gap: rem * 0.55,
              padding: { left: rem * 0.85, right: rem * 0.85 },
              background: i === view.index ? theme.hover : undefined,
              hoverBackground: theme.hover,
            }}
            onClick={() => actions.paletteRun(i)}
          >
            <Text
              style={{
                flexGrow: 1,
                flexBasis: 0,
                fontSize: rem * 0.95,
                wrap: false,
                selectable: false,
              }}
            >
              {item.label}
            </Text>
            <Text
              style={{ fontSize: rem * 0.82, color: theme.muted, wrap: false, selectable: false }}
            >
              {item.shortcut}
            </Text>
          </Box>
        ))}
      </Box>
    </ModalCard>
  );
}

export function UrlCard({
  state,
  actions,
  layout,
  theme,
}: {
  state: BrowserState;
  actions: ChromeActions;
  layout: ChromeLayout;
  theme: Theme;
}) {
  const rem = layout.rem;
  const cardW = Math.min(rem * 28, layout.width - rem * 4);
  const [value, setValue] = useState(state.url === "about:blank" ? "" : state.url);
  const input = useRef<NodeHandle | null>(null);
  useEffect(() => {
    input.current?.focus();
    input.current?.selectAll();
  }, []);
  return (
    <ModalCard layout={layout} theme={theme} width={cardW} onClose={actions.urlEditCancel}>
      <Box
        style={{
          height: rem * 2.4,
          alignItems: "center",
          gap: rem * 0.5,
          padding: { left: rem * 0.85, right: rem * 0.85 },
        }}
      >
        <Icon icon="search" size={rem} color={theme.muted} />
        <Input
          ref={input}
          autoFocus
          value={value}
          style={{ flexGrow: 1, flexBasis: 0, wrap: false, fontSize: rem }}
          caretColor={theme.accent}
          selectionColor={theme.selection}
          onChange={setValue}
          onSubmit={(text) => actions.urlSubmit(text)}
        />
      </Box>
    </ModalCard>
  );
}

export function NewTabCard({
  view,
  actions,
  layout,
  theme,
}: {
  view: NewTabView;
  actions: ChromeActions;
  layout: ChromeLayout;
  theme: Theme;
}) {
  const rem = layout.rem;
  const cardW = Math.min(rem * 28, layout.width - rem * 4);
  const rowH = rem * 2;
  const input = useRef<NodeHandle | null>(null);
  useEffect(() => {
    input.current?.focus();
  }, []);
  return (
    <ModalCard layout={layout} theme={theme} width={cardW} onClose={actions.newTabCancel}>
      <Box
        style={{
          height: rem * 2.4,
          alignItems: "center",
          gap: rem * 0.5,
          padding: { left: rem * 0.85, right: rem * 0.85 },
          border: view.suggestions.length ? { bottom: [1, theme.hairline] } : undefined,
        }}
      >
        <Icon icon="search" size={rem} color={theme.muted} />
        <Input
          ref={input}
          autoFocus
          style={{ flexGrow: 1, flexBasis: 0, wrap: false, fontSize: rem }}
          caretColor={theme.accent}
          selectionColor={theme.selection}
          onChange={(text) => actions.newTabQuery(text)}
        />
      </Box>
      {view.suggestions.length > 0 && (
        <Box style={{ flexDirection: "column", padding: { bottom: rem * 0.25 } }}>
          {view.suggestions.map((suggestion, i) => {
            const maxChars = Math.floor((cardW - rem * 3.15) / (rem * 0.95 * 0.6));
            const shown =
              suggestion.length > maxChars
                ? `${suggestion.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`
                : suggestion;
            return (
              <Box
                key={`${i}:${suggestion}`}
                style={{
                  height: rowH,
                  alignItems: "center",
                  gap: rem * 0.6,
                  padding: { left: rem * 0.85, right: rem * 0.85 },
                  background: i === view.index ? theme.hover : undefined,
                  hoverBackground: theme.hover,
                }}
                onClick={() => actions.newTabSubmit(suggestion)}
              >
                <Icon icon="search" size={rem * 0.8} color={theme.disabled} />
                <Text
                  style={{
                    flexGrow: 1,
                    flexBasis: 0,
                    flexShrink: 1,
                    fontSize: rem * 0.95,
                    color: i === view.index ? theme.fg : theme.muted,
                    wrap: false,
                    selectable: false,
                    overflow: "hidden",
                  }}
                >
                  {shown}
                </Text>
              </Box>
            );
          })}
        </Box>
      )}
    </ModalCard>
  );
}

export function CloseConfirmCard({
  actions,
  layout,
  theme,
}: {
  actions: ChromeActions;
  layout: ChromeLayout;
  theme: Theme;
}) {
  const rem = layout.rem;
  const cardW = Math.min(rem * 23, layout.width - rem * 4);
  const rowH = rem * 2;
  const options: { label: string; hint: string; closePane: boolean }[] = [
    { label: "close the terminal pane", hint: "y", closePane: true },
    { label: "just exit the browser", hint: "n", closePane: false },
  ];
  return (
    <ModalCard layout={layout} theme={theme} width={cardW} onClose={actions.closeConfirmCancel}>
      <Box
        style={{
          height: rem * 2.4,
          alignItems: "center",
          gap: rem * 0.4,
          padding: { left: rem * 0.85, right: rem * 0.85 },
          border: { bottom: [1, theme.hairline] },
        }}
      >
        <Box
          style={{
            width: rem * 0.5,
            height: rem * 0.5,
            cornerRadius: rem * 0.25,
            background: theme.accent,
          }}
        />
        <Text style={{ fontSize: rem * 0.88, color: theme.muted, wrap: false, selectable: false }}>
          close the last tab?
        </Text>
        <Box style={{ flexGrow: 1, flexBasis: 0 }} />
        <Text style={{ fontSize: rem * 0.82, color: theme.disabled, wrap: false, selectable: false }}>
          esc cancels
        </Text>
      </Box>
      <Box style={{ flexDirection: "column", padding: { top: rem * 0.25, bottom: rem * 0.25 } }}>
        {options.map((option) => (
          <Box
            key={option.hint}
            style={{
              height: rowH,
              alignItems: "center",
              gap: rem * 0.55,
              padding: { left: rem * 0.85, right: rem * 0.85 },
              hoverBackground: theme.hover,
            }}
            onClick={() => actions.closeConfirmChoose(option.closePane)}
          >
            <Text
              style={{
                flexGrow: 1,
                flexBasis: 0,
                fontSize: rem * 0.95,
                wrap: false,
                selectable: false,
              }}
            >
              {option.label}
            </Text>
            <Text
              style={{ fontSize: rem * 0.82, color: theme.muted, wrap: false, selectable: false }}
            >
              {option.hint}
            </Text>
          </Box>
        ))}
      </Box>
    </ModalCard>
  );
}
