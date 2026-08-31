import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import {
  WorkspaceBridge,
  type WorkspaceApi,
  type WorkspaceSession,
  type WorkspaceStatus,
  type WorkspaceTab,
} from "./bridge";
import { FrameViewport, useFrameRenderer, type FrameMetrics } from "./FrameViewport";
import { useHumanCanvasInput } from "./humanInput";
import {
  displayText,
  findSelected,
  formatAge,
  initialWorkspaceViewState,
  reduceWorkspaceRecord,
  safeOrigin,
  shortId,
  type WorkspaceViewState,
} from "./workspaceState";

interface AppProps { bridge?: WorkspaceApi; initialState?: WorkspaceViewState }

export function App({ bridge: suppliedBridge, initialState }: AppProps) {
  const bridge = useMemo(() => suppliedBridge ?? new WorkspaceBridge(), [suppliedBridge]);
  const [view, dispatch] = useReducer(reduceWorkspaceRecord, initialState ?? initialWorkspaceViewState);
  const [selectionPending, setSelectionPending] = useState<string>();
  const [selectionError, setSelectionError] = useState<string>();
  const [controlPending, setControlPending] = useState<"take" | "return">();
  const [controlError, setControlError] = useState<string>();
  const [now, setNow] = useState(Date.now());
  const connected = view.status.connection === "ready";
  const rendererState = connected ? view.publicState : { ...view.publicState, snapshot: undefined, selected: undefined };
  const renderer = useFrameRenderer(bridge, rendererState);
  const frameHandlerRef = useRef(renderer.handleFrame);
  frameHandlerRef.current = renderer.handleFrame;

  useEffect(() => {
    let active = true;
    void bridge.open(
      (record) => { if (active) dispatch(record); },
      (record) => { if (active) void frameHandlerRef.current(record); },
    ).catch(() => {
      if (active) dispatch({ kind: "status", status: { connection: "unavailable", browserd: "unavailable", message: "The local workspace service is unavailable." } });
    });
    return () => { active = false; };
  }, [bridge]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);

  const sessions = connected ? view.publicState.snapshot?.sessions ?? [] : [];
  const selected = findSelected(sessions, connected ? view.publicState.selected : undefined);
  const humanActive = selected?.session.controlState === "human";
  const humanOwned = humanActive || selected?.session.controlState === "human-disconnected" || selected?.session.controlState === "return-pending";
  useEffect(() => {
    if (controlPending === "take" && (selected?.session.controlState === "human" || selected?.session.controlState === "human-disconnected")) setControlPending(undefined);
    if (controlPending === "return" && selected?.session.controlState === "agent") setControlPending(undefined);
  }, [controlPending, selected?.session.controlState]);
  const performReturn = useCallback(async (cleanup: () => Promise<void>) => {
    setControlPending("return"); setControlError(undefined);
    try { await cleanup(); await bridge.returnControl(); }
    catch {
      setControlError("Control could not be returned safely. The workspace will remain visible.");
      setControlPending(undefined);
      throw new Error("control return failed");
    }
  }, [bridge]);
  const humanInput = useHumanCanvasInput(bridge, renderer.canvasRef, humanActive, renderer.metrics.acknowledgedPaintDeliveryId, performReturn);

  const select = useCallback(async (session: WorkspaceSession, tab: WorkspaceTab) => {
    const key = `${session.browserSessionId}:${tab.tabId}`;
    if (selectionPending === key || humanOwned || controlPending !== undefined) return;
    renderer.clear();
    setSelectionPending(key);
    setSelectionError(undefined);
    try {
      await bridge.select(session.browserSessionId, tab.tabId);
    } catch {
      renderer.resume();
      setSelectionError("The browser tab could not be selected.");
    } finally {
      setSelectionPending(undefined);
    }
  }, [bridge, renderer, selectionPending, humanOwned, controlPending]);

  const frameAgeMs = renderer.metrics.metadata ? Math.max(0, now - Date.parse(renderer.metrics.metadata.capturedAt)) : undefined;
  const viewportState = deriveViewportState(selected?.session, selected?.tab, Boolean(selectionPending), renderer.metrics, frameAgeMs);
  const framePainted = renderer.metrics.metadata !== undefined && renderer.metrics.acknowledgedPaintDeliveryId === renderer.metrics.metadata.deliveryId;
  const canTakeControl = connected && controlPending === undefined && selected?.session.controlState === "agent" && selected.session.state === "ready" && selected.session.captureReadiness === "ready" && selected.tab.state === "ready" && selected.tab.captureReadiness === "ready" && framePainted && frameAgeMs !== undefined && frameAgeMs <= 1_500;
  const takeControl = useCallback(async () => {
    if (!canTakeControl) return;
    setControlPending("take"); setControlError(undefined);
    try { await bridge.takeControl(); }
    catch { setControlError("Browser control is not ready. Wait for a current frame and try again."); setControlPending(undefined); }
  }, [bridge, canTakeControl]);
  const returnControl = humanInput.quiesceAndReturn;
  const agents = groupAgents(sessions);

  return (
    <main className="workspace-shell">
      <aside className="sidebar" aria-label="Active agents and browser sessions">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">π</span>
          <div><strong>Browser Workspace</strong><span>Multi-agent view</span></div>
        </div>
        <ConnectionSummary status={view.status} count={agents.length} />
        <nav className="agent-list" aria-label="Browser sessions">
          {agents.length === 0 ? <EmptyAgents status={view.status} /> : agents.map((agent) => (
            <section className="agent-group" key={agent.actorDisplayId}>
              <header><span className="agent-dot" aria-hidden="true" /><div><strong>{displayText(agent.label, "Pi agent")}</strong><span>{shortId(agent.actorDisplayId)}</span></div></header>
              {agent.sessions.map((session) => {
                const isSelected = selected?.session.browserSessionId === session.browserSessionId;
                const readyTabs = session.tabs.filter((tab) => tab.state !== "closed");
                return (
                  <button
                    className={`session-row${isSelected ? " selected" : ""}`}
                    key={session.browserSessionId}
                    onClick={() => { const tab = readyTabs.find((candidate) => candidate.state === "ready") ?? readyTabs[0]; if (tab) void select(session, tab); }}
                    disabled={readyTabs.length === 0 || humanOwned || controlPending !== undefined}
                    aria-current={isSelected ? "true" : undefined}
                  >
                    <span className={`state-dot ${session.state}`} aria-hidden="true" />
                    <span><strong>{shortId(session.browserSessionId, 22)}</strong><small>{readyTabs.length} tab{readyTabs.length === 1 ? "" : "s"} · {formatAge(session.lastActivityAt, now)}</small></span>
                  </button>
                );
              })}
            </section>
          ))}
        </nav>
        <div className="readonly-notice"><span aria-hidden="true">◉</span><div><strong>{controlStateLabel(selected?.session.controlState, controlPending)}</strong><span>{humanOwned ? "Ctrl+Shift+Escape returns control" : "Explicit takeover required"}</span></div></div>
      </aside>

      <section className="workspace-main">
        <header className="session-header">
          <div className="session-identity">
            <span className="eyebrow">Selected agent</span>
            <strong>{selected ? displayText(selected.session.agentLabel, "Pi agent") : "No browser selected"}</strong>
            <span>{selected ? shortId(selected.session.browserSessionId, 28) : "Choose a session from the sidebar"}</span>
          </div>
          <div className="control-actions">
            <span className={`connection-badge ${view.status.connection}`}><span aria-hidden="true" />{connectionLabel(view.status)}</span>
            {humanOwned
              ? <button className="return-control" onClick={() => void returnControl()} disabled={controlPending !== undefined}>Return to agent</button>
              : <button className="take-control" onClick={() => void takeControl()} disabled={!canTakeControl}>{controlPending === "take" ? "Taking control…" : "Take control"}</button>}
          </div>
        </header>

        <div className="tab-strip" role="tablist" aria-label="Open browser tabs">
          {selected?.session.tabs.filter((tab) => tab.state !== "closed").map((tab) => (
            <button
              role="tab"
              aria-selected={selected.tab.tabId === tab.tabId}
              className={selected.tab.tabId === tab.tabId ? "active" : ""}
              key={tab.tabId}
              onClick={() => void select(selected.session, tab)}
              disabled={humanOwned || controlPending !== undefined}
            >
              <span className={`tab-state ${tab.state}`} aria-hidden="true" />
              <span>{displayText(tab.title)}</span>
            </button>
          ))}
        </div>

        <div className="page-bar">
          <span className="page-title">{selected ? displayText(selected.tab.title) : "No page"}</span>
          <span className="page-origin" dir="ltr">{selected ? safeOrigin(selected.tab.url) : "—"}</span>
          {selectionPending && <span className="switching" role="status">Switching…</span>}
        </div>

        <div className="content-grid">
          <FrameViewport canvasRef={renderer.canvasRef} state={viewportState} frameAgeMs={frameAgeMs} humanControl={humanActive} inputHandlers={humanActive && controlPending !== "return" ? humanInput.handlers : undefined} />
          <StatusPanel status={view.status} selected={selected} metrics={renderer.metrics} now={now} droppedBeforeFrontend={view.publicState.droppedBeforeFrontend} humanControl={humanActive} />
        </div>
        {(selectionError || controlError || humanInput.error || view.error) && <div className="error-banner" role="alert">{selectionError ?? controlError ?? humanInput.error ?? view.error}</div>}
      </section>
    </main>
  );
}

function ConnectionSummary({ status, count }: { status: WorkspaceStatus; count: number }) {
  return <div className="connection-summary"><span className={`large-state ${status.connection}`} aria-hidden="true" /><div><strong>{connectionLabel(status)}</strong><span>{count} active agent{count === 1 ? "" : "s"}</span></div></div>;
}

function EmptyAgents({ status }: { status: WorkspaceStatus }) {
  const text = status.connection === "reconnecting" ? "Reconnecting to the local workspace…"
    : status.connection === "unavailable" ? "AgentCursor browser workspace is not active."
      : status.browserd === "replaced" ? "The browser service restarted. Waiting for new sessions…"
        : "No AgentCursor browser sessions are active.";
  return <div className="empty-agents" role="status"><span aria-hidden="true">◇</span><p>{text}</p></div>;
}

function StatusPanel({ status, selected, metrics, now, droppedBeforeFrontend, humanControl }: {
  status: WorkspaceStatus;
  selected: ReturnType<typeof findSelected>;
  metrics: FrameMetrics;
  now: number;
  droppedBeforeFrontend: number;
  humanControl: boolean;
}) {
  const operation = selected?.session.activeOperation;
  const metadata = metrics.metadata;
  return (
    <aside className="status-panel" aria-label="Browser and frame status">
      <header><span>Status</span><span className={`readonly-pill${humanControl ? " interactive" : ""}`}>{humanControl ? "Human control" : "Read only"}</span></header>
      <StatusGroup title="Control" rows={[
        ["Controller", selected ? controlStateLabel(selected.session.controlState) : "—"],
        ["Persona", selected ? shortId(selected.session.personaDisplayId) : "—"],
        ["Cursor", selected ? `${Math.round(selected.session.cursor.x)}, ${Math.round(selected.session.cursor.y)} CSS px` : "—"],
        ["Cursor visible", selected ? (selected.session.cursor.visible ? "yes" : "no") : "—"],
      ]} />
      <StatusGroup title="Page" rows={[
        ["Session", selected?.session.state ?? "—"],
        ["Tab", selected?.tab.state ?? "—"],
        ["Capture", selected ? `${selected.session.captureReadiness} / ${selected.tab.captureReadiness}` : "—"],
      ]} />
      <StatusGroup title="Frame" rows={[
        ["Delivery", metadata ? String(metadata.deliveryId) : "—"],
        ["Dimensions", metadata ? `${metadata.imagePixelWidth} × ${metadata.imagePixelHeight}` : "—"],
        ["Media", metadata?.mediaType ?? "—"],
        ["Age", metadata ? formatAge(metadata.capturedAt, now) : "—"],
        ["Decode / paint", `${milliseconds(metrics.decodeMs)} / ${milliseconds(metrics.paintMs)}`],
        ["Total", milliseconds(metrics.totalMs)],
      ]} />
      <StatusGroup title="Operation" rows={[
        ["Kind", operation?.kind ?? "Idle"],
        ["State", operation?.state ?? "—"],
        ["Dispatch", operation?.dispatchState ?? "—"],
      ]} />
      <StatusGroup title="Diagnostics" rows={[
        ["webxd", status.connection],
        ["browserd", status.browserd],
        ["Dropped", String(droppedBeforeFrontend + metrics.droppedBeforeDecode + metrics.droppedDuringDecode)],
      ]} />
    </aside>
  );
}

function StatusGroup({ title, rows }: { title: string; rows: Array<[string, string]> }) {
  return <section className="status-group"><h2>{title}</h2><dl>{rows.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{displayText(value, "—")}</dd></div>)}</dl></section>;
}

function groupAgents(sessions: WorkspaceSession[]): Array<{ actorDisplayId: string; label: string; sessions: WorkspaceSession[] }> {
  const groups = new Map<string, { actorDisplayId: string; label: string; sessions: WorkspaceSession[] }>();
  for (const session of sessions) {
    const current = groups.get(session.actorDisplayId);
    if (current) current.sessions.push(session);
    else groups.set(session.actorDisplayId, { actorDisplayId: session.actorDisplayId, label: session.agentLabel, sessions: [session] });
  }
  return [...groups.values()];
}

function deriveViewportState(
  session: WorkspaceSession | undefined,
  tab: WorkspaceTab | undefined,
  pending: boolean,
  metrics: FrameMetrics,
  age: number | undefined,
): "idle" | "connecting" | "preparing" | "live" | "stale" | "unsupported" | "crashed" {
  if (!session || !tab) return "idle";
  if (tab.state === "crashed" || tab.state === "closed") return "crashed";
  if (pending) return "connecting";
  if (session.captureReadiness !== "ready" || tab.captureReadiness !== "ready") return "preparing";
  if (!metrics.metadata) return metrics.lastDropReason === "decode" || metrics.lastDropReason === "decoded-dimensions" ? "unsupported" : "connecting";
  return age !== undefined && age > 5_000 ? "stale" : "live";
}

function controlStateLabel(state: WorkspaceSession["controlState"] | undefined, pending?: "take" | "return"): string {
  if (pending === "take" || state === "takeover-pending") return "Taking control…";
  if (pending === "return" || state === "return-pending") return "Returning control…";
  if (state === "human") return "Human control";
  if (state === "human-disconnected") return "Connection lost — agent paused";
  return "Agent control";
}

function connectionLabel(status: WorkspaceStatus): string {
  if (status.connection === "ready" && status.browserd === "ready") return "Connected";
  if (status.browserd === "replaced") return "Browser restarted";
  if (status.connection === "connecting") return "Connecting";
  if (status.connection === "reconnecting") return "Reconnecting";
  return "Unavailable";
}

function milliseconds(value: number | undefined): string { return value === undefined ? "—" : `${value.toFixed(1)} ms`; }
