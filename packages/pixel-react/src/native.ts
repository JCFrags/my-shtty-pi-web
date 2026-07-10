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

// eslint-disable-next-line @typescript-eslint/no-var-requires
const binding = require("../native/pixel.node") as {
  PixelEngine: new () => NativeEngine;
};

export function createNativeEngine(): NativeEngine {
  return new binding.PixelEngine();
}
