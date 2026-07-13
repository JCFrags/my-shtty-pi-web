import { useState } from "react";
import { Box, Image, Input, Text } from "pixel-react";
import type { NodeHandle, Rgba } from "pixel-react";

import { menus } from "../menu";
import { PERMISSION_MODES, store, THINKING } from "../session";
import type { PermissionMode } from "@anthropic-ai/claude-agent-sdk";
import { useCtx } from "../theme";

export function Composer({ inputRef }: { inputRef: React.RefObject<NodeHandle | null> }) {
  const { theme, rem } = useCtx();
  const session = store.active();
  const attached = store.composerMarks.flatMap((mark) => {
    const image = store.composerImage(mark.id);
    return image ? [{ id: mark.id, path: image.path }] : [];
  });
  return (
    <Box style={{ flexDirection: "column", flexShrink: 0 }}>
      <Box
        style={{ height: Math.ceil(Math.max(rem / 16, 1) + 0.5), width: "100%", background: theme.separator }}
      />
      {attached.length > 0 && (
        <Box
          style={{
            gap: rem * 0.5,
            alignItems: "start",
            padding: { left: rem * 0.75, right: rem * 0.75, top: rem * 0.75 },
          }}
        >
          {attached.map((attachment) => (
            <Image
              key={attachment.id}
              src={attachment.path}
              style={{
                height: rem * 8,
                cornerRadius: rem * 0.4,
                border: { width: Math.max(rem / 16, 1), color: theme.hairline },
              }}
              placeholder={<Box style={{ background: theme.bgAlt }} />}
            />
          ))}
        </Box>
      )}
      <Box style={{ alignItems: "start", padding: rem * 0.75 }}>
        <Input
          key={store.composerEpoch}
          ref={inputRef as React.Ref<NodeHandle>}
          style={{ flexGrow: 1, flexBasis: 0 }}
          caretColor={theme.accent}
          selectionColor={theme.selection}
          autoFocus
          onChange={(text, change) => {
            store.composerText = text;
            store.syncComposerMarks(change.marks);
            menus.onChange(text, change);
          }}
          onCaret={(caret) => menus.onCaret(caret)}
          onPasteImage={(image) => {
            const id = store.addComposerImage(image);
            inputRef.current?.insertMark(id);
          }}
          onSubmit={(text, marks) => {
            menus.reset();
            const paths = marks.flatMap((mark) => {
              const image = store.composerImage(mark.id);
              return image ? [{ path: image.path }] : [];
            });
            store.composerText = "";
            store.syncComposerMarks([]);
            store.active().send(text, paths);
          }}
        >
          {attached.map((attachment) => (
            <Input.Widget key={attachment.id} markId={attachment.id}>
              <AttachmentPill path={attachment.path} />
            </Input.Widget>
          ))}
        </Input>
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
        <ModelPicker />
        <Picker
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

function AttachmentPill({ path }: { path: string }) {
  const { theme, rem } = useCtx();
  return (
    <Box
      style={{
        alignItems: "center",
        gap: rem * 0.3,
        padding: { left: rem * 0.25, right: rem * 0.45, top: rem * 0.1, bottom: rem * 0.1 },
        margin: { left: rem * 0.1, right: rem * 0.25 },
        background: theme.chipBg,
        border: { width: Math.max(rem / 16, 1), color: theme.hairline },
        cornerRadius: rem * 0.3,
      }}
    >
      <Image
        src={path}
        style={{ height: rem * 0.85, cornerRadius: rem * 0.15 }}
        placeholder={<Box style={{ background: theme.bgAlt }} />}
      />
      <Text style={{ color: theme.muted, fontSize: rem * 0.75, wrap: false }}>Image</Text>
    </Box>
  );
}

function ModelPicker() {
  const { theme, rem } = useCtx();
  const session = store.active();
  const [open, setOpen] = useState(false);
  const itemPad = { left: rem * 0.6, right: rem * 0.6, top: rem * 0.3, bottom: rem * 0.3 };
  const modelItems = session.modelOptions();
  const thinkingLabel = THINKING[session.thinking].label;
  const label = `${session.model.replace(/^claude-/, "") || "…"} · ${thinkingLabel}`;

  return (
    <Box>
      <PickerChip
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
  color,
  children,
  onClick,
}: {
  color: Rgba;
  children: string;
  onClick: () => void;
}) {
  const { theme, rem } = useCtx();
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
  color,
  label,
  items,
  selected,
  onPick,
  onOpen,
}: {
  color: Rgba;
  label: string;
  items: { value: string; label: string }[];
  selected: string;
  onPick: (value: string) => void;
  onOpen?: () => void;
}) {
  const { theme, rem } = useCtx();
  const [open, setOpen] = useState(false);
  const itemPad = { left: rem * 0.6, right: rem * 0.6, top: rem * 0.3, bottom: rem * 0.3 };
  return (
    <Box>
      <PickerChip
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
