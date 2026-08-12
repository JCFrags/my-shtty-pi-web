import { invoke } from "@tauri-apps/api/core";
import { safeFailure, type SafeFailure, type ViewportLease, type WorkspaceFrame, type WorkspaceSnapshot } from "../model";

const BROWSER_PROTOCOL_MAJOR = 2;

export interface BrowserdDescriptor {
  protocolVersion: string;
  workspaceEndpoint: string;
  workspaceWebsocketEndpoint: string;
  workspaceToken: string;
  unixSocket: string;
}

export interface ScopedWorkspaceEvent {
  scopeId: string;
  sequence: number;
  kind: "snapshot-changed" | "operation-changed" | "control-changed" | "viewport-changed";
}

export class WorkspaceRpc {
  descriptor?: BrowserdDescriptor;
  #sequence = 0;

  async connect(): Promise<BrowserdDescriptor> {
    const descriptor = await invoke<BrowserdDescriptor>("browserd_descriptor");
    const major = Number.parseInt(descriptor.protocolVersion.split(".", 1)[0] ?? "", 10);
    if (major !== BROWSER_PROTOCOL_MAJOR) throw safeFailure({ code: "daemon_disconnected" });
    this.descriptor = descriptor;
    return descriptor;
  }

  // The daemon binds these calls to the authenticated principal. No caller agent ID is accepted.
  open(): Promise<WorkspaceSnapshot> {
    return this.call("workspace.openScoped", {});
  }

  refresh(scopeId: string): Promise<WorkspaceSnapshot> {
    return this.call("workspace.getScoped", { scopeId });
  }

  select(scopeId: string, tabId: string): Promise<WorkspaceSnapshot> {
    return this.call("workspace.selectOwnedTab", { scopeId, tabId });
  }

  lease(scopeId: string, tabId: string): Promise<ViewportLease> {
    return this.call("workspace.acquireViewportLease", { scopeId, tabId });
  }

  releaseLease(scopeId: string, leaseId: string): Promise<void> {
    return this.call("workspace.releaseViewportLease", { scopeId, leaseId });
  }

  setControl(scopeId: string, lease: ViewportLease, control: "human" | "agent", expectedControlEpoch: number): Promise<{ controlEpoch: number }> {
    return this.call("workspace.compareSetControl", {
      scopeId,
      leaseId: lease.leaseId,
      viewportId: lease.identity.viewportId,
      viewportGeneration: lease.identity.viewportGeneration,
      control,
      expectedControlEpoch,
    });
  }

  frame(scopeId: string, leaseId: string): Promise<WorkspaceFrame> {
    return this.call("workspace.getFrame", { scopeId, leaseId });
  }

  input(scopeId: string, lease: ViewportLease, frame: WorkspaceFrame, controlEpoch: number, inputSequence: number, action: Record<string, unknown>): Promise<void> {
    return this.call("workspace.input", {
      scopeId, leaseId: lease.leaseId, viewportId: lease.identity.viewportId,
      viewportGeneration: lease.identity.viewportGeneration, controlEpoch,
      screenshotSha256: frame.screenshotSha256, screenshotSequence: frame.sequence,
      inputSequence, action,
    });
  }

  cancel(scopeId: string, operationId: string): Promise<void> {
    return this.call("workspace.cancelOperation", { scopeId, operationId });
  }

  async call<T>(method: string, params: unknown): Promise<T> {
    const descriptor = this.descriptor ?? await this.connect();
    try {
      const response = await fetch(`${descriptor.workspaceEndpoint}/rpc`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${descriptor.workspaceToken}` },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++this.#sequence, method, params }),
      });
      if (!response.ok) throw { code: "daemon_disconnected" };
      const body = await response.json() as { result?: T; error?: { data?: unknown } };
      if (body.error) throw body.error.data;
      return body.result as T;
    } catch (error) {
      if (isSafeFailure(error)) throw error;
      throw safeFailure(error);
    }
  }

  events(scopeId: string, onEvent: (event: ScopedWorkspaceEvent) => void, onState: (state: "open" | "closed" | "error") => void): () => void {
    // Browser WebSocket APIs cannot set an Authorization header. Poll through
    // authenticated HTTP instead of putting the workspace token in a URL.
    let sequence = 0;
    onState("open");
    const timer = window.setInterval(() => onEvent({ scopeId, sequence: ++sequence, kind: "snapshot-changed" }), 1_000);
    return () => { window.clearInterval(timer); onState("closed"); };
  }
}

function isSafeFailure(value: unknown): value is SafeFailure {
  return Boolean(value && typeof value === "object" && "code" in value && "recovery" in value && "message" in value);
}
