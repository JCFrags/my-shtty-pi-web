import { EventEmitter } from "node:events";
import { PROTOCOL_VERSION, type ActorIdentity, type FrameEvent, type TabAddress } from "@webx/browser-protocol";
import type { BrowserArtifactStore } from "../artifacts/store.js";
import type { SessionMotor } from "../motor/session-motor.js";
import type { TargetRegistry, TabRecord } from "../targets/registry.js";

interface TabSchedule {
  readonly address: TabAddress;
  subscribers: number;
  activeActions: number;
  interest: "idle" | "selected";
  captureInFlight: boolean;
  captureRequested: boolean;
  lastCaptureStartedMs: number;
  timer?: NodeJS.Timeout;
}

export interface FrameSchedulerOptions { idleIntervalMs?: number; selectedIntervalMs?: number; burstIntervalMs?: number }

export class FrameScheduler extends EventEmitter {
  private readonly schedules = new Map<string, TabSchedule>();
  private readonly latest = new Map<string, FrameEvent>();
  private readonly idleIntervalMs: number;
  private readonly selectedIntervalMs: number;
  private readonly burstIntervalMs: number;
  droppedFrames = 0;
  private closed = false;

  constructor(private readonly actor: ActorIdentity, private readonly registry: TargetRegistry, private readonly artifacts: BrowserArtifactStore, private readonly motor: SessionMotor, options: FrameSchedulerOptions = {}) {
    super();
    this.idleIntervalMs = options.idleIntervalMs ?? 2_000;
    this.selectedIntervalMs = options.selectedIntervalMs ?? 500;
    this.burstIntervalMs = options.burstIntervalMs ?? 100;
    motor.on("actionStart", this.onActionStart);
    motor.on("actionEnd", this.onActionEnd);
    motor.on("sample", this.onSample);
  }

  subscribe(address: TabAddress, interest: "idle" | "selected" = "selected"): void {
    const tab = this.registry.resolve(address);
    const schedule = this.schedule(tab, address);
    schedule.interest = interest;
    schedule.subscribers++;
    this.arm(schedule, 0);
  }

  unsubscribe(address: TabAddress): void {
    const schedule = this.schedules.get(address.tabId);
    if (schedule === undefined || !sameAddress(schedule.address, address)) return;
    schedule.subscribers = Math.max(0, schedule.subscribers - 1);
    if (schedule.subscribers === 0 && schedule.activeActions === 0) this.stop(address.tabId);
  }

  latestFrame(tabId: string): FrameEvent | undefined { return this.latest.get(tabId); }

  stop(tabId: string): void {
    const schedule = this.schedules.get(tabId);
    if (schedule?.timer) clearTimeout(schedule.timer);
    this.schedules.delete(tabId);
    this.latest.delete(tabId);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.motor.off("actionStart", this.onActionStart);
    this.motor.off("actionEnd", this.onActionEnd);
    this.motor.off("sample", this.onSample);
    for (const tabId of [...this.schedules.keys()]) this.stop(tabId);
  }

  private readonly onActionStart = ({ tabId }: { tabId: string }): void => {
    const schedule = this.schedules.get(tabId);
    if (schedule === undefined) return;
    schedule.activeActions++;
    this.arm(schedule, 0);
  };
  private readonly onActionEnd = ({ tabId }: { tabId: string }): void => {
    const schedule = this.schedules.get(tabId);
    if (schedule === undefined) return;
    schedule.activeActions = Math.max(0, schedule.activeActions - 1);
    if (schedule.subscribers === 0 && schedule.activeActions === 0) this.stop(tabId);
  };
  private readonly onSample = ({ tabId }: { tabId: string }): void => {
    const schedule = this.schedules.get(tabId);
    if (schedule !== undefined && schedule.activeActions > 0) this.arm(schedule, 0);
  };

  private schedule(tab: TabRecord, address: TabAddress): TabSchedule {
    const existing = this.schedules.get(tab.tabId);
    if (existing !== undefined) return existing;
    const schedule: TabSchedule = { address: { ...address }, subscribers: 0, activeActions: 0, interest: "selected", captureInFlight: false, captureRequested: false, lastCaptureStartedMs: 0 };
    this.schedules.set(tab.tabId, schedule);
    return schedule;
  }

  private arm(schedule: TabSchedule, delay?: number): void {
    if (this.closed) return;
    if (schedule.timer) clearTimeout(schedule.timer);
    const interval = delay ?? this.interval(schedule);
    schedule.timer = setTimeout(() => { delete schedule.timer; void this.capture(schedule); }, interval);
  }

  private interval(schedule: TabSchedule): number {
    if (schedule.activeActions > 0) return this.burstIntervalMs;
    return schedule.interest === "idle" ? this.idleIntervalMs : this.selectedIntervalMs;
  }

  private async capture(schedule: TabSchedule): Promise<void> {
    if (this.closed || (schedule.subscribers === 0 && schedule.activeActions === 0)) return;
    if (schedule.captureInFlight) { schedule.captureRequested = true; this.droppedFrames++; return; }
    const elapsed = performance.now() - schedule.lastCaptureStartedMs;
    const minimum = this.interval(schedule);
    if (elapsed < minimum) { this.arm(schedule, minimum - elapsed); return; }
    const tab = this.registry.getById(schedule.address.tabId);
    if (tab === undefined || tab.state !== "open" || tab.targetId !== schedule.address.targetId) { this.stop(schedule.address.tabId); return; }
    schedule.captureInFlight = true;
    schedule.lastCaptureStartedMs = performance.now();
    try {
      await this.motor.ensureOverlay(tab);
      const capturedMonotonicMs = performance.now();
      const result = await frameConnection(tab).send<{ data: string }>("Page.captureScreenshot", { format: "png", fromSurface: true, captureBeyondViewport: false }, tab.cdpSessionId);
      const bytes = Buffer.from(result.data, "base64");
      const artifact = await this.artifacts.put(this.actor, bytes, "image/png");
      const frame: FrameEvent = {
        protocolVersion: PROTOCOL_VERSION, kind: "frame.available", address: { ...schedule.address },
        documentGeneration: tab.documentGeneration, viewportGeneration: tab.viewportGeneration,
        frameSequence: this.registry.incrementFrame(tab), capturedMonotonicMs, publishedMonotonicMs: performance.now(),
        mediaType: "image/png", artifactId: artifact.artifactId, sha256: artifact.sha256, cursor: this.motor.state,
      };
      this.latest.set(tab.tabId, frame);
      this.emit("frame", frame);
    } catch { if (tab.state !== "open") this.stop(tab.tabId); }
    finally {
      schedule.captureInFlight = false;
      if (schedule.captureRequested) { schedule.captureRequested = false; this.arm(schedule, 0); }
      else this.arm(schedule);
    }
  }
}

const connections = new WeakMap<TabRecord, { send<T>(method: string, params: Readonly<Record<string, unknown>>, sessionId: string): Promise<T> }>();
export function bindFrameTab(tab: TabRecord, connection: { send<T>(method: string, params: Readonly<Record<string, unknown>>, sessionId: string): Promise<T> }): void { connections.set(tab, connection); }
function frameConnection(tab: TabRecord) { const connection = connections.get(tab); if (connection === undefined) throw new Error("Tab has no CDP connection."); return connection; }
function sameAddress(left: TabAddress, right: TabAddress): boolean { return left.browserSessionId === right.browserSessionId && left.tabId === right.tabId && left.targetId === right.targetId && left.controlEpoch === right.controlEpoch; }
