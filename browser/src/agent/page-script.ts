export const REGISTRY_SETUP = String.raw`
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


export const DOM_HELPERS = String.raw`
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
  return element.isContentEditable === true;
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
    if (element.hasAttribute("list")) return "combobox";
    if (type === "search") return "searchbox";
    return "textbox";
  }
  if (/^h[1-6]$/.test(tag)) return "heading";
  if (tag === "img") return "img";
  if (tag === "form") return "form";
  if (tag === "nav") return "navigation";
  if (tag === "main") return "main";
  if (tag === "dialog") return "dialog";
  if (tag === "table") return "table";
  if (tag === "thead" || tag === "tbody" || tag === "tfoot") return "rowgroup";
  if (tag === "tr") return "row";
  if (tag === "td") return "cell";
  if (tag === "th") return element.getAttribute("scope") === "row" ? "rowheader" : "columnheader";
  if (tag === "progress") return "progressbar";
  if (tag === "article") return "article";
  if (tag === "aside") return "complementary";
  if (tag === "option") return "option";
  if (tag === "ul" || tag === "ol") return "list";
  if (tag === "li") return "listitem";
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
const accessibleName = (element, max = 200) => {
  const labelled = [
    labelledBy(element),
    element.getAttribute("aria-label"),
    associatedLabel(element),
    element.getAttribute("alt"),
    element.getAttribute("placeholder"),
    element.getAttribute("title"),
    element.tagName === "INPUT" && ["button", "submit", "reset"].includes(element.type) ? element.value || (element.type === "submit" ? "Submit" : element.type === "reset" ? "Reset" : "") : "",
    visibleText(element),
  ];
  if (!labelled[3]) {
    try {
      labelled[3] = element.querySelector("[alt]")?.getAttribute("alt") || "";
    } catch {}
  }
  return clean(labelled.find((value) => clean(value, max)) || "", max);
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
  if (element.getAttribute("aria-readonly") === "true") return false;
  const tag = element.tagName.toLowerCase();
  const type = (element.getAttribute("type") || "text").toLowerCase();
  if (contentEditable(element)) return true;
  if (tag === "textarea") return !element.matches(":disabled") && !element.readOnly;
  if (tag === "input" && ["text", "search", "email", "url", "tel", "password", "number"].includes(type)) return !element.matches(":disabled") && !element.readOnly;
  return false;
};
`;

export const LOCATOR_HELPERS = String.raw`
const parentOf = (element) => element.parentElement || element.getRootNode()?.host || null;
const containsComposed = (parent, child) => {
  for (let node = child; node; node = parentOf(node)) if (node === parent) return true;
  return false;
};
const descendants = (root) => {
  const result = [];
  const visit = (node) => {
    if (node instanceof Element) {
      if (result.length >= 20000) throw new Error("locator scope exceeds 20000 elements; narrow the scope");
      result.push(node);
      if (node.shadowRoot) visit(node.shadowRoot);
    }
    for (const child of node.children || []) visit(child);
  };
  if (root instanceof Element && root.shadowRoot) visit(root.shadowRoot);
  for (const child of root.children || []) visit(child);
  return result;
};
const textMatches = (value, wanted, exact = true) => {
  const actual = clean(value, 20000);
  const expected = clean(wanted, 20000);
  return exact ? actual === expected : actual.toLowerCase().includes(expected.toLowerCase());
};
const ariaHidden = (element) => {
  for (let node = element; node; node = parentOf(node)) if (node.getAttribute("aria-hidden") === "true") return true;
  return false;
};
const queryLocator = (spec) => {
  let roots = [document];
  for (const step of spec) {
    if (step.kind === "nth") {
      const index = step.index < 0 ? roots.length + step.index : step.index;
      roots = roots[index] ? [roots[index]] : [];
      continue;
    }
    if (step.kind === "filter") {
      roots = roots.filter(node => textMatches(node.textContent, step.hasText, false));
      continue;
    }
    const found = new Set();
    for (const root of roots) {
      const nodes = descendants(root);
      if (step.kind === "css") {
        const scopes = [root, ...nodes.filter(node => node.shadowRoot).map(node => node.shadowRoot)];
        if (root.shadowRoot) scopes.push(root.shadowRoot);
        for (const scope of scopes) for (const node of scope.querySelectorAll(step.value)) found.add(node);
        continue;
      }
      for (const node of nodes) {
        let matches = false;
        if (step.kind === "role") matches = roleOf(node) === step.value && shown(node) && !ariaHidden(node) &&
          (step.name === undefined || textMatches(accessibleName(node, 20000), step.name, step.exact));
        if (step.kind === "label") matches = ("labels" in node && (textMatches(associatedLabel(node), step.value, step.exact) ||
          Array.from(node.labels || []).some(label => textMatches(visibleText(label), step.value, step.exact)))) ||
          textMatches(node.getAttribute("aria-label"), step.value, step.exact) ||
          textMatches(labelledBy(node), step.value, step.exact);
        if (step.kind === "placeholder") matches = textMatches(node.getAttribute("placeholder"), step.value, step.exact);
        if (step.kind === "testid") matches = node.getAttribute("data-testid") === step.value;
        if (step.kind === "text") {
          const value = node.tagName === "INPUT" && ["button", "submit", "reset"].includes(node.type)
            ? node.value : Array.from(node.childNodes).filter(child => child.nodeType === 3).map(child => child.textContent).join("");
          matches = !["SCRIPT", "STYLE", "NOSCRIPT"].includes(node.tagName) && textMatches(value, step.value, step.exact);
        }
        if (matches) found.add(node);
      }
    }
    roots = [...found];
    if (roots.length > 20000) throw new Error("locator exceeds 20000 matches; narrow the scope");
  }
  return roots;
};
const enabledOf = (element) => {
  if (element.matches(":disabled")) return false;
  for (let node = element; node; node = parentOf(node)) {
    if (node.inert || node.getAttribute("aria-disabled") === "true") return false;
  }
  return true;
};
const shown = (element) => {
  if (!element.isConnected || !rectInfo(element)) return false;
  for (let node = element; node; node = parentOf(node)) {
    const style = getComputedStyle(node);
    if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse" || Number(style.opacity) === 0) return false;
  }
  return true;
};
const clippedRect = (element) => {
  const rect = element.getBoundingClientRect();
  let left = Math.max(0, rect.left), top = Math.max(0, rect.top);
  let right = Math.min(innerWidth, rect.right), bottom = Math.min(innerHeight, rect.bottom);
  for (let parent = parentOf(element); parent; parent = parentOf(parent)) {
    const style = getComputedStyle(parent);
    const bounds = parent.getBoundingClientRect();
    if (/(auto|scroll|hidden|clip)/.test(style.overflowX)) {
      left = Math.max(left, bounds.left + parent.clientLeft);
      right = Math.min(right, bounds.left + parent.clientLeft + parent.clientWidth);
    }
    if (/(auto|scroll|hidden|clip)/.test(style.overflowY)) {
      top = Math.max(top, bounds.top + parent.clientTop);
      bottom = Math.min(bottom, bounds.top + parent.clientTop + parent.clientHeight);
    }
  }
  return { x: left, y: top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
};
const hitAt = (point) => {
  let hit = document.elementFromPoint(point.x, point.y);
  const visited = new Set();
  while (hit?.shadowRoot && !visited.has(hit)) {
    visited.add(hit);
    const inner = hit.shadowRoot.elementFromPoint(point.x, point.y);
    if (!inner || inner === hit) break;
    hit = inner;
  }
  return hit;
};
const focusedElement = () => {
  let focused = document.activeElement;
  while (focused?.shadowRoot?.activeElement) focused = focused.shadowRoot.activeElement;
  return focused;
};
const stateOf = (element, point) => {
  if (!element || !element.isConnected) return null;
  const rect = clippedRect(element);
  const checkPoint = point || { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  const visible = shown(element);
  const enabled = enabledOf(element);
  const hit = visible && rect.width > 0 && rect.height > 0 &&
    checkPoint.x >= rect.x && checkPoint.x < rect.x + rect.width &&
    checkPoint.y >= rect.y && checkPoint.y < rect.y + rect.height && containsComposed(element, hitAt(checkPoint));
  const full = element.getBoundingClientRect();
  const bounds = { x: full.x, y: full.y, width: full.width, height: full.height };
  return { ref: refFor(element), rect, bounds, visible, enabled, editable: enabled && editableOf(element),
    hit, focused: containsComposed(element, focusedElement()), text: clean(visibleText(element), 200),
    tag: element.tagName.toLowerCase(), name: accessibleName(element), role: roleOf(element) };
};
`;
