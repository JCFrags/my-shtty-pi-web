import type { LocatorSpec, LocatorStep } from "agentcursor" with { "resolution-mode": "import" };

export const MAX_LOCATOR_STEPS = 16;
export const MAX_LOCATOR_TEXT = 1_024;

export function parseLocator(value: unknown): LocatorSpec {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_LOCATOR_STEPS) {
    throw new Error("locator must contain 1 to 16 native locator steps");
  }
  return value.map((input, index): LocatorStep => {
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("invalid locator step");
    const step = input as Record<string, unknown>;
    const kind = step.kind;
    const keys = kind === "role" ? ["kind", "value", "name", "exact"]
      : kind === "text" || kind === "label" || kind === "placeholder" ? ["kind", "value", "exact"]
      : kind === "css" || kind === "testid" ? ["kind", "value"]
      : kind === "filter" ? ["kind", "hasText"]
      : kind === "nth" ? ["kind", "index"] : [];
    if (!keys.length || Object.keys(step).some(key => !keys.includes(key))) throw new Error("invalid locator step fields");
    if (index === 0 && (kind === "nth" || kind === "filter")) throw new Error("locator must start with a query step");
    if (kind === "nth") {
      if (!Number.isSafeInteger(step.index) || Math.abs(step.index as number) > 20_000) throw new Error("locator nth index must be an integer within 20000");
      return { kind, index: step.index as number };
    }
    if (kind === "filter") return { kind, hasText: locatorText(step.hasText) };
    const text = locatorText(step.value);
    if (step.exact !== undefined && typeof step.exact !== "boolean") throw new Error("locator exact must be boolean");
    if (kind === "css" || kind === "testid") return { kind, value: text };
    if (kind === "role") return {
      kind, value: text,
      ...(step.name === undefined ? {} : { name: locatorText(step.name) }),
      ...(step.exact === undefined ? {} : { exact: step.exact as boolean }),
    };
    return { kind: kind as "text" | "label" | "placeholder", value: text,
      ...(step.exact === undefined ? {} : { exact: step.exact as boolean }) };
  });
}

function locatorText(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > MAX_LOCATOR_TEXT || /[\u0000-\u001f\u007f-\u009f]/.test(value)) {
    throw new Error("locator text must be non-empty, contain no control characters, and be at most 1024 characters");
  }
  return value;
}
