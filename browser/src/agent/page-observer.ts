import type { PageSnapshot, Rect } from "agentcursor" with {
  "resolution-mode": "import",
};

import type {
  AgentBrowserTarget,
  AgentPageObserver,
  AgentPageProbe,
  ObservedPage,
} from "./types";

const DEFAULT_MAX_ELEMENTS = 200;
const MAX_ELEMENTS = 500;
const MAX_TEXT = 20_000;

const REGISTRY_SETUP = String.raw`
const registryKey = "__terminalBrowserAgentRegistry";
const existingRegistry = globalThis[registryKey];
const makeDocumentId = () => {
  try {
    return globalThis.crypto.randomUUID();
  } catch {}
  return "document-" + Date.now() + "-" + Math.random().toString(36).slice(2);
};
const registry =
  existingRegistry && existingRegistry.ownerDocument === document
    ? existingRegistry
    : {
        ownerDocument: document,
        documentId: makeDocumentId(),
        refs: new WeakMap(),
        elements: new Map(),
        next: 1,
      };
if (registry !== existingRegistry) globalThis[registryKey] = registry;
`;

function observeSource(maxElements: number, includeText: boolean): string {
  return String.raw`(() => {
${REGISTRY_SETUP}
const limit = ${maxElements};
const includeText = ${includeText ? "true" : "false"};
const clean = (value, max) => String(value ?? "")
  .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
  .replace(/\s+/g, " ")
  .trim()
  .slice(0, max);
const refFor = (element) => {
  let ref = registry.refs.get(element);
  if (!ref) {
    ref = "e" + registry.next++;
    registry.refs.set(element, ref);
    registry.elements.set(ref, element);
  }
  return ref;
};
const contentEditable = (element) => {
  const value = element.getAttribute("contenteditable");
  return element.isContentEditable === true ||
    (value !== null && value.toLowerCase() !== "false");
};
const hasTabIndex = (element) => element.hasAttribute("tabindex") && element.tabIndex >= 0;
const roleOf = (element) => {
  const explicit = element.getAttribute("role")?.trim().split(/\s+/, 1)[0];
  if (explicit) return explicit;
  const tag = element.tagName.toLowerCase();
  if (tag === "a" && element.hasAttribute("href")) return "link";
  if (tag === "button" || tag === "summary") return "button";
  if (tag === "textarea") return "textbox";
  if (tag === "select") return element.multiple ? "listbox" : "combobox";
  if (tag === "input") {
    const type = (element.getAttribute("type") || "text").toLowerCase();
    if (["button", "image", "reset", "submit"].includes(type)) return "button";
    if (type === "checkbox") return "checkbox";
    if (type === "radio") return "radio";
    if (type === "range") return "slider";
    if (type === "number") return "spinbutton";
    if (type === "search") return "searchbox";
    return "textbox";
  }
  if (contentEditable(element)) return "textbox";
  return "generic";
};
const candidate = (element) => {
  const tag = element.tagName.toLowerCase();
  if (tag === "input" && (element.getAttribute("type") || "text").toLowerCase() === "hidden") {
    return false;
  }
  if (element.getAttribute("role")?.trim()) return true;
  if (hasTabIndex(element) || contentEditable(element)) return true;
  return tag === "a" && element.hasAttribute("href") ||
    ["button", "input", "textarea", "select", "summary"].includes(tag);
};
const rectInfo = (element) => {
  const rect = element.getBoundingClientRect();
  const style = getComputedStyle(element);
  const opacity = Number.parseFloat(style.opacity || "1");
  if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse" ||
      !Number.isFinite(opacity) || opacity <= 0 || rect.width <= 0 || rect.height <= 0) {
    return null;
  }
  return {
    rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
    visible: true,
    inViewport: rect.bottom > 0 && rect.right > 0 && rect.left < innerWidth && rect.top < innerHeight,
  };
};
const visibleText = (element) => {
  try {
    return element.innerText || element.textContent || "";
  } catch {
    return element.textContent || "";
  }
};
const labelledBy = (element) => {
  const value = element.getAttribute("aria-labelledby");
  if (!value) return "";
  const root = element.getRootNode();
  const getById = root && typeof root.getElementById === "function"
    ? (id) => root.getElementById(id)
    : () => null;
  return value.split(/\s+/).map((id) => getById(id)?.textContent || "").join(" ");
};
const associatedLabel = (element) => {
  try {
    if ("labels" in element && element.labels?.length) {
      return Array.from(element.labels).map((label) => visibleText(label)).join(" ");
    }
  } catch {}
  try {
    return element.closest("label") ? visibleText(element.closest("label")) : "";
  } catch {
    return "";
  }
};
const accessibleName = (element) => {
  const labelled = [
    element.getAttribute("aria-label"),
    labelledBy(element),
    associatedLabel(element),
    element.getAttribute("alt"),
    element.getAttribute("placeholder"),
    element.getAttribute("title"),
    visibleText(element),
  ];
  if (!labelled[3]) {
    try {
      labelled[3] = element.querySelector("[alt]")?.getAttribute("alt") || "";
    } catch {}
  }
  return clean(labelled.find((value) => clean(value, 200)) || "", 200);
};
const valueOf = (element) => {
  const tag = element.tagName.toLowerCase();
  const type = (element.getAttribute("type") || "text").toLowerCase();
  if (tag === "input" && type === "password") return "";
  if (tag === "input" || tag === "textarea") return clean(element.value, 200);
  if (tag === "select") return clean(Array.from(element.selectedOptions || []).map((option) => option.textContent).join(" "), 200);
  if (contentEditable(element)) return clean(element.textContent, 200);
  return "";
};
const editableOf = (element) => {
  const tag = element.tagName.toLowerCase();
  const type = (element.getAttribute("type") || "text").toLowerCase();
  if (contentEditable(element)) return true;
  if (tag === "textarea") return !element.disabled && !element.readOnly;
  if (tag === "input" && type !== "hidden") return !element.disabled && !element.readOnly;
  return false;
};
const elements = [];
const shadowTexts = [];
const visited = new WeakSet();
const walk = (node) => {
  if (node instanceof Element) {
    if (visited.has(node)) return;
    visited.add(node);
    if (candidate(node) && elements.length < limit) {
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
  ): Promise<ObservedPage> {
    const result = await this.target.runJs(observeSource(boundMaxElements(maxElements), includeText));
    return parseObservedPage(result);
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
