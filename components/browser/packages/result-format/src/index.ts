export type PresentationFormat = "markdown" | "line" | "toon" | "json";

export interface FormatDecision {
  format: PresentationFormat;
  text: string;
  lengths: Partial<Record<PresentationFormat, number>>;
}

const TOON_CANDIDATE_KEYS = new Set([
  "results", "tabs", "controls", "requests", "messages", "downloads", "history", "artifacts",
]);

/**
 * Pick a model-facing representation without changing the typed JSON used by the
 * daemon or persisted artifacts. TOON is considered only for sufficiently uniform
 * tabular data and is rejected when it is not materially smaller than compact JSON.
 */
export async function formatModelResult(
  value: unknown,
  options: { label?: string; preferMarkdown?: boolean; minimumSavings?: number } = {},
): Promise<FormatDecision> {
  if (typeof value === "string") {
    return { format: "markdown", text: value, lengths: { markdown: value.length } };
  }

  const jsonText = JSON.stringify(value);
  const lineText = encodeLineFormat(value, options.label);
  const lengths: FormatDecision["lengths"] = { json: jsonText.length, line: lineText.length };
  let best: FormatDecision = lineText.length < jsonText.length
    ? { format: "line", text: lineText, lengths }
    : { format: "json", text: jsonText, lengths };

  if (isToonCandidate(value, options.label)) {
    try {
      const { encode } = await import("@toon-format/toon");
      const toonText = encode(value as never);
      lengths.toon = toonText.length;
      const savings = options.minimumSavings ?? 0.05;
      if (toonText.length <= best.text.length * (1 - savings)) {
        best = { format: "toon", text: toonText, lengths };
      }
    } catch {
      // The extension remains functional during partial/offline installation. The
      // Fedora installer installs the pinned official implementation for production.
    }
  }
  return best;
}

export function encodeLineFormat(value: unknown, label = "items"): string {
  if (Array.isArray(value) && isUniformObjectArray(value)) {
    const keys = Object.keys(value[0] as Record<string, unknown>);
    const rows = value.map((item) => keys.map((key) => scalar((item as Record<string, unknown>)[key])).join(","));
    return `${label}[${value.length}]{${keys.join(",")}}:\n${rows.map((row) => `  ${row}`).join("\n")}`;
  }
  if (isRecord(value)) {
    const entries = Object.entries(value);
    if (entries.length === 1 && Array.isArray(entries[0]?.[1]) && isUniformObjectArray(entries[0][1])) {
      return encodeLineFormat(entries[0][1], entries[0][0]);
    }
    return entries.map(([key, item]) => `${key}: ${scalar(item)}`).join("\n");
  }
  return scalar(value);
}

export function formatObservation(value: {
  title?: string;
  url?: string;
  content?: string;
  controls?: object[];
  changed?: string[];
  artifactId?: string;
  truncated?: boolean;
}): string {
  const output = [`page: ${value.title ?? ""}`, `url: ${value.url ?? ""}`];
  if (value.content) output.push("", "main:", indent(value.content));
  if (value.controls?.length) output.push("", encodeLineFormat(value.controls, "controls"));
  if (value.changed?.length) output.push("", "changed:", ...value.changed.map((line) => `  ${line}`));
  if (value.artifactId) output.push("", `artifact: ${value.artifactId}${value.truncated ? " (complete result)" : ""}`);
  return output.join("\n");
}

function isToonCandidate(value: unknown, label?: string): boolean {
  if (label && TOON_CANDIDATE_KEYS.has(label)) return true;
  if (Array.isArray(value)) return value.length >= 2 && isUniformObjectArray(value);
  if (!isRecord(value)) return false;
  return Object.entries(value).some(([key, item]) => TOON_CANDIDATE_KEYS.has(key) && Array.isArray(item) && item.length >= 2);
}

function isUniformObjectArray(value: unknown[]): boolean {
  if (value.length === 0 || !value.every(isRecord)) return false;
  const first = Object.keys(value[0] as Record<string, unknown>);
  return value.every((item) => {
    const keys = Object.keys(item as Record<string, unknown>);
    return keys.length === first.length && keys.every((key, index) => key === first[index]);
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function scalar(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return /[\n,]/.test(value) ? JSON.stringify(value) : value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value) && value.every((item) => typeof item !== "object")) return value.map(scalar).join("|");
  return JSON.stringify(value);
}

function indent(value: string): string {
  return value.split("\n").map((line) => `  ${line}`).join("\n");
}
