import { useState } from "react";
import { Box, Image, Input, Text } from "pixel-react";
import type { NodeHandle, Rgba } from "pixel-react";

import { menus } from "../menu";
import { PERMISSION_MODES, store, THINKING } from "../session";
import type { PermissionMode } from "@anthropic-ai/claude-agent-sdk";
import type { Ctx } from "../theme";

export function Composer({ ctx: { theme, rem }, inputRef }: { ctx: Ctx; inputRef: React.Ref<NodeHandle> }) {
  const session = store.active();
  return (
    <Box style={{ flexDirection: "column", flexShrink: 0 }}>
      <Box
        style={{ height: Math.ceil(Math.max(rem / 16, 1) + 0.5), width: "100%", background: theme.separator }}
      />
      {store.composerAttachments.length > 0 && (
        <Box
          style={{
            gap: rem * 0.5,
            alignItems: "start",
            padding: { left: rem * 0.75, right: rem * 0.75, top: rem * 0.75 },
          }}
        >
          {store.composerAttachments.map((attachment) => (
            <Image
              key={attachment.id}
              src={attachment.path}
              style={{
                height: rem * 8,
                cornerRadius: rem * 0.4,
                border: { width: Math.max(rem / 16, 1), color: theme.hairline },
              }}
            />
          ))}
        </Box>
      )}
      <Box style={{ alignItems: "start", padding: rem * 0.75 }}>
        <Input
          key={store.composerEpoch}
          ref={inputRef}
          style={{ flexGrow: 1, flexBasis: 0 }}
          caretColor={theme.accent}
          selectionColor={theme.selection}
          autoFocus
          onChange={(text, attachments, change) => {
            store.composerText = text;
            store.syncComposerAttachments(attachments);
            menus.onChange(text, change);
          }}
          onCaret={(caret) => menus.onCaret(caret)}
          onAttach={(attachment) => store.addComposerAttachment(attachment)}
          onSubmit={(text, attachments) => {
            menus.reset();
            store.composerText = "";
            store.syncComposerAttachments([]);
            store.active().send(text, attachments);
          }}
        />
      </Box>
      <Box
        style={{ height: Math.ceil(Math.max(rem / 16, 1) + 0.5), width: "100%", background: theme.separator }}
      />
      <Box
        style={{
          alignItems: "end",
          gap: rem * 0.5,
          padding: { left: rem, right: rem, top: rem * 0.5, bottom: rem * 0.5 },
        }}
      >
        <ModelPicker ctx={{ theme, rem }} />
        <Picker
          ctx={{ theme, rem }}
          color={session.mode === "bypassPermissions" ? theme.red : theme.muted}
          label={session.mode}
          items={PERMISSION_MODES.map((mode) => ({ value: mode, label: mode }))}
          selected={session.mode}
          onPick={(value) => session.setMode(value as PermissionMode)}
        />
      </Box>
    </Box>
  );
}

function ModelPicker({ ctx }: { ctx: Ctx }) {
  const { theme, rem } = ctx;
  const session = store.active();
  const [open, setOpen] = useState(false);
  const itemPad = { left: rem * 0.6, right: rem * 0.6, top: rem * 0.3, bottom: rem * 0.3 };
  const modelItems = session.modelOptions();
  const thinkingLabel = THINKING[session.thinking].label;
  const label = `${session.model.replace(/^claude-/, "") || "…"} · ${thinkingLabel}`;

  return (
    <Box>
      <PickerChip
        ctx={ctx}
        color={theme.fg}
        onClick={() => {
          if (!open) session.loadModels();
          setOpen(!open);
        }}
      >
        {label}
      </PickerChip>
      {open && (
        <Box
          style={{
            position: "absolute",
            inset: { left: 0, bottom: "100%" },
            margin: { bottom: rem * 0.35 },
            flexDirection: "column",
            padding: rem * 0.25,
            background: theme.menuBg,
            border: { width: Math.max(rem / 16, 1), color: theme.hairline },
            cornerRadius: rem * 0.4,
          }}
          onClickOutside={() => setOpen(false)}
        >
          {modelItems.length === 0 && (
            <Text
              style={{
                padding: itemPad,
                color: theme.muted,
                wrap: false,
              }}
            >
              loading…
            </Text>
          )}
          {modelItems.map((item) => (
            <Text
              key={item.value}
              style={{
                padding: itemPad,
                cornerRadius: rem * 0.25,
                hoverBackground: theme.itemHover,
                color: item.value === session.model ? theme.accent : theme.fg,
                wrap: false,
              }}
              onClick={() => {
                session.setModel(item.value);
                setOpen(false);
              }}
            >
              {item.displayName}
            </Text>
          ))}
          <Box
            style={{
              height: Math.max(rem / 16, 1),
              margin: { top: rem * 0.25, bottom: rem * 0.25 },
              background: theme.hairline,
            }}
          />
          <Text
            style={{
              padding: { left: rem * 0.6, right: rem * 0.6, top: rem * 0.15, bottom: rem * 0.15 },
              color: theme.muted,
              wrap: false,
            }}
          >
            thinking
          </Text>
          {THINKING.map((t, i) => (
            <Text
              key={i}
              style={{
                padding: itemPad,
                cornerRadius: rem * 0.25,
                hoverBackground: theme.itemHover,
                color: i === session.thinking ? theme.accent : theme.fg,
                wrap: false,
              }}
              onClick={() => {
                session.setThinking(i);
                setOpen(false);
              }}
            >
              {t.label}
            </Text>
          ))}
        </Box>
      )}
    </Box>
  );
}

function PickerChip({
  ctx: { theme, rem },
  color,
  children,
  onClick,
}: {
  ctx: Ctx;
  color: Rgba;
  children: string;
  onClick: () => void;
}) {
  return (
    <Text
      style={{
        padding: { left: rem * 0.6, right: rem * 0.6, top: rem * 0.15, bottom: rem * 0.15 },
        cornerRadius: 999,
        hoverBackground: theme.itemHover,
        color,
        flexShrink: 0,
        wrap: false,
      }}
      onClick={onClick}
    >
      {children}
    </Text>
  );
}

function Picker({
  ctx,
  color,
  label,
  items,
  selected,
  onPick,
  onOpen,
}: {
  ctx: Ctx;
  color: Rgba;
  label: string;
  items: { value: string; label: string }[];
  selected: string;
  onPick: (value: string) => void;
  onOpen?: () => void;
}) {
  const { theme, rem } = ctx;
  const [open, setOpen] = useState(false);
  const itemPad = { left: rem * 0.6, right: rem * 0.6, top: rem * 0.3, bottom: rem * 0.3 };
  return (
    <Box>
      <PickerChip
        ctx={ctx}
        color={color}
        onClick={() => {
          if (!open) onOpen?.();
          setOpen(!open);
        }}
      >
        {label}
      </PickerChip>
      {open && (
        <Box
          style={{
            position: "absolute",
            inset: { left: 0, bottom: "100%" },
            margin: { bottom: rem * 0.35 },
            flexDirection: "column",
            padding: rem * 0.25,
            background: theme.menuBg,
            border: { width: Math.max(rem / 16, 1), color: theme.hairline },
            cornerRadius: rem * 0.4,
          }}
          onClickOutside={() => setOpen(false)}
        >
          {items.length === 0 && (
            <Text
              style={{
                padding: itemPad,
                color: theme.muted,
                wrap: false,
              }}
            >
              loading…
            </Text>
          )}
          {items.map((item) => (
            <Text
              key={item.value}
              style={{
                padding: itemPad,
                cornerRadius: rem * 0.25,
                hoverBackground: theme.itemHover,
                color: item.value === selected ? theme.accent : theme.fg,
                wrap: false,
              }}
              onClick={() => {
                onPick(item.value);
                setOpen(false);
              }}
            >
              {item.label}
            </Text>
          ))}
        </Box>
      )}
    </Box>
  );
}
