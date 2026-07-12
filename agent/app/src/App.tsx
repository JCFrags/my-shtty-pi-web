import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Box, diff, HIGHLIGHT_CAPTURES, highlight, Input, Text } from "pixel-react";
import type { EngineInfo, NodeHandle, Rgba, TextSpan } from "pixel-react";

import { useCollection } from "./db/react";
import { PALETTE_ACTIONS } from "./palette";
import { PERMISSION_MODES, store, THINKING } from "./session";
import type { Ask, Item, Session, ToolCall } from "./session";
import type { PermissionMode } from "@anthropic-ai/claude-agent-sdk";
import { makeTheme, Theme } from "./theme";
import { transcript } from "./transcript";

const FONT_MONO = 1;

interface Ctx {
  theme: Theme;
  rem: number;
}

export function App({ info }: { info: EngineInfo }) {
  useSyncExternalStore(store.subscribe, store.snapshot);
  const theme = useMemo(() => makeTheme(info.colors), [info]);
  const rem = info.basePx;
  const ctx = { theme, rem };
  const session = store.active();
  const log = useCollection(session.logRef);
  const items = transcript(session.dbId, session.legacyItems, log.items);

  const list = useRef<NodeHandle | null>(null);
  const input = useRef<NodeHandle | null>(null);
  const follow = useRef(true);
  const lastOffset = useRef(0);

  useEffect(() => {
    follow.current = true;
    list.current?.scrollTo(1e9);
  }, [store.at]);
  useEffect(() => {
    if (follow.current) list.current?.scrollTo(1e9, true);
  });
  useEffect(() => {
    if (session.ask || store.palette) input.current?.blur();
    else input.current?.focus();
  }, [session.ask, store.palette]);

  return (
    <Box
      style={{
        width: "100%",
        height: "100%",
        background: theme.bg,
        color: theme.fg,
        fontSize: rem,
      }}
    >
      {store.sidebar && <Sidebar ctx={ctx} />}
      <Box style={{ flexDirection: "column", flexGrow: 1, flexBasis: 0, overflow: "hidden" }}>
        <Header ctx={ctx} session={session} />
        <Box
          ref={list}
          style={{
            flexDirection: "column",
            flexGrow: 1,
            flexBasis: 0,
            overflow: "scroll",
            padding: rem,
            gap: rem * 0.75,
            selectionMode: "unified",
          }}
          onScroll={(e) => {
            if (e.offset < lastOffset.current - 1) follow.current = false;
            if (e.offset >= e.max - 2) follow.current = true;
            lastOffset.current = e.offset;
          }}
        >
          {items.map((item, i) => (
            <Message key={i} ctx={ctx} item={item} />
          ))}
        </Box>
        {session.ask && <AskBox ctx={ctx} ask={session.ask} />}
        {session.working && <WorkingStatus ctx={ctx} session={session} />}
        <Composer ctx={ctx} inputRef={input} />
      </Box>
      {store.palette && <Palette ctx={ctx} />}
      {store.settings && <Settings ctx={ctx} />}
    </Box>
  );
}

function Palette({ ctx }: { ctx: Ctx }) {
  const { theme, rem } = ctx;
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

function Settings({ ctx }: { ctx: Ctx }) {
  const { theme, rem } = ctx;
  return (
    <Box
      style={{
        position: "absolute",
        inset: { left: 0, right: 0, top: 0, bottom: 0 },
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
      }}
      onClick={() => store.closeSettings()}
    >
      <Box
        style={{
          flexDirection: "column",
          width: rem * 28,
          maxHeight: "80%",
          background: theme.bgAlt,
          border: { width: Math.max(rem / 16, 1), color: theme.hairline },
          cornerRadius: rem * 0.5,
          overflow: "hidden",
        }}
        onClick={() => {}}
      >
        <Box
          style={{
            padding: { left: rem * 0.8, right: rem * 0.8, top: rem * 0.6, bottom: rem * 0.6 },
            border: { bottom: [Math.max(rem / 16, 1), theme.hairline] },
          }}
        >
          <Text style={{ fontSize: rem * 1.1 }}>settings</Text>
        </Box>
        <Box
          style={{
            flexDirection: "column",
            padding: rem * 0.8,
            overflow: "scroll",
          }}
        >
          <Text style={{ color: theme.muted, fontSize: rem * 0.85 }}>general</Text>
        </Box>
      </Box>
    </Box>
  );
}

function Sidebar({ ctx }: { ctx: Ctx }) {
  const { theme, rem } = ctx;
  const hairlineWidth = Math.max(rem / 16, 1);
  const radius = rem * 0.5;
  const innerRadius = radius - hairlineWidth;
  return (
    <Box
      style={{
        width: rem * 13,
        flexShrink: 0,
        margin: { left: rem * 0.4, top: rem * 0.4 },
        background: theme.hairline,
        cornerRadius: radius,
        padding: hairlineWidth,
      }}
    >
      <Box
        style={{
          flexDirection: "column",
          flexGrow: 1,
          padding: { top: rem * 0.4 },
          background: theme.sidebarBg,
          cornerRadius: innerRadius,
        }}
      >
        <Text
          style={{
            padding: { left: rem * 0.6, right: rem * 0.6, top: rem * 0.45, bottom: rem * 0.45 },
            border: { bottom: [hairlineWidth, theme.hairline] },
            color: theme.accent,
            hoverBackground: theme.itemHover,
            cornerRadius: innerRadius,
          }}
          onClick={() => store.add()}
        >
          + new session
        </Text>
        {store.sessions.map((session, i) => (
          <SidebarItem key={i} ctx={ctx} session={session} at={i} />
        ))}
      </Box>
    </Box>
  );
}

function SidebarItem({ ctx, session, at }: { ctx: Ctx; session: Session; at: number }) {
  const { theme, rem } = ctx;
  const active = at === store.at;
  return (
    <Box
      style={{
        alignItems: "center",
        gap: rem * 0.5,
        padding: { left: rem * 0.6, right: rem * 0.6, top: rem * 0.35, bottom: rem * 0.35 },
        background: active ? theme.itemActive : undefined,
        hoverBackground: active ? undefined : theme.itemHover,
        overflow: "hidden",
      }}
      onClick={() => store.select(at)}
    >
      <Text
        style={{
          color: active ? theme.fg : theme.muted,
          flexGrow: 1,
          flexBasis: 0,
          wrap: false,
        }}
      >
        {session.title()}
      </Text>
      {session.working && <Dot ctx={ctx} color={theme.accent} />}
    </Box>
  );
}

function Header({ ctx, session }: { ctx: Ctx; session: Session }) {
  const { theme, rem } = ctx;
  return (
    <Box
      style={{
        alignItems: "center",
        gap: rem * 0.5,
        padding: { left: rem, right: rem, top: rem * 0.5, bottom: rem * 0.5 },
      }}
    />
  );
}

function Message({ ctx, item }: { ctx: Ctx; item: Item }) {
  const { theme, rem } = ctx;
  if (item.kind === "user") {
    return (
      <Box
        style={{
          margin: { left: -rem, right: -rem },
          padding: { left: rem, right: rem, top: rem * 0.5, bottom: rem * 0.5 },
          background: theme.bgAlt,
          border: { top: [1, theme.hairline], bottom: [1, theme.hairline] },
        }}
      >
        <Text>&gt; {item.text}</Text>
      </Box>
    );
  }
  if (item.kind === "tool") {
    return <ToolRow ctx={ctx} call={item.call} />;
  }
  const parts = segments(item.text);
  if (parts.length === 1 && !parts[0].code) {
    return <Text>{parts[0].text}</Text>;
  }
  return (
    <Box style={{ flexDirection: "column", gap: rem * 0.5 }}>
      {parts.map((part, i) =>
        part.code ? (
          <CodeBlock key={i} ctx={ctx} language={part.language} code={part.text} />
        ) : (
          <Text key={i}>{part.text}</Text>
        )
      )}
    </Box>
  );
}

interface Segment {
  code: boolean;
  language: string;
  text: string;
}

// An unclosed fence (mid-stream) renders as a code block to the end of the text.
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
      <Text style={{ font: FONT_MONO, fontSize: rem * 0.9, wrap: false }} spans={spans}>
        {code}
      </Text>
    </Box>
  );
}

function langFromPath(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  const map: Record<string, string> = {
    ts: "typescript",
    tsx: "tsx",
    js: "javascript",
    jsx: "jsx",
    rs: "rust",
    py: "python",
    go: "go",
    rb: "ruby",
    java: "java",
    c: "c",
    cpp: "cpp",
    h: "c",
    hpp: "cpp",
    css: "css",
    scss: "scss",
    html: "html",
    json: "json",
    yaml: "yaml",
    yml: "yaml",
    md: "markdown",
    sh: "bash",
    bash: "bash",
    zsh: "bash",
    toml: "toml",
    sql: "sql",
    swift: "swift",
  };
  return map[ext] ?? "";
}

const MAX_DIFF_ROWS = 14;

interface DiffSources {
  oldSource: string;
  newSource: string;
  path: string;
}

function diffSources(call: ToolCall): DiffSources | null {
  const r = call.result as Record<string, unknown> | null;
  if (!r || typeof r !== "object") return null;
  if (call.name === "Edit") {
    const { originalFile, oldString, newString, replaceAll, filePath } = r as {
      originalFile?: unknown;
      oldString?: unknown;
      newString?: unknown;
      replaceAll?: unknown;
      filePath?: unknown;
    };
    if (
      typeof originalFile !== "string" ||
      typeof oldString !== "string" ||
      typeof newString !== "string"
    ) {
      return null;
    }
    const newSource = replaceAll
      ? originalFile.split(oldString).join(newString)
      : originalFile.replace(oldString, () => newString);
    return { oldSource: originalFile, newSource, path: String(filePath ?? "") };
  }
  if (call.name === "Write") {
    const { originalFile, content, filePath } = r as {
      originalFile?: unknown;
      content?: unknown;
      filePath?: unknown;
    };
    if (typeof content !== "string") return null;
    return {
      oldSource: typeof originalFile === "string" ? originalFile : "",
      newSource: content,
      path: String(filePath ?? ""),
    };
  }
  return null;
}

// Splits syntax spans at emphasis boundaries so emphasized segments keep
// their syntax foreground while gaining the emphasis background.
function overlayEmphasis(
  syntax: TextSpan[],
  emphasis: { start: number; end: number }[],
  background: Rgba,
  fallback: Rgba
): TextSpan[] {
  if (emphasis.length === 0) return syntax;
  const bounds = new Set<number>();
  for (const s of syntax) {
    bounds.add(s.start);
    bounds.add(s.end);
  }
  for (const e of emphasis) {
    bounds.add(e.start);
    bounds.add(e.end);
  }
  const points = [...bounds].sort((a, b) => a - b);
  const out: TextSpan[] = [];
  for (let i = 0; i < points.length - 1; i++) {
    const [start, end] = [points[i], points[i + 1]];
    const emphasized = emphasis.some((e) => e.start <= start && end <= e.end);
    const fg = syntax.find((s) => s.start <= start && end <= s.end);
    if (!emphasized && !fg) continue;
    out.push({
      start,
      end,
      color: fg?.color ?? fallback,
      ...(emphasized ? { background } : {}),
    });
  }
  return out;
}

function DiffCard({ ctx, sources }: { ctx: Ctx; sources: DiffSources }) {
  const { theme, rem } = ctx;
  const [expanded, setExpanded] = useState(false);
  const language = langFromPath(sources.path);
  const { rows, syntax } = useMemo(() => {
    const toSpans = (source: string) =>
      highlight(source, language).map((s) => ({
        start: s.start,
        end: s.end,
        color: theme.syntax[HIGHLIGHT_CAPTURES[s.capture]] ?? theme.fg,
      }));
    return {
      rows: diff(sources.oldSource, sources.newSource, 3),
      syntax: { old: toSpans(sources.oldSource), new: toSpans(sources.newSource) },
    };
  }, [sources, language, theme]);

  const gutterWidth = Math.max(
    2,
    ...rows.map((row) => String(Math.max(row.oldLine ?? 0, row.newLine ?? 0)).length)
  );
  const shown = expanded || rows.length <= MAX_DIFF_ROWS ? rows : rows.slice(0, MAX_DIFF_ROWS);

  return (
    <Box style={{ flexDirection: "column", overflow: "hidden" }}>
      {shown.map((row, i) => {
        if (row.kind === "gap") {
          return (
            <Text
              key={i}
              style={{ color: theme.muted, fontSize: rem * 0.8, font: FONT_MONO }}
            >
              {`${" ".repeat(gutterWidth + 1)}… ${row.count} unchanged lines`}
            </Text>
          );
        }
        const removed = row.kind === "del";
        const added = row.kind === "add";
        const sideSpans = removed ? syntax.old : syntax.new;
        const start = row.sideStart;
        const end = start + Buffer.byteLength(row.text);
        const rowSyntax: TextSpan[] = [];
        for (const s of sideSpans) {
          if (s.end <= start || s.start >= end) continue;
          rowSyntax.push({
            start: Math.max(s.start, start) - start,
            end: Math.min(s.end, end) - start,
            color: s.color,
          });
        }
        const spans = overlayEmphasis(
          rowSyntax,
          row.emphasis,
          removed ? theme.diffRemovedEmphasisBg : theme.diffAddedEmphasisBg,
          theme.fg
        );
        const lineNo = removed ? row.oldLine : row.newLine;
        const sign = removed ? "-" : added ? "+" : " ";
        return (
          <Box
            key={i}
            style={{
              background: removed
                ? theme.diffRemovedBg
                : added
                  ? theme.diffAddedBg
                  : undefined,
            }}
          >
            <Text
              style={{
                color: removed ? theme.red : added ? theme.green : theme.muted,
                font: FONT_MONO,
                fontSize: rem * 0.9,
                flexShrink: 0,
                wrap: false,
              }}
            >
              {`${String(lineNo ?? "").padStart(gutterWidth)} ${sign} `}
            </Text>
            <Text style={{ font: FONT_MONO, fontSize: rem * 0.9, wrap: false }} spans={spans}>
              {row.text || " "}
            </Text>
          </Box>
        );
      })}
      {shown.length < rows.length && (
        <Text
          style={{
            color: theme.muted,
            fontSize: rem * 0.8,
            font: FONT_MONO,
            hoverColor: theme.fg,
          }}
          onClick={() => setExpanded(true)}
        >
          {`${" ".repeat(gutterWidth + 1)}… show ${rows.length - shown.length} more lines`}
        </Text>
      )}
    </Box>
  );
}

function ToolRow({ ctx, call }: { ctx: Ctx; call: ToolCall }) {
  const { theme, rem } = ctx;
  const color =
    call.status === "running"
      ? theme.accent
      : call.status === "ok"
        ? theme.green
        : theme.red;

  const sources = diffSources(call);

  return (
    <Box style={{ flexDirection: "column", gap: rem * 0.25 }}>
      <Box style={{ gap: rem * 0.5, alignItems: "center", overflow: "hidden" }}>
        <Dot ctx={ctx} color={color} />
        <Text style={{ font: FONT_MONO, fontSize: rem * 0.9, flexShrink: 0, wrap: false }}>
          {call.name}
        </Text>
        <Text style={{ color: theme.muted, font: FONT_MONO, fontSize: rem * 0.9, wrap: false }}>
          {call.detail}
        </Text>
      </Box>
      {sources && (
        <Box style={{ margin: { left: rem } }}>
          <DiffCard ctx={ctx} sources={sources} />
        </Box>
      )}
      {call.kids.length > 0 && (
        <Box style={{ flexDirection: "column", gap: rem * 0.25, margin: { left: rem } }}>
          {call.kids.map((kid) => (
            <ToolRow key={kid.id} ctx={ctx} call={kid} />
          ))}
        </Box>
      )}
    </Box>
  );
}

function AskBox({ ctx: { theme, rem }, ask }: { ctx: Ctx; ask: Ask }) {
  return (
    <Box
      style={{
        flexDirection: "column",
        gap: rem * 0.25,
        margin: { left: rem, right: rem, bottom: rem * 0.5 },
        padding: rem * 0.6,
        border: { width: Math.max(rem / 16, 1), color: theme.accent },
        cornerRadius: rem * 0.4,
      }}
    >
      <Box style={{ gap: rem * 0.5, overflow: "hidden" }}>
        <Text style={{ color: theme.accent, font: FONT_MONO, flexShrink: 0 }}>{ask.tool}</Text>
        <Text style={{ color: theme.muted, font: FONT_MONO, wrap: false }}>{ask.detail}</Text>
      </Box>
      <Text style={{ color: theme.muted, fontSize: rem * 0.85 }}>enter allow · esc deny</Text>
    </Box>
  );
}

function WorkingStatus({ ctx, session }: { ctx: Ctx; session: Session }) {
  const { theme, rem } = ctx;
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setFrame((f) => f + 1), 250);
    return () => clearInterval(timer);
  }, []);

  const status = `${session.activity || "working"}${".".repeat(1 + (frame % 3))}`;

  return (
    <Box
      style={{
        alignItems: "center",
        gap: rem * 0.5,
        padding: { left: rem, right: rem, bottom: rem * 0.5 },
      }}
    >
      <Text
        style={{
          color: theme.accent,
          fontSize: rem * 0.85,
          font: FONT_MONO,
          wrap: false,
          flexShrink: 0,
        }}
      >
        {status}
      </Text>
    </Box>
  );
}

function Composer({ ctx: { theme, rem }, inputRef }: { ctx: Ctx; inputRef: React.Ref<NodeHandle> }) {
  const session = store.active();
  return (
    <Box style={{ flexDirection: "column", flexShrink: 0 }}>
      <Box style={{ height: Math.max(rem / 16, 1), width: "100%", background: theme.hairline }} />
      <Box style={{ alignItems: "start", padding: rem * 0.75 }}>
        <Input
          ref={inputRef}
          style={{ flexGrow: 1, flexBasis: 0 }}
          caretColor={theme.accent}
          selectionColor={theme.selection}
          autoFocus
          onSubmit={(text) => {
            const trimmed = text.trim();
            if (trimmed) store.active().send(trimmed);
          }}
        />
      </Box>
      <Box
        style={{
          alignItems: "center",
          gap: rem * 0.5,
          padding: { left: rem, right: rem },
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
                fontSize: rem * 0.85,
                font: FONT_MONO,
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
                fontSize: rem * 0.85,
                font: FONT_MONO,
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
              fontSize: rem * 0.7,
              font: FONT_MONO,
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
                fontSize: rem * 0.85,
                font: FONT_MONO,
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
                fontSize: rem * 0.85,
                font: FONT_MONO,
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
                fontSize: rem * 0.85,
                font: FONT_MONO,
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

function Dot({ ctx: { rem }, color }: { ctx: Ctx; color: Rgba }) {
  return (
    <Box
      style={{
        width: rem * 0.45,
        height: rem * 0.45,
        cornerRadius: 999,
        background: color,
        flexShrink: 0,
      }}
    />
  );
}

function Chip({ ctx: { theme, rem }, color, children }: { ctx: Ctx; color: Rgba; children: string }) {
  return (
    <Text
      style={{
        padding: { left: rem * 0.6, right: rem * 0.6, top: rem * 0.15, bottom: rem * 0.15 },
        cornerRadius: 999,
        background: theme.chipBg,
        color,
        fontSize: rem * 0.85,
        font: FONT_MONO,
        flexShrink: 0,
        wrap: false,
      }}
    >
      {children}
    </Text>
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
        fontSize: rem * 0.85,
        font: FONT_MONO,
        flexShrink: 0,
        wrap: false,
      }}
      onClick={onClick}
    >
      {children}
    </Text>
  );
}
