import { FrameObserver } from "./frame-observer";
import { validateUploadFiles } from "./files";
import { readiness, sameRect, TargetPreparation } from "./target-preparation";
import { parseLocator } from "./locator";
import { requiredText } from "./protocol";
import { randomUUID } from "node:crypto";

import type { ActionService, BrowserDriver, Persona, Point } from "agentcursor" with {
  "resolution-mode": "import",
};

import {
  createSlowNaturalPersonaProvider,
  type AgentPersonaProvider,
} from "./interaction-profile";
import { PageObserver } from "./page-observer";
import { parseAgentKey } from "./key";
import { TerminalBrowserDriver } from "./terminal-browser-driver";
import type { BrowserControl } from "./control";
import type {
  AgentActionService,
  AgentActionTarget,
  AgentElementTarget,
  AgentElementState,
  AgentActivity,
  AgentBrowserTarget,
  AgentClickRequest,
  AgentUploadRequest,
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
  personaProvider?: AgentPersonaProvider;
  actionServiceFactory?: (
    driver: BrowserDriver,
    persona: Persona,
  ) => Promise<AgentActionService>;
  observationId?: () => string;
}

type AgentCursorModule = typeof import("agentcursor", {
  with: { "resolution-mode": "import" },
});
let agentCursorModule: Promise<AgentCursorModule> | null = null;

function loadAgentCursor(): Promise<AgentCursorModule> {
  return (agentCursorModule ??= import("agentcursor"));
}

async function defaultActionServiceFactory(
  driver: BrowserDriver,
  persona: Persona,
): Promise<AgentActionService> {
  const { ActionService } = await loadAgentCursor();
  return new ActionService(driver, persona);
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
  signal?: AbortSignal;
}

export class BrowserAgentRuntime {
  readonly observer: AgentPageObserver;
  readonly driver: BrowserDriver;
  private readonly control: BrowserControl;
  private readonly onActivityChange: (activity: AgentActivity | null) => void;
  private readonly personaProvider: AgentPersonaProvider;
  private readonly actionServiceFactory: (
    driver: BrowserDriver,
    persona: Persona,
  ) => Promise<AgentActionService>;
  private readonly observationId: () => string;
  private latestObservation: AgentObservation | null = null;
  private actionService: Promise<AgentActionService> | null = null;
  private operationQueue: Promise<void> = Promise.resolve();
  private documentGeneration = 0;
  private requestSignal: AbortSignal | undefined;
  private activeOperation: AgentOperation | null = null;
  private activityValue: AgentActivity | null = null;
  private pulseTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly target: AgentBrowserTarget,
    options: BrowserAgentRuntimeOptions,
  ) {
    this.control = options.control;
    this.onActivityChange = options.onActivityChange ?? (() => {});
    this.observer = options.observer ?? (target.frames ? new FrameObserver(target.frames) : new PageObserver(target));
    target.frames?.subscribe(() => this.invalidateDocument());
    this.driver = options.driver ?? new TerminalBrowserDriver(target, this.observer, {
      beforeInput: () => this.assertOperationInput(),
      sleep: (ms) => this.operationSleep(ms),
      onPointer: (event) => this.updateActivity(event),
      onTarget: (point) => this.updateTarget(point),
    });
    this.personaProvider = options.personaProvider ?? createSlowNaturalPersonaProvider();
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
      await this.target.frames?.select(options.frame);
      const documentGeneration = this.documentGeneration;
      const maxElements = options.maxElements ?? 200;
      const includeText = options.includeText ?? true;
      const view = options.view ?? "semantic";
      const scope = options.scope ?? "viewport";
      const page = await this.observer.observe(maxElements, includeText, options.filter);
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
        ...(this.target.frames?.summaries() ?? {}),
        observationId: this.observationId(),
        documentId: page.documentId,
        controlEpoch,
        snapshot: page.snapshot,
        ...(visual ? { visual } : {}),
      };
      this.requestSignal?.throwIfAborted();
      this.target.frames?.rememberGeometry();
      this.latestObservation = observation;
      return observation;
    }, options.signal);
  }

  invalidateDocument(): void {
    this.target.uploads?.cancel();
    this.documentGeneration += 1;
    this.latestObservation = null;
    this.actionService = null;
    try {
      this.target.releaseAgentInput();
    } catch {}
    this.clearActivity();
  }

  invalidateControl(): void {
    this.target.uploads?.cancel();
    this.documentGeneration += 1;
    this.latestObservation = null;
    this.actionService = null;
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
        const prepared = await this.prepareTargets(operation, observation, elementTarget(request));
        const ref = prepared.primary!.state.ref;
        const downloadStartSequence = this.target.downloadStartSequence;
        const point: Point = await action.click({ ref });
        await this.assertClickCompletion(operation, downloadStartSequence);
        const finalDocumentId = await this.observer.currentDocumentId();
        const downloadStarted = await this.assertClickCompletion(operation, downloadStartSequence);
        if (finalDocumentId !== observation.documentId ||
          (downloadStarted && await this.observer.currentDocumentId() !== observation.documentId)) {
          throw new Error("page changed since observation");
        }
        this.control.assertAgent(operation.controlEpoch);
        return {
          ref: prepared.primary!.state.ref,
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
    }, request.signal);
  }

  async upload(request: AgentUploadRequest, projectRoot: string | null): Promise<AgentClickResult> {
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
        if (!this.target.uploads) throw new Error("upload is unavailable in this context");
        validateUploadFiles(projectRoot, request.files);
        const prepared = await this.prepareTargets(operation, observation, elementTarget(request));
        const ref = prepared.primary!.state.ref;
        let point: Point = { x: 0, y: 0 };
        await this.target.uploads.run(projectRoot, request.files, async () => {
          point = await action.click({ ref });
        }, async () => {
          this.assertOperation(operation);
          if (await this.observer.currentDocumentId() !== observation.documentId) throw new Error("page changed since observation");
          this.assertOperation(operation);
        }, () => this.invalidateControl());
        this.assertOperation(operation);
        const finalDocumentId = await this.observer.currentDocumentId();
        this.assertOperation(operation);
        if (finalDocumentId !== observation.documentId) {
          throw new Error("page changed since observation");
        }
        return {
          ref: prepared.primary!.state.ref,
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
    }, request.signal);
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
        const prepared = await this.prepareTargets(operation, observation, request.target, undefined, true);
        await action.hover(prepared.primary ? { ref: prepared.primary.state.ref } : request.target as { x: number; y: number });
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
        this.actionService = null;
      }
    }, request.signal);
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
        const prepared = await this.prepareTargets(operation, observation, request.from, request.to);
        await action.drag(
          prepared.primary ? { ref: prepared.primary.state.ref } : request.from as { x: number; y: number },
          prepared.destination ? { ref: prepared.destination.state.ref } : request.to as { x: number; y: number }, request.button);
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
        this.actionService = null;
        try {
          this.target.releaseAgentPointer();
        } catch {}
      }
    }, request.signal);
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
      requiredText(request.text, request.replace);
      const operation = this.installOperation({
        kind: "type",
        controlEpoch: request.expectedControlEpoch,
        documentGeneration: this.documentGeneration,
        observationId: observation.observationId,
        allowDocumentChange: false,
      });
      try {
        this.assertOperationInput();
        const prepared = await this.prepareTargets(operation, observation, elementTarget(request), undefined, false, true);
        const ref = prepared.primary!.state.ref;
        await action.type({ ref, text: request.text, replace: request.replace });
        this.assertOperation(operation);
        const finalDocumentId = await this.observer.currentDocumentId();
        this.assertOperation(operation);
        if (finalDocumentId !== observation.documentId) {
          throw new Error("page changed since observation");
        }
        return {
          ref: prepared.primary!.state.ref,
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
    }, request.signal);
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
    }, request.signal);
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
    }, request.signal);
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
    }, request.signal);
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
    }, request.signal);
  }

  async waitFor(request: AgentWaitForRequest): Promise<AgentWaitForResult> {
    return this.enqueue(async () => {
      const observation = this.latestObservation;
      this.assertObservation(observation, request.observationId, request.expectedControlEpoch);
      const condition = request.condition ?? (request.ref || request.locator ? "visible" : "text");
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
        const matched = request.locator || condition === "actionable"
          ? await this.waitForTarget(request, observation, operation)
          : await action.waitFor({ ref: request.ref, text: request.text, condition, timeoutMs: request.timeoutMs });
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
    }, request.signal);
  }

  private async operationSleep(ms: number): Promise<void> {
    const deadline = Date.now() + ms;
    do {
      this.assertOperationInput();
      await new Promise(resolve => setTimeout(resolve, Math.min(40, Math.max(0, deadline - Date.now()))));
    } while (Date.now() < deadline);
    this.assertOperationInput();
  }

  private async prepareTargets(operation: AgentOperation, observation: AgentObservation,
    from: AgentActionTarget, to?: AgentActionTarget, hover = false, editable = false) {
    this.assertActionTarget(observation, from);
    if (to) this.assertActionTarget(observation, to);
    if ("x" in from) await this.target.frames?.assertCoordinates(from);
    if (to && "x" in to) await this.target.frames?.assertCoordinates(to);
    const preparation = new TargetPreparation(this.observer, observation.documentId,
      () => this.assertOperation(operation), ms => this.operationSleep(ms));
    const scroll = !("x" in from || to && "x" in to);
    const primary = "x" in from ? undefined : await preparation.prepare(from, editable ? "editable" : "pointer", 5_000, scroll);
    const destination = !to || "x" in to ? undefined : await preparation.prepare(to, "pointer", 5_000, scroll);
    if (primary && destination) {
      const point = { x: primary.state.rect.x + primary.state.rect.width / 2, y: primary.state.rect.y + primary.state.rect.height / 2 };
      if (!await preparation.check(primary, point)) throw new Error("drag source is no longer actionable after preparing destination");
    }
    this.assertOperation(operation);
    if (this.driver instanceof TerminalBrowserDriver) this.driver.bindTargets(preparation, primary, destination, hover);
    return { primary, destination };
  }

  private async waitForTarget(request: AgentWaitForRequest, observation: AgentObservation, operation: AgentOperation): Promise<boolean> {
    if (!Number.isSafeInteger(request.timeoutMs) || request.timeoutMs < 0 || request.timeoutMs > 60_000) throw new Error("invalid wait timeout");
    const target = elementTarget(request);
    const condition = request.condition ?? "visible";
    if (!["exists", "visible", "text", "actionable"].includes(condition)) throw new Error("invalid wait condition");
    if (condition === "text" && (typeof request.text !== "string" || !request.text.length || request.text.length > 1024 || request.text.includes("\0"))) throw new Error("text wait needs bounded text");
    const deadline = Date.now() + request.timeoutMs;
    let previous: AgentElementState | null = null;
    while (true) {
      this.assertOperation(operation);
      let state: AgentElementState | null;
      if ("locator" in target) {
        const query = await this.observer.queryLocator(target.locator);
        this.assertOperation(operation);
        if (query.documentId !== observation.documentId) throw new Error("page changed since observation");
        if (query.count > 1) {
          const candidates = query.matches.map(({ ref, role, name }) => ({ ref, role, name: name.slice(0, 120) }));
          throw new Error(`ambiguous locator (${query.count} matches); narrow the scope or use nth: ${JSON.stringify(candidates)}`);
        }
        state = query.matches[0] ?? null;
      } else {
        const result = await this.observer.elementState(target.ref, { documentId: observation.documentId });
        this.assertOperation(operation);
        if (result.documentId !== observation.documentId) throw new Error("page changed since observation");
        state = result.state;
      }
      let textMatched = false;
      if (state && condition === "text") {
        const probe = await this.observer.probe(state.ref, request.text);
        this.assertOperation(operation);
        textMatched = probe.refText.replace(/\s+/g, " ").trim().includes(request.text!.replace(/\s+/g, " ").trim());
      }
      if (state && (condition === "exists" || condition === "visible" && state.visible || textMatched ||
          condition === "actionable" && !readiness(state, "pointer") && previous?.ref === state.ref && sameRect(previous.rect, state.rect))) return true;
      previous = state;
      if (Date.now() >= deadline) return false;
      await this.operationSleep(Math.min(80, deadline - Date.now()));
    }
  }

  private actionServiceInstance(): Promise<AgentActionService> {
    return (this.actionService ??= this.createActionService());
  }

  private async createActionService(): Promise<AgentActionService> {
    const persona = await this.personaProvider();
    if (this.driver instanceof TerminalBrowserDriver) this.driver.usePersona(persona);
    return this.actionServiceFactory(this.driver, persona);
  }

  private assertObservation(
    observation: AgentObservation | null,
    observationId: string,
    expectedControlEpoch: number,
  ): asserts observation is AgentObservation {
    this.requestSignal?.throwIfAborted();
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
    target: AgentActionTarget,
  ): void {
    if ("locator" in target) { parseLocator(target.locator); return; }
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
    this.actionService = null;
    try {
      this.assertOperation(operation);
    } catch (guardError) {
      throw guardError;
    }
    throw error;
  }

  private installOperation(operation: AgentOperation): AgentOperation {
    operation.signal = this.requestSignal;
    operation.signal?.throwIfAborted();
    this.activeOperation = operation;
    return operation;
  }

  private clearOperation(operation: AgentOperation): void {
    if (this.activeOperation === operation) {
      this.activeOperation = null;
      if (this.driver instanceof TerminalBrowserDriver) this.driver.clearTargets();
    }
  }

  private async assertClickCompletion(operation: AgentOperation, sequence: number | undefined): Promise<boolean> {
    operation.signal?.throwIfAborted();
    this.control.assertAgent(operation.controlEpoch);
    let downloadStarted = sequence !== undefined &&
      this.target.downloadStartSequence !== undefined && this.target.downloadStartSequence > sequence;
    if (!downloadStarted && sequence !== undefined && this.target.waitForDownloadStart &&
      this.documentGeneration !== operation.documentGeneration) {
      const abort = new AbortController();
      const cancel = () => abort.abort();
      operation.signal?.addEventListener("abort", cancel, { once: true });
      if (operation.signal?.aborted) abort.abort();
      const unsubscribe = this.control.subscribe(() => {
        if (this.control.state !== "agent" || this.control.controlEpoch !== operation.controlEpoch) abort.abort();
      });
      try {
        downloadStarted = await this.target.waitForDownloadStart(sequence, abort.signal) &&
          this.target.downloadStartSequence !== undefined && this.target.downloadStartSequence > sequence;
      } finally {
        operation.signal?.removeEventListener("abort", cancel);
        unsubscribe();
        abort.abort();
      }
    }
    operation.signal?.throwIfAborted();
    if (downloadStarted && this.activeOperation === operation) {
      this.control.assertAgent(operation.controlEpoch);
    } else {
      this.assertOperation(operation);
    }
    return downloadStarted;
  }

  private assertOperation(operation: AgentOperation): void {
    this.target.frames?.assertInput();
    operation.signal?.throwIfAborted();
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

  private enqueue<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const previous = this.operationQueue;
    let release!: () => void;
    this.operationQueue = new Promise<void>((resolve) => {
      release = resolve;
    });
    return previous.then(async () => {
      signal?.throwIfAborted();
      this.requestSignal = signal;
      const abort = () => {
        if (this.requestSignal !== signal) return;
        try { this.target.releaseAgentInput(); } catch {}
        this.target.uploads?.cancel();
        this.actionService = null;
        this.latestObservation = null;
      };
      signal?.addEventListener("abort", abort, { once: true });
      try { return await operation(); }
      finally {
        signal?.removeEventListener("abort", abort);
        this.requestSignal = undefined;
      }
    }).finally(release);
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

function elementTarget(request: { ref?: string; locator?: import("agentcursor", { with: { "resolution-mode": "import" } }).LocatorSpec }): AgentElementTarget {
  if ((request.ref !== undefined) === (request.locator !== undefined)) throw new Error("provide exactly one ref or locator");
  return request.locator !== undefined ? { locator: parseLocator(request.locator) } : { ref: request.ref! };
}
