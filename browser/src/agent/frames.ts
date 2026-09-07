import type { AgentKey } from "./key";
import type { WebContents } from "electron";
import { createHash, randomUUID } from "node:crypto";
import type { Point, Rect } from "agentcursor" with { "resolution-mode": "import" };
export interface FrameSummary {
  ref: string;
  parent?: string;
  name: string;
  url: string;
  selected: boolean;
}
export interface FrameDocument {
  id: string;
  ref: string;
  parent?: string;
  session: string;
  context?: string;
  contextId?: number;
  loader?: string;
  url: string;
  name: string;
}
interface Owner {
  frame: FrameDocument;
  objectId: string;
  x: number;
  y: number;
  width: number;
  height: number;
  clip: Rect;
  visible: boolean;
}
export interface FrameGeometry {
  x: number;
  y: number;
  zoom: number;
  clip: Rect;
  owners: Owner[];
  signature: string;
}
type Send = (method: string, params?: Record<string, unknown>, sessionId?: string) => Promise<any>;
const AUTO_ATTACH = { autoAttach: true, waitForDebuggerOnStart: true, flatten: true, filter: [{ type: "iframe", exclude: false }, { exclude: true }] };
const OWNER_MEASURE = `function(scroll) {
  if (!this.isConnected) throw new Error('frame detached');
  if (scroll) this.scrollIntoView({block:'center',inline:'center',behavior:'instant'});
  let visible = true;
  let clip = {x:0,y:0,width:innerWidth,height:innerHeight};
  const intersect = (a,b) => { const x=Math.max(a.x,b.x),y=Math.max(a.y,b.y); return {x,y,width:Math.max(0,Math.min(a.x+a.width,b.x+b.width)-x),height:Math.max(0,Math.min(a.y+a.height,b.y+b.height)-y)}; };
  for(let node=this;node;node=node.parentElement || node.getRootNode()?.host) {
    const style=getComputedStyle(node);
    if(style.transform !== 'none' || style.perspective !== 'none' || style.rotate !== 'none' || style.scale !== 'none' || style.translate !== 'none' || Number(style.zoom || 1) !== 1) throw new Error('unsupported frame owner transform');
    if(style.display==='none'||style.visibility!=='visible'||Number(style.opacity)===0) visible=false;
    if(node!==this && /(hidden|clip|auto|scroll)/.test(style.overflowX+' '+style.overflowY)) {
      const r=node.getBoundingClientRect();
      clip=intersect(clip,{x:r.x+node.clientLeft,y:r.y+node.clientTop,width:node.clientWidth,height:node.clientHeight});
    }
  }
  const style=getComputedStyle(this),r=this.getBoundingClientRect();
  const x=r.x+parseFloat(style.borderLeftWidth)+parseFloat(style.paddingLeft),y=r.y+parseFloat(style.borderTopWidth)+parseFloat(style.paddingTop);
  const width=r.width-parseFloat(style.borderLeftWidth)-parseFloat(style.borderRightWidth)-parseFloat(style.paddingLeft)-parseFloat(style.paddingRight);
  const height=r.height-parseFloat(style.borderTopWidth)-parseFloat(style.borderBottomWidth)-parseFloat(style.paddingTop)-parseFloat(style.paddingBottom);
  return {x,y,width,height,clip:intersect(clip,{x,y,width,height}),visible};
}`;
export class BrowserFrames {
  private readonly frames = new Map<string, FrameDocument>();
  private readonly sessions = new Map<string, string>();
  private readonly pending = new Set<Promise<unknown>>();
  private readonly listeners = new Set<() => void>();
  private next = 1;
  private root = "";
  private selected = "";
  private ready: Promise<void> | null = null;
  private failure: Error | null = null;
  private disposed = false;
  private geometryValue: FrameGeometry | null = null;
  private observationGeometry: string | null = null;
  private inputError: Error | null = null;
  private drag: {
    key: string;
    session: string;
    pressed: boolean;
    data?: Record<string, unknown>;
    entered: boolean;
    point: Point;
  } | null = null;
  private dragQueue: Promise<unknown> = Promise.resolve();
  private readonly namespace = randomUUID();
  private lastRoute: {
    session: string;
    point: Point;
  } | null = null;
  constructor(private readonly contents: WebContents, private readonly send: Send, private readonly initializeSession: (session: string) => Promise<void>) {
    contents.debugger.on("message", this.onMessage);
    contents.debugger.on("detach", () => this.invalidateAll());
    contents.once("destroyed", () => { this.disposed = true; this.invalidateAll(); });
  }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  private changed(): void {
    void this.finishDrag(true).catch(() => { }); this.geometryValue = null; for (const listener of this.listeners)
      listener();
  }
  private invalidateAll(): void { this.frames.clear(); this.sessions.clear(); this.changed(); }
  initialize(): Promise<void> {
    return this.ready ??= (async () => {
      await this.send("Page.enable");
      const tree = await this.send("Page.getFrameTree");
      this.tree(tree.frameTree, "");
      this.root = tree.frameTree.frame.id;
      this.selected = this.root;
      await this.send("Runtime.enable");
      await this.send("Target.setAutoAttach", AUTO_ATTACH);
      await this.settle();
    })();
  }
  private async settle(): Promise<void> {
    while (this.pending.size)
      await Promise.all([...this.pending]); if (this.failure)
      throw this.failure;
  }
  private track(task: Promise<unknown>): void {
    this.pending.add(task);
    void task.catch(error => { this.failure = error instanceof Error ? error : new Error(String(error)); this.changed(); }).finally(() => this.pending.delete(task));
  }
  private record(id: string, session: string): FrameDocument {
    let frame = this.frames.get(id);
    if (!frame) {
      frame = { id, ref: `f${this.next++}`, session, url: "", name: "" };
      this.frames.set(id, frame);
    }
    return frame;
  }
  private tree(tree: any, session: string, parent?: string): void {
    if (!tree?.frame?.id)
      return;
    const frame = this.record(tree.frame.id, session);
    Object.assign(frame, { session, parent: tree.frame.parentId ?? parent ?? frame.parent, loader: tree.frame.loaderId, url: tree.frame.url ?? "", name: tree.frame.name ?? "" });
    for (const child of tree.childFrames ?? [])
      this.tree(child, session, frame.id);
  }
  private affects(id: string): boolean {
    let frame = this.frames.get(this.selected); const seen = new Set<string>(); while (frame && !seen.has(frame.id)) {
      if (frame.id === id)
        return true;
      seen.add(frame.id);
      frame = frame.parent ? this.frames.get(frame.parent) : undefined;
    } return false;
  }
  private readonly onMessage = (_event: Electron.Event, method: string, params: any, session = "") => {
    if (this.disposed || session && !this.sessions.has(session))
      return;
    if (method === "Input.dragIntercepted" && !session && this.drag?.pressed)
      this.drag.data = params.data;
    if (method === "Target.attachedToTarget" && params.targetInfo.type === "iframe") {
      const child = params.sessionId;
      const frame = this.record(params.targetInfo.targetId, child);
      frame.parent = params.targetInfo.parentFrameId ?? frame.parent;
      frame.session = child;
      this.sessions.set(child, frame.id);
      this.track((async () => {
        try {
          await this.send("Runtime.enable", {}, child);
          await this.send("Page.enable", {}, child);
          this.tree((await this.send("Page.getFrameTree", {}, child)).frameTree, child, frame.parent);
          await this.initializeSession(child);
          await this.send("Target.setAutoAttach", AUTO_ATTACH, child);
        }
        finally {
          if (params.waitingForDebugger)
            await this.send("Runtime.runIfWaitingForDebugger", {}, child).catch(() => { });
        }
      })());
    }
    if (method === "Target.detachedFromTarget") {
      const id = this.sessions.get(params.sessionId);
      if (id) {
        if (this.frames.get(id)?.session === params.sessionId) {
          if (this.affects(id)) this.changed();
          this.frames.delete(id);
        }
        this.sessions.delete(params.sessionId);
      }
    }
    if (method === "Page.navigatedWithinDocument") {
      const frame=this.frames.get(params.frameId);
      if(frame) { if(this.affects(frame.id)) this.changed();frame.url=String(params.url); }
    }
    if (method === "Page.frameAttached")
      this.record(params.frameId, session).parent = params.parentFrameId;
    if (method === "Page.frameNavigated") {
      if (this.affects(params.frame.id))
        this.changed();
      this.tree({ frame: params.frame }, session);
    }
    if (method === "Page.frameDetached") {
      if (this.affects(params.frameId))
        this.changed();
      if (params.reason !== "swap")
        this.frames.delete(params.frameId);
      else {
        const frame = this.frames.get(params.frameId);
        if (frame?.session === session) {
          frame.context = undefined;
          frame.contextId = undefined;
        }
      }
    }
    if (method === "Runtime.executionContextCreated" && params.context.auxData?.isDefault) {
      const context = params.context;
      const frame = this.record(context.auxData.frameId, session);
      if (frame.context && frame.context !== context.uniqueId && this.affects(frame.id))
        this.changed();
      Object.assign(frame, { session, context: context.uniqueId, contextId: context.id });
    }
    if (method === "Runtime.executionContextsCleared" || method === "Runtime.executionContextDestroyed") {
      for (const frame of this.frames.values())
        if (frame.session === session && (method.endsWith("Cleared") || frame.contextId === params.executionContextId)) {
          if (this.affects(frame.id))
            this.changed();
          frame.context = undefined;
          frame.contextId = undefined;
        }
    }
  };
  async select(ref?: string): Promise<void> {
    await this.initialize();
    await this.settle();
    if (ref !== undefined) {
      const frame = ref === "main" ? this.frames.get(this.root) : [...this.frames.values()].find(frame => frame.ref === ref);
      if (!frame)
        throw new Error("stale or unknown frame; observe main to list frames");
      if (this.selected !== frame.id) {
        this.changed();
        this.selected = frame.id;
      }
    }
    this.chain();
    this.inputError = null;
  }
  assertInput(): void {
    if (this.inputError)
      throw this.inputError;
  }
  private async input(method: string, params: Record<string, unknown>, session: string): Promise<unknown> {
    try {
      return await this.send(method, params, session);
    }
    catch (error) {
      this.inputError = error instanceof Error ? error : new Error(String(error));
      throw error;
    }
  }
  selectedFrame(): FrameDocument {
    const frame = this.frames.get(this.selected); if (!frame?.context)
      throw new Error("selected frame changed or detached; observe main to select again"); return { ...frame };
  }
  chain(): FrameDocument[] {
    const result: FrameDocument[] = [];
    let frame = this.selectedFrame();
    while (true) {
      if (result.some(item => item.id === frame.id) || result.length >= 32)
        throw new Error("invalid frame ancestry");
      result.unshift({ ...frame });
      if (frame.id === this.root)
        break;
      const parent = frame.parent ? this.frames.get(frame.parent) : undefined;
      if (!parent?.context)
        throw new Error("frame ancestor changed or detached");
      frame = parent;
    }
    return result;
  }
  documentKey(): string { return createHash("sha256").update(this.namespace + ":" + this.chain().map(frame => frame.context).join(":")).digest("hex"); }
  summaries(): {
    frame: string;
    frames: FrameSummary[];
    framesTruncated: boolean;
  } {
    const values = [...this.frames.values()].filter(frame => {
      const visited = new Set<string>();
      let current: FrameDocument | undefined = frame;
      while (current?.context && !visited.has(current.id)) {
        if (current.id === this.root)
          return true;
        visited.add(current.id);
        current = current.parent ? this.frames.get(current.parent) : undefined;
      }
      return false;
    });
    return { frame: this.selectedFrame().ref, frames: values.slice(0, 24).map(frame => ({ ref: frame.ref, ...(frame.parent ? { parent: this.frames.get(frame.parent)?.ref } : {}), name: frame.name.slice(0, 100), url: frame.url.slice(0, 500), selected: frame.id === this.selected })), framesTruncated: values.length > 24 };
  }
  async evaluate(source: string, frame = this.selectedFrame()): Promise<unknown> {
    const key = this.documentKey();
    const result = await this.send("Runtime.evaluate", { expression: source, uniqueContextId: frame.context, returnByValue: true, awaitPromise: true, userGesture: true }, frame.session);
    if (key !== this.documentKey())
      throw new Error("frame changed during evaluation");
    if (result.exceptionDetails)
      throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? "frame evaluation failed");
    return result.result?.value;
  }
  rememberGeometry(): void { this.observationGeometry = this.geometryValue?.signature ?? null; }
  async assertCoordinates(point: Point): Promise<void> {
    const expected = this.observationGeometry;
    const geometry = await this.geometry();
    if (!expected || geometry.signature !== expected)
      throw new Error("frame geometry changed since visual observation");
    if (!await this.hit(geometry, point))
      throw new Error("coordinate target is outside or obstructed in selected frame");
  }
  async geometry(scroll = false): Promise<FrameGeometry> {
    const chain = this.chain(), key = this.documentKey(), zoom = this.contents.getZoomFactor();
    let x = 0, y = 0;
    const root = await this.evaluate("({width:innerWidth,height:innerHeight,scrollX,scrollY})", chain[0]) as {
      width: number;
      height: number;
    };
    let clip: Rect = { x: 0, y: 0, width: root.width, height: root.height };
    const owners: Owner[] = [];
    try {
      for (const session of new Set(chain.slice(0, -1).map(frame => frame.session)))
        await this.send("Runtime.releaseObjectGroup", { objectGroup: "terminal-browser-frame-owners" }, session);
      for (let index = 1; index < chain.length; index++) {
        const parent = chain[index - 1], child = chain[index];
        const node = await this.send("DOM.getFrameOwner", { frameId: child.id }, parent.session);
        const resolved = await this.send("DOM.resolveNode", { backendNodeId: node.backendNodeId, executionContextId: parent.contextId, objectGroup: "terminal-browser-frame-owners" }, parent.session);
        const objectId = resolved.object.objectId;
        const result = await this.send("Runtime.callFunctionOn", { objectId, functionDeclaration: OWNER_MEASURE, arguments: [{ value: scroll }], returnByValue: true }, parent.session);
        if (result.exceptionDetails)
          throw new Error(result.exceptionDetails.exception?.description ?? "frame owner measurement failed");
        const owner: Owner = { ...result.result.value, frame: parent, objectId };
        owners.push(owner);
        clip = intersect(clip, { ...owner.clip, x: owner.clip.x + x, y: owner.clip.y + y });
        if (!owner.visible)
          clip.width = clip.height = 0;
        x += owner.x;
        y += owner.y;
      }
      if (key !== this.documentKey() || zoom !== this.contents.getZoomFactor())
        throw new Error("frame changed during geometry measurement");
      const local = await this.evaluate("({width:innerWidth,height:innerHeight,scrollX,scrollY})");
      const geometry = { x, y, zoom, clip, owners, signature: JSON.stringify({ x, y, zoom, clip, root, local, owners: owners.map(({ x, y, width, height, clip, visible }) => ({ x, y, width, height, clip, visible })) }) };
      this.geometryValue = geometry;
      return geometry;
    }
    catch (error) {
      this.geometryValue = null;
      throw error;
    }
  }
  async hit(geometry: FrameGeometry, point: Point): Promise<boolean> {
    let x = point.x / geometry.zoom, y = point.y / geometry.zoom;
    if (!contains(geometry.clip, { x, y }))
      return false;
    for (const owner of geometry.owners) {
      const result = await this.send("Runtime.callFunctionOn", { objectId: owner.objectId, functionDeclaration: "function(x,y){let node=document.elementFromPoint(x,y);while(node?.shadowRoot?.elementFromPoint(x,y)) node=node.shadowRoot.elementFromPoint(x,y);return node===this;}", arguments: [{ value: x }, { value: y }], returnByValue: true }, owner.frame.session);
      if (result.exceptionDetails || result.result?.value !== true)
        return false;
      x -= owner.x;
      y -= owner.y;
    }
    return true;
  }
  async focused(geometry: FrameGeometry): Promise<boolean> {
    for (const owner of geometry.owners) {
      const result = await this.send("Runtime.callFunctionOn", { objectId: owner.objectId, functionDeclaration: "function(){let node=document.activeElement;while(node?.shadowRoot?.activeElement) node=node.shadowRoot.activeElement;return node===this;}", returnByValue: true }, owner.frame.session);
      if (result.exceptionDetails || result.result?.value !== true)
        return false;
    }
    return true;
  }
  inputRoute(point: Point): {
    session: string;
    point: Point;
  } {
    const frame = this.selectedFrame(), geometry = this.geometryValue;
    if (!geometry || geometry.zoom !== this.contents.getZoomFactor())
      throw new Error("frame geometry changed; observe again");
    const chain = this.chain();
    let x = point.x / geometry.zoom, y = point.y / geometry.zoom;
    const rootOfSession = chain.findIndex(item => item.session === frame.session);
    for (let index = 0; index < rootOfSession; index++) {
      x -= geometry.owners[index].x;
      y -= geometry.owners[index].y;
    }
    return { session: frame.session, point: { x, y } };
  }
  async startDrag(): Promise<void> {
    if (this.drag)
      throw new Error("a frame drag is already active");
    const frame = this.selectedFrame();
    this.drag = { key: this.documentKey(), session: frame.session, pressed: false, entered: false, point: { x: 0, y: 0 } };
    try {
      await this.send("Input.setInterceptDrags", { enabled: true });
    }
    catch (error) {
      this.drag = null;
      throw error;
    }
  }
  async finishDrag(cancelled: boolean): Promise<void> {
    const drag = this.drag;
    if (!drag)
      return;
    if (cancelled)
      this.drag = null;
    await this.dragQueue.catch(() => { });
    if (this.drag === drag)
      this.drag = null;
    try {
      if (cancelled && drag.data)
        await this.send("Input.dispatchDragEvent", { type: "dragCancel", ...drag.point, data: drag.data }, drag.session);
    }
    finally {
      await this.send("Input.setInterceptDrags", { enabled: false }).catch(() => { });
    }
  }
  dispatchEdit(text?: string): Promise<unknown> | null {
    const session = this.selectedFrame().session;
    if (!session)
      return null;
    if (text !== undefined)
      return this.input("Input.insertText", { text }, session);
    return (async () => {
      try {
        await this.input("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "a", code: "KeyA", windowsVirtualKeyCode: 65, commands: ["selectAll"] }, session);
      }
      finally {
        await this.input("Input.dispatchKeyEvent", { type: "keyUp", key: "a", code: "KeyA", windowsVirtualKeyCode: 65 }, session);
      }
    })();
  }
  dispatchKey(event: {
    type: "rawKeyDown" | "keyUp" | "char";
    key: AgentKey;
    character?: string;
  }): Promise<unknown> | null {
    const session = event.type === "keyUp" && !this.geometryValue ? this.lastRoute?.session : this.selectedFrame().session;
    if (!session)
      return null;
    const named: Record<string, [
      string,
      number
    ]> = { return: ["Enter", 13], escape: ["Escape", 27], tab: ["Tab", 9], backspace: ["Backspace", 8], delete: ["Delete", 46], up: ["ArrowUp", 38], down: ["ArrowDown", 40], left: ["ArrowLeft", 37], right: ["ArrowRight", 39], home: ["Home", 36], end: ["End", 35], pageup: ["PageUp", 33], pagedown: ["PageDown", 34], space: [" ", 32] };
    const [key, code] = named[event.key.keyCode] ?? [event.key.keyCode, /^F([1-9]|1[0-2])$/.test(event.key.keyCode) ? 111 + Number(event.key.keyCode.slice(1)) : event.key.keyCode.toUpperCase().charCodeAt(0)];
    const modifiers = event.key.modifiers.reduce((bits, key) => bits | ({ alt: 1, ctrl: 2, meta: 4, shift: 8 }[key]), 0);
    return this.input("Input.dispatchKeyEvent", { type: event.type, key, windowsVirtualKeyCode: code, modifiers, ...(event.type === "char" ? { text: event.character, unmodifiedText: event.character } : {}) }, session);
  }
  dispatchPointer(event: Electron.MouseInputEvent | Electron.MouseWheelInputEvent): Promise<unknown> | null {
    if (event.type === "mouseUp" && !this.geometryValue && !this.lastRoute)
      return null;
    let route: {
      session: string;
      point: Point;
    };
    if (event.type === "mouseUp" && !this.geometryValue && this.lastRoute)
      route = this.lastRoute;
    else
      route = this.inputRoute({ x: event.x, y: event.y });
    const drag = this.drag;
    if (drag) {
      if (drag.key !== this.documentKey() || drag.session !== route.session)
        throw new Error("frame changed during drag");
      if (event.type === "mouseDown")
        drag.pressed = true;
      drag.point = route.point;
      if (drag.data && (event.type === "mouseMove" || event.type === "mouseUp")) {
        const type = event.type === "mouseUp" ? "drop" : "dragOver";
        const data = drag.data, point = { ...route.point };
        this.dragQueue = this.dragQueue.then(async () => {
          if (this.drag !== drag)
            return;
          if (!drag.entered) {
            await this.input("Input.dispatchDragEvent", { type: "dragEnter", ...point, data }, drag.session);
            drag.entered = true;
          }
          if (this.drag !== drag)
            return;
          await this.input("Input.dispatchDragEvent", { type, ...point, data }, drag.session);
          if (type === "drop")
            await this.input("Input.dispatchMouseEvent", { type: "mouseReleased", ...point, button: event.button ?? "left", clickCount: 1 }, drag.session);
        });
        return this.dragQueue;
      }
    }
    if (!route.session) {
      this.lastRoute = null;
      return null;
    }
    this.lastRoute = route;
    const type = { mouseMove: "mouseMoved", mouseDown: "mousePressed", mouseUp: "mouseReleased", mouseWheel: "mouseWheel", mouseEnter: "mouseMoved", mouseLeave: "mouseMoved", contextMenu: "mouseMoved" }[event.type];
    const button = event.type === "mouseWheel" ? "none" : event.button ?? (event.modifiers?.includes("leftbuttondown") ? "left" : event.modifiers?.includes("rightbuttondown") ? "right" : event.modifiers?.includes("middlebuttondown") ? "middle" : "none");
    return this.input("Input.dispatchMouseEvent", { type, x: route.point.x, y: route.point.y, button, clickCount: event.type === "mouseWheel" ? 0 : event.clickCount ?? 0, ...(event.type === "mouseWheel" ? { deltaX: -((event as Electron.MouseWheelInputEvent).deltaX ?? 0), deltaY: -((event as Electron.MouseWheelInputEvent).deltaY ?? 0) } : {}), buttons: (event.modifiers?.includes("leftbuttondown") ? 1 : 0) | (event.modifiers?.includes("rightbuttondown") ? 2 : 0) | (event.modifiers?.includes("middlebuttondown") ? 4 : 0) }, route.session);
  }
  get active(): boolean { return !!this.ready && !!this.geometryValue; }
}
export function intersect(a: Rect, b: Rect): Rect { const x = Math.max(a.x, b.x), y = Math.max(a.y, b.y); return { x, y, width: Math.max(0, Math.min(a.x + a.width, b.x + b.width) - x), height: Math.max(0, Math.min(a.y + a.height, b.y + b.height) - y) }; }
export function contains(rect: Rect, point: Point): boolean { return point.x >= rect.x && point.y >= rect.y && point.x < rect.x + rect.width && point.y < rect.y + rect.height; }
export function toSurface(rect: Rect, geometry: FrameGeometry): Rect { return { x: (rect.x + geometry.x) * geometry.zoom, y: (rect.y + geometry.y) * geometry.zoom, width: rect.width * geometry.zoom, height: rect.height * geometry.zoom }; }
