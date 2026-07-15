import { useState } from "react";
import { Box, Image, Input, Text } from "pixel-react";
import type { NodeHandle, Rgba } from "pixel-react";

import { menus } from "../menu";
import { PERMISSION_MODES, selectionMarkdown, store, THINKING } from "../session";
import type { SelectionRef } from "../session";
import type { PermissionMode } from "@anthropic-ai/claude-agent-sdk";
import { useCtx } from "../theme";

export function Composer({ inputRef }: { inputRef: React.RefObject<NodeHandle | null> }) {
  const { theme, rem } = useCtx();
  const session = store.active();
  const attached = store.composerMarks.flatMap((mark) => {
    const attachment = store.composerImage(mark.id);
    if (!attachment) return [];
    return [
      {
        id: mark.id,
        src: attachment.durable ?? attachment.image.path,
        equalTo: attachment.durable ? [attachment.image.path] : undefined,
      },
    ];
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
              src={attachment.src}
              style={{
                height: rem * 8,
                cornerRadius: rem * 0.4,
                border: { width: Math.max(rem / 16, 1), color: theme.hairline },
              }}
              placeholder={<Box style={{ background: theme.bgAlt }} />}
              advanced={{ confirmedEqualTo: attachment.equalTo }}
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
          renderMark={renderComposerMark}
          serializeMark={(id) => {
            const selection = store.composerSelection(id);
            if (selection) return JSON.stringify({ kind: "selection", ...selection });
            const attachment = store.composerImage(id);
            if (!attachment) return undefined;
            return JSON.stringify({
              kind: "image",
              path: attachment.durable ?? attachment.image.path,
            });
          }}
          onChange={(text, change) => {
            store.composerText = text;
            store.syncComposerMarks(change.marks);
            menus.onChange(text, change);
          }}
          onCaret={(caret) => menus.onCaret(caret)}
          onPasteImage={(image) => {
            const id = store.addComposerImage(image);
            inputRef.current?.addMark(id);
          }}
          onSubmit={(text, marks) => {
            menus.reset();
            store.composerText = "";
            store.syncComposerMarks([]);
            store.active().send(text, marks);
          }}
        >
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

export function renderComposerMark(id: number): React.ReactNode {
  const selection = store.composerSelection(id);
  if (selection) return <SelectionPill refData={selection} />;
  const attachment = store.composerImage(id);
  if (!attachment) return null;
  return (
    <AttachmentPill
      src={attachment.durable ?? attachment.image.path}
      equalTo={attachment.durable ? [attachment.image.path] : undefined}
    />
  );
}

export function SelectionPill({ refData }: { refData: SelectionRef }) {
  const { theme, rem } = useCtx();
  const snippet = selectionMarkdown(refData).replace(/\s+/g, " ");
  const label = snippet.length > 26 ? `${snippet.slice(0, 25)}…` : snippet;
  return (
    <Box
      style={{
        alignItems: "center",
        gap: rem * 0.3,
        padding: { left: rem * 0.4, right: rem * 0.45, top: rem * 0.1, bottom: rem * 0.1 },
        margin: { left: rem * 0.1, right: rem * 0.25 },
        background: theme.chipBg,
        hoverBackground: theme.itemHover,
        border: { width: Math.max(rem / 16, 1), color: theme.hairline },
        cornerRadius: rem * 0.3,
      }}
      onClick={() => store.revealSelection(refData)}
    >
      <Text style={{ color: theme.accent, fontSize: rem * 0.75, wrap: false }}>“</Text>
      <Text style={{ color: theme.muted, fontSize: rem * 0.75, wrap: false }}>{label}</Text>
    </Box>
  );
}

export function AttachmentPill({ src, equalTo }: { src: string; equalTo?: string[] }) {
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
        src={src}
        style={{ height: rem * 0.85, cornerRadius: rem * 0.15 }}
        placeholder={<Box style={{ background: theme.bgAlt }} />}
        advanced={{ confirmedEqualTo: equalTo }}
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
