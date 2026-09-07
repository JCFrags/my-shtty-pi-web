import type { WebContents } from "electron";
import { validateUploadFiles } from "./files";

export class BrowserUploads {
  private armActive: (() => void) | null = null;
  private cancelActive: (() => void) | null = null;

  constructor(private readonly contents: WebContents, private readonly send: (method: string, params?: Record<string, unknown>) => Promise<unknown>) {
    contents.on("did-start-navigation", (_event, _url, inPlace, mainFrame) => { if (mainFrame && !inPlace) this.cancel(); });
    contents.once("destroyed", () => this.cancel());
    contents.debugger.on("detach", () => this.cancel());
  }

  cancel(): void { this.cancelActive?.(); }

  acceptChooserFromClick(): void { this.armActive?.(); }

  async run(projectRoot: string | null, paths: unknown, click: () => Promise<unknown>, guard: () => Promise<void>, onCancel: () => void = () => {}): Promise<void> {
    if (this.cancelActive) throw new Error("an upload is already pending");
    const files = validateUploadFiles(projectRoot, paths);
    let cancelled = false;
    let assigned = false;
    let accepting = false;
    let node: number | null = null;
    let resolveChooser!: (event: Record<string, unknown>) => void;
    let rejectCancelled!: (error: Error) => void;
    const chooser = new Promise<Record<string, unknown>>(resolve => { resolveChooser = resolve; });
    const aborted = new Promise<never>((_resolve, reject) => { rejectCancelled = reject; });
    void aborted.catch(() => {});
    const cancel = () => { if (cancelled) return; cancelled = true; onCancel(); rejectCancelled(new Error("upload cancelled by navigation, control change, or context closure")); };
    this.cancelActive = cancel;
    this.armActive = () => { accepting = true; };
    const check = async () => { if (cancelled) throw new Error("upload cancelled"); await Promise.race([guard(), aborted]); if (cancelled) throw new Error("upload cancelled"); };
    const onMessage = (_event: Electron.Event, method: string, params: Record<string, unknown>) => {
      if (method !== "Page.fileChooserOpened") return;
      if (!accepting || node !== null || cancelled) {
        if (typeof params.backendNodeId === "number") void this.send("DOM.setFileInputFiles", { backendNodeId: params.backendNodeId, files: [] }).catch(() => {});
        if (!accepting) cancel();
        return;
      }
      node = typeof params.backendNodeId === "number" ? params.backendNodeId : null;
      resolveChooser(params);
    };
    const timer = setTimeout(cancel, 15000);
    this.contents.debugger.on("message", onMessage);
    try {
      await check();
      await this.send("Page.enable");
      const tree = await this.send("Page.getFrameTree") as { frameTree: { frame: { id: string; loaderId: string } } };
      await check();
      await this.send("Page.setInterceptFileChooserDialog", { enabled: true });
      await check();
      const event = await Promise.race([Promise.all([click(), chooser]).then(([, event]) => event), aborted]);
      await check();
      const current = await this.send("Page.getFrameTree") as typeof tree;
      if (!node || event.frameId !== tree.frameTree.frame.id || current.frameTree.frame.loaderId !== tree.frameTree.frame.loaderId) throw new Error("file chooser is not in the observed document");
      if (event.mode !== "selectMultiple" && files.length !== 1) throw new Error("file input does not accept multiple files");
      await check();
      const checked = validateUploadFiles(projectRoot, paths);
      if (checked.some((file, index) => file !== files[index])) throw new Error("upload paths changed");
      await this.send("DOM.setFileInputFiles", { backendNodeId: node, files: checked });
      assigned = true;
      await check();
    } finally {
      clearTimeout(timer);
      if (!assigned && node !== null) await this.send("DOM.setFileInputFiles", { backendNodeId: node, files: [] }).catch(() => {});
      await this.send("Page.setInterceptFileChooserDialog", { enabled: false }).catch(() => {});
      this.contents.debugger.off("message", onMessage);
      if (this.cancelActive === cancel) { this.cancelActive = null; this.armActive = null; }
    }
  }
}
