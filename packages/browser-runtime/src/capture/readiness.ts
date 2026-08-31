import type { TabRecord } from "../targets/registry.js";

export type CaptureReadinessState = "starting" | "warming" | "ready" | "degraded" | "unavailable";

export interface CaptureProofIdentity {
  readonly browserSessionId: string;
  readonly tabId: string;
  readonly targetId: string;
  readonly documentGeneration: number;
  readonly viewportGeneration: number;
  readonly controlEpoch: number;
}

interface TabReadiness extends CaptureProofIdentity {
  readonly state: Exclude<CaptureReadinessState, "starting" | "unavailable">;
  readonly successfulTransactions: number;
}

export class SessionCaptureReadiness {
  private readonly tabs = new Map<string, TabReadiness>();
  private unavailable = false;

  constructor(private readonly changed: () => void) {}

  get state(): CaptureReadinessState {
    if (this.unavailable) return "unavailable";
    if (this.tabs.size === 0) return "starting";
    const values = [...this.tabs.values()];
    if (values.some((value) => value.state === "ready")) return "ready";
    if (values.some((value) => value.state === "degraded")) return "degraded";
    return "warming";
  }

  tabState(tabId: string): CaptureReadinessState {
    if (this.unavailable) return "unavailable";
    return this.tabs.get(tabId)?.state ?? "starting";
  }

  begin(tab: TabRecord, controlEpoch: number): void {
    if (this.unavailable) return;
    const priorSessionState = this.state;
    const priorTabState = this.tabState(tab.tabId);
    const identity = identityFromTab(tab, controlEpoch);
    const prior = this.tabs.get(tab.tabId);
    if (prior !== undefined && sameIdentity(prior, identity)) return;
    this.tabs.set(tab.tabId, { ...identity, state: "warming", successfulTransactions: 0 });
    this.notifyVisibleChange(priorSessionState, priorTabState, tab.tabId);
  }

  succeeded(identity: CaptureProofIdentity): CaptureReadinessState {
    if (this.unavailable) return "unavailable";
    const prior = this.tabs.get(identity.tabId);
    if (prior === undefined || !sameIdentity(prior, identity)) return this.tabState(identity.tabId);
    const priorSessionState = this.state;
    const priorTabState = prior.state;
    const successfulTransactions = Math.min(2, prior.successfulTransactions + 1);
    this.tabs.set(identity.tabId, {
      ...identity,
      state: successfulTransactions >= 2 ? "ready" : "warming",
      successfulTransactions,
    });
    this.notifyVisibleChange(priorSessionState, priorTabState, identity.tabId);
    return this.tabState(identity.tabId);
  }

  failed(identity: CaptureProofIdentity): void {
    if (this.unavailable) return;
    const prior = this.tabs.get(identity.tabId);
    if (prior === undefined || !sameIdentity(prior, identity)) return;
    const priorSessionState = this.state;
    const priorTabState = prior.state;
    this.tabs.set(identity.tabId, { ...identity, state: "degraded", successfulTransactions: prior.successfulTransactions });
    this.notifyVisibleChange(priorSessionState, priorTabState, identity.tabId);
  }

  remove(tabId: string): void {
    if (!this.tabs.has(tabId)) return;
    const priorSessionState = this.state;
    this.tabs.delete(tabId);
    if (this.state !== priorSessionState) this.changed();
  }

  markUnavailable(): void {
    if (this.unavailable) return;
    this.unavailable = true;
    this.changed();
  }

  private notifyVisibleChange(priorSessionState: CaptureReadinessState, priorTabState: CaptureReadinessState, tabId: string): void {
    if (this.state !== priorSessionState || this.tabState(tabId) !== priorTabState) this.changed();
  }
}

export function captureProofIdentity(tab: TabRecord, controlEpoch: number): CaptureProofIdentity {
  return identityFromTab(tab, controlEpoch);
}

function identityFromTab(tab: TabRecord, controlEpoch: number): CaptureProofIdentity {
  return {
    browserSessionId: tab.browserSessionId,
    tabId: tab.tabId,
    targetId: tab.targetId,
    documentGeneration: tab.documentGeneration,
    viewportGeneration: tab.viewportGeneration,
    controlEpoch,
  };
}

function sameIdentity(left: CaptureProofIdentity, right: CaptureProofIdentity): boolean {
  return left.browserSessionId === right.browserSessionId
    && left.tabId === right.tabId
    && left.targetId === right.targetId
    && left.documentGeneration === right.documentGeneration
    && left.viewportGeneration === right.viewportGeneration
    && left.controlEpoch === right.controlEpoch;
}
