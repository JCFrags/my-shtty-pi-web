import { createHash, randomUUID } from "node:crypto";
import type { BrowserOwner } from "pixel-store";
import path from "node:path";
import fs from "node:fs";
import type { DownloadItem, Session, WebContents } from "electron";
import type { BrowserControl } from "./control";
import { downloadFilename, reserveDownloadPath } from "./files";

export interface BrowserDownload {
  id: string;
  contextId: number;
  name: string;
  savePath: string;
  received: number;
  total: number;
  state: "progressing" | "completed" | "cancelled" | "interrupted" | "failed";
}

type Entry = { value: BrowserDownload; item?: DownloadItem; terminal: boolean; cleanup: () => void };
const HISTORY_BYTES = 128 * 1024;
type Source = { tracker: BrowserDownloads; contextId: number };
const dispatchers = new WeakMap<Session, Map<WebContents, Source>>();

export function registerDownloadSource(contents: WebContents, tracker: BrowserDownloads, contextId: number): void {
  let sources = dispatchers.get(contents.session);
  if (!sources) {
    sources = new Map();
    dispatchers.set(contents.session, sources);
    const routes = sources;
    contents.session.on("will-download", (event, item, source) => {
      const route = routes.get(source);
      if (!route) { event.preventDefault(); return; }
      route.tracker.start(item, route.contextId);
    });
  }
  sources.set(contents, { tracker, contextId });
  const routes = sources;
  contents.once("destroyed", () => { routes.delete(contents); tracker.interruptContext(contextId); });
}

export class BrowserDownloads {
  private readonly entries = new Map<string, Entry>();
  private readonly listeners = new Set<() => void>();
  private stopped = false;
  private persistTimer?: NodeJS.Timeout;
  private readonly historyFile: string | null;

  constructor(private readonly projectRoot: string | null, owner: Pick<BrowserOwner, "workspaceId" | "tabId" | "paneId"> | null, private readonly onProgress: (value: BrowserDownload) => void = () => {}) {
    const tuple = owner && [owner.workspaceId, owner.tabId, owner.paneId];
    this.historyFile = tuple?.every(id => typeof id === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(id))
      ? `history-${createHash("sha256").update(JSON.stringify(tuple)).digest("hex")}.json` : null;
    this.load();
  }

  private directory(create = false): string {
    if (!this.historyFile || !this.projectRoot || fs.realpathSync(this.projectRoot) !== path.resolve(this.projectRoot)) throw new Error("owning project root is unavailable");
    const directory = path.join(this.projectRoot, ".terminal-browser-downloads");
    if (create) fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(directory) !== directory || stat.uid !== process.getuid?.()) throw new Error("unsafe download directory");
    return directory;
  }

  private valid(value: unknown): value is BrowserDownload {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const record = value as BrowserDownload;
    if (Object.keys(record).sort().join(",") !== "contextId,id,name,received,savePath,state,total") return false;
    if (typeof record.id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(record.id)) return false;
    if (!Number.isSafeInteger(record.contextId) || record.contextId < 0) return false;
    if (typeof record.name !== "string" || record.name !== downloadFilename(record.name)) return false;
    if (![record.received, record.total].every(bytes => Number.isSafeInteger(bytes) && bytes >= 0)) return false;
    if (!["progressing", "completed", "cancelled", "interrupted", "failed"].includes(record.state)) return false;
    if (typeof record.savePath !== "string") return false;
    if (record.savePath === "") return record.state === "failed";
    const parts = record.savePath.split("/");
    if (parts.length !== 3 || parts[0] !== ".terminal-browser-downloads" || !/^item-[a-zA-Z0-9]+$/.test(parts[1]) || parts[2] !== record.name) return false;
    let location = this.projectRoot!;
    for (const part of parts) {
      location = path.join(location, part);
      try {
        if (fs.lstatSync(location).isSymbolicLink() || fs.realpathSync(location) !== location) return false;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false;
      }
    }
    return true;
  }

  private load(): void {
    let descriptor: number | undefined;
    try {
      const directory = this.directory();
      descriptor = fs.openSync(path.join(directory, this.historyFile!), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
      const stat = fs.fstatSync(descriptor);
      if (!stat.isFile() || stat.size > HISTORY_BYTES || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) return;
      const bytes = Buffer.alloc(HISTORY_BYTES + 1);
      const length = fs.readSync(descriptor, bytes, 0, bytes.length, 0);
      if (length > HISTORY_BYTES) return;
      const values: unknown = JSON.parse(bytes.subarray(0, length).toString("utf8"));
      if (!Array.isArray(values)) return;
      for (const value of values) {
        if (!this.valid(value) || this.entries.has(value.id)) continue;
        const recovered = { ...value, state: value.state === "progressing" ? "interrupted" as const : value.state };
        this.entries.set(value.id, { value: recovered, terminal: true, cleanup: () => {} });
        this.prune();
      }
    } catch {} finally {
      if (descriptor !== undefined) fs.closeSync(descriptor);
    }
    if (this.entries.size) this.persist();
  }

  private persist(): void {
    clearTimeout(this.persistTimer);
    this.persistTimer = undefined;
    let temporary: string | undefined;
    let descriptor: number | undefined;
    try {
      const directory = this.directory(true);
      const values = this.list().filter(value => this.valid(value));
      temporary = path.join(directory, `.history-${randomUUID()}.tmp`);
      descriptor = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
      fs.writeFileSync(descriptor, JSON.stringify(values));
      fs.fsyncSync(descriptor);
      fs.closeSync(descriptor);
      descriptor = undefined;
      fs.renameSync(temporary, path.join(directory, this.historyFile!));
      temporary = undefined;
      descriptor = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
      fs.fsyncSync(descriptor);
    } catch {} finally {
      if (descriptor !== undefined) fs.closeSync(descriptor);
      if (temporary) { try { fs.unlinkSync(temporary); } catch {} }
    }
  }

  start(item: DownloadItem, contextId: number): void {
    if (this.stopped || !this.projectRoot || !this.historyFile || [...this.entries.values()].filter(entry => !entry.terminal).length >= 32) { item.cancel(); return; }
    const entry: Entry = {
      value: { id: randomUUID(), contextId, name: downloadFilename(item.getFilename()), savePath: "", received: 0, total: 0, state: "progressing" },
      item, terminal: false, cleanup: () => {},
    };
    this.entries.set(entry.value.id, entry);
    const update = (state: BrowserDownload["state"], immediate = false) => {
      if (entry.terminal) return;
      entry.value = { ...entry.value, state, received: item.getReceivedBytes(), total: item.getTotalBytes() };
      entry.terminal = state !== "progressing";
      if (entry.terminal) entry.cleanup();
      this.prune();
      this.changed(entry.value, immediate);
    };
    const updated = (_event: Electron.Event, state: string) => {
      if (state === "interrupted") { update("interrupted"); setImmediate(() => { try { item.cancel(); } catch {} }); }
      else update("progressing");
    };
    const done = (_event: Electron.Event, state: string) => update(state === "completed" ? "completed" : state === "cancelled" ? "cancelled" : state === "interrupted" ? "interrupted" : "failed");
    entry.cleanup = () => { item.off("updated", updated); item.off("done", done); };
    item.on("updated", updated);
    item.once("done", done);
    try {
      const savePath = reserveDownloadPath(this.projectRoot, item.getFilename());
      entry.value.savePath = path.relative(fs.realpathSync(this.projectRoot), savePath);
      item.setSavePath(savePath);
      update("progressing", true);
    } catch {
      update("failed");
      try { item.cancel(); } catch {}
    }
  }

  list(contextId?: number): BrowserDownload[] {
    return [...this.entries.values()].filter(entry => contextId === undefined || entry.value.contextId === contextId).map(entry => ({ ...entry.value }));
  }

  private get(id: string, contextId?: number): Entry {
    const entry = this.entries.get(id);
    if (!entry || (contextId !== undefined && entry.value.contextId !== contextId)) throw new Error("unknown download ID in this browser context");
    return entry;
  }

  cancel(id: string, contextId?: number): BrowserDownload {
    const entry = this.get(id, contextId);
    this.finish(entry, "cancelled");
    return { ...entry.value };
  }

  wait(id: string, timeoutMs: number, control: BrowserControl, epoch: number, contextId?: number): Promise<BrowserDownload> {
    control.assertAgent(epoch);
    this.get(id, contextId);
    return new Promise((resolve, reject) => {
      let unsubscribe = () => {};
      const cleanup = () => { clearTimeout(timer); this.listeners.delete(check); unsubscribe(); };
      const check = (timeout = false) => {
        try {
          control.assertAgent(epoch);
          const entry = this.get(id, contextId);
          if (entry.terminal || timeout) { cleanup(); resolve({ ...entry.value }); }
        } catch (error) { cleanup(); reject(error); }
      };
      const timer = setTimeout(() => check(true), timeoutMs);
      this.listeners.add(check);
      unsubscribe = control.subscribe(() => check());
      check();
    });
  }

  interruptContext(contextId: number): void {
    for (const entry of this.entries.values()) if (entry.value.contextId === contextId) this.finish(entry, "interrupted");
  }

  stop(): void {
    this.stopped = true;
    for (const entry of this.entries.values()) this.finish(entry, "interrupted");
    if (this.persistTimer) this.persist();
  }

  private finish(entry: Entry, state: "cancelled" | "interrupted"): void {
    if (entry.terminal) return;
    entry.terminal = true;
    entry.value = { ...entry.value, state };
    entry.cleanup();
    try { entry.item?.cancel(); } catch {}
    this.changed(entry.value);
  }

  private prune(): void {
    for (const [id, entry] of this.entries) {
      if (this.entries.size <= 64) break;
      if (entry.terminal) this.entries.delete(id);
    }
  }

  private changed(value: BrowserDownload, immediate = false) {
    if (immediate || value.state !== "progressing") this.persist();
    else if (!this.persistTimer) {
      this.persistTimer = setTimeout(() => this.persist(), 1000);
      this.persistTimer.unref();
    }
    this.onProgress({ ...value });
    for (const listener of this.listeners) listener();
  }
}
