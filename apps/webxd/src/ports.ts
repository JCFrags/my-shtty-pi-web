import type {
  BrowserAction,
  BrowserControlResult,
  BrowserDebugRequest,
  BrowserDebugResult,
  BrowserObservation,
  BrowserOperationResult,
  BrowserPathCapability,
  BrowserPathId,
  BrowserSession,
  BrowserSessionRequest,
  BrowserVisualFrame,
  BrowserWorkspaceRequest,
  BrowserWorkspaceResult,
  Visibility,
} from "../../../packages/sdk/src/index.js";

export interface AuthorityActor {
  readonly principalId: string;
  readonly agentId: string;
  readonly scopes: ReadonlySet<string>;
}

export interface IndexedSource {
  readonly hitId: string;
  readonly ownerPrincipalId: string;
  readonly title: string;
  readonly url: string;
  readonly content: string;
  readonly visibility: Visibility;
  readonly pageId: string;
  readonly artifactId: string;
}

export class BrowserPortError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
    public readonly retryable = false,
  ) {
    super(message);
    this.name = "BrowserPortError";
  }
}

export interface BrowserDaemonPort {
  capabilities(signal?: AbortSignal): Promise<readonly BrowserPathCapability[]>;
  createSession(actor: AuthorityActor, request: BrowserSessionRequest, operationId: string, signal?: AbortSignal): Promise<BrowserSession>;
  listSessions(actor: AuthorityActor, signal?: AbortSignal): Promise<readonly BrowserSession[]>;
  getSession(actor: AuthorityActor, sessionId: string, signal?: AbortSignal): Promise<BrowserSession>;
  observe(actor: AuthorityActor, sessionId: string, view: string, maxChars: number, operationId: string, signal?: AbortSignal): Promise<BrowserObservation>;
  captureFrame(actor: AuthorityActor, sessionId: string, operationId: string, signal?: AbortSignal): Promise<BrowserVisualFrame>;
  act(actor: AuthorityActor, sessionId: string, action: BrowserAction, operationId: string, signal?: AbortSignal): Promise<BrowserOperationResult>;
  debug(actor: AuthorityActor, sessionId: string, request: BrowserDebugRequest, operationId: string, signal?: AbortSignal): Promise<BrowserDebugResult>;
  workspace(actor: AuthorityActor, request: BrowserWorkspaceRequest, operationId: string, signal?: AbortSignal): Promise<BrowserWorkspaceResult>;
  setControl(actor: AuthorityActor, sessionId: string, controller: "human" | "agent", operationId: string, signal?: AbortSignal): Promise<BrowserControlResult>;
  cancel(actor: AuthorityActor, operationId: string, signal?: AbortSignal): Promise<BrowserOperationResult>;
  closeTab(actor: AuthorityActor, sessionId: string, tabId: string, signal?: AbortSignal): Promise<void>;
  close(actor: AuthorityActor, sessionId: string, signal?: AbortSignal): Promise<void>;
  shutdown(): Promise<void>;
}

export interface AuthorityClock {
  now(): string;
}

export interface AuthorityIdSource {
  next(prefix: string): string;
}

export function isBrowserPathId(value: unknown): value is BrowserPathId {
  return value === "agent-browser/chrome" || value === "pinchtab/chrome";
}
