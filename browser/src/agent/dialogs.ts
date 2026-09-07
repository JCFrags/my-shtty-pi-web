import { createHash, randomUUID } from "node:crypto";
import type { WebContents } from "electron";
import type { BrowserControl } from "./control";

export interface BrowserIntent {
  type: "navigate" | "reload" | "history" | "close";
  url?: string;
}

export interface BrowserDialog {
  id: string;
  contextId: number;
  controlEpoch: number;
  type: "alert" | "confirm" | "prompt" | "beforeunload";
  message: string;
  defaultValue: string;
  url: string;
  canAccept: boolean;
  intent?: BrowserIntent;
}

export interface DialogResponse {
  dialogId: string;
  expectedControlEpoch: number;
  accept: boolean;
  text?: string;
}

export const PROMPT_SOURCE = `(() => { const stringify = String; const slice = Function.prototype.call.bind(String.prototype.slice);
const prompt = function terminalBrowserPrompt(message = '', defaultValue = '') {
  const promptMessage = slice(stringify(message), 0, 4096);
  const promptDefault = slice(stringify(defaultValue), 0, 4096);
  let promptResult = null;
  debugger;
  return promptResult;
}; Object.defineProperty(window, "prompt", { configurable: true, get: () => prompt, set: () => {} });
})();
//# sourceURL=terminal-browser-prompt.js`;
const PROMPT_HASH = createHash("sha256").update(PROMPT_SOURCE).digest("hex");

type Intent = { generation: number; replay: () => void; description: BrowserIntent };
type Pending = {
  value: Omit<BrowserDialog, "contextId" | "controlEpoch">;
  reply: (accept: boolean, text?: string, guard?: () => void) => Promise<void>;
  timer: ReturnType<typeof setTimeout>;
};

export class BrowserDialogs {
  private readonly debugger: Electron.Debugger;
  private contextId = 0;
  private control: BrowserControl | null = null;
  private value: Pending | null = null;
  private readonly listeners = new Set<() => void>();
  private readonly scripts = new Map<number, string>();
  private generation = 0;
  private intent: Intent | null = null;
  private permit: Intent | null = null;
  private permitTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  private responding = false;
  private ready: Promise<void> | null = null;

  constructor(
    private readonly contents: WebContents,
    private readonly send: (method: string, params?: Record<string, unknown>) => Promise<unknown>,
    private readonly timeoutMs = 60_000,
  ) {
    this.debugger = contents.debugger;
    this.debugger.on("message", this.onMessage);
    this.debugger.on("detach", this.onDetach);
    contents.on("will-prevent-unload", this.onBeforeUnload);
    contents.on("did-start-navigation", (_event, url, inPlace, mainFrame) => {
      if (mainFrame && this.intent && this.intent.description.url !== url) { this.intent = null; this.clearPermit(); }
      if (mainFrame && !inPlace && this.value?.value.type !== "beforeunload") void this.cancel();
    });
    contents.on("did-navigate", () => {
      this.generation++;
      this.intent = null;
      this.clearPermit();
      void this.cancel();
    });
    contents.on("did-stop-loading", () => { this.intent = null; this.clearPermit(); });
    contents.once("destroyed", () => this.dispose());
  }

  configure(contextId: number, control: BrowserControl) {
    this.contextId = contextId;
    this.control = control;
  }

  get pending(): BrowserDialog | null {
    return this.value ? { ...this.value.value, contextId: this.contextId, controlEpoch: this.control?.controlEpoch ?? 1 } : null;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  initialize(): Promise<void> {
    return this.ready ??= Promise.all([
      this.send("Page.enable"),
      this.send("Runtime.enable"),
      this.send("Debugger.enable"),
      this.send("Page.addScriptToEvaluateOnNewDocument", { source: PROMPT_SOURCE, runImmediately: true }),
    ]).then(() => undefined);
  }

  runIntent<T>(description: BrowserIntent, replay: () => void, operation: () => T): T {
    if (this.value) throw new Error("a browser dialog is pending");
    this.clearPermit();
    const intent = { generation: this.generation, replay, description };
    this.intent = intent;
    try { return operation(); }
    catch (error) { if (this.intent === intent) this.intent = null; throw error; }
  }

  async respond(request: DialogResponse): Promise<void> {
    this.control?.assertAgent(request.expectedControlEpoch);
    if (this.pending?.controlEpoch !== request.expectedControlEpoch) throw new Error("stale control epoch");
    await this.answer(request.dialogId, request.accept, request.text, () => this.control?.assertAgent(request.expectedControlEpoch));
  }

  async answer(id: string, accept: boolean, text?: string, guard?: () => void): Promise<void> {
    const pending = this.value;
    if (!pending || pending.value.id !== id || this.responding) throw new Error("stale or unknown dialog");
    if (typeof accept !== "boolean" || (text !== undefined && (typeof text !== "string" || text.length > 32768))) {
      throw new Error("invalid dialog response");
    }
    if (text !== undefined && pending.value.type !== "prompt") throw new Error("text requires a prompt dialog");
    if (accept && !pending.value.canAccept) throw new Error("unknown beforeunload intent; dismiss and retry an explicit navigation");
    this.responding = true;
    clearTimeout(pending.timer);
    try {
      guard?.();
      await pending.reply(accept, text, guard);
    } finally {
      if (this.value === pending) this.value = null;
      this.responding = false;
      this.changed();
    }
  }

  async cancel(): Promise<void> {
    const pending = this.value;
    if (!pending || this.responding) return;
    await this.answer(pending.value.id, false).catch(() => {});
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    void this.cancel();
    if (this.value) clearTimeout(this.value.timer);
    this.value = null;
    this.clearPermit();
    this.intent = null;
    this.scripts.clear();
    this.changed();
    this.listeners.clear();
    this.debugger.off("message", this.onMessage);
    this.debugger.off("detach", this.onDetach);
    this.contents.off("will-prevent-unload", this.onBeforeUnload);
  }

  private clearPermit() {
    if (this.permitTimer) clearTimeout(this.permitTimer);
    this.permitTimer = null;
    this.permit = null;
  }

  private readonly onDetach = () => {
    this.scripts.clear();
    this.generation++;
    this.intent = null;
    this.clearPermit();
    if (this.value) clearTimeout(this.value.timer);
    this.value = null;
    this.changed();
  };

  private readonly onBeforeUnload = (event: Electron.Event) => {
    if (this.permit && this.permit === this.intent && this.permit.generation === this.generation) {
      this.clearPermit();
      this.intent = null;
      event.preventDefault();
      return;
    }
    const intent = this.intent;
    this.intent = null;
    const settled = this.cancellationSettled(intent);
    this.open("beforeunload", "This page asks to stay open.", "", !!intent, async (accept, _text, guard) => {
      await settled;
      if (this.disposed) return;
      await this.send("Runtime.evaluate", { expression: "void 0" });
      guard?.();
      if (!accept || !intent || intent.generation !== this.generation) return;
      this.permit = intent;
      this.intent = intent;
      this.permitTimer = setTimeout(() => this.clearPermit(), 5_000);
      setImmediate(() => {
        if (this.permit !== intent || this.disposed) return;
        try { intent.replay(); } catch { this.clearPermit(); this.intent = null; }
      });
    }, intent?.description);
  };

  private cancellationSettled(intent: Intent | null): Promise<void> {
    if (!intent || intent.description.type === "close") return new Promise(resolve => setImmediate(resolve));
    return new Promise(resolve => {
      const done = () => {
        clearTimeout(timer);
        this.contents.off("did-stop-loading", done);
        this.contents.off("destroyed", done);
        this.debugger.off("detach", done);
        resolve();
      };
      const timer = setTimeout(() => { this.generation++; this.intent = null; this.clearPermit(); done(); }, 5000);
      this.contents.once("did-stop-loading", done);
      this.contents.once("destroyed", done);
      this.debugger.once("detach", done);
    });
  }

  private readonly onMessage = (_event: Electron.Event, method: string, params: Record<string, unknown>) => {
    if (this.disposed) return;
    if (method === "Runtime.executionContextsCleared") this.scripts.clear();
    if (method === "Runtime.executionContextDestroyed") this.scripts.delete(Number(params.executionContextId));
    if (method === "Debugger.scriptParsed") {
      const context = Number(params.executionContextId);
      if (!this.scripts.has(context) && params.url === "terminal-browser-prompt.js" && params.hash === PROMPT_HASH && params.startLine === 0 && params.endLine === 9) {
        this.scripts.set(context, String(params.scriptId));
      }
    }
    if (method === "Page.javascriptDialogOpening" && (params.type === "alert" || params.type === "confirm")) {
      this.open(params.type, String(params.message ?? ""), "", true, async (accept) => {
        await this.send("Page.handleJavaScriptDialog", { accept });
      });
    }
    if (method === "Page.javascriptDialogClosed" && this.value?.value.type !== "prompt" && this.value?.value.type !== "beforeunload") {
      if (this.value) clearTimeout(this.value.timer);
      this.value = null;
      this.changed();
    }
    if (method === "Debugger.paused") void this.paused(params).catch(async () => {
      await this.send("Debugger.resume").catch(() => {});
    });
  };

  private async paused(params: Record<string, unknown>) {
    const frame = (params.callFrames as Array<{ callFrameId: string; functionName: string; location: { scriptId: string; lineNumber: number; columnNumber: number } }>)[0];
    if (!frame || ![...this.scripts.values()].includes(frame.location.scriptId) || frame.functionName !== "terminalBrowserPrompt" || frame.location.lineNumber !== 5 || frame.location.columnNumber !== 2) {
      await this.send("Debugger.resume");
      return;
    }
    const result = await this.send("Debugger.evaluateOnCallFrame", {
      callFrameId: frame.callFrameId,
      expression: "({message:promptMessage,defaultValue:promptDefault})",
      returnByValue: true,
    }) as { result?: { value?: { message: string; defaultValue: string } }; exceptionDetails?: unknown };
    if (result.exceptionDetails || !result.result?.value) throw new Error("cannot read prompt");
    const { message, defaultValue } = result.result.value;
    this.open("prompt", message, defaultValue, true, async (accept, text) => {
      try {
        const written = await this.send("Debugger.evaluateOnCallFrame", {
          callFrameId: frame.callFrameId,
          expression: `promptResult = ${JSON.stringify(accept ? text ?? defaultValue : null)}`,
          returnByValue: true,
        }) as { exceptionDetails?: unknown };
        if (written.exceptionDetails) throw new Error("cannot set prompt response");
      } finally {
        await this.send("Debugger.resume");
      }
    });
  }

  private open(type: BrowserDialog["type"], message: string, defaultValue: string, canAccept: boolean, reply: Pending["reply"], intent?: BrowserIntent) {
    if (this.value || this.disposed) {
      void reply(false).catch(() => {});
      return;
    }
    const id = randomUUID();
    this.value = {
      value: { id, type, message: message.slice(0, 4096), defaultValue: defaultValue.slice(0, 4096), url: this.contents.getURL().slice(0, 8192), canAccept, ...(intent ? { intent: { ...intent, ...(intent.url ? { url: intent.url.slice(0, 8192) } : {}) } } : {}) },
      reply,
      timer: setTimeout(() => { void this.cancel(); }, this.timeoutMs),
    };
    this.changed();
  }

  private changed() {
    for (const listener of this.listeners) listener();
  }
}
