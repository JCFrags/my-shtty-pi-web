import { INTERACTION_STYLE } from "./interaction-profile";

export type AgentControlState = "agent" | "human" | "paused";

export type AgentControlReason =
  | "pointer"
  | "wheel"
  | "keyboard"
  | "paste"
  | "navigation"
  | "tabs"
  | "devtools"
  | "manual-pause"
  | "manual-resume";

export interface AgentControlSnapshot {
  state: AgentControlState;
  controlEpoch: number;
  reason: AgentControlReason | null;
  busy: boolean;
  interactionStyle: typeof INTERACTION_STYLE;
}

export interface AgentControlTransition {
  previous: AgentControlSnapshot;
  current: AgentControlSnapshot;
}

export interface BrowserControlOptions {
  beforeResume?: () => void;
  onTransition?: (transition: AgentControlTransition) => void;
  onChange?: (snapshot: AgentControlSnapshot) => void;
}

export class BrowserControl {
  private currentValue: AgentControlSnapshot = {
    state: "agent",
    controlEpoch: 1,
    reason: null,
    busy: false,
    interactionStyle: INTERACTION_STYLE,
  };
  private mutationTail: Promise<void> = Promise.resolve();
  private readonly listeners = new Set<(snapshot: AgentControlSnapshot) => void>();
  private readonly options: BrowserControlOptions;

  constructor(options: BrowserControlOptions = {}) {
    this.options = options;
  }

  get snapshot(): AgentControlSnapshot {
    return { ...this.currentValue };
  }

  get state(): AgentControlState {
    return this.currentValue.state;
  }

  get controlEpoch(): number {
    return this.currentValue.controlEpoch;
  }

  get busy(): boolean {
    return this.currentValue.busy;
  }

  subscribe(listener: (snapshot: AgentControlSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  takeHuman(reason: Exclude<AgentControlReason, "manual-pause" | "manual-resume">): AgentControlSnapshot {
    return this.transition("human", reason);
  }

  pause(expectedEpoch: number): AgentControlSnapshot {
    this.assertExpectedEpoch(expectedEpoch);
    if (this.currentValue.state === "paused") return this.snapshot;
    return this.transition("paused", "manual-pause");
  }

  resume(expectedEpoch: number): AgentControlSnapshot {
    this.assertExpectedEpoch(expectedEpoch);
    if (this.currentValue.state === "agent") return this.snapshot;
    try {
      this.options.beforeResume?.();
    } catch {}
    return this.transition("agent", "manual-resume");
  }

  assertAgent(expectedEpoch?: number): AgentControlSnapshot {
    if (expectedEpoch !== undefined) this.assertExpectedEpoch(expectedEpoch);
    if (this.currentValue.state !== "agent") {
      throw new Error(`agent control is ${this.currentValue.state}`);
    }
    return this.snapshot;
  }

  async runMutation<T>(expectedEpoch: number, operation: () => Promise<T>): Promise<T> {
    const previous = this.mutationTail;
    let release!: () => void;
    const slot = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.mutationTail = previous.then(() => slot);
    return previous.then(async () => {
      try {
        this.assertAgent(expectedEpoch);
        this.setBusy(true);
        try {
          this.assertAgent(expectedEpoch);
          return await operation();
        } finally {
          this.setBusy(false);
        }
      } finally {
        release();
      }
    });
  }

  private assertExpectedEpoch(expectedEpoch: number) {
    if (expectedEpoch !== this.currentValue.controlEpoch) {
      throw new Error("stale control epoch");
    }
  }

  private setBusy(busy: boolean) {
    if (this.currentValue.busy === busy) return;
    this.currentValue = { ...this.currentValue, busy };
    this.notifyChange();
  }

  private transition(state: AgentControlState, reason: AgentControlReason): AgentControlSnapshot {
    if (this.currentValue.state === state) return this.snapshot;
    const previous = this.snapshot;
    this.currentValue = {
      ...this.currentValue,
      state,
      controlEpoch: this.currentValue.controlEpoch + 1,
      reason,
    };
    const current = this.snapshot;
    try {
      this.options.onTransition?.({ previous, current });
    } catch {}
    this.notifyChange();
    return current;
  }

  private notifyChange() {
    const snapshot = this.snapshot;
    try {
      this.options.onChange?.(snapshot);
    } catch {}
    for (const listener of this.listeners) {
      try {
        listener(snapshot);
      } catch {}
    }
  }
}
