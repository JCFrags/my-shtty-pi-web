import { WebxClient } from "./client.js";
import { nodeNdjsonConnectionFactory } from "./node-unix.js";
import { UnixSocketTransport } from "./transport.js";
import { defaultExportRoot, saveReadMarkdown, validateRelativeMarkdownPath } from "./save-markdown.js";
import type { BoundedContent, ContentRequest, DirectReadRequest, ReadBatchRequest, ReadRequest, ReadSaveOptions, RequestOptions } from "./types.js";

export const FACADE_OPERATION_INVENTORY = {
  "web.search": "search",
  "web.read": "read",
  "web.readBatch": "readBatch; 1 to 5 ordered sources with concurrency 3",
  "web.content": "content; stored normalized content only",
} as const;

export interface FacadeRequestOptions { readonly signal: AbortSignal; readonly idempotencyKey: string; readonly ownerId: string; readonly cwd: string }
export interface FacadeResult {
  readonly title?: string; readonly url?: string; readonly summary: string; readonly data?: unknown;
  readonly artifacts?: readonly { readonly id: string; readonly kind?: string }[];
  readonly artifactPayload?: { readonly artifactId: string; readonly mediaType: string; readonly dataBase64: string; readonly size: number; readonly complete: boolean; readonly mode: "image" | "raw"; readonly offset?: number; readonly nextOffset?: number | null; readonly eof?: boolean };
  readonly trust?: "untrusted-external" | "local";
}
export interface FacadeCapabilities { readonly apiVersion: string; readonly daemon: "ready" | "unavailable"; readonly groups: { readonly search: boolean; readonly read: boolean; readonly browser: boolean; readonly browserDebug: boolean }; readonly browserPathIds: readonly string[] }
/** SDK adapter for the singular Pi facade operation names. */
export class WebxFacadeClient {
  #ownerId?: string;
  #client?: WebxClient;

  constructor(private readonly socketPath: string, private readonly exportRoot = defaultExportRoot()) {}

  async start(options: { signal: AbortSignal; ownerId: string; cwd: string }): Promise<void> {
    if (options.signal.aborted) throw new DOMException("startup was cancelled", "AbortError");
    validateId(options.ownerId, "ownerId");
    this.#ownerId = options.ownerId;
    this.#client = new WebxClient(new UnixSocketTransport(this.socketPath, nodeNdjsonConnectionFactory));
    await this.#client.bind(options.ownerId, options.signal);
    await this.#client.negotiate(options.signal);
  }

  async capabilities(options: { signal: AbortSignal; ownerId: string }): Promise<FacadeCapabilities> {
    const client = this.client(options.ownerId);
    try {
      const catalog = await client.capabilities({ signal: options.signal });
      const healthy = (id: "search" | "read") => catalog.capabilities.some((capability) => capability.id === id && capability.enabled && capability.healthy);
      return { apiVersion: catalog.apiVersion, daemon: "ready", groups: { search: healthy("search"), read: healthy("read"), browser: false, browserDebug: false }, browserPathIds: [] };
    } catch (error) {
      if (options.signal.aborted) throw error;
      return { apiVersion: "3.0.0", daemon: "unavailable", groups: { search: false, read: false, browser: false, browserDebug: false }, browserPathIds: [] };
    }
  }

  async request(operation: string, input: unknown, options: FacadeRequestOptions): Promise<FacadeResult> {
    const client = this.client(options.ownerId);
    const value = object(input);
    const requestOptions: RequestOptions = { signal: options.signal, idempotencyKey: options.idempotencyKey };
    if (operation === "web.search") {
      rejectPresent(value, ["operation", "effort", "freshness", "limit", "crawlPages", "crawlDepth"], operation);
      return external("Search results", await client.search({ query: requiredString(value.query, "query"), output: optionalSearchOutput(value.output), domains: optionalStringArray(value.domains, "domains") }, requestOptions));
    }
    if (operation === "web.read") return this.read(client, value, requestOptions);
    if (operation === "web.readBatch") return external("Batch read results", await client.readBatch(readBatchRequest(value), requestOptions));
    if (operation === "web.content") return external("Stored content", await client.content(contentRequest(value), requestOptions));
    throw unavailable(operation, "operation is not in the facade inventory");
  }

  async decideApproval(): Promise<FacadeResult> { throw unavailable("approval.decide", "this runtime never returns approval placeholders"); }
  async stop(options: { ownerId: string }): Promise<void> { if (this.#ownerId !== options.ownerId) throw new Error("WebX facade owner mismatch"); const client = this.#client; this.#client = undefined; this.#ownerId = undefined; await client?.close(); }

  private client(ownerId: string): WebxClient { if (this.#client === undefined || this.#ownerId !== ownerId) throw new Error("WebX facade client is not started for this owner"); return this.#client; }

  private async read(client: WebxClient, value: Record<string, unknown>, options: RequestOptions): Promise<FacadeResult> {
    rejectPresent(value, ["browserSessionId", "tabId"], "web.read");
    const requestedUrl = requiredString(value.url, "url");
    const save = readSaveOptions(value.save);
    if (save !== undefined) rejectPresent(value, ["fields", "itemOffset", "itemLimit", "maxPages", "maxDepth", "sameDomain"], "web.read save");
    const request: ReadRequest = {
      url: requestedUrl,
      query: optionalString(value.query),
      view: optionalReadView(value.view),
      fields: optionalStringArray(value.fields, "fields"),
      itemOffset: optionalNumber(value.itemOffset),
      itemLimit: optionalNumber(value.itemLimit),
      maxChars: optionalNumber(value.maxChars),
      contentOffset: optionalNumber(value.contentOffset),
      maxPages: optionalNumber(value.maxPages),
      maxDepth: optionalNumber(value.maxDepth),
      sameDomain: optionalBoolean(value.sameDomain),
      refresh: strictOptionalBoolean(value.refresh, "refresh"),
    };
    const content = await client.read(request, options);
    if (save === undefined) return external("Read result", content);
    const completeContent = await this.completeStoredContentForSave(client, content, options);
    return local("Web content saved as Markdown", await saveReadMarkdown(completeContent, requestedUrl, save, this.exportRoot));
  }

  private async completeStoredContentForSave(client: WebxClient, content: BoundedContent, options: RequestOptions): Promise<BoundedContent> {
    const metadata = typeof content.metadata === "object" && content.metadata !== null ? content.metadata as Record<string, unknown> : {};
    const contentId = typeof metadata.contentId === "string" ? metadata.contentId : undefined;
    if (contentId === undefined) return content;
    const chunks: string[] = [];
    let offset = 0;
    for (;;) {
      const part = await client.content({ contentId, offset, limit: 30_000 }, { ...options, idempotencyKey: `${options.idempotencyKey}:save:${offset}` });
      chunks.push(part.untrustedContent);
      const next = part.metadata.nextOffset;
      if (next === null || next === undefined) break;
      offset = next;
    }
    const reader = typeof metadata.reader === "object" && metadata.reader !== null ? metadata.reader as Record<string, unknown> : {};
    const sourceComplete = reader.sourceComplete;
    const truncated = sourceComplete === true ? false : sourceComplete === false ? true : reader.complete !== true;
    return { ...content, untrustedContent: chunks.join(""), truncated, metadata };
  }
}

function external(summary: string, data: unknown): FacadeResult { return { summary, data, trust: "untrusted-external" }; }
function local(summary: string, data: unknown): FacadeResult { return { summary, data, trust: "local" }; }
function unavailable(operation: string, reason: string): Error { const error = new Error(`${operation} is unavailable: ${reason}`); error.name = "WebxUnavailableError"; return error; }
function object(value: unknown): Record<string, unknown> { if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TypeError("operation input must be an object"); return value as Record<string, unknown>; }
function readBatchRequest(value: Record<string, unknown>): ReadBatchRequest {
  for (const key of Object.keys(value)) if (key !== "items") throw new TypeError(`${key} is not supported by web.readBatch`);
  if (!Array.isArray(value.items) || value.items.length < 1 || value.items.length > 5) throw new TypeError("items must contain 1 to 5 direct read requests");
  return { items: value.items.map((item, index) => directReadRequest(object(item), `items[${index}]`)) };
}
function directReadRequest(value: Record<string, unknown>, name: string): DirectReadRequest {
  const allowed = new Set(["url", "query", "view", "fields", "itemOffset", "itemLimit", "maxChars", "contentOffset", "refresh"]);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new TypeError(`${name}.${key} is not supported by web.readBatch`);
  const url = requiredString(value.url, `${name}.url`);
  if (!/^https?:\/\//u.test(url) || url.length > 8_192) throw new TypeError(`${name}.url must be a public HTTP(S) URL`);
  const query = optionalString(value.query);
  if (query !== undefined && query.length > 8_192) throw new TypeError(`${name}.query must contain at most 8192 characters`);
  const fields = optionalStringArray(value.fields, `${name}.fields`);
  if (fields !== undefined && (fields.length > 32 || fields.some((field) => field.length < 1 || field.length > 256))) throw new TypeError(`${name}.fields must contain at most 32 property names`);
  return {
    url, query, view: optionalReadView(value.view), fields,
    itemOffset: boundedOptionalInteger(value.itemOffset, `${name}.itemOffset`, 0, 1_000_000),
    itemLimit: boundedOptionalInteger(value.itemLimit, `${name}.itemLimit`, 1, 500),
    maxChars: boundedOptionalInteger(value.maxChars, `${name}.maxChars`, 1, 1_000_000),
    contentOffset: boundedOptionalInteger(value.contentOffset, `${name}.contentOffset`, 0, 100_000_000),
    refresh: strictOptionalBoolean(value.refresh, `${name}.refresh`),
  };
}
function contentRequest(value: Record<string, unknown>): ContentRequest {
  for (const key of Object.keys(value)) if (!["contentId", "offset", "limit", "findText", "query"].includes(key)) throw new TypeError(`${key} is not supported by web.content`);
  const offset = boundedOptionalInteger(value.offset, "offset", 0, 100_000_000);
  const limit = boundedOptionalInteger(value.limit, "limit", 1, 30_000);
  const findText = optionalString(value.findText);
  const query = optionalString(value.query);
  if (findText !== undefined && query !== undefined || offset !== undefined && (findText !== undefined || query !== undefined)) throw new TypeError("offset mode and focused mode are mutually exclusive");
  if (findText !== undefined && (findText.length < 1 || findText.length > 8_192)) throw new TypeError("findText must contain 1 to 8192 characters");
  if (query !== undefined && (query.trim().length < 1 || query.length > 8_192)) throw new TypeError("query must contain 1 to 8192 characters");
  return { contentId: requiredString(value.contentId, "contentId"), offset, limit, findText, query };
}
function boundedOptionalInteger(value: unknown, name: string, minimum: number, maximum: number): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) throw new TypeError(`${name} must be an integer from ${minimum} to ${maximum}`);
  return value;
}
function readSaveOptions(value: unknown): ReadSaveOptions | undefined {
  if (value === undefined) return undefined;
  const save = object(value);
  for (const key of Object.keys(save)) if (key !== "path" && key !== "overwrite") throw new TypeError(`save.${key} is not supported`);
  const path = validateRelativeMarkdownPath(requiredString(save.path, "save.path"));
  const overwrite = optionalBoolean(save.overwrite);
  if (save.overwrite !== undefined && overwrite === undefined) throw new TypeError("save.overwrite must be a boolean");
  return { path, overwrite };
}
function requiredString(value: unknown, name: string): string { if (typeof value !== "string" || value.length === 0) throw new TypeError(`${name} is required`); return value; }
function optionalString(value: unknown): string | undefined { return typeof value === "string" ? value : undefined; }
function optionalNumber(value: unknown): number | undefined { return typeof value === "number" ? value : undefined; }
function optionalBoolean(value: unknown): boolean | undefined { return typeof value === "boolean" ? value : undefined; }
function strictOptionalBoolean(value: unknown, name: string): boolean | undefined {
  if (value === undefined || typeof value === "boolean") return value;
  throw new TypeError(`${name} must be a boolean`);
}
function optionalStringArray(value: unknown, name: string): readonly string[] | undefined { return value === undefined ? undefined : stringArray(value, name); }
function optionalSearchOutput(value: unknown): "links" | "extracts" | undefined { if (value === undefined) return undefined; if (value === "links" || value === "extracts") return value; throw new TypeError("output must be links or extracts"); }
function optionalReadView(value: unknown): "main" | "outline" | "raw" | undefined { if (value === undefined) return undefined; if (value === "main" || value === "outline" || value === "raw") return value; throw new TypeError("view is invalid"); }
function validateId(value: string, name: string): void { if (!/^[A-Za-z0-9._:-]{1,256}$/u.test(value)) throw new TypeError(`${name} is invalid`); }
function rejectPresent(value: Record<string, unknown>, names: readonly string[], operation: string): void { for (const name of names) if (value[name] !== undefined) throw unavailable(operation, `${name} is not supported by the daemon route`); }
function stringArray(value: unknown, name: string): readonly string[] { if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw new TypeError(`${name} is invalid`); return value as string[]; }
