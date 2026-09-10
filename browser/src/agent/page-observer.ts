import { DOM_HELPERS, LOCATOR_HELPERS, REGISTRY_SETUP } from "./page-script";
import { parseLocator } from "./locator";
import type { LocatorSpec, PageSnapshot, Point, Rect } from "agentcursor" with {
  "resolution-mode": "import",
};

import type {
  AgentBrowserTarget,
  AgentElementState,
  AgentLocatorQuery,
  AgentPageObserver,
  AgentPageProbe,
  ObservedPage,
} from "./types";

const DEFAULT_MAX_ELEMENTS = 200;
const MAX_ELEMENTS = 500;
const MAX_TEXT = 20_000;


function observeSource(maxElements: number, includeText: boolean, filter?: LocatorSpec): string {
  return String.raw`(() => {
${REGISTRY_SETUP}
const limit = ${maxElements};
const includeText = ${includeText ? "true" : "false"};
${DOM_HELPERS}
${LOCATOR_HELPERS}
const selected = ${JSON.stringify(filter ?? null)};
const selectedNodes = selected ? new Set(queryLocator(selected)) : null;
const elements = [];
const shadowTexts = [];
const visited = new WeakSet();
const walk = (node) => {
  if (node instanceof Element) {
    if (visited.has(node)) return;
    visited.add(node);
    if ((selectedNodes ? selectedNodes.has(node) : candidate(node)) && elements.length < limit) {
      const info = rectInfo(node);
      if (info) {
        const value = valueOf(node);
        elements.push({
          ref: refFor(node),
          tag: node.tagName.toLowerCase(),
          role: roleOf(node),
          name: accessibleName(node),
          rect: info.rect,
          editable: editableOf(node),
          ...(value ? { value } : {}),
          visible: info.visible,
          inViewport: info.inViewport,
        });
      }
    }
    if (node.shadowRoot) {
      if (includeText) shadowTexts.push(node.shadowRoot.textContent || "");
      walk(node.shadowRoot);
    }
  }
  for (const child of node.children || []) walk(child);
};
if (document.documentElement) walk(document.documentElement);
const normalText = document.body?.innerText || document.body?.textContent || "";
const text = includeText ? clean([normalText, ...shadowTexts].join("\n"), ${MAX_TEXT}) : "";
return {
  documentId: registry.documentId,
  snapshot: {
    url: String(location.href),
    title: clean(document.title, 500),
    viewport: {
      width: innerWidth,
      height: innerHeight,
      scrollX: globalThis.scrollX,
      scrollY: globalThis.scrollY,
      devicePixelRatio: globalThis.devicePixelRatio || 1,
    },
    elements,
    text,
  },
};
})()`;
}

const CURRENT_DOCUMENT_SOURCE = String.raw`(() => {
${REGISTRY_SETUP}
return registry.documentId;
})()`;

function refStateSource(ref: string): string {
  return String.raw`(() => {
${REGISTRY_SETUP}
const element = registry.elements.get(${JSON.stringify(ref)});
if (!element) return { exists: false, connected: false, editable: false };
const tag = element.tagName.toLowerCase();
const type = (element.getAttribute("type") || "text").toLowerCase();
const contentEditable = element.isContentEditable === true ||
  (element.getAttribute("contenteditable") || "").toLowerCase() !== "false" &&
  element.hasAttribute("contenteditable");
const editable = contentEditable ||
  (tag === "textarea" && !element.disabled && !element.readOnly) ||
  (tag === "input" && type !== "hidden" && !element.disabled && !element.readOnly);
return { exists: true, connected: element.isConnected === true, editable };
})()`;
}

const PROBE_SOURCE = String.raw`(() => {
${REGISTRY_SETUP}
const clean = (value, max) => String(value ?? "")
  .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
  .replace(/\s+/g, " ")
  .trim()
  .slice(0, max);
const rectVisible = (element) => {
  if (!element || !element.isConnected) return false;
  const rect = element.getBoundingClientRect();
  const style = getComputedStyle(element);
  const opacity = Number.parseFloat(style.opacity || "1");
  return style.display !== "none" && style.visibility !== "hidden" &&
    style.visibility !== "collapse" && Number.isFinite(opacity) && opacity > 0 &&
    rect.width > 0 && rect.height > 0;
};
const visibleText = (element) => {
  try { return element.innerText || element.textContent || ""; }
  catch { return element.textContent || ""; }
};
const contentEditable = (element) => element.isContentEditable === true ||
  (element.getAttribute("contenteditable") || "").toLowerCase() !== "false" &&
  element.hasAttribute("contenteditable");
const valueOf = (element) => {
  const tag = element.tagName.toLowerCase();
  const type = (element.getAttribute("type") || "text").toLowerCase();
  if (tag === "input" && type === "password") return "";
  if (tag === "input" || tag === "textarea") return element.value;
  if (contentEditable(element)) return element.textContent;
  return "";
};
const ref = registry.elements.get(${JSON.stringify("__REF__")});
const parts = [];
const visit = (node) => {
  if (node instanceof Element && node.shadowRoot) {
    parts.push(node.shadowRoot.textContent || "");
    visit(node.shadowRoot);
  }
  for (const child of node.children || []) visit(child);
};
if (document.documentElement) visit(document.documentElement);
const normalText = document.body?.innerText || document.body?.textContent || "";
const connected = !!ref && ref.isConnected === true;
const refText = connected
  ? clean([visibleText(ref), valueOf(ref)].join(" "), 20000)
  : "";
return {
  exists: connected,
  visible: rectVisible(ref),
  refText,
  documentText: clean([normalText, ...parts].join("\n"), 20000),
};
})()`;

function probeSource(ref?: string): string {
  return PROBE_SOURCE.replace(JSON.stringify("__REF__"), JSON.stringify(ref ?? ""));
}

function ensureVisibleSource(ref: string): string {
  return String.raw`(() => {
${REGISTRY_SETUP}
const element = registry.elements.get(${JSON.stringify(ref)});
if (!element || !element.isConnected) return null;
const before = element.getBoundingClientRect();
const inViewport = before.bottom > 0 && before.right > 0 && before.left < innerWidth && before.top < innerHeight;
if (!inViewport) element.scrollIntoView({ block: "center", inline: "nearest", behavior: "auto" });
const rect = element.getBoundingClientRect();
return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
})()`;
}

export class PageObserver implements AgentPageObserver {
  constructor(private readonly target: Pick<AgentBrowserTarget, "runJs">) {}

  async observe(
    maxElements = DEFAULT_MAX_ELEMENTS,
    includeText = true,
    filter?: LocatorSpec,
  ): Promise<ObservedPage> {
    const result = await this.target.runJs(observeSource(boundMaxElements(maxElements), includeText, filter === undefined ? undefined : parseLocator(filter)));
    return parseObservedPage(result);
  }

  async queryLocator(spec: LocatorSpec): Promise<AgentLocatorQuery> {
    const result = await this.target.runJs(`(() => {
${REGISTRY_SETUP}
${DOM_HELPERS}
${LOCATOR_HELPERS}
const nodes = queryLocator(${JSON.stringify(parseLocator(spec))});
return { documentId: registry.documentId, count: nodes.length, matches: nodes.slice(0, 8).map(node => stateOf(node)) };
})()`);
    if (!result || typeof result !== "object") throw new Error("invalid locator result");
    const query = result as AgentLocatorQuery;
    if (typeof query.documentId !== "string" || !Number.isSafeInteger(query.count) || query.count < 0 ||
        !Array.isArray(query.matches) || query.matches.length > 8) throw new Error("invalid locator result");
    query.matches.forEach(validateElementState);
    return query;
  }

  async elementState(ref: string, options: { point?: Point; scroll?: boolean; guard?: () => void; documentId?: string } = {}): Promise<{ documentId: string; state: AgentElementState | null }> {
    options.guard?.();
    const result = await this.target.runJs(`(() => {
${REGISTRY_SETUP}
${DOM_HELPERS}
${LOCATOR_HELPERS}
const expected = ${JSON.stringify(options.documentId ?? null)};
if (expected && registry.documentId !== expected) throw new Error("page changed since observation");
const element = registry.elements.get(${JSON.stringify(ref)});
if (${options.scroll === true} && element?.isConnected && shown(element)) {
  const rect = clippedRect(element);
  const full = element.getBoundingClientRect();
  if (rect.width < full.width || rect.height < full.height) element.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
}
return { documentId: registry.documentId, state: stateOf(element, ${JSON.stringify(options.point ?? null)}) };
})()`);
    if (!result || typeof result !== "object" || typeof (result as { documentId?: unknown }).documentId !== "string") throw new Error("invalid element state");
    const state = result as { documentId: string; state: AgentElementState | null };
    if (state.state !== null) validateElementState(state.state);
    return state;
  }

  async currentDocumentId(): Promise<string> {
    const result = await this.target.runJs(CURRENT_DOCUMENT_SOURCE);
    if (typeof result !== "string" || result.length === 0) {
      throw new Error("page observer returned an invalid document id");
    }
    return result;
  }

  async ensureVisible(ref: string): Promise<Rect | null> {
    const result = await this.target.runJs(ensureVisibleSource(ref));
    if (result === null) return null;
    if (!result || typeof result !== "object") {
      throw new Error("page observer returned an invalid rectangle");
    }
    const rect = result as Record<string, unknown>;
    if (![rect.x, rect.y, rect.width, rect.height].every((value) => typeof value === "number")) {
      throw new Error("page observer returned an invalid rectangle");
    }
    return {
      x: rect.x as number,
      y: rect.y as number,
      width: rect.width as number,
      height: rect.height as number,
    };
  }

  async refState(ref: string): Promise<{ exists: boolean; connected: boolean; editable: boolean }> {
    const result = await this.target.runJs(refStateSource(ref));
    if (!result || typeof result !== "object") {
      throw new Error("page observer returned an invalid ref state");
    }
    const state = result as Record<string, unknown>;
    if (![state.exists, state.connected, state.editable].every((value) => typeof value === "boolean")) {
      throw new Error("page observer returned an invalid ref state");
    }
    return {
      exists: state.exists as boolean,
      connected: state.connected as boolean,
      editable: state.editable as boolean,
    };
  }

  async probe(ref?: string, _text?: string): Promise<AgentPageProbe> {
    const result = await this.target.runJs(probeSource(ref));
    if (!result || typeof result !== "object") {
      throw new Error("page observer returned an invalid wait probe");
    }
    const probe = result as Record<string, unknown>;
    if (typeof probe.exists !== "boolean" || typeof probe.visible !== "boolean" ||
        typeof probe.refText !== "string" || typeof probe.documentText !== "string") {
      throw new Error("page observer returned an invalid wait probe");
    }
    return {
      exists: probe.exists,
      visible: probe.visible,
      refText: probe.refText,
      documentText: probe.documentText,
    };
  }
}

function parseObservedPage(value: unknown): ObservedPage {
  if (!value || typeof value !== "object") throw new Error("page observer returned an invalid snapshot");
  const result = value as { documentId?: unknown; snapshot?: unknown };
  if (typeof result.documentId !== "string" || result.documentId.length === 0 ||
      !result.snapshot || typeof result.snapshot !== "object") {
    throw new Error("page observer returned an invalid snapshot");
  }
  return {
    documentId: result.documentId,
    snapshot: result.snapshot as PageSnapshot,
  };
}

function boundMaxElements(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_MAX_ELEMENTS;
  return Math.min(MAX_ELEMENTS, Math.max(1, Math.floor(value)));
}

function validateElementState(state: AgentElementState): void {
  if (!state || typeof state !== "object" || !state.rect || !state.bounds ||
      ![state.bounds.x, state.bounds.y, state.bounds.width, state.bounds.height].every(Number.isFinite) ||
      ![state.rect.x, state.rect.y, state.rect.width, state.rect.height].every(Number.isFinite) ||
      state.rect.width < 0 || state.rect.height < 0 ||
      ![state.ref, state.text, state.tag, state.name, state.role].every(value => typeof value === "string") ||
      ![state.visible, state.enabled, state.editable, state.hit, state.focused].every(value => typeof value === "boolean")) {
    throw new Error("invalid element state");
  }
}
