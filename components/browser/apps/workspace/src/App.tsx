import { useEffect, useMemo, useState } from "react";
import { WorkspaceBridge, decodeFrameEnvelope, type PublicWorkspaceState, type WorkspaceSnapshot, type WorkspaceStatus } from "./bridge";

export function App() {
  const bridge = useMemo(() => new WorkspaceBridge(), []);
  const [state, setState] = useState<PublicWorkspaceState>({ connection: "connecting", droppedBeforeFrontend: 0, inflightFrame: false });
  const [status, setStatus] = useState<WorkspaceStatus>({ connection: "connecting", browserd: "unavailable" });

  useEffect(() => {
    let active = true;
    void bridge.open((record) => {
      if (!active) return;
      if (record.kind === "current") setState(record.state);
      else if (record.kind === "snapshot") setState((current) => ({ ...current, snapshot: record.snapshot }));
      else if (record.kind === "status") setStatus(record.status);
      else if (record.kind === "selection") setState((current) => ({ ...current, selected: record.selected }));
      else if (record.kind === "selectionCleared") setState((current) => ({ ...current, selected: undefined }));
      else if (record.kind === "error") setStatus({ connection: "reconnecting", browserd: "unavailable", message: record.error.message });
    }, (record) => {
      if (!active) return;
      try { void bridge.acknowledgeFrame(decodeFrameEnvelope(record).metadata.deliveryId); } catch { /* The full renderer reports malformed frames after transport qualification. */ }
    }).catch(() => { if (active) setStatus({ connection: "unavailable", browserd: "unavailable", message: "Workspace transport is unavailable." }); });
    return () => { active = false; };
  }, [bridge]);

  const snapshot: WorkspaceSnapshot | undefined = state.snapshot;
  return (
    <main className="workspace-shell">
      <header><div><strong>Pi Browser Workspace</strong><span>Read-only multi-agent viewer</span></div><span className={`connection ${status.connection}`}>{status.connection}</span></header>
      <section className="transport-ready" aria-live="polite">
        <h1>Viewing agent control</h1>
        <p>{status.message ?? (snapshot?.sessions.length ? `${snapshot.sessions.length} active browser session${snapshot.sessions.length === 1 ? "" : "s"}.` : "No AgentCursor browser session is active.")}</p>
        <small>Secure binary workspace transport is ready. The multi-agent viewport is loading.</small>
      </section>
    </main>
  );
}
