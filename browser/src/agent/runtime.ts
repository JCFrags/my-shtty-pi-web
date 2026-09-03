import { randomUUID } from "node:crypto";

import type { ActionService, BrowserDriver, Point } from "agentcursor" with {
  "resolution-mode": "import",
};

import { PageObserver } from "./page-observer";
import { TerminalBrowserDriver } from "./terminal-browser-driver";
import type {
  AgentActionService,
  AgentBrowserTarget,
  AgentClickRequest,
  AgentClickResult,
  AgentObservation,
  AgentPageObserver,
} from "./types";

export interface BrowserAgentRuntimeOptions {
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
  readonly controlState = "agent" as const;
  readonly observer: AgentPageObserver;
  readonly driver: BrowserDriver;
  private readonly actionServiceFactory: (driver: BrowserDriver) => Promise<AgentActionService>;
  private readonly observationId: () => string;
  private latestObservation: AgentObservation | null = null;
  private readonly epoch = 1;
  private actionService: Promise<AgentActionService> | null = null;

  constructor(
    private readonly target: AgentBrowserTarget,
    options: BrowserAgentRuntimeOptions = {},
  ) {
    this.observer = options.observer ?? new PageObserver(target);
    this.driver = options.driver ?? new TerminalBrowserDriver(target, this.observer);
    this.actionServiceFactory = options.actionServiceFactory ?? defaultActionServiceFactory;
    this.observationId = options.observationId ?? randomUUID;
  }

  get controlEpoch(): number {
    return this.epoch;
  }

  async observe(maxElements = 200, includeText = true): Promise<AgentObservation> {
    const page = await this.observer.observe(maxElements, includeText);
    const observation: AgentObservation = {
      observationId: this.observationId(),
      documentId: page.documentId,
      controlEpoch: this.epoch,
      snapshot: page.snapshot,
    };
    this.latestObservation = observation;
    return observation;
  }

  invalidateDocument(): void {
    this.latestObservation = null;
  }

  async click(request: AgentClickRequest): Promise<AgentClickResult> {
    const observation = this.latestObservation;
    if (!observation || observation.observationId !== request.observationId) {
      throw new Error("stale or unknown observation");
    }
    if (request.expectedControlEpoch !== this.epoch) {
      throw new Error("stale control epoch");
    }
    const documentId = await this.observer.currentDocumentId();
    if (documentId !== observation.documentId) {
      throw new Error("page changed since observation");
    }
    const action = await this.actionServiceInstance();
    const point: Point = await action.click({ ref: request.ref });
    return {
      ref: request.ref,
      point,
      documentId,
      controlEpoch: this.epoch,
      url: this.target.currentUrl(),
    };
  }

  private actionServiceInstance(): Promise<AgentActionService> {
    return (this.actionService ??= this.actionServiceFactory(this.driver));
  }
}
