import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Viewport, type ViewportHandle } from "./components/Viewport";
import { fixtureData, parseFixtureState } from "./fixtures";
import { WorkspaceRpc } from "./lib/rpc";
import {
  isSupportedPath,
  safeFailure,
  selectOwnedTab,
  type ControlState,
  type SafeFailure,
  type ViewportLease,
  type ViewportState,
  type WorkspaceSnapshot,
} from "./model";

export function App() {
  const fixtureState = useMemo(() => parseFixtureState(window.location.search), []);
  const fixture = useMemo(() => fixtureState ? fixtureData(fixtureState) : undefined, [fixtureState]);
  const rpc = useMemo(() => new WorkspaceRpc(), []);
  const viewportRef = useRef<ViewportHandle>(null);
  const takeoverPromise = useRef<Promise<number> | undefined>(undefined);
  const [connection, setConnection] = useState<"connecting" | "live" | "reconnecting" | "failed" | "closed">(fixture ? "live" : "connecting");
  const [snapshot, setSnapshot] = useState<WorkspaceSnapshot | undefined>(fixture?.snapshot);
  const [lease, setLease] = useState<ViewportLease | undefined>(fixture?.lease);
  const [failure, setFailure] = useState<SafeFailure | undefined>(fixture?.snapshot.failure);
  const [frameAgeMs, setFrameAgeMs] = useState<number>();

  const applySnapshot = useCallback((next: WorkspaceSnapshot) => {
    if (next.selected) {
      if (!isSupportedPath(next.selected.pathId)) {
        setFailure(safeFailure({ code: "unsupported" }));
        return;
      }
      const session = next.sessions.find((item) => item.browserSessionId === next.selected?.browserSessionId);
      const tab = selectOwnedTab(next, next.selected.tabId);
      if (!session || !tab || session.pathId !== next.selected.pathId || session.backend !== next.selected.backend || session.engine !== next.selected.engine) {
        setFailure(safeFailure({ code: "ownership_lost" }));
        return;
      }
    }
    setSnapshot(next);
    setFailure(next.failure);
  }, []);

  const refresh = useCallback(async (scopeId: string) => {
    try { applySnapshot(await rpc.refresh(scopeId)); }
    catch (error) { setFailure(safeFailure(error)); }
  }, [applySnapshot, rpc]);

  useEffect(() => {
    if (fixture) return;
    let disposed = false;
    let stopEvents = () => {};
    void rpc.open().then((next) => {
      if (disposed) return;
      applySnapshot(next);
      setConnection("live");
      stopEvents = rpc.events(next.scopeId, () => void refresh(next.scopeId), (state) => {
        setConnection(state === "open" ? "live" : state === "closed" ? "reconnecting" : "failed");
      });
    }).catch((error) => {
      if (!disposed) {
        setConnection("failed");
        setFailure(safeFailure(error));
      }
    });
    return () => { disposed = true; stopEvents(); };
  }, [applySnapshot, fixture, refresh, rpc]);

  useEffect(() => {
    if (fixture || !snapshot?.selected) {
      if (!fixture) setLease(undefined);
      return;
    }
    let disposed = false;
    let acquired: ViewportLease | undefined;
    setLease(undefined);
    void rpc.lease(snapshot.scopeId, snapshot.selected.tabId).then((next) => {
      if (disposed) {
        void rpc.releaseLease(snapshot.scopeId, next.leaseId);
        return;
      }
      acquired = next;
      if (next.identity.viewportId !== snapshot.selected?.viewportId || next.identity.viewportGeneration !== snapshot.selected.viewportGeneration) {
        setFailure(safeFailure({ code: "lease_expired" }));
        void rpc.releaseLease(snapshot.scopeId, next.leaseId);
        return;
      }
      setLease(next);
    }).catch((error) => { if (!disposed) setFailure(safeFailure(error)); });
    return () => {
      disposed = true;
      if (acquired) void rpc.releaseLease(snapshot.scopeId, acquired.leaseId);
    };
  }, [fixture, rpc, snapshot?.scopeId, snapshot?.selected?.tabId, snapshot?.selected?.viewportId, snapshot?.selected?.viewportGeneration]);

  const selectTab = async (tabId: string) => {
    if (!snapshot || fixture || tabId === snapshot.selected?.tabId) return;
    try { applySnapshot(await rpc.select(snapshot.scopeId, tabId)); }
    catch (error) { setFailure(safeFailure(error)); }
  };

  const takeover = useCallback(async (expectedControlEpoch: number) => {
    if (!snapshot || !lease || fixture || snapshot.controlState === "human") return expectedControlEpoch;
    if (takeoverPromise.current) return takeoverPromise.current;
    setSnapshot((current) => current ? { ...current, controlState: "takeover-pending" } : current);
    const pending = rpc.setControl(snapshot.scopeId, lease, "human", expectedControlEpoch).then(({ controlEpoch }) => {
      setLease((current) => current ? { ...current, identity: { ...current.identity, controlEpoch } } : current);
      setSnapshot((current) => current?.selected ? { ...current, controlState: "human", selected: { ...current.selected, controlEpoch } } : current);
      return controlEpoch;
    }).catch((error) => {
      setSnapshot((current) => current ? { ...current, controlState: "conflict" } : current);
      setFailure(safeFailure(error));
      throw error;
    }).finally(() => { takeoverPromise.current = undefined; });
    takeoverPromise.current = pending;
    return pending;
  }, [fixture, lease, rpc, snapshot]);

  const returnControl = async () => {
    if (!snapshot?.selected || !lease || fixture || snapshot.controlState !== "human") return;
    setSnapshot({ ...snapshot, controlState: "return-pending" });
    try {
      await viewportRef.current?.releasePressedInput();
      const result = await rpc.setControl(snapshot.scopeId, lease, "agent", snapshot.selected.controlEpoch);
      setLease({ ...lease, identity: { ...lease.identity, controlEpoch: result.controlEpoch } });
      setSnapshot({ ...snapshot, controlState: "agent", selected: { ...snapshot.selected, controlEpoch: result.controlEpoch } });
    } catch (error) {
      setSnapshot({ ...snapshot, controlState: "human" });
      setFailure(safeFailure(error));
    }
  };

  const cancelOperation = async () => {
    if (!snapshot?.operation?.cancellable || fixture) return;
    setSnapshot({ ...snapshot, operation: { ...snapshot.operation, state: "cancelling" } });
    try { await rpc.cancel(snapshot.scopeId, snapshot.operation.operationId); }
    catch (error) { setFailure(safeFailure(error)); }
  };

  const updateViewportState = (viewportState: ViewportState, age?: number) => {
    setFrameAgeMs(age);
    setSnapshot((current) => current ? { ...current, viewportState } : current);
  };

  const getFrame = useCallback((activeLease: ViewportLease) => {
    if (!snapshot) return Promise.reject(new Error("workspace scope unavailable"));
    return rpc.frame(snapshot.scopeId, activeLease.leaseId);
  }, [rpc, snapshot?.scopeId]);

  const sendInput = useCallback((activeLease: ViewportLease, frame: import("./model").WorkspaceFrame, epoch: number, sequence: number, action: Record<string, unknown>) => {
    if (!snapshot) return Promise.reject(new Error("workspace scope unavailable"));
    return rpc.input(snapshot.scopeId, activeLease, frame, epoch, sequence, action);
  }, [rpc, snapshot?.scopeId]);

  const selectedTab = snapshot?.selected && selectOwnedTab(snapshot, snapshot.selected.tabId);
  const selectedSession = snapshot?.selected && snapshot.sessions.find((item) => item.browserSessionId === snapshot.selected?.browserSessionId);
  const displayFailure = failure ?? snapshot?.failure;

  return (
    <main className="workspace">
      <header className="workspace-header">
        <div className="product-title"><strong>Pi Browser Workspace</strong><span className={`connection ${connection}`}>{connection}</span></div>
        <div className="identity-summary" aria-label="Selected browser identity">
          <span>{safeText(snapshot?.agentLabel ?? "Invoking agent")}</span>
          {selectedSession && <span>{safeText(selectedSession.label)}</span>}
          {snapshot?.selected && <><b>{snapshot.selected.pathId}</b><span>{snapshot.selected.backend} · {snapshot.selected.engine}</span></>}
        </div>
      </header>

      <nav className="owned-tabs" aria-label="Owned browser tabs">
        {snapshot?.tabs.map((tab) => (
          <button key={tab.tabId} className={tab.tabId === snapshot.selected?.tabId ? "selected" : ""} onClick={() => void selectTab(tab.tabId)}>
            <span>{safeText(tab.title || "New tab")}</span><small>{tab.state}</small>
          </button>
        ))}
        {!snapshot?.tabs.length && <span className="empty-state">No owned browser session is active.</span>}
      </nav>

      <section className="selected-view">
        <div className="view-toolbar">
          <div><strong>{safeText(selectedTab?.title ?? "No tab selected")}</strong>{selectedTab && <span>{safeOrigin(selectedTab.url)}</span>}</div>
          <div className="view-status"><span className={`state-dot ${snapshot?.viewportState ?? "unselected"}`} />{stateLabel(snapshot?.viewportState ?? "unselected", frameAgeMs)}</div>
        </div>
        <Viewport
          ref={viewportRef}
          lease={lease}
          controlEpoch={snapshot?.selected?.controlEpoch}
          fixtureFrameUrl={fixture?.fixtureFrameUrl}
          fixtureState={snapshot?.viewportState}
          onTakeover={takeover}
          onFrame={getFrame}
          onInput={sendInput}
          onState={updateViewportState}
          onFailure={setFailure}
        />
        {displayFailure && (
          <div className="failure-card" role="alert">
            <strong>{failureTitle(displayFailure.code)}</strong><span>{displayFailure.message}</span>
            {displayFailure.diagnosticRef && <code>Reference {displayFailure.diagnosticRef}</code>}
          </div>
        )}
      </section>

      <footer className="control-events">
        <section className="control-card">
          <div><span>Control</span><strong className={`control-state ${snapshot?.controlState ?? "agent"}`}>{controlLabel(snapshot?.controlState ?? "agent")}</strong></div>
          <p>{controlHelp(snapshot?.controlState ?? "agent")}</p>
          {snapshot?.controlState === "human" && <button className="primary" onClick={() => void returnControl()}>Return to agent</button>}
          {snapshot?.controlState === "return-pending" && <button disabled>Returning control…</button>}
          {snapshot?.controlState === "conflict" && <button onClick={() => snapshot && void refresh(snapshot.scopeId)}>Refresh control</button>}
        </section>
        <section className="operation-card">
          <div><span>Current operation</span><strong>{snapshot?.operation ? safeText(snapshot.operation.label) : "Idle"}</strong></div>
          <p>{snapshot?.operation ? operationLabel(snapshot.operation.state) : "No browser operation is active."}</p>
          {snapshot?.operation?.cancellable && ["queued", "running"].includes(snapshot.operation.state) && <button onClick={() => void cancelOperation()}>Cancel operation</button>}
          {snapshot?.operation?.state === "cancelling" && <button disabled>Cancellation pending…</button>}
        </section>
        <section className="event-card">
          <h2>Scoped events</h2>
          <div>{snapshot?.events.slice(0, 3).map((event) => <p key={event.id}><time>{safeText(event.at, 16)}</time><span>{safeText(event.message, 160)}</span></p>)}</div>
          {!snapshot?.events.length && <p className="muted">No recent event.</p>}
        </section>
      </footer>
    </main>
  );
}

function safeText(value: string, limit = 80): string {
  return value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, limit);
}

function safeOrigin(value: string): string {
  try { const url = new URL(value); return url.origin === "null" ? url.protocol : url.origin; } catch { return "Address unavailable"; }
}

function stateLabel(state: ViewportState, age?: number): string {
  if (state === "stale" && age !== undefined) return `Stale · ${Math.ceil(age / 1000)} s old`;
  const labels: Record<ViewportState, string> = { unselected: "No live view", connecting: "Connecting", live: "Live", stale: "Stale", reconnecting: "Reconnecting", unsupported: "Unsupported", failed: "Failed", closed: "Closed" };
  return labels[state];
}

function controlLabel(state: ControlState): string {
  return ({ agent: "Agent control", "takeover-pending": "Takeover pending", human: "Human control", "return-pending": "Return pending", conflict: "Control conflict" } as const)[state];
}

function controlHelp(state: ControlState): string {
  return ({
    agent: "Click or type in the live view to request control.",
    "takeover-pending": "Taking control after the current action.",
    human: "Agent work waits until you return control.",
    "return-pending": "Input is stopped while control returns.",
    conflict: "Refresh to get the authoritative control owner.",
  } as const)[state];
}

function operationLabel(state: string): string {
  const labels: Record<string, string> = { queued: "Waiting to start.", running: "The operation is running.", succeeded: "The operation succeeded.", cancelling: "Cancellation is pending.", cancelled: "The operation was cancelled.", failed: "The operation failed.", idle: "No browser operation is active." };
  return labels[state] ?? "Operation state unavailable.";
}

function failureTitle(code: SafeFailure["code"]): string {
  return code === "browser_crashed" ? "Browser crashed" : code === "unsupported" ? "Live view unsupported" : code === "ownership_lost" ? "View unavailable" : "Workspace notice";
}
