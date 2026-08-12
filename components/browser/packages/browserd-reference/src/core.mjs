import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { EventEmitter } from "node:events";

export const PROTOCOL_VERSION = "1.0.0";

export class RpcError extends Error {
  constructor(code, message, data) {
    super(message);
    this.name = "RpcError";
    this.code = code;
    this.data = data;
  }
}

export class SerialQueue {
  #tail = Promise.resolve();
  #pending = 0;

  get pending() { return this.#pending; }

  run(task) {
    this.#pending += 1;
    const result = this.#tail.then(task, task);
    this.#tail = result.catch(() => undefined).finally(() => { this.#pending -= 1; });
    return result;
  }
}

class ControlGate {
  mode = "agent";
  #waiters = new Set();

  set(mode) {
    if (!["agent", "human", "shared"].includes(mode)) {
      throw new RpcError(-32602, `invalid control mode: ${mode}`);
    }
    this.mode = mode;
    if (mode !== "human") {
      for (const resolve of this.#waiters) resolve();
      this.#waiters.clear();
    }
  }

  async waitForAgent() {
    if (this.mode !== "human") return;
    await new Promise((resolve) => this.#waiters.add(resolve));
  }
}

export class ArtifactStore {
  constructor(root) {
    this.root = root;
    this.records = new Map();
  }

  async initialize() {
    await mkdir(join(this.root, "artifacts", "sha256"), { recursive: true });
  }

  async put(bytes, { mediaType = "application/octet-stream", ...context } = {}) {
    const body = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
    const sha256 = createHash("sha256").update(body).digest("hex");
    const path = join(this.root, "artifacts", "sha256", sha256.slice(0, 2), sha256.slice(2, 4), sha256);
    await mkdir(join(path, ".."), { recursive: true });
    try { await writeFile(path, body, { flag: "wx" }); } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    const record = {
      artifactId: id(), sha256, ownerAgentId: context.ownerAgentId,
      browserSessionId: context.browserSessionId, tabId: context.tabId,
      mediaType, size: body.length, path, sourceUrl: context.sourceUrl,
      createdAt: now(), metadata: context.metadata ?? {},
    };
    this.records.set(record.artifactId, record);
    return structuredClone(record);
  }

  async get(artifactId, offset = 0, limit = 64 * 1024) {
    const record = required(this.records, artifactId, "artifact");
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > record.size) {
      throw new RpcError(-32602, "invalid artifact offset", { offset, size: record.size });
    }
    limit = Math.max(1, Math.min(Number(limit) || 64 * 1024, 4 * 1024 * 1024));
    const bytes = await readFile(record.path);
    const page = bytes.subarray(offset, offset + limit);
    const nextOffset = offset + page.length < bytes.length ? offset + page.length : undefined;
    const result = { record: structuredClone(record), offset, nextOffset, eof: nextOffset === undefined };
    if (record.mediaType.startsWith("text/") || record.mediaType.includes("json") || record.mediaType.includes("markdown")) {
      result.text = page.toString("utf8");
    } else {
      result.dataBase64 = page.toString("base64");
    }
    return result;
  }

  list({ ownerAgentId, browserSessionId, limit = 100 } = {}) {
    return [...this.records.values()]
      .filter((record) => !ownerAgentId || record.ownerAgentId === ownerAgentId)
      .filter((record) => !browserSessionId || record.browserSessionId === browserSessionId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, Math.max(1, Math.min(limit, 1000)))
      .map((value) => structuredClone(value));
  }

  async delete(artifactId) {
    return this.records.delete(artifactId);
  }
}

export class MockBrowserBackend {
  constructor({ actionDelayMs = 0 } = {}) {
    this.actionDelayMs = actionDelayMs;
    this.hosts = new Map();
    this.activeOperations = 0;
    this.maxConcurrentOperations = 0;
  }

  capabilities() {
    return {
      backend: "mock", engines: ["lightpanda", "chromium"],
      actions: ["navigate", "click", "fill", "type", "press", "select", "hover", "scroll", "drag", "upload", "download", "back", "forward", "reload", "wait", "tab-new", "tab-close", "tab-focus"],
      debug: ["evaluate", "console", "network", "html", "cookies", "storage", "pdf", "record-start", "record-stop"],
      persistentProfiles: true, extensions: true, viewportStreaming: true, directTabAddressing: true,
    };
  }

  async startHost({ engine, profileId }) {
    const backendHostId = id();
    this.hosts.set(backendHostId, { backendHostId, engine, profileId, tabs: new Map() });
    return { backendHostId };
  }

  async stopHost(backendHostId) { this.hosts.delete(backendHostId); }

  async openTab(backendHostId, url = "about:blank") {
    const host = required(this.hosts, backendHostId, "backend host");
    const backendTabId = id();
    const tab = makeMockTab(backendTabId, url);
    host.tabs.set(backendTabId, tab);
    return structuredClone(tab);
  }

  async closeTab(backendHostId, backendTabId) {
    required(this.hosts, backendHostId, "backend host").tabs.delete(backendTabId);
  }

  async listTabs(backendHostId) {
    return [...required(this.hosts, backendHostId, "backend host").tabs.values()].map((value) => structuredClone(value));
  }

  async act(backendHostId, backendTabId, action) {
    return this.#operation(async () => {
      const tab = required(required(this.hosts, backendHostId, "backend host").tabs, backendTabId, "backend tab");
      const changed = [];
      switch (action.kind) {
        case "navigate":
          tab.history.push(tab.url); tab.url = action.url; tab.title = titleFor(action.url);
          tab.content = `Main content for ${action.url}`; changed.push(`navigated to ${action.url}`); break;
        case "click":
          tab.clicks += 1; tab.content = `${tab.content}\nClicked ${action.ref ?? action.selector ?? "control"}`;
          changed.push(`clicked ${action.ref ?? action.selector ?? "control"}`); break;
        case "fill": case "type":
          tab.values[action.ref ?? action.selector ?? "active"] = action.text;
          changed.push(`${action.kind} ${action.ref ?? action.selector ?? "active"}`); break;
        case "press": changed.push(`pressed ${action.key}`); break;
        case "back": if (tab.history.length) { tab.url = tab.history.pop(); tab.title = titleFor(tab.url); changed.push(`back to ${tab.url}`); } break;
        case "forward": changed.push("no forward entry"); break;
        case "reload": changed.push("page reloaded"); break;
        case "wait": await sleep(action.milliseconds ?? 1); changed.push("wait complete"); break;
        case "upload": changed.push(`uploaded ${action.files?.length ?? 0} file(s)`); break;
        case "download": changed.push("download started"); break;
        default: changed.push(`${action.kind} completed`);
      }
      tab.lastChanged = changed;
      return { ok: true, action: action.kind, title: tab.title, url: tab.url, changed };
    });
  }

  async observe(backendHostId, backendTabId, request = {}) {
    return this.#operation(async () => {
      const tab = required(required(this.hosts, backendHostId, "backend host").tabs, backendTabId, "backend tab");
      const view = request.view ?? "main";
      const controls = [
        { ref: "e1", role: "textbox", name: "Search", state: "enabled" },
        { ref: "e2", role: "button", name: "Submit", state: "enabled" },
      ];
      let content;
      if (view === "interactive") content = controls.map((c) => `${c.ref},${c.role},${c.name},${c.state}`).join("\n");
      else if (view === "diff") content = tab.lastChanged.join("\n");
      else if (view === "full") content = `${tab.content}\n${JSON.stringify({ controls, values: tab.values }, null, 2)}`;
      else content = tab.content;
      return { view, title: tab.title, url: tab.url, content, controls: view === "interactive" || view === "visual" ? controls : [], changed: view === "diff" ? [...tab.lastChanged] : [], truncated: false, metadata: {} };
    });
  }

  async debug(backendHostId, backendTabId, request) {
    const tab = required(required(this.hosts, backendHostId, "backend host").tabs, backendTabId, "backend tab");
    return { ok: true, operation: request.operation, data: { url: tab.url, args: request.args ?? {} } };
  }

  async streamInfo(backendHostId, backendTabId) {
    required(required(this.hosts, backendHostId, "backend host").tabs, backendTabId, "backend tab");
    return { protocol: "mock-jpeg-v1", url: `ws://127.0.0.1:0/mock/${backendHostId}/${backendTabId}`, width: 1280, height: 720 };
  }

  async screenshot(backendHostId, backendTabId) {
    required(required(this.hosts, backendHostId, "backend host").tabs, backendTabId, "backend tab");
    return Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z4ZkAAAAASUVORK5CYII=", "base64");
  }

  async #operation(task) {
    this.activeOperations += 1;
    this.maxConcurrentOperations = Math.max(this.maxConcurrentOperations, this.activeOperations);
    try { if (this.actionDelayMs) await sleep(this.actionDelayMs); return await task(); }
    finally { this.activeOperations -= 1; }
  }
}

export class Coordinator extends EventEmitter {
  constructor({ dataRoot, backend = new MockBrowserBackend(), limits = {}, heartbeatTimeoutMs = 15_000 } = {}) {
    super();
    if (!dataRoot) throw new TypeError("dataRoot is required");
    this.dataRoot = dataRoot;
    this.backend = backend;
    this.artifacts = new ArtifactStore(dataRoot);
    this.limits = { maxChromiumHosts: 6, maxLightpandaHosts: 24, maxTabsPerHost: 30, ...limits };
    this.heartbeatTimeoutMs = heartbeatTimeoutMs;
    this.agents = new Map();
    this.clients = new Map();
    this.profiles = new Map();
    this.hosts = new Map();
    this.sessions = new Map();
    this.tabs = new Map();
    this.profileHosts = new Map();
    this.profileQueues = new Map();
    this.controlGates = new Map();
    this.workspace = { visible: false, focusedAgentId: undefined, focusedTabId: undefined };
  }

  async initialize() { await this.artifacts.initialize(); }

  notify(method, params = {}) {
    const event = { jsonrpc: "2.0", method, params };
    this.emit("event", event);
    return event;
  }

  async call(method, params = {}) {
    switch (method) {
      case "system.ping": return { ok: true, protocolVersion: PROTOCOL_VERSION, now: now() };
      case "system.capabilities": return this.#capabilities();
      case "agent.register": return this.#registerAgent(params);
      case "agent.heartbeat": return this.#heartbeat(params);
      case "agent.unregister": return this.#unregister(params);
      case "agent.list": return this.#listAgents();
      case "workspace.show": return this.#workspaceShow(params);
      case "workspace.hide": this.workspace.visible = false; return { visible: false };
      case "workspace.focusAgent": return this.#focusAgent(params);
      case "workspace.focusTab": return this.#focusTab(params);
      case "workspace.requestAttention": this.notify("browser.attentionRequested", params); return { requested: true };
      case "profile.list": return [...this.profiles.values()].map((value) => structuredClone(value));
      case "profile.create": return this.#createProfile(params);
      case "profile.update": return this.#updateProfile(params);
      case "profile.delete": return this.#deleteProfile(params);
      case "browser.start": return this.#startBrowser(params);
      case "browser.stop": return this.#stopBrowser(params);
      case "browser.list": return this.#listBrowsers(params);
      case "browser.openTab": return this.#openTab(params);
      case "browser.closeTab": return this.#closeTab(params);
      case "browser.focusTab": return this.#backendFocusTab(params);
      case "browser.navigate": return this.#act({ ...params, action: { kind: "navigate", url: params.url } });
      case "browser.observe": return this.#observe(params);
      case "browser.act": return this.#act(params);
      case "browser.debug": return this.#debug(params);
      case "browser.streamInfo": return this.#streamInfo(params);
      case "browser.setControl": return this.#setControl(params);
      case "search.query": return this.#search(params);
      case "read.url": return this.#readUrl(params);
      case "read.activeTab": return this.#observe({ ...params, view: "main" });
      case "artifact.get": return this.artifacts.get(params.artifactId, params.offset, params.limit);
      case "artifact.list": return this.artifacts.list(params);
      case "artifact.delete": return { deleted: await this.artifacts.delete(params.artifactId) };
      default: throw new RpcError(-32601, `method not found: ${method}`);
    }
  }

  sweepDisconnected(at = Date.now()) {
    const disconnected = [];
    for (const [clientId, client] of this.clients) {
      if (!client.disconnected && at - Date.parse(client.lastHeartbeatAt) > this.heartbeatTimeoutMs) {
        client.disconnected = true;
        disconnected.push(clientId);
        this.notify("agent.disconnected", { agentId: client.agentId, clientId });
      }
    }
    return disconnected;
  }

  async #capabilities() {
    return {
      protocolVersion: PROTOCOL_VERSION,
      backend: await this.backend.capabilities(),
      methods: ["system.ping", "system.capabilities", "agent.register", "agent.heartbeat", "agent.unregister", "agent.list", "workspace.show", "workspace.hide", "workspace.focusAgent", "workspace.focusTab", "workspace.requestAttention", "profile.list", "profile.create", "profile.update", "profile.delete", "browser.start", "browser.stop", "browser.list", "browser.openTab", "browser.closeTab", "browser.focusTab", "browser.navigate", "browser.observe", "browser.act", "browser.debug", "browser.streamInfo", "browser.setControl", "search.query", "read.url", "read.activeTab", "artifact.get", "artifact.list", "artifact.delete"],
    };
  }

  #registerAgent(params) {
    for (const key of ["agentId", "clientId", "cwd", "pid", "mode"]) requireField(params, key);
    const stamp = now();
    const registration = { ...params, startedAt: params.startedAt ?? stamp, lastHeartbeatAt: stamp };
    this.agents.set(registration.agentId, structuredClone(registration));
    this.clients.set(registration.clientId, { ...structuredClone(registration), disconnected: false });
    this.notify("agent.registered", registration);
    return registration;
  }

  #heartbeat({ agentId, clientId }) {
    const client = required(this.clients, clientId, "client");
    if (client.agentId !== agentId) throw new RpcError(-32009, "client does not belong to agent", { agentId, clientId });
    client.lastHeartbeatAt = now(); client.disconnected = false;
    const agent = required(this.agents, agentId, "agent"); agent.lastHeartbeatAt = client.lastHeartbeatAt;
    this.notify("agent.updated", { agentId, clientId, lastHeartbeatAt: client.lastHeartbeatAt });
    return { ok: true, lastHeartbeatAt: client.lastHeartbeatAt };
  }

  #unregister({ agentId, clientId }) {
    const client = required(this.clients, clientId, "client");
    if (client.agentId !== agentId) throw new RpcError(-32009, "client does not belong to agent");
    this.clients.delete(clientId);
    return { ok: true, browserStatePreserved: true };
  }

  #listAgents() {
    return [...this.agents.values()].map((agent) => ({
      ...structuredClone(agent),
      connectedClients: [...this.clients.values()].filter((client) => client.agentId === agent.agentId && !client.disconnected).map((client) => client.clientId),
    }));
  }

  #workspaceShow(params) {
    this.workspace.visible = true;
    if (params.agentId) this.workspace.focusedAgentId = params.agentId;
    this.notify("workspace.focusRequested", { visible: true, agentId: params.agentId, tabId: params.tabId });
    return structuredClone(this.workspace);
  }

  #focusAgent({ agentId }) {
    required(this.agents, agentId, "agent"); this.workspace.focusedAgentId = agentId;
    this.notify("workspace.focusRequested", { agentId }); return structuredClone(this.workspace);
  }

  #focusTab({ agentId, browserSessionId, tabId }) {
    this.#address({ agentId, browserSessionId, tabId });
    this.workspace.focusedAgentId = agentId; this.workspace.focusedTabId = tabId;
    this.notify("workspace.focusRequested", { agentId, browserSessionId, tabId });
    return structuredClone(this.workspace);
  }

  #createProfile(params) {
    requireField(params, "name");
    if ([...this.profiles.values()].some((profile) => profile.name === params.name)) throw new RpcError(-32009, "profile name already exists", { name: params.name });
    const profile = { profileId: params.profileId ?? id(), name: params.name, engine: "chromium", dataDir: params.dataDir ?? join(this.dataRoot, "profiles", params.name), extensions: params.extensions ?? [], launchArgs: params.launchArgs ?? [], visibleByDefault: params.visibleByDefault ?? true };
    this.profiles.set(profile.profileId, profile); return structuredClone(profile);
  }

  #updateProfile(params) {
    const profile = required(this.profiles, params.profileId, "profile");
    if (this.profileHosts.has(profile.profileId) && (params.dataDir || params.extensions || params.launchArgs)) throw new RpcError(-32009, "cannot mutate launch configuration while profile host is running", { profileId: profile.profileId });
    Object.assign(profile, Object.fromEntries(Object.entries(params).filter(([key, value]) => key !== "profileId" && value !== undefined)));
    return structuredClone(profile);
  }

  #deleteProfile({ profileId }) {
    if (this.profileHosts.has(profileId)) throw new RpcError(-32009, "profile host is running", { profileId });
    return { deleted: this.profiles.delete(profileId) };
  }

  async #startBrowser(params) {
    requireField(params, "agentId"); required(this.agents, params.agentId, "agent");
    const profile = this.#resolveProfile(params.profileId ?? params.profile);
    const engine = params.engine === "auto" || !params.engine ? (profile || params.visible ? "chromium" : "lightpanda") : params.engine;
    if (profile && engine !== "chromium") throw new RpcError(-32602, "persistent profiles require Chromium");
    const profileQueue = profile ? getOrCreate(this.profileQueues, profile.profileId, () => new SerialQueue()) : null;
    const operation = async () => {
      let host = profile ? this.profileHosts.get(profile.profileId) && this.hosts.get(this.profileHosts.get(profile.profileId)) : undefined;
      if (!host) {
        this.#enforceHostLimit(engine);
        const backendHandle = await this.backend.startHost({ engine, profileId: profile?.profileId, profile });
        host = { hostId: id(), backend: params.backend ?? "agent-browser", engine, profileId: profile?.profileId, state: "ready", backendSessionId: backendHandle.backendHostId, backendHandle, createdAt: now(), queue: new SerialQueue() };
        this.hosts.set(host.hostId, host);
        if (profile) this.profileHosts.set(profile.profileId, host.hostId);
        this.notify("browser.hostUpdated", publicHost(host));
      }
      const browserSession = { browserSessionId: id(), ownerAgentId: params.agentId, hostId: host.hostId, label: params.label ?? profile?.name ?? `${engine} session`, createdAt: now(), lastActivityAt: now() };
      this.sessions.set(browserSession.browserSessionId, browserSession);
      const tab = await this.#openBackendTab(host, browserSession, params.url ?? "about:blank");
      this.notify("browser.sessionUpdated", browserSession);
      return { host: publicHost(host), browserSession: structuredClone(browserSession), tab };
    };
    return profileQueue ? profileQueue.run(operation) : operation();
  }

  async #stopBrowser(params) {
    const session = this.#ownedSession(params.agentId, params.browserSessionId);
    const host = required(this.hosts, session.hostId, "host");
    const ownedTabs = [...this.tabs.values()].filter((tab) => tab.browserSessionId === session.browserSessionId);
    await host.queue.run(async () => { for (const tab of ownedTabs) await this.#closeBackendTab(host, tab); });
    this.sessions.delete(session.browserSessionId);
    const stillUsed = [...this.sessions.values()].some((candidate) => candidate.hostId === host.hostId);
    if (!stillUsed && !host.profileId) { await this.backend.stopHost(host.backendHandle.backendHostId); this.hosts.delete(host.hostId); }
    return { stopped: true, hostPreserved: Boolean(host.profileId) };
  }

  #listBrowsers({ agentId } = {}) {
    const sessions = [...this.sessions.values()].filter((session) => !agentId || session.ownerAgentId === agentId);
    const sessionIds = new Set(sessions.map((session) => session.browserSessionId));
    const tabs = [...this.tabs.values()].filter((tab) => sessionIds.has(tab.browserSessionId));
    const hostIds = new Set(sessions.map((session) => session.hostId));
    const hosts = [...this.hosts.values()].filter((host) => hostIds.has(host.hostId)).map(publicHost);
    return { hosts, sessions: sessions.map((value) => structuredClone(value)), tabs: tabs.map((value) => structuredClone(value)) };
  }

  async #openTab(params) {
    const session = this.#ownedSession(params.agentId, params.browserSessionId);
    const host = required(this.hosts, session.hostId, "host");
    return host.queue.run(() => this.#openBackendTab(host, session, params.url ?? "about:blank"));
  }

  async #openBackendTab(host, session, url) {
    const count = [...this.tabs.values()].filter((tab) => tab.hostId === host.hostId).length;
    if (count >= this.limits.maxTabsPerHost) throw new RpcError(-32009, "tab limit reached", { hostId: host.hostId, limit: this.limits.maxTabsPerHost });
    const backendTab = await this.backend.openTab(host.backendHandle.backendHostId, url);
    const tab = { tabId: id(), hostId: host.hostId, browserSessionId: session.browserSessionId, ownerAgentId: session.ownerAgentId, backendTabId: backendTab.backendTabId, title: backendTab.title, url: backendTab.url, index: count, control: "agent", state: "idle", lastActionAt: undefined };
    this.tabs.set(tab.tabId, tab); this.controlGates.set(tab.tabId, new ControlGate());
    this.notify("browser.tabUpdated", publicTab(tab)); return publicTab(tab);
  }

  async #closeTab(params) {
    const initial = this.#address(params);
    if (params.source !== "human") {
      await required(this.controlGates, initial.tab.tabId, "control gate").waitForAgent();
    }
    const { host, tab } = this.#address(params);
    return host.queue.run(async () => { await this.#closeBackendTab(host, tab); return { closed: true, tabId: tab.tabId }; });
  }

  async #closeBackendTab(host, tab) {
    await this.backend.closeTab(host.backendHandle.backendHostId, tab.backendTabId);
    this.tabs.delete(tab.tabId); this.controlGates.delete(tab.tabId);
    this.notify("browser.tabUpdated", { ...publicTab(tab), state: "closed" });
  }

  async #backendFocusTab(params) {
    const initial = this.#address(params);
    if (params.source !== "human") {
      await required(this.controlGates, initial.tab.tabId, "control gate").waitForAgent();
    }
    const { tab } = this.#address(params);
    this.workspace.focusedAgentId = tab.ownerAgentId; this.workspace.focusedTabId = tab.tabId;
    this.notify("workspace.focusRequested", { agentId: tab.ownerAgentId, browserSessionId: tab.browserSessionId, tabId: tab.tabId });
    return { focused: true, tab: publicTab(tab) };
  }

  async #act(params) {
    requireField(params, "action");
    const initial = this.#address(params);
    if (params.source !== "human") {
      await required(this.controlGates, initial.tab.tabId, "control gate").waitForAgent();
    }

    if (params.action.kind === "tab-close") {
      const targetId = params.action.tabId ?? params.tabId;
      const initialTarget = this.#address({ agentId: params.agentId, browserSessionId: params.browserSessionId, tabId: targetId });
      if (params.source !== "human" && targetId !== params.tabId) {
        await required(this.controlGates, initialTarget.tab.tabId, "control gate").waitForAgent();
      }
      const { host, tab } = this.#address({ agentId: params.agentId, browserSessionId: params.browserSessionId, tabId: targetId });
      return host.queue.run(async () => {
        await this.#closeBackendTab(host, tab);
        return { ok: true, action: "tab-close", changed: ["tab closed"], tabId: targetId };
      });
    }

    if (params.action.kind === "tab-focus") {
      const targetId = params.action.tabId;
      const initialTarget = this.#address({ agentId: params.agentId, browserSessionId: params.browserSessionId, tabId: targetId });
      if (params.source !== "human" && targetId !== params.tabId) {
        await required(this.controlGates, initialTarget.tab.tabId, "control gate").waitForAgent();
      }
      const target = this.#address({ agentId: params.agentId, browserSessionId: params.browserSessionId, tabId: targetId }).tab;
      this.workspace.focusedAgentId = target.ownerAgentId;
      this.workspace.focusedTabId = target.tabId;
      this.notify("workspace.focusRequested", { agentId: target.ownerAgentId, browserSessionId: target.browserSessionId, tabId: target.tabId });
      return { ok: true, action: "tab-focus", changed: [`focused ${target.tabId}`], tabId: target.tabId };
    }

    const { host, session, tab } = this.#address(params);
    return host.queue.run(async () => {
      tab.state = "running"; tab.lastActionAt = now(); this.notify("browser.activity", { agentId: tab.ownerAgentId, browserSessionId: tab.browserSessionId, tabId: tab.tabId, action: params.action.kind, state: "running" });
      try {
        let result;
        if (params.action.kind === "tab-new") {
          const newTab = await this.#openBackendTab(host, session, params.action.url ?? "about:blank");
          result = { ok: true, action: "tab-new", changed: ["new tab opened"], newTabId: newTab.tabId };
        } else {
          result = await this.backend.act(host.backendHandle.backendHostId, tab.backendTabId, params.action);
          tab.url = result.url ?? tab.url; tab.title = result.title ?? tab.title;
          if (params.action.kind === "download") {
            const artifact = await this.artifacts.put(`mock download for ${tab.url}`, { mediaType: "text/plain", ownerAgentId: tab.ownerAgentId, browserSessionId: tab.browserSessionId, tabId: tab.tabId, sourceUrl: tab.url });
            result.downloadArtifactId = artifact.artifactId; this.notify("artifact.created", artifact);
          }
        }
        tab.state = "idle"; session.lastActivityAt = now(); this.notify("browser.tabUpdated", publicTab(tab));
        this.notify("browser.activity", { agentId: tab.ownerAgentId, browserSessionId: tab.browserSessionId, tabId: tab.tabId, action: params.action.kind, state: "complete", changed: result.changed });
        return result;
      } catch (error) { tab.state = "idle"; throw error; }
    });
  }

  async #observe(params) {
    const { host, tab } = this.#address(params);
    const maxChars = Math.max(1, Math.min(params.maxChars ?? 16_000, 1_000_000));
    return host.queue.run(async () => {
      const observation = await this.backend.observe(host.backendHandle.backendHostId, tab.backendTabId, { view: params.view ?? "main", selector: params.selector, includeBounds: params.includeBounds });
      if (params.view === "visual") {
        const bytes = await this.backend.screenshot(host.backendHandle.backendHostId, tab.backendTabId);
        const artifact = await this.artifacts.put(bytes, { mediaType: "image/png", ownerAgentId: tab.ownerAgentId, browserSessionId: tab.browserSessionId, tabId: tab.tabId, sourceUrl: tab.url });
        observation.artifactId = artifact.artifactId; this.notify("artifact.created", artifact);
      }
      if ([...observation.content].length > maxChars) {
        const artifact = await this.artifacts.put(observation.content, { mediaType: "text/markdown", ownerAgentId: tab.ownerAgentId, browserSessionId: tab.browserSessionId, tabId: tab.tabId, sourceUrl: tab.url, metadata: { view: observation.view } });
        observation.content = [...observation.content].slice(0, maxChars - 1).join("") + "…";
        observation.truncated = true; observation.artifactId = artifact.artifactId; this.notify("artifact.created", artifact);
      }
      return observation;
    });
  }

  async #debug(params) {
    const { host, tab } = this.#address(params);
    return host.queue.run(() => this.backend.debug(host.backendHandle.backendHostId, tab.backendTabId, { operation: params.operation, args: params.args }));
  }

  async #streamInfo(params) {
    const { host, tab } = this.#address(params);
    return this.backend.streamInfo(host.backendHandle.backendHostId, tab.backendTabId);
  }

  #setControl(params) {
    const { tab } = this.#address(params);
    const gate = required(this.controlGates, tab.tabId, "control gate"); gate.set(params.control); tab.control = params.control;
    this.notify("browser.controlChanged", { agentId: tab.ownerAgentId, browserSessionId: tab.browserSessionId, tabId: tab.tabId, control: tab.control });
    return publicTab(tab);
  }

  async #search(params) {
    requireField(params, "query");
    const endpoint = params.endpoint ?? process.env.PI_WEB_SEARXNG_URL;
    if (!endpoint) return { query: params.query, results: [], warning: "SearXNG endpoint is not configured" };
    const url = new URL("/search", endpoint); url.searchParams.set("q", params.query); url.searchParams.set("format", "json");
    const response = await fetch(url, optionalFetchTimeout("PI_WEB_SEARCH_TIMEOUT_MS"));
    if (!response.ok) throw new RpcError(-32050, `SearXNG request failed: ${response.status}`);
    const body = await response.json();
    const seen = new Set();
    const results = [];
    for (const item of body.results ?? []) {
      const normalized = normalizeUrl(item.url); if (!normalized || seen.has(normalized)) continue; seen.add(normalized);
      results.push({ title: item.title ?? "", url: normalized, snippet: item.content ?? "", engines: item.engines ?? [] });
      if (results.length >= Math.max(1, Math.min(params.limit ?? 8, 20))) break;
    }
    return { query: params.query, results };
  }

  async #readUrl(params) {
    requireField(params, "url");
    const response = await fetch(params.url, {
      headers: { Accept: "text/markdown, text/plain;q=0.9, text/html;q=0.8" },
      redirect: "follow",
      ...optionalFetchTimeout("PI_WEB_READER_TIMEOUT_MS"),
    });
    if (!response.ok) throw new RpcError(-32051, `read request failed: ${response.status}`);
    const mediaType = response.headers.get("content-type")?.split(";", 1)[0] ?? "application/octet-stream";
    const body = await response.text();
    const content = mediaType === "text/html" ? basicMainText(body) : body;
    const maxChars = Math.max(1, Math.min(params.maxChars ?? 20_000, 1_000_000));
    if ([...content].length <= maxChars) return { url: response.url, mediaType, content, truncated: false };
    const artifact = await this.artifacts.put(content, { mediaType: "text/markdown", ownerAgentId: params.agentId, sourceUrl: response.url });
    return { url: response.url, mediaType, content: [...content].slice(0, maxChars - 1).join("") + "…", truncated: true, artifactId: artifact.artifactId };
  }

  #resolveProfile(value) {
    if (!value) return undefined;
    return this.profiles.get(value) ?? [...this.profiles.values()].find((profile) => profile.name === value) ?? (() => { throw new RpcError(-32004, "profile not found", { profile: value }); })();
  }

  #enforceHostLimit(engine) {
    const current = [...this.hosts.values()].filter((host) => host.engine === engine).length;
    const limit = engine === "chromium" ? this.limits.maxChromiumHosts : this.limits.maxLightpandaHosts;
    if (current >= limit) throw new RpcError(-32009, `${engine} host limit reached`, { limit });
  }

  #ownedSession(agentId, browserSessionId) {
    requireField({ agentId }, "agentId");
    const session = required(this.sessions, browserSessionId, "browser session");
    if (session.ownerAgentId !== agentId) throw new RpcError(-32003, "browser session belongs to another agent", { agentId, browserSessionId });
    return session;
  }

  #address({ agentId, browserSessionId, tabId }) {
    for (const [name, value] of Object.entries({ agentId, browserSessionId, tabId })) if (!value) throw new RpcError(-32602, `${name} is required`);
    const session = this.#ownedSession(agentId, browserSessionId);
    const tab = required(this.tabs, tabId, "tab");
    if (tab.ownerAgentId !== agentId || tab.browserSessionId !== browserSessionId || tab.hostId !== session.hostId) throw new RpcError(-32003, "tab address does not match ownership", { agentId, browserSessionId, tabId });
    const host = required(this.hosts, tab.hostId, "host"); return { host, session, tab };
  }
}

function makeMockTab(backendTabId, url) {
  return { backendTabId, title: titleFor(url), url, content: `Main content for ${url}`, history: [], values: {}, clicks: 0, lastChanged: ["page loaded"] };
}
function titleFor(url) { try { return new URL(url).hostname || url; } catch { return url; } }
function publicHost(host) { const { queue, backendHandle, ...publicValue } = host; return structuredClone(publicValue); }
function publicTab(tab) { const { backendTabId, ...publicValue } = tab; return structuredClone(publicValue); }
function getOrCreate(map, key, factory) { if (!map.has(key)) map.set(key, factory()); return map.get(key); }
function id() { return randomUUID(); }
function now() { return new Date().toISOString(); }
function required(map, key, kind) { const value = map.get(key); if (!value) throw new RpcError(-32004, `${kind} not found`, { kind, id: key }); return value; }
function requireField(object, key) { if (object[key] === undefined || object[key] === null || object[key] === "") throw new RpcError(-32602, `${key} is required`); }
function sleep(milliseconds) { return new Promise((resolve) => setTimeout(resolve, milliseconds)); }
function normalizeUrl(input) { try { const url = new URL(input); for (const key of [...url.searchParams.keys()]) if (/^(utm_|fbclid|gclid)/i.test(key)) url.searchParams.delete(key); url.hash = ""; return url.toString(); } catch { return undefined; } }
function basicMainText(html) { return html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "").replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "").replace(/<(nav|footer|header|aside)\b[^>]*>[\s\S]*?<\/\1>/gi, "").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim(); }
function optionalFetchTimeout(variable) { const value = Number.parseInt(process.env[variable] ?? "0", 10); return Number.isFinite(value) && value > 0 ? { signal: AbortSignal.timeout(value) } : {}; }

export async function removeTree(path) { await rm(path, { recursive: true, force: true }); }
