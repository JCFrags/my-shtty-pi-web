export interface NativeEngine {
  info(): string;
  applyOps(ops: string): void;
  start(callback: (err: unknown, event: string) => void): void;
  stop(): void;
}

export type Rgba = [number, number, number, number];

export interface EngineInfo {
  width: number;
  height: number;
  cellWidth: number;
  cellHeight: number;
  basePx: number;
  colors: {
    foreground: Rgba | null;
    background: Rgba | null;
    palette: (Rgba | null)[];
  };
}

export interface HighlightSpan {
  /** Byte offset into the UTF-8 source. */
  start: number;
  end: number;
  /** Index into HIGHLIGHT_CAPTURES. */
  capture: number;
}

export interface DiffEmphasis {
  /** Byte range relative to the row's text, painted as emphasis background. */
  start: number;
  end: number;
}

export interface DiffRow {
  kind: "context" | "del" | "add" | "gap";
  /** 1-based line numbers in each source; absent where the row has no side. */
  oldLine?: number;
  newLine?: number;
  /** Line content without the trailing newline; empty for gap rows. */
  text: string;
  /**
   * Byte offset of text within its side's source (old for "del", new
   * otherwise) — intersect highlight() spans of that source with it.
   */
  sideStart: number;
  emphasis: DiffEmphasis[];
  /** Hidden unchanged line count, only on gap rows. */
  count?: number;
}

// eslint-disable-next-line @typescript-eslint/no-var-requires
const binding = require("../native/pixel.node") as {
  PixelEngine: new () => NativeEngine;
  highlight(source: string, language: string): HighlightSpan[];
  highlightCaptures(): string[];
  diff(oldSource: string, newSource: string, contextLines?: number): DiffRow[];
};

export function createNativeEngine(): NativeEngine {
  return new binding.PixelEngine();
}

/** Tree-sitter syntax highlighting; empty for unknown languages. */
export function highlight(source: string, language: string): HighlightSpan[] {
  return binding.highlight(source, language);
}

export const HIGHLIGHT_CAPTURES: readonly string[] = binding.highlightCaptures();

/** Line diff with word-level emphasis; rows carry byte ranges into each source. */
export function diff(oldSource: string, newSource: string, contextLines?: number): DiffRow[] {
  return binding.diff(oldSource, newSource, contextLines);
}
