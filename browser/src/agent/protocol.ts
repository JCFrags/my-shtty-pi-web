import { parseAgentKey } from "./key";
import type {
  AgentDragRequest,
  AgentGetUrlRequest,
  AgentHoverRequest,
  AgentNavigateRequest,
  AgentPressKeyRequest,
  AgentScrollRequest,
  AgentTypeRequest,
  AgentWaitForRequest,
} from "./types";

export const MAX_AGENT_STRING = 256;
export const MAX_AGENT_KEY = 128;
export const MAX_AGENT_NATURAL_TEXT = 4_096;
export const MAX_AGENT_REPLACE_TEXT = 32_768;
export const MAX_AGENT_URL = 8_192;
export const MAX_AGENT_WAIT_TEXT = 1_024;

export interface AgentWireRequest {
  tab?: unknown;
  ref?: unknown;
  x?: unknown;
  y?: unknown;
  fromRef?: unknown;
  fromX?: unknown;
  fromY?: unknown;
  toRef?: unknown;
  toX?: unknown;
  toY?: unknown;
  button?: unknown;
  text?: unknown;
  replace?: unknown;
  key?: unknown;
  dx?: unknown;
  dy?: unknown;
  url?: unknown;
  observationId?: unknown;
  expectedControlEpoch?: unknown;
  condition?: unknown;
  timeoutMs?: unknown;
}

export function requiredTab(request: AgentWireRequest, command: string): number {
  if (request.tab === undefined) throw new Error(`${command} needs a tab id`);
  if (typeof request.tab !== "number" || !Number.isSafeInteger(request.tab) || request.tab < 1) {
    throw new Error(`${command} needs a valid tab id`);
  }
  return request.tab;
}

export function requiredEpoch(value: unknown, command: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${command} expectedControlEpoch must be a positive integer`);
  }
  return value;
}

export function parseHoverRequest(request: AgentWireRequest): {
  tab: number;
  request: AgentHoverRequest;
} {
  return {
    tab: requiredTab(request, "agent.hover"),
    request: {
      target: parseActionTarget(request.ref, request.x, request.y, "agent.hover"),
      observationId: requiredAgentString(request.observationId, "agent.hover", "observationId"),
      expectedControlEpoch: requiredEpoch(request.expectedControlEpoch, "agent.hover"),
    },
  };
}

export function parseDragRequest(request: AgentWireRequest): {
  tab: number;
  request: AgentDragRequest;
} {
  const button = request.button === undefined ? "left" : request.button;
  if (button !== "left" && button !== "middle" && button !== "right") {
    throw new Error("agent.drag button must be left, middle, or right");
  }
  return {
    tab: requiredTab(request, "agent.drag"),
    request: {
      from: parseActionTarget(request.fromRef, request.fromX, request.fromY, "agent.drag from"),
      to: parseActionTarget(request.toRef, request.toX, request.toY, "agent.drag to"),
      button,
      observationId: requiredAgentString(request.observationId, "agent.drag", "observationId"),
      expectedControlEpoch: requiredEpoch(request.expectedControlEpoch, "agent.drag"),
    },
  };
}

export function parseTypeRequest(request: AgentWireRequest): { tab: number; request: AgentTypeRequest } {
  const tab = requiredTab(request, "agent.type");
  const ref = requiredAgentString(request.ref, "agent.type", "ref");
  const observationId = requiredAgentString(request.observationId, "agent.type", "observationId");
  const replace = request.replace === undefined ? false : request.replace;
  if (typeof replace !== "boolean") throw new Error("agent.type replace must be boolean");
  const text = requiredText(request.text, replace);
  return {
    tab,
    request: {
      ref,
      text,
      replace,
      observationId,
      expectedControlEpoch: requiredEpoch(request.expectedControlEpoch, "agent.type"),
    },
  };
}

export function parsePressKeyRequest(request: AgentWireRequest): {
  tab: number;
  request: AgentPressKeyRequest;
} {
  const tab = requiredTab(request, "agent.press-key");
  const key = requiredAgentString(request.key, "agent.press-key", "key");
  if (key.length > MAX_AGENT_KEY) throw new Error("agent.press-key key is too long");
  parseAgentKey(key);
  return {
    tab,
    request: {
      key,
      observationId: requiredAgentString(request.observationId, "agent.press-key", "observationId"),
      expectedControlEpoch: requiredEpoch(request.expectedControlEpoch, "agent.press-key"),
    },
  };
}

export function parseScrollRequest(request: AgentWireRequest): {
  tab: number;
  request: AgentScrollRequest;
} {
  const tab = requiredTab(request, "agent.scroll");
  const dx = request.dx === undefined ? 0 : request.dx;
  const dy = request.dy;
  if (typeof dx !== "number" || typeof dy !== "number" ||
      !Number.isFinite(dx) || !Number.isFinite(dy)) {
    throw new Error("agent.scroll dx and dy must be finite numbers");
  }
  if (Math.abs(dx) > 20_000 || Math.abs(dy) > 20_000) {
    throw new Error("agent.scroll delta is too large");
  }
  if (dx === 0 && dy === 0) throw new Error("agent.scroll needs a nonzero delta");
  return {
    tab,
    request: {
      dx,
      dy,
      observationId: requiredAgentString(request.observationId, "agent.scroll", "observationId"),
      expectedControlEpoch: requiredEpoch(request.expectedControlEpoch, "agent.scroll"),
    },
  };
}

export function parseNavigateRequest(request: AgentWireRequest): {
  tab: number;
  request: AgentNavigateRequest;
} {
  const tab = requiredTab(request, "agent.navigate");
  const url = request.url;
  if (typeof url !== "string" || url.trim().length === 0 || url.length > MAX_AGENT_URL) {
    throw new Error("agent.navigate url must be a non-empty string of at most 8192 characters");
  }
  validateNavigationValue(url);
  return {
    tab,
    request: { url, expectedControlEpoch: requiredEpoch(request.expectedControlEpoch, "agent.navigate") },
  };
}

export function parseGetUrlRequest(request: AgentWireRequest): {
  tab: number;
  request: AgentGetUrlRequest;
} {
  return {
    tab: requiredTab(request, "agent.get-url"),
    request: { expectedControlEpoch: requiredEpoch(request.expectedControlEpoch, "agent.get-url") },
  };
}

export function parseWaitForRequest(request: AgentWireRequest): {
  tab: number;
  request: AgentWaitForRequest;
} {
  const tab = requiredTab(request, "agent.wait-for");
  const ref = request.ref === undefined ? undefined : requiredAgentString(request.ref, "agent.wait-for", "ref");
  const text = request.text === undefined ? undefined : requiredWaitText(request.text);
  if (ref === undefined && text === undefined) throw new Error("agent.wait-for needs a ref or text");
  const condition = request.condition === undefined ? undefined : request.condition;
  if (condition !== undefined && condition !== "exists" && condition !== "visible" && condition !== "text") {
    throw new Error("agent.wait-for condition must be exists, visible, or text");
  }
  if (condition === "exists" && ref === undefined) throw new Error("agent.wait-for exists needs a ref");
  if (condition === "visible" && ref === undefined) throw new Error("agent.wait-for visible needs a ref");
  if (condition === "text" && text === undefined) throw new Error("agent.wait-for text needs text");
  const timeoutMs = request.timeoutMs === undefined ? 10_000 : request.timeoutMs;
  if (typeof timeoutMs !== "number" || !Number.isSafeInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 60_000) {
    throw new Error("agent.wait-for timeoutMs must be an integer from 0 to 60000");
  }
  return {
    tab,
    request: {
      ...(ref === undefined ? {} : { ref }),
      ...(text === undefined ? {} : { text }),
      ...(condition === undefined ? {} : { condition }),
      timeoutMs,
      observationId: requiredAgentString(request.observationId, "agent.wait-for", "observationId"),
      expectedControlEpoch: requiredEpoch(request.expectedControlEpoch, "agent.wait-for"),
    },
  };
}

export function validateNavigationValue(value: string): void {
  if (/[\u0000-\u001f\u007f-\u009f]/.test(value)) throw new Error("agent.navigate url contains control characters");
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(value.trim())?.[1]?.toLowerCase();
  if (scheme && scheme !== "http" && scheme !== "https" && scheme !== "file" && scheme !== "about") {
    throw new Error("agent.navigate url scheme is not allowed");
  }
  if (scheme === "about" && value.trim().toLowerCase() !== "about:blank") {
    throw new Error("agent.navigate only allows about:blank");
  }
}

function parseActionTarget(
  refValue: unknown,
  xValue: unknown,
  yValue: unknown,
  command: string,
): { ref: string } | { x: number; y: number } {
  const hasRef = refValue !== undefined;
  const hasCoordinates = xValue !== undefined || yValue !== undefined;
  if (hasRef === hasCoordinates) throw new Error(`${command} needs exactly one ref or x/y pair`);
  if (hasRef) return { ref: requiredAgentString(refValue, command, "ref") };
  if (typeof xValue !== "number" || typeof yValue !== "number" ||
      !Number.isFinite(xValue) || !Number.isFinite(yValue) ||
      Math.abs(xValue) > 20_000 || Math.abs(yValue) > 20_000) {
    throw new Error(`${command} x and y must be finite coordinates within 20000`);
  }
  return { x: xValue, y: yValue };
}

function requiredAgentString(value: unknown, command: string, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > MAX_AGENT_STRING) {
    throw new Error(`${command} ${name} must be a non-empty string of at most ${MAX_AGENT_STRING} characters`);
  }
  return value;
}

function requiredText(value: unknown, replace: boolean): string {
  const max = replace ? MAX_AGENT_REPLACE_TEXT : MAX_AGENT_NATURAL_TEXT;
  if (typeof value !== "string" || value.length > max) throw new Error(`agent.type text must be at most ${max} characters`);
  if (value.includes("\0")) throw new Error("agent.type text contains NUL");
  if (!replace && value.length === 0) throw new Error("agent.type text must not be empty unless replace is used");
  return value;
}

function requiredWaitText(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_AGENT_WAIT_TEXT) {
    throw new Error("agent.wait-for text must be non-empty and at most 1024 characters");
  }
  if (value.includes("\0")) throw new Error("agent.wait-for text contains NUL");
  return value;
}
