import { useMemo, useState } from "react";
import { Box, diff, HIGHLIGHT_CAPTURES, highlight, Text } from "pixel-react";
import type { Rgba, TextSpan } from "pixel-react";

import type { ToolCall } from "../session";
import { useCtx } from "../theme";

const MAX_DIFF_ROWS = 14;

export interface DiffSources {
  oldSource: string;
  newSource: string;
  path: string;
}

export function diffSources(call: ToolCall): DiffSources | null {
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

export function DiffCard({ sources }: { sources: DiffSources }) {
  const { theme } = useCtx();
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
    <Box style={{ flexDirection: "column", flexGrow: 1, flexBasis: 0, overflow: "hidden" }}>
      {shown.map((row, i) => {
        if (row.kind === "gap") {
          return (
            <Text
              key={i}
              style={{ color: theme.muted }}
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
                flexShrink: 0,
                wrap: false,
              }}
            >
              {`${String(lineNo ?? "").padStart(gutterWidth)} ${sign} `}
            </Text>
            <Text style={{ wrap: false }} spans={spans}>
              {row.text || " "}
            </Text>
          </Box>
        );
      })}
      {shown.length < rows.length && (
        <Text
          style={{
            color: theme.muted,
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
