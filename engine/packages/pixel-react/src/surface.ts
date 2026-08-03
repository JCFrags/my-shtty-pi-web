import type { DamageRect, NativeEngine } from "./native";

type Damaged = { damage?: DamageRect };

export type SurfaceFrame =
  | ({ bgra: Buffer; width: number; height: number } & Damaged) // i think we want to kilt the case of passing the raw pixels to react, there's never a case that I know of
  | ({ ioSurface: Buffer } & Damaged);

export class Surface {
  private readonly id: number;
  private readonly engine: NativeEngine;
  private closed = false;

  constructor(engine: NativeEngine, id: number) {
    this.engine = engine;
    this.id = id;
  }

  present(frame: SurfaceFrame): void {
    if (this.closed) return;
    if ("ioSurface" in frame) {
      const submit = this.engine.updateSurfaceTexture;
      if (!submit) throw new Error("IOSurface frames are not supported on this platform");
      submit.call(this.engine, this.id, frame.ioSurface, frame.damage);
    } else {
      this.engine.updateSurface(this.id, frame.bgra, frame.width, frame.height, frame.damage);
    }
  }

  clear(): void {
    if (this.closed) return;
    this.engine.removeSurface(this.id);
  }

  startCapture(dir: string): SurfaceCapture {
    return new SurfaceCapture(this.engine, this.engine.startSurfaceCapture(this.id, dir));
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.engine.removeSurface(this.id);
  }
}

export interface CaptureStats {
  frames: number;
  drops: number;
  durationMs: number;
}

export interface CaptureFrameMeta {
  tMs: number;
  key: boolean;
  width: number;
  height: number;
  dropsBefore: number;
}

export interface CaptureIndex {
  frames: CaptureFrameMeta[];
  drops: number;
  durationMs: number;
}

export class SurfaceCapture {
  private readonly engine: NativeEngine;
  readonly id: number;

  constructor(engine: NativeEngine, id: number) {
    this.engine = engine;
    this.id = id;
  }

  stop(): CaptureStats {
    return JSON.parse(this.engine.stopSurfaceCapture(this.id)) as CaptureStats;
  }

  index(): CaptureIndex {
    return JSON.parse(this.engine.captureIndex(this.id)) as CaptureIndex;
  }

  frame(index: number): Buffer {
    return this.engine.captureFrame(this.id, index);
  }

  release(): void {
    this.engine.releaseCapture(this.id);
  }
}

export function surfaceId(surface: Surface): number {
  return (surface as unknown as { id: number }).id;
}
