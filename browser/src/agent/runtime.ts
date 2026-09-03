import { randomUUID } from "node:crypto";

import type { ActionService, BrowserDriver, Point } from "agentcursor" with {
  "resolution-mode": "import",
};

import { PageObserver } from "./page-observer";
import { TerminalBrowserDriver } from "./terminal-browser-driver";
import type { BrowserControl } from "./control";
import type {
  AgentActionService,
  AgentActivity,
  AgentBrowserTarget,
  AgentClickRequest,
  AgentClickResult,
  AgentObservation,
  AgentPageObserver,
} from "./types";

export interface BrowserAgentRuntimeOptions {
  control: BrowserControl;
  onActivityChange?: (activity: AgentActivity | null) => void;
  observer?: AgentPageObserver;
  driver?: BrowserDriver;
  actionServiceFactory?: (driver: BrowserDriver) => Promise<AgentActionService>;
  observationId?: () => string;
}

type AgentCursorModule = typeof import("agentcursor", {
  with: { "resolution-mode": "import" },
});
let agentCursorModule: Promise<AgentCursorModule> | null = null;

function loadAgentCursor(): Promise<AgentCursorModule> {
  return (agentCursorModule ??= import("agentcursor"));
}

async function defaultActionServiceFactory(driver: BrowserDriver): Promise<AgentActionService> {
  const { ActionService } = await loadAgentCursor();
  return new ActionService(driver);
}

export class BrowserAgentRuntime {
  readonly observer: AgentPageObserver;
  readonly driver: BrowserDriver;
  private readonly control: BrowserControl;
  private readonly onActivityChange: (activity: AgentActivity | null) => void;
  private readonly actionServiceFactory: (driver: BrowserDriver) => Promise<AgentActionService>;
  private readonly observationId: () => string;
  private latestObservation: AgentObservation | null = null;
  private actionService: Promise<AgentActionService> | null = null;
  private operationQueue: Promise<void> = Promise.resolve();
  private documentGeneration = 0;
  private activeClick: {
    observationId: string;
    documentGeneration: number;
    controlEpoch: number;
  } | null = null;
  private activityValue: AgentActivity | null = null;
  private pulseTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly target: AgentBrowserTarget,
    options: BrowserAgentRuntimeOptions,
  ) {
    this.control = options.control;
    this.onActivityChange = options.onActivityChange ?? (() => {});
    this.observer = options.observer ?? new PageObserver(target);
    this.driver = options.driver ?? new TerminalBrowserDriver(target, this.observer, {
      beforeInput: () => this.assertClickInput(),
      onPointer: (event) => this.updateActivity(event),
      onTarget: (point) => this.updateTarget(point),
    });
    this.actionServiceFactory = options.actionServiceFactory ?? defaultActionServiceFactory;
    this.observationId = options.observationId ?? randomUUID;
  }

  get controlEpoch(): number {
    return this.control.snapshot.controlEpoch;
  }

  get activity(): AgentActivity | null {
    if (!this.activityValue) return null;
    return {
      ...this.activityValue,
      cursor: this.activityValue.cursor ? { ...this.activityValue.cursor } : null,
      target: this.activityValue.target ? { ...this.activityValue.target } : null,
    };
  }

  async observe(maxElements = 200, includeText = true): Promise<AgentObservation> {
    return this.enqueue(async () => {
      const controlEpoch = this.control.assertAgent().controlEpoch;
      const documentGeneration = this.documentGeneration;
      const page = await this.observer.observe(maxElements, includeText);
      this.control.assertAgent(controlEpoch);
      if (documentGeneration !== this.documentGeneration) {
        throw new Error("page changed during observation");
      }
      const observation: AgentObservation = {
        observationId: this.observationId(),
        documentId: page.documentId,
        controlEpoch,
        snapshot: page.snapshot,
      };
      this.latestObservation = observation;
      return observation;
    });
  }

  invalidateDocument(): void {
    this.documentGeneration += 1;
    this.latestObservation = null;
    try {
      this.target.releaseAgentPointer();
    } catch {}
    this.clearActivity();
  }

  invalidateControl(): void {
    this.documentGeneration += 1;
    this.latestObservation = null;
    this.clearActivity();
  }

  async click(request: AgentClickRequest): Promise<AgentClickResult> {
    return this.enqueue(async () => {
      const observation = this.latestObservation;
      this.assertObservation(observation, request);
      const controlEpoch = request.expectedControlEpoch;
      const action = await this.actionServiceInstance();
      this.assertObservation(observation, request);
      const documentId = await this.observer.currentDocumentId();
      this.assertObservation(observation, request);
      if (documentId !== observation.documentId) {
        throw new Error("page changed since observation");
      }
      const click = {
        observationId: observation.observationId,
        documentGeneration: this.documentGeneration,
        controlEpoch,
      };
      this.activeClick = click;
      try {
        this.assertClickInput();
        const point: Point = await action.click({ ref: request.ref });
        this.assertObservation(observation, request);
        const finalDocumentId = await this.observer.currentDocumentId();
        this.assertObservation(observation, request);
        if (finalDocumentId !== observation.documentId) {
          throw new Error("page changed since observation");
        }
        return {
          ref: request.ref,
          point,
          documentId: finalDocumentId,
          controlEpoch,
          url: this.target.currentUrl(),
        };
      } finally {
        if (this.activeClick === click) this.activeClick = null;
        this.clearTarget();
      }
    });
  }

  private actionServiceInstance(): Promise<AgentActionService> {
    return (this.actionService ??= this.actionServiceFactory(this.driver));
  }

  private assertObservation(
    observation: AgentObservation | null,
    request: AgentClickRequest,
  ): asserts observation is AgentObservation {
    if (
      !observation ||
      this.latestObservation !== observation ||
      observation.observationId !== request.observationId
    ) {
      throw new Error("stale or unknown observation");
    }
    this.control.assertAgent(request.expectedControlEpoch);
  }

  private updateActivity(event: import("../page/input").ProgrammaticPointerEvent) {
    if (!this.currentClickActivity()) return;
    const previous = this.activityValue;
    this.activityValue = {
      cursor: { x: event.x, y: event.y },
      target: previous?.target ?? null,
      pulse: event.kind === "down" || previous?.pulse === true,
    };
    if (event.kind === "down") this.startPulse();
    this.emitActivity();
  }

  private updateTarget(point: Point) {
    if (!this.currentClickActivity()) return;
    const previous = this.activityValue;
    this.activityValue = {
      cursor: previous?.cursor ?? null,
      target: { ...point },
      pulse: true,
    };
    this.startPulse();
    this.emitActivity();
  }

  private currentClickActivity(): boolean {
    const click = this.activeClick;
    return (
      !!click &&
      click.controlEpoch === this.control.snapshot.controlEpoch &&
      this.control.state === "agent" &&
      click.documentGeneration === this.documentGeneration &&
      this.latestObservation?.observationId === click.observationId
    );
  }

  private clearTarget() {
    if (!this.activityValue || !this.activityValue.target) return;
    this.activityValue = { ...this.activityValue, target: null };
    this.emitActivity();
  }

  private startPulse() {
    if (this.pulseTimer) clearTimeout(this.pulseTimer);
    this.pulseTimer = setTimeout(() => {
      this.pulseTimer = null;
      if (!this.activityValue) return;
      this.activityValue = { ...this.activityValue, pulse: false };
      this.emitActivity();
    }, 450);
  }

  private clearActivity() {
    if (this.pulseTimer) {
      clearTimeout(this.pulseTimer);
      this.pulseTimer = null;
    }
    if (!this.activityValue) return;
    this.activityValue = null;
    this.emitActivity();
  }

  private emitActivity() {
    this.onActivityChange(this.activity);
  }

  private assertClickInput(): void {
    const click = this.activeClick;
    if (!click) throw new Error("page changed since observation");
    this.control.assertAgent(click.controlEpoch);
    if (
      this.documentGeneration !== click.documentGeneration ||
      this.latestObservation?.observationId !== click.observationId
    ) {
      throw new Error("page changed since observation");
    }
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.operationQueue;
    let release!: () => void;
    this.operationQueue = new Promise<void>((resolve) => {
      release = resolve;
    });
    return previous.then(operation).finally(release);
  }
}
