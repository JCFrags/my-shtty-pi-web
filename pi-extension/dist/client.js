import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const CLI_PATH = resolve(dirname(fileURLToPath(import.meta.url)), "../../cli/dist/main.js");
const OUTPUT_LIMIT = 256 * 1024;
function ownerEnvironment(context) {
    if (process.env.HERDR_ENV !== "1" || !process.env.HERDR_WORKSPACE_ID ||
        !process.env.HERDR_TAB_ID || !process.env.HERDR_PANE_ID) {
        throw new Error("Browser tools require a Pi pane managed by Herdr.");
    }
    return {
        ...process.env,
        TERMINAL_BROWSER_OWNER_WORKSPACE_ID: process.env.HERDR_WORKSPACE_ID,
        TERMINAL_BROWSER_OWNER_TAB_ID: process.env.HERDR_TAB_ID,
        TERMINAL_BROWSER_OWNER_PANE_ID: process.env.HERDR_PANE_ID,
        TERMINAL_BROWSER_OWNER_SESSION_ID: context.sessionId,
        TERMINAL_BROWSER_OWNER_PROJECT_DIR: context.cwd,
    };
}
export const defaultCommandRunner = ({ args, context, stdin, timeoutMs = 30_000 }) => new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, [CLI_PATH, ...args], {
        cwd: context.cwd,
        env: ownerEnvironment(context),
        stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let exceeded = false;
    const collect = (target, chunk) => {
        if (exceeded)
            return;
        if (target === "stdout")
            stdout += chunk.toString("utf8");
        else
            stderr += chunk.toString("utf8");
        if (Buffer.byteLength(stdout, "utf8") + Buffer.byteLength(stderr, "utf8") > OUTPUT_LIMIT) {
            exceeded = true;
            child.kill("SIGTERM");
        }
    };
    child.stdout.on("data", (chunk) => collect("stdout", chunk));
    child.stderr.on("data", (chunk) => collect("stderr", chunk));
    const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
    const abort = () => child.kill("SIGTERM");
    context.signal?.addEventListener("abort", abort, { once: true });
    child.once("error", reject);
    child.once("close", (code) => {
        clearTimeout(timer);
        context.signal?.removeEventListener("abort", abort);
        if (context.signal?.aborted)
            return reject(new Error("Browser operation cancelled."));
        if (exceeded)
            return reject(new Error("Browser response exceeded its safe limit."));
        if (code !== 0)
            return reject(new Error(actionableError(stderr)));
        try {
            resolveResult(JSON.parse(stdout));
        }
        catch {
            reject(new Error("Browser returned an invalid response."));
        }
    });
    child.stdin.end(stdin);
});
function actionableError(stderr) {
    const message = stderr.replace(/^terminal-browser:\s*/u, "").trim();
    if (/agent control is human|agent control is paused|browser control is with the user/iu.test(message)) {
        return "Browser control is with the user. Wait until the user returns control, then call browser_control with status or resume.";
    }
    if (/stale control epoch|page changed|stale or unknown observation/iu.test(message)) {
        return "Browser state changed. Call browser_observe and retry the action.";
    }
    if (/no browser companion/iu.test(message))
        return "No companion browser is open. Call browser_open first.";
    return message || "Browser operation failed.";
}
function boundedTabs(value) {
    const tabs = value?.tabs;
    if (!Array.isArray(tabs))
        return [];
    return tabs.slice(0, 32).map((item) => {
        const tab = item;
        return {
            id: tab.id,
            url: typeof tab.url === "string" ? tab.url.slice(0, 8192) : "",
            title: typeof tab.title === "string" ? tab.title.slice(0, 512) : "",
            active: tab.active === true,
        };
    });
}
function parseVisualState(value) {
    const rect = value.rect;
    const width = Number(value.width);
    const height = Number(value.height);
    const parsedRect = {
        x: Number(rect?.x),
        y: Number(rect?.y),
        width: Number(rect?.width),
        height: Number(rect?.height),
    };
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0 ||
        !Object.values(parsedRect).every(Number.isFinite) || parsedRect.width <= 0 || parsedRect.height <= 0) {
        throw new Error("Browser returned invalid visual geometry.");
    }
    return { width, height, rect: parsedRect };
}
function targetArguments(observation, target, prefix) {
    if ("ref" in target)
        return prefix ? [`--${prefix}-ref`, target.ref] : [target.ref];
    const visual = observation.visual;
    if (!visual)
        throw new Error("Coordinate actions require the latest visual browser_observe result.");
    if (!Number.isFinite(target.x) || !Number.isFinite(target.y) ||
        target.x < 0 || target.y < 0 || target.x > visual.width || target.y > visual.height) {
        throw new Error("Action coordinates are outside the latest visual observation.");
    }
    const x = visual.rect.x + target.x * visual.rect.width / visual.width;
    const y = visual.rect.y + target.y * visual.rect.height / visual.height;
    return prefix
        ? [`--${prefix}-x`, String(x), `--${prefix}-y`, String(y)]
        : ["--x", String(x), "--y", String(y)];
}
export class PiBrowserClient {
    runner;
    observation = null;
    constructor(runner = defaultCommandRunner) {
        this.runner = runner;
    }
    async open(context, options) {
        const args = ["companion", "open"];
        if (options.newTab)
            args.push("--new-tab");
        if (options.focus === false)
            args.push("--no-focus");
        if (options.url)
            args.push(options.url);
        const value = await this.runner({ args, context, timeoutMs: 30_000 });
        this.observation = null;
        return { action: value.action, tabs: boundedTabs(value) };
    }
    async tabs(context, request) {
        const args = ["companion", "tabs", "--action", request.action];
        if (request.tabId !== undefined)
            args.push("--tab", String(request.tabId));
        if (request.url !== undefined)
            args.push("--url", request.url);
        const value = await this.runner({ args, context });
        if (request.action !== "list")
            this.observation = null;
        return { tabs: boundedTabs(value) };
    }
    async observe(context, options = {}) {
        const view = options.view ?? "semantic";
        const scope = options.scope ?? "viewport";
        const args = [
            "agent", "observe",
            "--max-elements", String(options.maxElements ?? 120),
            "--view", view,
            "--scope", scope,
        ];
        if (options.includeText === false)
            args.push("--no-text");
        if (options.ref)
            args.push("--ref", options.ref);
        let directory = null;
        let imagePath = null;
        if (view !== "semantic") {
            directory = await mkdtemp(join(tmpdir(), "pi-terminal-browser-"));
            imagePath = join(directory, "observation.png");
            args.push("--image-output", imagePath);
        }
        try {
            const value = await this.runner({ args, context });
            const snapshot = value.snapshot;
            const elements = Array.isArray(snapshot?.elements) ? snapshot.elements.slice(0, options.maxElements ?? 120) : [];
            const visual = value.visual && typeof value.visual === "object"
                ? value.visual
                : undefined;
            this.observation = {
                tabId: Number(snapshot.tabId ?? value.tabId ?? 0),
                observationId: String(value.observationId),
                controlEpoch: Number(value.controlEpoch),
                ...(visual ? { visual: parseVisualState(visual) } : {}),
            };
            if (!this.observation.tabId) {
                const tabs = await this.tabs(context, { action: "list" });
                this.observation.tabId = Number(tabs.tabs.find((tab) => tab.active)?.id ?? 0);
            }
            const semantic = {
                url: typeof snapshot.url === "string" ? snapshot.url.slice(0, 8192) : "",
                title: typeof snapshot.title === "string" ? snapshot.title.slice(0, 512) : "",
                viewport: snapshot.viewport,
                elements,
                ...(typeof snapshot.text === "string" ? { text: snapshot.text.slice(0, 12_000) } : {}),
                truncated: typeof snapshot.text === "string" && snapshot.text.length > 12_000,
            };
            const image = imagePath ? await readFile(imagePath) : null;
            return {
                ...(view === "visual" ? {
                    url: semantic.url,
                    title: semantic.title,
                    viewport: semantic.viewport,
                } : semantic),
                ...(visual ? { visual } : {}),
                ...(image ? { image: { data: image.toString("base64"), mimeType: "image/png" } } : {}),
            };
        }
        finally {
            if (directory)
                await rm(directory, { recursive: true, force: true });
        }
    }
    async status(context) {
        return this.runner({ args: ["agent", "status"], context });
    }
    async control(context, action) {
        const before = await this.status(context);
        if (action === "status")
            return before;
        if (action === "pause") {
            const result = await this.runner({
                args: ["agent", "pause", "--control-epoch", String(before.controlEpoch)], context,
            });
            this.observation = null;
            return result;
        }
        const result = before.state === "agent" ? before : await this.runner({
            args: ["agent", "resume", "--control-epoch", String(before.controlEpoch)], context,
        });
        const observation = await this.observe(context);
        return { ...result, observationReady: true, url: observation.url };
    }
    async act(context, request) {
        const status = await this.status(context);
        if (status.state !== "agent") {
            throw new Error("Browser control is with the user. Wait for control to be returned, or call browser_control with resume when asked.");
        }
        const args = ["agent"];
        const needsObservation = request.action !== "navigate" && request.action !== "get_url";
        if (needsObservation) {
            if (!this.observation || this.observation.controlEpoch !== status.controlEpoch) {
                this.observation = null;
                throw new Error("Call browser_observe before this action so it uses the current page state.");
            }
        }
        if (request.action === "click")
            args.push("click", request.ref);
        if (request.action === "hover") {
            args.push("hover", ...targetArguments(this.observation, request.target));
        }
        if (request.action === "drag") {
            args.push("drag", ...targetArguments(this.observation, request.from, "from"), ...targetArguments(this.observation, request.to, "to"));
            if (request.button)
                args.push("--button", request.button);
        }
        if (request.action === "type")
            args.push("type", request.ref, "--stdin", ...(request.replace ? ["--replace"] : []));
        if (request.action === "press_key")
            args.push("press-key", request.key);
        if (request.action === "scroll")
            args.push("scroll", "--dy", String(request.dy), "--dx", String(request.dx ?? 0));
        if (request.action === "navigate")
            args.push("navigate", request.url);
        if (request.action === "get_url")
            args.push("get-url");
        if (request.action === "wait_for") {
            args.push("wait-for");
            if (request.ref)
                args.push("--ref", request.ref);
            if (request.text)
                args.push("--text", request.text);
            if (request.condition)
                args.push("--condition", request.condition);
            if (request.timeoutMs !== undefined)
                args.push("--timeout-ms", String(request.timeoutMs));
        }
        if (this.observation && needsObservation) {
            args.push("--observation", this.observation.observationId);
        }
        args.push("--control-epoch", String(status.controlEpoch));
        const value = await this.runner({
            args,
            context,
            ...(request.action === "type" ? { stdin: request.text } : {}),
            timeoutMs: request.action === "wait_for" ? (request.timeoutMs ?? 10_000) + 5_000 : 300_000,
        });
        if (request.action !== "get_url" && request.action !== "wait_for")
            this.observation = null;
        if (request.action === "get_url")
            return { url: typeof value.url === "string" ? value.url.slice(0, 8192) : "" };
        if (request.action === "wait_for")
            return { matched: value.matched === true, condition: value.condition };
        return { action: request.action, completed: true };
    }
}
