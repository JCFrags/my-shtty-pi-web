// Reduced protocol types for the selective AgentCursor port.
export interface Point {
  x: number;
  y: number;
}

export interface Rect extends Point {
  width: number;
  height: number;
}

export interface CursorSample extends Point {
  t: number;
}

export type KeyOp =
  | { t: "key"; ch: string; delayMs: number }
  | { t: "back"; delayMs: number };
