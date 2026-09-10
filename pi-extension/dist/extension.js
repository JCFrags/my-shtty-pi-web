import { StringEnum, Type } from "@earendil-works/pi-ai";
import { PiBrowserClient } from "./client.js";
import { loadWebResearch } from "./web-research.js";
function context(ctx, signal) {
    return {
        cwd: ctx.cwd,
        sessionId: ctx.sessionManager.getSessionId(),
        signal,
    };
}
function result(value) {
    return {
        content: [{ type: "text", text: JSON.stringify(value) }],
        details: value,
    };
}
export function observationResult(value) {
    const image = value.image;
    const { image: _image, ...details } = value;
    const content = [{ type: "text", text: JSON.stringify(details) }];
    if (typeof image?.data === "string" && image.mimeType === "image/png") {
        content.push({ type: "image", data: image.data, mimeType: image.mimeType });
    }
    return { content, details };
}
const openParameters = Type.Object({
    url: Type.Optional(Type.String({ maxLength: 8192, description: "Optional URL or local HTML path" })),
    new_tab: Type.Optional(Type.Boolean({ description: "Open the URL in a new tab when reusing the companion" })),
    focus: Type.Optional(Type.Boolean({ description: "Focus the companion pane; defaults to true" })),
}, { additionalProperties: false });
const tabsParameters = Type.Object({
    action: StringEnum(["list", "activate", "open", "close", "wait", "downloads", "download_wait", "download_cancel"]),
    context_id: Type.Optional(Type.Integer({ minimum: 1 })),
    download_id: Type.Optional(Type.String({ minLength: 36, maxLength: 36 })),
    after_context_id: Type.Optional(Type.Integer({ minimum: 0 })),
    timeout_ms: Type.Optional(Type.Integer({ minimum: 0, maximum: 60000 })),
    url: Type.Optional(Type.String({ maxLength: 8192 })),
}, { additionalProperties: false });
const locatorText = Type.String({ minLength: 1, maxLength: 1024, pattern: "^[^\\u0000-\\u001f\\u007f-\\u009f]+$" });
const locatorParameters = Type.Array(Type.Union([
    Type.Object({ kind: StringEnum(["css", "testid"]), value: locatorText }, { additionalProperties: false }),
    Type.Object({ kind: StringEnum(["role"]), value: locatorText, name: Type.Optional(locatorText), exact: Type.Optional(Type.Boolean()) }, { additionalProperties: false }),
    Type.Object({ kind: StringEnum(["text", "label", "placeholder"]), value: locatorText, exact: Type.Optional(Type.Boolean()) }, { additionalProperties: false }),
    Type.Object({ kind: StringEnum(["filter"]), hasText: locatorText }, { additionalProperties: false }),
    Type.Object({ kind: StringEnum(["nth"]), index: Type.Integer({ minimum: -20000, maximum: 20000 }) }, { additionalProperties: false }),
]), { minItems: 1, maxItems: 16, description: "Native AgentCursor steps. Query steps scope following queries. Actions require one match; use nth only for explicit selection." });
const frameParameter = Type.Optional(Type.String({ pattern: "^(main|f[1-9][0-9]{0,8})$", description: "Friendly frame ref from observe, or main. Omit to keep selection." }));
const observeParameters = Type.Object({
    frame: frameParameter,
    context_id: Type.Optional(Type.Integer({ minimum: 1 })),
    max_elements: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
    include_text: Type.Optional(Type.Boolean()),
    filter: Type.Optional(locatorParameters),
    view: Type.Optional(StringEnum(["semantic", "visual", "both"])),
    scope: Type.Optional(StringEnum(["viewport", "element"])),
    ref: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
}, { additionalProperties: false });
const actParameters = Type.Object({
    frame: frameParameter,
    files: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 4096 }), { minItems: 1, maxItems: 16 })),
    context_id: Type.Optional(Type.Integer({ minimum: 1 })),
    dialog_id: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
    accept: Type.Optional(Type.Boolean()),
    action: StringEnum(["upload", "click", "hover", "drag", "type", "press_key", "scroll", "navigate", "get_url", "wait_for", "dialog"]),
    ref: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
    locator: Type.Optional(locatorParameters),
    from_locator: Type.Optional(locatorParameters),
    to_locator: Type.Optional(locatorParameters),
    x: Type.Optional(Type.Number({ minimum: 0, maximum: 20000 })),
    y: Type.Optional(Type.Number({ minimum: 0, maximum: 20000 })),
    from_ref: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
    from_x: Type.Optional(Type.Number({ minimum: 0, maximum: 20000 })),
    from_y: Type.Optional(Type.Number({ minimum: 0, maximum: 20000 })),
    to_ref: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
    to_x: Type.Optional(Type.Number({ minimum: 0, maximum: 20000 })),
    to_y: Type.Optional(Type.Number({ minimum: 0, maximum: 20000 })),
    button: Type.Optional(StringEnum(["left", "middle", "right"])),
    text: Type.Optional(Type.String({ maxLength: 32768 })),
    replace: Type.Optional(Type.Boolean()),
    key: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
    dx: Type.Optional(Type.Number({ minimum: -20000, maximum: 20000 })),
    dy: Type.Optional(Type.Number({ minimum: -20000, maximum: 20000 })),
    url: Type.Optional(Type.String({ minLength: 1, maxLength: 8192 })),
    condition: Type.Optional(StringEnum(["exists", "visible", "text", "actionable"])),
    timeout_ms: Type.Optional(Type.Integer({ minimum: 0, maximum: 60000 })),
}, { additionalProperties: false });
const controlParameters = Type.Object({
    action: StringEnum(["status", "pause", "resume"]),
}, { additionalProperties: false });
function browserAction(params) {
    if (params.action === "dialog") {
        if (!params.dialog_id || params.accept === undefined)
            throw new Error("dialog requires dialog_id and accept");
        return { action: "dialog", contextId: params.context_id, dialogId: params.dialog_id, accept: params.accept, text: params.text };
    }
    if (params.action === "upload") {
        if (!params.files?.length)
            throw new Error("upload requires a trigger/input ref and project file paths");
        return { action: "upload", ...elementTarget(params.ref, params.locator), files: params.files };
    }
    if (params.action === "click") {
        return { action: "click", ...elementTarget(params.ref, params.locator) };
    }
    if (params.action === "hover") {
        const target = actionTarget(params.ref, params.x, params.y, "hover", params.locator);
        return { action: "hover", target };
    }
    if (params.action === "drag") {
        const from = actionTarget(params.from_ref, params.from_x, params.from_y, "drag from", params.from_locator);
        const to = actionTarget(params.to_ref, params.to_x, params.to_y, "drag to", params.to_locator);
        return { action: "drag", from, to, button: params.button };
    }
    if (params.action === "type") {
        if (params.text === undefined)
            throw new Error("type requires ref and text");
        return { action: "type", ...elementTarget(params.ref, params.locator), text: params.text, replace: params.replace };
    }
    if (params.action === "press_key") {
        if (!params.key)
            throw new Error("press_key requires key");
        return { action: "press_key", key: params.key };
    }
    if (params.action === "scroll") {
        if (params.dy === undefined)
            throw new Error("scroll requires dy");
        return { action: "scroll", dy: params.dy, dx: params.dx };
    }
    if (params.action === "navigate") {
        if (!params.url)
            throw new Error("navigate requires url");
        return { action: "navigate", url: params.url };
    }
    if (params.action === "get_url")
        return { action: "get_url" };
    if (!params.ref && !params.locator && !params.text)
        throw new Error("wait_for requires ref or text");
    return {
        action: "wait_for",
        ref: params.ref,
        locator: params.locator,
        text: params.text,
        condition: params.condition,
        timeoutMs: params.timeout_ms,
    };
}
function actionTarget(ref, x, y, name, locator) {
    if (locator !== undefined) {
        if (x !== undefined || y !== undefined)
            throw new Error("locator cannot be combined with coordinates");
        return elementTarget(ref, locator);
    }
    const hasCoordinates = x !== undefined || y !== undefined;
    if ((ref !== undefined) === hasCoordinates || (hasCoordinates && (x === undefined || y === undefined))) {
        throw new Error(`${name} requires exactly one ref or x/y pair`);
    }
    return ref !== undefined ? { ref } : { x: x, y: y };
}
export default async function terminalBrowserExtension(pi) {
    await loadWebResearch(pi);
    const client = new PiBrowserClient();
    pi.registerTool({
        name: "browser_open",
        label: "Browser Open",
        description: "Open or reuse the companion terminal-browser owned by this Pi pane. Returns bounded tab state and never requires a browser key.",
        promptSnippet: "Open or reuse this Pi pane's companion browser",
        promptGuidelines: ["Use browser_open before browser_observe. Reuse the returned companion instead of opening another browser."],
        parameters: openParameters,
        async execute(_id, params, signal, _update, ctx) {
            return result(await client.open(context(ctx, signal), {
                url: params.url,
                newTab: params.new_tab,
                focus: params.focus,
            }));
        },
    });
    pi.registerTool({
        name: "browser_tabs",
        label: "Browser Tabs",
        description: "List, wait for, activate, open, or close native tab and popup contexts. Use context_id; wait returns contexts newer than after_context_id without holding the action lane. Results are limited to 32 contexts. downloads lists up to 64 owner-scoped transfers, optionally filtered by context_id. download_wait and download_cancel require an exact download_id. Waits release the action lane. Results include the fixed launch projectRoot and relative savePath. Files are saved under that project and never opened.",
        parameters: tabsParameters,
        async execute(_id, params, signal, _update, ctx) {
            if ((params.action === "activate" || params.action === "close") && params.context_id === undefined) {
                throw new Error(`${params.action} requires context_id`);
            }
            if (params.action === "wait" && params.after_context_id === undefined)
                throw new Error("wait requires after_context_id from the last context list");
            return result(await client.tabs(context(ctx, signal), {
                action: params.action,
                downloadId: params.download_id,
                afterId: params.after_context_id,
                timeoutMs: params.timeout_ms,
                contextId: params.context_id,
                url: params.url,
            }));
        },
    });
    pi.registerTool({
        name: "browser_observe",
        label: "Browser Observe",
        description: "Read a bounded semantic, visual, or combined observation from the active companion tab. Use filter with native locator steps to narrow the element list. Visual captures cover the containing context viewport or one referenced element. Up to 24 friendly frame summaries are included. Use frame to select fN or main; omission keeps the current frame.",
        promptSnippet: "Observe the active companion browser tab before acting",
        promptGuidelines: ["Use browser_observe after browser_open and after each page-changing browser_act call. Then use one browser_act action."],
        parameters: observeParameters,
        async execute(_id, params, signal, _update, ctx) {
            if ((params.scope ?? "viewport") === "element" && !params.ref) {
                throw new Error("element scope requires ref from browser_observe");
            }
            if ((params.scope ?? "viewport") === "viewport" && params.ref) {
                throw new Error("ref requires element scope");
            }
            if ((params.scope ?? "viewport") === "element" && (params.view ?? "semantic") === "semantic") {
                throw new Error("element scope requires visual or both view");
            }
            return observationResult(await client.observe(context(ctx, signal), {
                frame: params.frame,
                contextId: params.context_id,
                maxElements: params.max_elements,
                includeText: params.include_text,
                view: params.view,
                scope: params.scope,
                ref: params.ref,
                filter: params.filter,
            }));
        },
    });
    pi.registerTool({
        name: "browser_act",
        label: "Browser Act",
        description: "Perform one native action in this Pi pane's companion browser: upload, click, hover, drag, type, press_key, scroll, navigate, get_url, wait_for, or dialog. Dialog responses require the exact dialog_id returned by observe, tabs, resume, or an interrupted action and an explicit accept decision. Optional context_id must match that dialog. Never assume acceptance. Upload clicks a visible input or chooser button through AgentCursor, then assigns 1–16 regular project files (32 MiB each, 64 MiB total); secret paths and project escapes are rejected. Changing cwd does not change the companion project root; reopen the companion to adopt another project. Use exactly one ref or locator (native bounded step array) for click, type, upload or hover; drag accepts from_locator/to_locator. Ambiguous locators fail; scope or nth selects explicitly. wait_for accepts locator and actionable. Coordinates require the latest visual observation. Frame defaults to the selected observation; explicit frame must match it. Select another frame with browser_observe first. Drag endpoints must be in that same frame. Omit frame for context navigation, get_url, and dialog.",
        promptSnippet: "Perform one native companion-browser action",
        promptGuidelines: ["Use browser_act for exactly one action per call, then use browser_observe again when the page may have changed."],
        parameters: actParameters,
        async execute(_id, params, signal, _update, ctx) {
            return result(await client.act(context(ctx, signal), { ...browserAction(params), frame: params.frame }));
        },
    });
    pi.registerTool({
        name: "browser_control",
        label: "Browser Control",
        description: "Read, pause, or resume browser-wide agent control for this Pi pane's companion. Resume refreshes the internal observation automatically.",
        parameters: controlParameters,
        async execute(_id, params, signal, _update, ctx) {
            return result(await client.control(context(ctx, signal), params.action));
        },
    });
}
function elementTarget(ref, locator) {
    if ((ref !== undefined) === (locator !== undefined))
        throw new Error("provide exactly one ref or locator");
    return locator !== undefined ? { locator } : { ref: ref };
}
