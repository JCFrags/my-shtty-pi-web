import type { LocatorSpec, Point, Rect } from "agentcursor" with { "resolution-mode": "import" };
import { BrowserFrames, intersect, toSurface } from "./frames";
import type { FrameGeometry } from "./frames";
import { PageObserver } from "./page-observer";
import type { AgentElementState, AgentPageObserver } from "./types";
export class FrameObserver implements AgentPageObserver {
  private readonly local: PageObserver;
  constructor(readonly frames: BrowserFrames) { this.local = new PageObserver({ runJs: source => frames.evaluate(source) }); }
  private nextRef = 1;
  private readonly refs = new Map<string, {
    key: string;
    local: string;
  }>();
  private readonly encoded = new Map<string, string>();
  private encode(local: string): string {
    const key = this.frames.documentKey(), identity = key + ":" + local;
    let ref = this.encoded.get(identity);
    if (!ref) {
      ref = "e" + this.nextRef++;
      this.encoded.set(identity, ref);
      this.refs.set(ref, { key, local });
      if (this.refs.size > 20000) {
        const oldest = this.refs.keys().next().value!;
        const entry = this.refs.get(oldest)!;
        this.refs.delete(oldest);
        this.encoded.delete(entry.key + ":" + entry.local);
      }
    }
    return ref;
  }
  private decode(ref: string): string {
    const entry = this.refs.get(ref);
    if (!entry || entry.key !== this.frames.documentKey())
      throw new Error('stale or cross-frame ref');
    return entry.local;
  }
  async currentDocumentId(): Promise<string> { return this.frames.documentKey() + ":" + await this.local.currentDocumentId(); }
  private async state(state: AgentElementState | null, geometry: FrameGeometry, point?: Point): Promise<AgentElementState | null> {
    if (!state)
      return null;
    const bounds = toSurface(state.bounds, geometry), rect = intersect(toSurface(state.rect, geometry), toSurface({ ...geometry.clip, x: geometry.clip.x - geometry.x, y: geometry.clip.y - geometry.y }, geometry));
    const hitPoint = point ?? { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    return { ...state, focused: state.focused && await this.frames.focused(geometry), ref: this.encode(state.ref), bounds, rect, visible: state.visible && rect.width > 0 && rect.height > 0, hit: state.hit && await this.frames.hit(geometry, hitPoint) };
  }
  async observe(maxElements: number, includeText: boolean, filter?: LocatorSpec) {
    const key = this.frames.documentKey(), geometry = await this.frames.geometry();
    const page = await this.local.observe(maxElements, includeText, filter);
    const elements = page.snapshot.elements.map(element => {
      const rect = toSurface(element.rect, geometry), clipped = intersect(rect, { x: geometry.clip.x * geometry.zoom, y: geometry.clip.y * geometry.zoom, width: geometry.clip.width * geometry.zoom, height: geometry.clip.height * geometry.zoom });
      return { ...element, ref: this.encode(element.ref), rect, visible: element.visible && clipped.width > 0 && clipped.height > 0, inViewport: element.inViewport && clipped.width > 0 && clipped.height > 0 };
    });
    if (key !== this.frames.documentKey())
      throw new Error('frame changed during observation');
    const root = await this.frames.evaluate('({width:innerWidth,height:innerHeight})', this.frames.chain()[0]) as {
      width: number;
      height: number;
    };
    return { documentId: key + ":" + page.documentId, snapshot: { ...page.snapshot, elements, viewport: { ...page.snapshot.viewport, width: root.width * geometry.zoom, height: root.height * geometry.zoom } } };
  }
  async queryLocator(spec: LocatorSpec) {
    const geometry = await this.frames.geometry(), result = await this.local.queryLocator(spec);
    return { documentId: this.frames.documentKey() + ":" + result.documentId, count: result.count, matches: await Promise.all(result.matches.map(async (state) => (await this.state(state, geometry))!)) };
  }
  async elementState(ref: string, options: {
    point?: Point;
    scroll?: boolean;
    guard?: () => void;
    documentId?: string;
  } = {}) {
    options.guard?.();
    const documentId = await this.currentDocumentId();
    options.guard?.();
    if (options.documentId && options.documentId !== documentId)
      throw new Error('frame changed since observation');
    const localRef = this.decode(ref);
    if (options.scroll) {
      await this.frames.geometry(true, options.guard);
      options.guard?.();
      await this.local.elementState(localRef, { scroll: true, guard: options.guard });
      options.guard?.();
    }
    const geometry = await this.frames.geometry();
    const point = options.point ? { x: options.point.x / geometry.zoom - geometry.x, y: options.point.y / geometry.zoom - geometry.y } : undefined;
    const result = await this.local.elementState(localRef, { point });
    return { documentId, state: await this.state(result.state, geometry, options.point) };
  }
  async ensureVisible(ref: string): Promise<Rect | null> { return (await this.elementState(ref, { scroll: true })).state?.rect ?? null; }
  async refState(ref: string) { return this.local.refState(this.decode(ref)); }
  async probe(ref?: string, text?: string) {
    const result = await this.local.probe(ref ? this.decode(ref) : undefined, text);
    if (ref && result.visible)
      result.visible = (await this.elementState(ref)).state?.visible ?? false;
    return result;
  }
}
