import { ApiVersionError, asWebxError } from "./errors.js";
import { WEBX_API_MAJOR, } from "./types.js";
const DEFAULT_MAX_RESPONSE_BYTES = 1_048_576;
export class WebxClient {
    transport;
    #maxResponseBytes;
    #negotiated;
    constructor(transport, options = {}) {
        this.transport = transport;
        this.#maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
    }
    bind(ownerId, signal) {
        const transport = this.transport;
        return transport.bind === undefined ? Promise.resolve() : transport.bind(ownerId, signal);
    }
    version(signal) {
        return this.call("GET", "/v1/version", undefined, { signal }, false);
    }
    async negotiate(signal) {
        this.#negotiated ??= this.version(signal).then((version) => {
            const major = Number.parseInt(version.apiVersion.split(".", 1)[0] ?? "", 10);
            if (major !== WEBX_API_MAJOR)
                throw new ApiVersionError(WEBX_API_MAJOR, version.apiVersion);
            return version;
        }).catch((error) => {
            this.#negotiated = undefined;
            throw error;
        });
        return this.#negotiated;
    }
    capabilities(options = {}) {
        return this.call("GET", "/v1/capabilities", undefined, options);
    }
    search(request, options) {
        return this.call("POST", "/v1/search", request, requireIdempotency(options));
    }
    read(request, options) {
        return this.call("POST", "/v1/read", request, requireIdempotency(options));
    }
    research(request, options) {
        return this.call("POST", "/v1/research", request, requireIdempotency(options));
    }
    getArtifactExcerpt(artifactId, offset = 0, maxBytes = 16_384, options = {}) {
        const query = new URLSearchParams({ offset: String(offset), max_bytes: String(maxBytes) });
        return this.call("GET", `/v1/artifacts/${encodeURIComponent(artifactId)}/excerpt?${query}`, undefined, options);
    }
    createBrowserSession(request, options) {
        return this.call("POST", "/v1/browser/sessions", request, requireIdempotency(options));
    }
    listBrowserSessions(options = {}) {
        return this.call("GET", "/v1/browser/sessions", undefined, options);
    }
    manageBrowserWorkspace(request, options) {
        return this.call("POST", "/v1/browser/workspace", request, requireIdempotency(options));
    }
    closeBrowserTab(sessionId, tabId, options) {
        return this.call("DELETE", `/v1/browser/sessions/${encodeURIComponent(sessionId)}/tabs/${encodeURIComponent(tabId)}`, undefined, requireIdempotency(options));
    }
    getBrowserSession(sessionId, options = {}) {
        return this.call("GET", `/v1/browser/sessions/${encodeURIComponent(sessionId)}`, undefined, options);
    }
    observeBrowser(sessionId, view, maxChars, options) {
        return this.call("POST", `/v1/browser/sessions/${encodeURIComponent(sessionId)}/observe`, { view, maxChars }, requireIdempotency(options));
    }
    getBrowserVisualFrame(sessionId, options) {
        return this.call("POST", `/v1/browser/sessions/${encodeURIComponent(sessionId)}/frame`, {}, requireIdempotency(options));
    }
    actBrowser(sessionId, action, options) {
        return this.call("POST", `/v1/browser/sessions/${encodeURIComponent(sessionId)}/actions`, { action }, requireIdempotency(options));
    }
    debugBrowser(sessionId, request, options) {
        return this.call("POST", `/v1/browser/sessions/${encodeURIComponent(sessionId)}/debug`, request, requireIdempotency(options));
    }
    setBrowserControl(sessionId, controller, options) {
        return this.call("POST", `/v1/browser/sessions/${encodeURIComponent(sessionId)}/control`, { controller }, requireIdempotency(options));
    }
    cancelBrowserOperation(operationId, options) {
        return this.call("POST", `/v1/browser/operations/${encodeURIComponent(operationId)}/cancel`, {}, requireIdempotency(options));
    }
    closeBrowserSession(sessionId, options) {
        return this.call("DELETE", `/v1/browser/sessions/${encodeURIComponent(sessionId)}`, undefined, requireIdempotency(options));
    }
    async call(method, path, body, options, negotiate = true) {
        if (negotiate)
            await this.negotiate(options.signal);
        const response = await this.transport.request({
            method,
            path,
            body,
            signal: options.signal,
            maxResponseBytes: this.#maxResponseBytes,
            headers: options.idempotencyKey === undefined ? undefined : { "idempotency-key": options.idempotencyKey },
        });
        if (response.status < 200 || response.status >= 300)
            throw asWebxError(response.status, response.body);
        return response.body;
    }
}
function requireIdempotency(options) {
    if (options.idempotencyKey === undefined || options.idempotencyKey.length < 8) {
        throw new TypeError("an idempotency key of at least 8 characters is required");
    }
    return options;
}
