import { WebxClient } from "./client.js";
import { nodeNdjsonConnectionFactory } from "./node-unix.js";
import { UnixSocketTransport } from "./transport.js";
export const FACADE_OPERATION_INVENTORY = {
    "web.search": "search",
    "web.read": "read",
    "web.research": "research",
    "library.search": "searchPages",
    "library.get": "getPage",
    "library.forget": "forgetPage",
    "artifact.read": "getArtifactExcerpt",
    "browser.open": "createBrowserSession",
    "browser.tabs": "list/closeBrowserTab/closeBrowserSession; discard and restore unavailable",
    "browser.observe": "observeBrowser plus getBrowserVisualFrame for visual binding",
    "browser.act": "actBrowser with semantic or bound visual actions",
    "browser.cancel": "cancelBrowserOperation",
    "browser.debug": "debugBrowser; secret-bearing operations refused",
    "browser.workspace": "manageBrowserWorkspace",
};
/** SDK adapter for the singular Pi facade operation names. */
export class WebxFacadeClient {
    socketPath;
    #ownerId;
    #client;
    #observations = new Map();
    #observationSequence = 0;
    constructor(socketPath) {
        this.socketPath = socketPath;
    }
    async start(options) {
        if (options.signal.aborted)
            throw new DOMException("startup was cancelled", "AbortError");
        validateId(options.ownerId, "ownerId");
        this.#ownerId = options.ownerId;
        this.#client = new WebxClient(new UnixSocketTransport(this.socketPath, nodeNdjsonConnectionFactory));
        await this.#client.bind(options.ownerId, options.signal);
        await this.#client.negotiate(options.signal);
    }
    async capabilities(options) {
        const client = this.client(options.ownerId);
        try {
            const catalog = await client.capabilities({ signal: options.signal });
            const paths = catalog.browserPaths.map((path) => path.pathId);
            if (paths.length !== 2 || paths[0] !== "agent-browser/chrome" || paths[1] !== "pinchtab/chrome")
                throw new Error("WebX returned an invalid browser path inventory");
            return { apiVersion: catalog.apiVersion, daemon: "ready", groups: { web: true, browser: true, browserDebug: true, artifacts: true }, browserPathIds: [paths[0], paths[1]] };
        }
        catch (error) {
            if (options.signal.aborted)
                throw error;
            return { apiVersion: "1.0.0", daemon: "unavailable", groups: { web: false, browser: false, browserDebug: false, artifacts: false }, browserPathIds: ["agent-browser/chrome", "pinchtab/chrome"] };
        }
    }
    async request(operation, input, options) {
        const client = this.client(options.ownerId);
        const value = object(input);
        const requestOptions = { signal: options.signal, idempotencyKey: options.idempotencyKey };
        if (operation === "web.search")
            return external("Search results", await client.search({ query: requiredString(value.query, "query"), limit: optionalNumber(value.limit), domains: optionalStringArray(value.domains, "domains"), freshness: optionalFreshness(value.freshness) }, requestOptions));
        if (operation === "web.read") {
            rejectPresent(value, ["browserSessionId", "tabId"], operation);
            return external("Read result", await client.read({ url: optionalString(value.url), query: optionalString(value.query), view: optionalReadView(value.view), maxChars: optionalNumber(value.maxChars) }, requestOptions));
        }
        if (operation === "web.research")
            return external("Research result", await client.research({ question: requiredString(value.question, "question"), mode: optionalResearchMode(value.mode), maxQueries: optionalNumber(value.maxQueries), maxPages: optionalNumber(value.maxPages), maxBytes: optionalNumber(value.maxBytes), resume: optionalObject(value.resume) }, requestOptions));
        if (operation === "library.search")
            return external("Page-library results", await client.searchPages({ query: requiredString(value.query, "query"), limit: optionalNumber(value.limit), includeHistory: optionalBoolean(value.includeHistory) }, requestOptions));
        if (operation === "library.get")
            return external("Page-library record", await client.getPage(requiredString(value.versionId, "versionId"), { signal: options.signal }));
        if (operation === "library.forget")
            return local("Page-library record forgotten", await client.forgetPage({ pageId: optionalString(value.versionId), url: optionalString(value.url) }, requestOptions));
        if (operation === "artifact.read")
            return this.artifact(client, value, options.signal);
        if (operation === "browser.open") {
            rejectPresent(value, ["newTab"], operation);
            return local("Browser session opened", await client.createBrowserSession({ pathId: browserPath(value.pathId), url: optionalString(value.url), visible: optionalBoolean(value.visible), label: optionalString(value.label) }, requestOptions));
        }
        if (operation === "browser.tabs")
            return this.browserTabs(client, value, requestOptions);
        if (operation === "browser.observe")
            return this.observe(client, value, options, requestOptions);
        if (operation === "browser.act")
            return local("Browser action completed", await client.actBrowser(requiredString(value.browserSessionId, "browserSessionId"), this.browserAction(value.action, options.ownerId, requiredString(value.browserSessionId, "browserSessionId")), requestOptions));
        if (operation === "browser.cancel")
            return local("Browser cancellation requested", await client.cancelBrowserOperation(requiredString(value.operationId, "operationId"), requestOptions));
        if (operation === "browser.debug")
            return local("Browser diagnostic completed", await client.debugBrowser(requiredString(value.browserSessionId, "browserSessionId"), { operation: debugOperation(value.operation), args: optionalObject(value.args), maxChars: optionalNumber(value.maxChars) }, requestOptions));
        if (operation === "browser.workspace")
            return this.workspace(client, value, requestOptions);
        throw unavailable(operation, "operation is not in the facade inventory");
    }
    async decideApproval() { throw unavailable("approval.decide", "this runtime never returns approval placeholders"); }
    async stop(options) { if (this.#ownerId !== options.ownerId)
        throw new Error("WebX facade owner mismatch"); this.#observations.clear(); this.#client = undefined; this.#ownerId = undefined; }
    /** Import one visual binding only for deterministic cross-owner refusal tests. */
    importObservationBindingForTest(observationId, ownerId, sessionId, frame) { this.#observations.set(observationId, { ownerId, sessionId, frame }); }
    client(ownerId) { if (this.#client === undefined || this.#ownerId !== ownerId)
        throw new Error("WebX facade client is not started for this owner"); return this.#client; }
    async artifact(client, value, signal) {
        const offset = optionalNumber(value.offset) ?? 0;
        const artifact = await client.getArtifactExcerpt(requiredString(value.artifactId, "artifactId"), offset, optionalNumber(value.limit) ?? 16_384, { signal });
        const bytes = new TextEncoder().encode(artifact.excerpt);
        return { summary: "Artifact excerpt", data: artifact, artifacts: [{ id: artifact.artifactId, kind: artifact.mediaType }], artifactPayload: { artifactId: artifact.artifactId, mediaType: artifact.mediaType, dataBase64: bytesToBase64(bytes), size: artifact.sizeBytes, complete: artifact.nextOffset === undefined && offset === 0, mode: "raw", offset, nextOffset: artifact.nextOffset ?? null, eof: artifact.nextOffset === undefined }, trust: "local" };
    }
    async browserTabs(client, input, options) {
        const action = requiredString(input.action, "action");
        if (action === "list")
            return local("Owned browser sessions", await client.listBrowserSessions({ signal: options.signal }));
        if (action === "close-session") {
            await client.closeBrowserSession(requiredString(input.browserSessionId, "browserSessionId"), options);
            return local("Browser session closed", { closed: true });
        }
        if (action === "close-tab") {
            await client.closeBrowserTab(requiredString(input.browserSessionId, "browserSessionId"), requiredString(input.tabId, "tabId"), options);
            return local("Browser tab closed", { closed: true });
        }
        throw unavailable("browser.tabs", `${action} has no safe Pi 0.84.1 equivalent in this product`);
    }
    async observe(client, value, options, requestOptions) {
        rejectPresent(value, ["selector", "includeBounds"], "browser.observe");
        const sessionId = requiredString(value.browserSessionId, "browserSessionId");
        const view = observationView(value.view);
        const observation = await client.observeBrowser(sessionId, view, optionalNumber(value.maxChars) ?? 16_384, requestOptions);
        if (view !== "visual")
            return external("Browser observation", observation);
        const frame = await client.getBrowserVisualFrame(sessionId, { signal: options.signal, idempotencyKey: `${options.idempotencyKey}:frame` });
        const observationId = `observation-${++this.#observationSequence}`;
        this.#observations.set(observationId, { ownerId: options.ownerId, sessionId, frame });
        return external("Browser visual observation", { ...observation, observationId, viewportId: frame.viewportId, screenshot: { mediaType: frame.mediaType, width: frame.width, height: frame.height, payloadBase64: frame.payloadBase64, screenshotSha256: frame.screenshotSha256, screenshotSequence: frame.screenshotSequence, viewportGeneration: frame.viewportGeneration } });
    }
    browserAction(value, ownerId, sessionId) {
        const action = object(value);
        const kind = requiredString(action.kind, "action.kind");
        if (kind === "mouse-move" || kind === "mouse-click" || kind === "mouse-double-click" || kind === "mouse-down" || kind === "mouse-up" || kind === "mouse-wheel" || kind === "coordinate-drag") {
            const guard = this.resolveGuard(action, ownerId, sessionId);
            if (kind === "mouse-move")
                return { kind, x: requiredNumber(action.x, "action.x"), y: requiredNumber(action.y, "action.y"), visualGuard: guard };
            if (kind === "mouse-wheel")
                return { kind: "wheel", deltaX: requiredNumber(action.deltaX, "action.deltaX"), deltaY: requiredNumber(action.deltaY, "action.deltaY"), visualGuard: guard };
            if (kind === "coordinate-drag")
                return { kind: "drag", from: { x: requiredNumber(action.startX, "action.startX"), y: requiredNumber(action.startY, "action.startY") }, to: { x: requiredNumber(action.endX, "action.endX"), y: requiredNumber(action.endY, "action.endY") }, visualGuard: guard };
            const mapped = kind === "mouse-click" ? "click" : kind === "mouse-double-click" ? "double-click" : kind;
            return { kind: mapped, x: requiredNumber(action.x, "action.x"), y: requiredNumber(action.y, "action.y"), button: pointerButton(action.button), visualGuard: guard };
        }
        if (kind === "navigate")
            return { kind, url: requiredString(action.url, "action.url") };
        if (kind === "click")
            return { kind, ref: optionalString(action.ref), selector: optionalString(action.selector) };
        if (kind === "fill" || kind === "type")
            return { kind, ref: optionalString(action.ref), selector: optionalString(action.selector), text: requiredString(action.text, "action.text") };
        if (kind === "press")
            return { kind, key: requiredString(action.key, "action.key") };
        if (kind === "hover")
            return { kind, ref: optionalString(action.ref), selector: optionalString(action.selector) };
        if (kind === "scroll")
            return { kind, direction: scrollDirection(action.direction), amount: optionalNumber(action.amount) };
        if (kind === "drag")
            return { kind: "semantic-drag", ref: requiredString(action.ref, "action.ref"), targetRef: requiredString(action.targetRef, "action.targetRef") };
        if (kind === "select")
            return { kind, ref: optionalString(action.ref), selector: optionalString(action.selector), values: stringArray(action.values, "action.values") };
        if (kind === "wait")
            return { kind, milliseconds: optionalNumber(action.milliseconds), selector: optionalString(action.selector), text: optionalString(action.text) };
        if (kind === "tab-new")
            return { kind, url: optionalString(action.url) };
        if (kind === "tab-close")
            return { kind, tabId: optionalString(action.tabId) };
        if (kind === "tab-focus")
            return { kind, tabId: requiredString(action.tabId, "action.tabId") };
        if (kind === "back" || kind === "forward" || kind === "reload")
            return { kind };
        throw unavailable("browser.act", `${kind} is not supported by the frozen daemon action shape`);
    }
    resolveGuard(action, ownerId, sessionId) {
        const observationId = requiredString(action.observationId, "action.observationId");
        const binding = this.#observations.get(observationId);
        if (binding === undefined)
            throw unavailable("browser.act", "visual observation binding is stale or unknown");
        if (binding.ownerId !== ownerId || binding.sessionId !== sessionId)
            throw unavailable("browser.act", "visual observation binding belongs to another owner or session");
        if (requiredString(action.viewportId, "action.viewportId") !== binding.frame.viewportId)
            throw unavailable("browser.act", "visual observation viewport is stale");
        this.#observations.delete(observationId);
        return { viewportId: binding.frame.viewportId, viewportGeneration: binding.frame.viewportGeneration, screenshotSha256: binding.frame.screenshotSha256, screenshotSequence: binding.frame.screenshotSequence };
    }
    async workspace(client, input, options) {
        const action = workspaceAction(input.action);
        const values = Array.isArray(input.values) ? input.values : [];
        const sessionId = optionalString(input.browserSessionId) ?? optionalString(values[0]);
        const tabId = optionalString(input.tabId) ?? optionalString(values[1]);
        return local(`Browser workspace ${action}`, await client.manageBrowserWorkspace({ action, sessionId, tabId }, options));
    }
}
function external(summary, data) { return { summary, data, trust: "untrusted-external" }; }
function local(summary, data) { return { summary, data, trust: "local" }; }
function unavailable(operation, reason) { const error = new Error(`${operation} is unavailable: ${reason}`); error.name = "WebxUnavailableError"; return error; }
function object(value) { if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new TypeError("operation input must be an object"); return value; }
function optionalObject(value) { return value === undefined ? undefined : object(value); }
function requiredString(value, name) { if (typeof value !== "string" || value.length === 0)
    throw new TypeError(`${name} is required`); return value; }
function optionalString(value) { return typeof value === "string" ? value : undefined; }
function requiredNumber(value, name) { if (typeof value !== "number" || !Number.isFinite(value))
    throw new TypeError(`${name} is required`); return value; }
function optionalNumber(value) { return typeof value === "number" ? value : undefined; }
function optionalBoolean(value) { return typeof value === "boolean" ? value : undefined; }
function optionalStringArray(value, name) { return value === undefined ? undefined : stringArray(value, name); }
function optionalFreshness(value) { if (value === undefined)
    return undefined; if (value === "day" || value === "week" || value === "month" || value === "year")
    return value; throw new TypeError("freshness is invalid"); }
function optionalReadView(value) { if (value === undefined)
    return undefined; if (value === "main" || value === "outline" || value === "raw")
    return value; throw new TypeError("view is invalid"); }
function optionalResearchMode(value) { if (value === undefined)
    return undefined; if (value === "quick" || value === "research" || value === "deep")
    return value; throw new TypeError("mode is invalid"); }
function validateId(value, name) { if (!/^[A-Za-z0-9._:-]{1,256}$/u.test(value))
    throw new TypeError(`${name} is invalid`); }
function browserPath(value) { if (value === undefined || value === "agent-browser/chrome")
    return "agent-browser/chrome"; if (value === "pinchtab/chrome")
    return value; throw new TypeError("pathId is unsupported"); }
function observationView(value) { if (value === undefined || value === "main")
    return "main"; if (value === "interactive" || value === "visual" || value === "full" || value === "diff")
    return value; throw unavailable("browser.observe", `${String(value)} view has no daemon route`); }
function debugOperation(value) { if (value === "console" || value === "network" || value === "html" || value === "pdf" || value === "record-start" || value === "record-stop")
    return value; throw unavailable("browser.debug", "secret-bearing or unknown debug operation is refused"); }
function workspaceAction(value) { if (value === "show" || value === "hide" || value === "list" || value === "attach" || value === "takeover" || value === "return")
    return value; throw unavailable("browser.workspace", `${String(value)} is unsupported`); }
function rejectPresent(value, names, operation) { for (const name of names)
    if (value[name] !== undefined)
        throw unavailable(operation, `${name} is not supported by the daemon route`); }
function bytesToBase64(bytes) { let binary = ""; for (const byte of bytes)
    binary += String.fromCharCode(byte); return btoa(binary); }
function pointerButton(value) { if (value === undefined || value === "left")
    return "left"; if (value === "middle" || value === "right")
    return value; throw new TypeError("action.button is invalid"); }
function scrollDirection(value) { if (value === "up" || value === "down" || value === "left" || value === "right")
    return value; throw new TypeError("action.direction is invalid"); }
function stringArray(value, name) { if (!Array.isArray(value) || value.some((item) => typeof item !== "string"))
    throw new TypeError(`${name} is invalid`); return value; }
