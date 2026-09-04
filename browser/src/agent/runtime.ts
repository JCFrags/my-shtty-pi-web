import { randomUUID } from "node:crypto";

import type { ActionService, BrowserDriver, Point } from "agentcursor" with {
  "resolution-mode": "import",
};

import { PageObserver } from "./page-observer";
import { parseAgentKey } from "./key";
import { TerminalBrowserDriver } from "./terminal-browser-driver";
import type { BrowserControl } from "./control";
import type {
  AgentActionService,
  AgentActivity,
  AgentBrowserTarget,
  AgentClickRequest,
  AgentClickResult,
  AgentDragRequest,
  AgentDragResult,
  AgentGetUrlRequest,
  AgentGetUrlResult,
  AgentHoverRequest,
  AgentHoverResult,
  AgentNavigateRequest,
  AgentNavigateResult,
  AgentObservation,
  AgentObserveRequest,
  AgentPageObserver,
  AgentPressKeyRequest,
  AgentPressKeyResult,
  AgentScrollRequest,
  AgentScrollResult,
  AgentTypeRequest,
  AgentTypeResult,
  AgentWaitForRequest,
  AgentWaitForResult,
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

type AgentOperationKind =
  | "click"
  | "hover"
  | "drag"
  | "type"
  | "press-key"
  | "scroll"
  | "navigate"
  | "get-url"
  | "wait-for";

interface AgentOperation {
  kind: AgentOperationKind;
  controlEpoch: number;
  documentGeneration: number;
  observationId?: string;
  allowDocumentChange: boolean;
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
  private activeOperation: AgentOperation | null = null;
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
      beforeInput: () => this.assertOperationInput(),
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

  async observe(options: Partial<AgentObserveRequest> = {}): Promise<AgentObservation> {
    return this.enqueue(async () => {
      const controlEpoch = this.control.assertAgent().controlEpoch;
      const documentGeneration = this.documentGeneration;
      const maxElements = options.maxElements ?? 200;
      const includeText = options.includeText ?? true;
      const view = options.view ?? "semantic";
      const scope = options.scope ?? "viewport";
      const page = await this.observer.observe(maxElements, includeText);
      this.control.assertAgent(controlEpoch);
      if (documentGeneration !== this.documentGeneration) {
        throw new Error("page changed during observation");
      }
      let visual: AgentObservation["visual"];
      if (view !== "semantic") {
        const viewport = page.snapshot.viewport;
        let rect = { x: 0, y: 0, width: viewport.width, height: viewport.height };
        if (scope === "element") {
          if (!options.ref) throw new Error("element visual observation needs a ref");
          const element = page.snapshot.elements.find((candidate) => candidate.ref === options.ref);
          if (!element) throw new Error("stale or unknown ref");
          if (!element.visible || !element.inViewport) throw new Error("element is outside the current viewport");
          rect = clipRect(element.rect, viewport);
        }
        const data = await this.target.capturePage(scope === "element" ? rect : undefined);
        this.control.assertAgent(controlEpoch);
        if (documentGeneration !== this.documentGeneration ||
            await this.observer.currentDocumentId() !== page.documentId) {
          throw new Error("page changed during observation");
        }
        const dimensions = pngDimensions(data);
        visual = {
          mimeType: "image/png",
          width: dimensions.width,
          height: dimensions.height,
          bytes: data.byteLength,
          scope,
          rect,
          data,
        };
      }
      const observation: AgentObservation = {
        observationId: this.observationId(),
        documentId: page.documentId,
        controlEpoch,
        snapshot: page.snapshot,
        ...(visual ? { visual } : {}),
      };
      this.latestObservation = observation;
      return observation;
    });
  }

  invalidateDocument(): void {
    this.documentGeneration += 1;
    this.latestObservation = null;
    try {
      this.target.releaseAgentInput();
    } catch {}
    this.clearActivity();
  }

  invalidateControl(): void {
    this.documentGeneration += 1;
    this.latestObservation = null;
    try {
      this.target.releaseAgentInput();
    } catch {}
    this.clearActivity();
  }

  clearActivity(): void {
    if (this.pulseTimer) {
      clearTimeout(this.pulseTimer);
      this.pulseTimer = null;
    }
    if (!this.activityValue) return;
    this.activityValue = null;
    this.emitActivity();
  }

  async click(request: AgentClickRequest): Promise<AgentClickResult> {
    return this.enqueue(async () => {
      const observation = this.latestObservation;
      this.assertObservation(observation, request.observationId, request.expectedControlEpoch);
      const action = await this.actionServiceInstance();
      this.assertObservation(observation, request.observationId, request.expectedControlEpoch);
      const documentId = await this.observer.currentDocumentId();
      this.assertObservation(observation, request.observationId, request.expectedControlEpoch);
      if (documentId !== observation.documentId) {
        throw new Error("page changed since observation");
      }
      const operation = this.installOperation({
        kind: "click",
        controlEpoch: request.expectedControlEpoch,
        documentGeneration: this.documentGeneration,
        observationId: observation.observationId,
        allowDocumentChange: false,
      });
      try {
        this.assertOperationInput();
        const point: Point = await action.click({ ref: request.ref });
        this.assertOperation(operation);
        const finalDocumentId = await this.observer.currentDocumentId();
        this.assertOperation(operation);
        if (finalDocumentId !== observation.documentId) {
          throw new Error("page changed since observation");
        }
        return {
          ref: request.ref,
          point,
          documentId: finalDocumentId,
          controlEpoch: request.expectedControlEpoch,
          url: this.target.currentUrl(),
        };
      } catch (error) {
        this.rethrowOperationError(operation, error);
      } finally {
        this.clearOperation(operation);
        this.clearTarget();
      }
    });
  }

  async hover(request: AgentHoverRequest): Promise<AgentHoverResult> {
    return this.enqueue(async () => {
      const observation = this.latestObservation;
      this.assertObservation(observation, request.observationId, request.expectedControlEpoch);
      this.assertActionTarget(observation, request.target);
      const action = await this.actionServiceInstance();
      this.assertObservation(observation, request.observationId, request.expectedControlEpoch);
      const documentId = await this.observer.currentDocumentId();
      this.assertObservation(observation, request.observationId, request.expectedControlEpoch);
      if (documentId !== observation.documentId) throw new Error("page changed since observation");
      const operation = this.installOperation({
        kind: "hover",
        controlEpoch: request.expectedControlEpoch,
        documentGeneration: this.documentGeneration,
        observationId: observation.observationId,
        allowDocumentChange: false,
      });
      try {
        this.resetPulse();
        this.assertOperationInput();
        await action.hover(request.target);
        this.assertOperation(operation);
        const finalDocumentId = await this.observer.currentDocumentId();
        this.assertOperation(operation);
        if (finalDocumentId !== observation.documentId) throw new Error("page changed since observation");
        return {
          point: await this.driver.cursorState(),
          documentId: finalDocumentId,
          controlEpoch: request.expectedControlEpoch,
          url: this.target.currentUrl(),
        };
      } catch (error) {
        this.rethrowOperationError(operation, error);
      } finally {
        this.clearOperation(operation);
      }
    });
  }

  async drag(request: AgentDragRequest): Promise<AgentDragResult> {
    return this.enqueue(async () => {
      const observation = this.latestObservation;
      this.assertObservation(observation, request.observationId, request.expectedControlEpoch);
      this.assertActionTarget(observation, request.from);
      this.assertActionTarget(observation, request.to);
      const action = await this.actionServiceInstance();
      this.assertObservation(observation, request.observationId, request.expectedControlEpoch);
      const documentId = await this.observer.currentDocumentId();
      this.assertObservation(observation, request.observationId, request.expectedControlEpoch);
      if (documentId !== observation.documentId) throw new Error("page changed since observation");
      const operation = this.installOperation({
        kind: "drag",
        controlEpoch: request.expectedControlEpoch,
        documentGeneration: this.documentGeneration,
        observationId: observation.observationId,
        allowDocumentChange: false,
      });
      try {
        this.assertOperationInput();
        await action.drag(request.from, request.to, request.button);
        this.assertOperation(operation);
        const finalDocumentId = await this.observer.currentDocumentId();
        this.assertOperation(operation);
        if (finalDocumentId !== observation.documentId) throw new Error("page changed since observation");
        return {
          from: request.from,
          to: request.to,
          button: request.button,
          documentId: finalDocumentId,
          controlEpoch: request.expectedControlEpoch,
          url: this.target.currentUrl(),
        };
      } catch (error) {
        this.rethrowOperationError(operation, error);
      } finally {
        this.clearOperation(operation);
        try {
          this.target.releaseAgentPointer();
        } catch {}
      }
    });
  }

  async type(request: AgentTypeRequest): Promise<AgentTypeResult> {
    return this.enqueue(async () => {
      const observation = this.latestObservation;
      this.assertObservation(observation, request.observationId, request.expectedControlEpoch);
      const action = await this.actionServiceInstance();
      this.assertObservation(observation, request.observationId, request.expectedControlEpoch);
      const documentId = await this.observer.currentDocumentId();
      this.assertObservation(observation, request.observationId, request.expectedControlEpoch);
      if (documentId !== observation.documentId) {
        throw new Error("page changed since observation");
      }
      const refState = await this.observer.refState(request.ref);
      this.assertObservation(observation, request.observationId, request.expectedControlEpoch);
      if (!refState.exists || !refState.connected) throw new Error("stale or unknown ref");
      if (!refState.editable) throw new Error("ref is not editable");
      const operation = this.installOperation({
        kind: "type",
        controlEpoch: request.expectedControlEpoch,
        documentGeneration: this.documentGeneration,
        observationId: observation.observationId,
        allowDocumentChange: false,
      });
      try {
        this.assertOperationInput();
        await action.type({ ref: request.ref, text: request.text, replace: request.replace });
        this.assertOperation(operation);
        const finalDocumentId = await this.observer.currentDocumentId();
        this.assertOperation(operation);
        if (finalDocumentId !== observation.documentId) {
          throw new Error("page changed since observation");
        }
        return {
          ref: request.ref,
          characters: [...request.text].length,
          documentId: finalDocumentId,
          controlEpoch: request.expectedControlEpoch,
          url: this.target.currentUrl(),
        };
      } catch (error) {
        this.rethrowOperationError(operation, error);
      } finally {
        this.clearOperation(operation);
        this.clearTarget();
      }
    });
  }

  async pressKey(request: AgentPressKeyRequest): Promise<AgentPressKeyResult> {
    return this.enqueue(async () => {
      const observation = this.latestObservation;
      this.assertObservation(observation, request.observationId, request.expectedControlEpoch);
      const key = parseAgentKey(request.key);
      const action = await this.actionServiceInstance();
      this.assertObservation(observation, request.observationId, request.expectedControlEpoch);
      const documentId = await this.observer.currentDocumentId();
      this.assertObservation(observation, request.observationId, request.expectedControlEpoch);
      if (documentId !== observation.documentId) {
        throw new Error("page changed since observation");
      }
      const operation = this.installOperation({
        kind: "press-key",
        controlEpoch: request.expectedControlEpoch,
        documentGeneration: this.documentGeneration,
        observationId: observation.observationId,
        allowDocumentChange: false,
      });
      try {
        this.assertOperationInput();
        await action.pressKey(key.canonical);
        this.assertOperation(operation);
        const finalDocumentId = await this.observer.currentDocumentId();
        this.assertOperation(operation);
        if (finalDocumentId !== observation.documentId) {
          throw new Error("page changed since observation");
        }
        return {
          key: key.canonical,
          documentId: finalDocumentId,
          controlEpoch: request.expectedControlEpoch,
          url: this.target.currentUrl(),
        };
      } catch (error) {
        this.rethrowOperationError(operation, error);
      } finally {
        this.clearOperation(operation);
      }
    });
  }

  async scroll(request: AgentScrollRequest): Promise<AgentScrollResult> {
    return this.enqueue(async () => {
      const observation = this.latestObservation;
      this.assertObservation(observation, request.observationId, request.expectedControlEpoch);
      const action = await this.actionServiceInstance();
      this.assertObservation(observation, request.observationId, request.expectedControlEpoch);
      const documentId = await this.observer.currentDocumentId();
      this.assertObservation(observation, request.observationId, request.expectedControlEpoch);
      if (documentId !== observation.documentId) {
        throw new Error("page changed since observation");
      }
      const operation = this.installOperation({
        kind: "scroll",
        controlEpoch: request.expectedControlEpoch,
        documentGeneration: this.documentGeneration,
        observationId: observation.observationId,
        allowDocumentChange: false,
      });
      try {
        this.assertOperationInput();
        await action.scroll({ dx: request.dx, dy: request.dy });
        this.assertOperation(operation);
        const finalDocumentId = await this.observer.currentDocumentId();
        this.assertOperation(operation);
        if (finalDocumentId !== observation.documentId) {
          throw new Error("page changed since observation");
        }
        return {
          dx: request.dx,
          dy: request.dy,
          documentId: finalDocumentId,
          controlEpoch: request.expectedControlEpoch,
          url: this.target.currentUrl(),
        };
      } catch (error) {
        this.rethrowOperationError(operation, error);
      } finally {
        this.clearOperation(operation);
      }
    });
  }

  async navigate(request: AgentNavigateRequest): Promise<AgentNavigateResult> {
    return this.enqueue(async () => {
      const controlEpoch = this.control.assertAgent(request.expectedControlEpoch).controlEpoch;
      this.latestObservation = null;
      const action = await this.actionServiceInstance();
      this.control.assertAgent(controlEpoch);
      const operation = this.installOperation({
        kind: "navigate",
        controlEpoch,
        documentGeneration: this.documentGeneration,
        allowDocumentChange: true,
      });
      try {
        this.assertOperationInput();
        await action.navigate(request.url);
        this.assertOperation(operation);
        return {
          requestedUrl: request.url,
          url: this.target.currentUrl(),
          controlEpoch,
        };
      } catch (error) {
        this.rethrowOperationError(operation, error);
      } finally {
        this.clearOperation(operation);
        this.clearActivity();
      }
    });
  }

  async getUrl(request: AgentGetUrlRequest): Promise<AgentGetUrlResult> {
    return this.enqueue(async () => {
      const controlEpoch = this.control.assertAgent(request.expectedControlEpoch).controlEpoch;
      const action = await this.actionServiceInstance();
      this.control.assertAgent(controlEpoch);
      const operation = this.installOperation({
        kind: "get-url",
        controlEpoch,
        documentGeneration: this.documentGeneration,
        allowDocumentChange: true,
      });
      try {
        this.assertOperationInput();
        const url = await action.getUrl();
        this.assertOperation(operation);
        return { url, controlEpoch };
      } catch (error) {
        this.rethrowOperationError(operation, error);
      } finally {
        this.clearOperation(operation);
      }
    });
  }

  async waitFor(request: AgentWaitForRequest): Promise<AgentWaitForResult> {
    return this.enqueue(async () => {
      const observation = this.latestObservation;
      this.assertObservation(observation, request.observationId, request.expectedControlEpoch);
      const condition = request.condition ?? (request.ref ? "visible" : "text");
      const action = await this.actionServiceInstance();
      this.assertObservation(observation, request.observationId, request.expectedControlEpoch);
      const documentId = await this.observer.currentDocumentId();
      this.assertObservation(observation, request.observationId, request.expectedControlEpoch);
      if (documentId !== observation.documentId) {
        throw new Error("page changed since observation");
      }
      const operation = this.installOperation({
        kind: "wait-for",
        controlEpoch: request.expectedControlEpoch,
        documentGeneration: this.documentGeneration,
        observationId: observation.observationId,
        allowDocumentChange: false,
      });
      try {
        this.assertOperationInput();
        const matched = await action.waitFor({
          ref: request.ref,
          text: request.text,
          condition,
          timeoutMs: request.timeoutMs,
        });
        this.assertOperation(operation);
        const finalDocumentId = await this.observer.currentDocumentId();
        this.assertOperation(operation);
        if (finalDocumentId !== observation.documentId) {
          throw new Error("page changed since observation");
        }
        return {
          matched,
          condition,
          ...(request.ref ? { ref: request.ref } : {}),
          documentId: finalDocumentId,
          controlEpoch: request.expectedControlEpoch,
          url: this.target.currentUrl(),
        };
      } catch (error) {
        this.rethrowOperationError(operation, error);
      } finally {
        this.clearOperation(operation);
      }
    });
  }

  private actionServiceInstance(): Promise<AgentActionService> {
    return (this.actionService ??= this.actionServiceFactory(this.driver));
  }

  private assertObservation(
    observation: AgentObservation | null,
    observationId: string,
    expectedControlEpoch: number,
  ): asserts observation is AgentObservation {
    this.control.assertAgent(expectedControlEpoch);
    if (
      !observation ||
      this.latestObservation !== observation ||
      observation.observationId !== observationId ||
      observation.controlEpoch !== expectedControlEpoch
    ) {
      throw new Error("stale or unknown observation");
    }
  }

  private assertActionTarget(
    observation: AgentObservation,
    target: { ref: string } | { x: number; y: number },
  ): void {
    if ("ref" in target) {
      if (!observation.snapshot.elements.some((element) => element.ref === target.ref)) {
        throw new Error("stale or unknown ref");
      }
      return;
    }
    if (!Number.isFinite(target.x) || !Number.isFinite(target.y)) {
      throw new Error("action coordinates must be finite");
    }
    const visual = observation.visual;
    if (!visual) throw new Error("coordinate actions require the latest visual observation");
    const right = visual.rect.x + visual.rect.width;
    const bottom = visual.rect.y + visual.rect.height;
    if (target.x < visual.rect.x || target.y < visual.rect.y || target.x > right || target.y > bottom) {
      throw new Error("action coordinates are outside the latest visual observation");
    }
  }

  private rethrowOperationError(operation: AgentOperation, error: unknown): never {
    try {
      this.assertOperation(operation);
    } catch (guardError) {
      throw guardError;
    }
    throw error;
  }

  private installOperation(operation: AgentOperation): AgentOperation {
    this.activeOperation = operation;
    return operation;
  }

  private clearOperation(operation: AgentOperation): void {
    if (this.activeOperation === operation) this.activeOperation = null;
  }

  private assertOperation(operation: AgentOperation): void {
    if (this.activeOperation !== operation) {
      throw new Error("agent operation is no longer active");
    }
    this.control.assertAgent(operation.controlEpoch);
    if (!operation.allowDocumentChange && this.documentGeneration !== operation.documentGeneration) {
      throw new Error("page changed since observation");
    }
    if (
      operation.observationId &&
      this.latestObservation?.observationId !== operation.observationId
    ) {
      throw new Error("stale or unknown observation");
    }
  }

  private assertOperationInput(): void {
    const operation = this.activeOperation;
    if (!operation) throw new Error("agent operation is no longer active");
    this.assertOperation(operation);
  }

  private updateActivity(event: import("../page/input").ProgrammaticPointerEvent) {
    if (!this.currentPointerActivity()) return;
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
    if (!this.currentPointerActivity()) return;
    const previous = this.activityValue;
    this.activityValue = {
      cursor: previous?.cursor ?? null,
      target: { ...point },
      pulse: true,
    };
    this.startPulse();
    this.emitActivity();
  }

  private currentPointerActivity(): boolean {
    const operation = this.activeOperation;
    return (
      !!operation &&
      (operation.kind === "click" || operation.kind === "hover" || operation.kind === "drag" ||
        operation.kind === "type" || operation.kind === "wait-for") &&
      operation.controlEpoch === this.control.snapshot.controlEpoch &&
      this.control.state === "agent" &&
      (operation.allowDocumentChange || operation.documentGeneration === this.documentGeneration) &&
      (!operation.observationId || this.latestObservation?.observationId === operation.observationId)
    );
  }

  private resetPulse() {
    if (this.pulseTimer) {
      clearTimeout(this.pulseTimer);
      this.pulseTimer = null;
    }
    if (!this.activityValue?.pulse) return;
    this.activityValue = { ...this.activityValue, pulse: false };
    this.emitActivity();
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

  private emitActivity() {
    this.onActivityChange(this.activity);
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

function clipRect(
  rect: { x: number; y: number; width: number; height: number },
  viewport: { width: number; height: number },
) {
  const left = Math.max(0, rect.x);
  const top = Math.max(0, rect.y);
  const right = Math.min(viewport.width, rect.x + rect.width);
  const bottom = Math.min(viewport.height, rect.y + rect.height);
  if (right <= left || bottom <= top) throw new Error("element is outside the current viewport");
  return { x: left, y: top, width: right - left, height: bottom - top };
}

function pngDimensions(data: Buffer): { width: number; height: number } {
  if (data.byteLength < 24 || data.toString("ascii", 1, 4) !== "PNG") {
    throw new Error("visual observation returned an invalid PNG");
  }
  const width = data.readUInt32BE(16);
  const height = data.readUInt32BE(20);
  if (width < 1 || height < 1 || width > 1_600 || height > 1_600) {
    throw new Error("visual observation returned invalid dimensions");
  }
  return { width, height };
}
