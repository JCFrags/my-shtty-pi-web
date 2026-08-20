import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { availableTools, planUpgrade, TOOL_NAMES, type WebMode } from "./modes.js";
import { presentResult } from "./output-constrained-v3.js";
import {
  ArtifactReadSchema,
  BrowserActSchema,
  BrowserDebugSchema,
  BrowserObserveSchema,
  BrowserOpenSchema,
  BrowserTabsSchema,
  WebReadSchema,
  WebRecallForgetSchema,
  WebRecallGetSchema,
  WebRecallSchema,
  WebResearchSchema,
  WebSearchSchema,
  WebUpgradeSchema,
} from "./schemas.js";
import {
  apiMajor,
  createSdkClient,
  SUPPORTED_API_MAJOR,
  type WebxCapabilities,
  type WebxSdk,
  type WebxSdkFactory,
} from "./sdk-structured-v2.js";

const STATUS_KEY = "pi-webx";
const REFRESH_MS = 60_000;
const REQUIRED_BROWSER_PATHS = new Set(["agent-browser/chrome", "pinchtab/chrome"]);

type Timer = ReturnType<typeof setTimeout>;

function isDownloadAction(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const action = (value as { action?: unknown }).action;
  return typeof action === "object" && action !== null && (action as { kind?: unknown }).kind === "download";
}

function capabilityError(capabilities: WebxCapabilities): string | undefined {
  if (apiMajor(capabilities.apiVersion) !== SUPPORTED_API_MAJOR) {
    return `WebX API major mismatch: facade requires ${SUPPORTED_API_MAJOR}.x, daemon reports ${capabilities.apiVersion}.`;
  }
  if (capabilities.daemon !== "ready") return "WebX daemon is unavailable. Direct fallback is disabled.";
  const paths = capabilities.browserPathIds;
  if (paths.length !== 2 || new Set(paths).size !== 2 || paths.some((path) => !REQUIRED_BROWSER_PATHS.has(path))) {
    return "WebX capability contract must report exactly agent-browser/chrome and pinchtab/chrome browser paths.";
  }
  return undefined;
}

function ownerId(ctx: ExtensionContext): string {
  return ctx.sessionManager.getSessionId();
}

function assertTrusted(ctx: ExtensionContext): void {
  if (!ctx.isProjectTrusted()) throw new Error("Pi WebX is disabled because this project is not trusted.");
}

export function createPiWebxExtension(sdkFactory: WebxSdkFactory = createSdkClient) {
  return function piWebxExtension(pi: ExtensionAPI): void {
    let mode: WebMode = "browser";
    let sdk: WebxSdk | undefined;
    let capabilities: WebxCapabilities | undefined;
    let lifecycle: AbortController | undefined;
    let refreshTimer: Timer | undefined;
    let activeOwner: string | undefined;
    let activeCwd: string | undefined;
    let diagnostic = "WebX has not started.";

    const applyTools = () => {
      const unrelated = pi.getActiveTools().filter((name) => !TOOL_NAMES.includes(name as (typeof TOOL_NAMES)[number]));
      pi.setActiveTools([...new Set([...unrelated, ...availableTools(mode, capabilities)])]);
    };

    const setUnavailable = (message: string, ctx?: ExtensionContext) => {
      diagnostic = message;
      capabilities = undefined;
      applyTools();
      ctx?.ui.setStatus(STATUS_KEY, "WebX unavailable");
      if (ctx?.hasUI) ctx.ui.notify(message, "error");
    };

    const refresh = async (ctx: ExtensionContext): Promise<void> => {
      if (!sdk || !lifecycle || lifecycle.signal.aborted || !activeOwner) return;
      try {
        const next = await sdk.capabilities({ signal: lifecycle.signal, ownerId: activeOwner });
        const error = capabilityError(next);
        if (error) {
          setUnavailable(error, ctx);
          return;
        }
        capabilities = next;
        diagnostic = `WebX ${next.apiVersion}; mode ${mode}; paths ${next.browserPathIds.join(", ")}`;
        applyTools();
        ctx.ui.setStatus(STATUS_KEY, `WebX ${mode}`);
      } catch (error) {
        if (!lifecycle.signal.aborted) {
          setUnavailable(`WebX daemon probe failed: ${error instanceof Error ? error.message : String(error)}. Direct fallback is disabled.`, ctx);
        }
      }
    };

    const scheduleRefresh = (ctx: ExtensionContext) => {
      if (!lifecycle || lifecycle.signal.aborted) return;
      refreshTimer = setTimeout(() => {
        void refresh(ctx).finally(() => scheduleRefresh(ctx));
      }, REFRESH_MS);
      refreshTimer.unref?.();
    };

    const invoke = (operation: string) => async (
      toolCallId: string,
      params: unknown,
      signal: AbortSignal,
      _onUpdate: unknown,
      ctx: ExtensionContext,
    ) => {
      assertTrusted(ctx);
      if (!sdk || !capabilities || !lifecycle || lifecycle.signal.aborted || !activeOwner || !activeCwd) {
        throw new Error(diagnostic);
      }
      const combined = AbortSignal.any([signal, lifecycle.signal]);
      const requestOptions = {
        signal: combined,
        idempotencyKey: `${toolCallId}:${randomUUID()}`,
        ownerId: activeOwner,
        cwd: activeCwd,
      };
      if (operation === "browser.act" && isDownloadAction(params)) {
        if (!ctx.hasUI) throw new Error("A browser download requires approval, but this Pi mode has no approval UI.");
        const choice = await ctx.ui.select(
          "WebX approval required\nOperation: browser download\nCapability: write a remote file to local storage\nDuration: one action",
          ["Allow once", "Deny"],
        );
        if (choice !== "Allow once") throw new Error("Browser download denied by the user.");
      }
      let result = await sdk.request(operation, params, requestOptions);
      if (result.approval) {
        if (!ctx.hasUI) throw new Error("WebX approval is required, but this Pi mode has no approval UI.");
        const approval = result.approval;
        const credential = approval.credentialRef ? `\nCredential reference: ${approval.credentialRef}` : "";
        const choice = await ctx.ui.select(
          `WebX approval required\nOperation: ${approval.operation}\nTarget: ${approval.target}\nCapability: ${approval.capability}\nBudget: ${approval.budget}${credential}\nReason: ${approval.reason}\nDuration: ${approval.duration}`,
          ["Allow once", "Deny"],
        );
        const decision = choice === "Allow once" ? "allow-once" : "deny";
        result = await sdk.decideApproval(approval.id, decision, requestOptions);
      }
      return presentResult(result);
    };

    pi.registerTool({
      name: "web_upgrade",
      label: "Upgrade web capabilities",
      description: "Add browser or browser-debug tools when the current WebX mode cannot complete the task. It never downgrades or overrides explicit /web off.",
      parameters: WebUpgradeSchema,
      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        assertTrusted(ctx);
        const previous = mode;
        mode = planUpgrade(mode, params.mode);
        applyTools();
        ctx.ui.setStatus(STATUS_KEY, capabilities ? `WebX ${mode}` : "WebX unavailable");
        return {
          content: [{ type: "text", text: previous === mode ? `WebX remains in ${mode} mode.` : `WebX upgraded from ${previous} to ${mode} mode.` }],
          details: { previousMode: previous, mode },
        };
      },
    });
    pi.registerTool({ name: "web_search", label: "Web search", description: "Search WebX sources and return compact attributed discovery results.", parameters: WebSearchSchema, execute: invoke("web.search") });
    pi.registerTool({ name: "web_research", label: "Web research", description: "Run bounded WebX research and return claims, citations, disagreement, and a resumable manifest.", parameters: WebResearchSchema, execute: invoke("web.research") });
    pi.registerTool({ name: "web_recall", label: "Recall web pages", description: "Search the owner-scoped durable public WebX page library.", parameters: WebRecallSchema, execute: invoke("library.search") });
    pi.registerTool({ name: "web_recall_get", label: "Read recalled page", description: "Read one exact owner-visible page-library version with bounded model output.", parameters: WebRecallGetSchema, execute: invoke("library.get") });
    pi.registerTool({ name: "web_recall_forget", label: "Forget recalled page", description: "Forget an owned page version or canonical URL. WebX remains the storage authority.", parameters: WebRecallForgetSchema, execute: invoke("library.forget") });
    pi.registerTool({ name: "web_read", label: "Read web content", description: "Read bounded main content through WebX. Exact source remains available by artifact ID.", parameters: WebReadSchema, execute: invoke("web.read") });
    pi.registerTool({ name: "browser_open", label: "Open browser", description: "Open an owned browser session or tab through exactly one explicit WebX path. No silent fallback is allowed.", parameters: BrowserOpenSchema, execute: invoke("browser.open") });
    pi.registerTool({ name: "browser_tabs", label: "Manage browser tabs", description: "List or clean up only this agent's browser sessions and tabs.", parameters: BrowserTabsSchema, execute: invoke("browser.tabs") });
    pi.registerTool({ name: "browser_observe", label: "Observe browser", description: "Return low-context semantic or screenshot-bound visual observations for an owned tab.", parameters: BrowserObserveSchema, execute: invoke("browser.observe") });
    pi.registerTool({ name: "browser_act", label: "Act in browser", description: "Act in an owned tab. Coordinate actions require exact observation and viewport bindings.", parameters: BrowserActSchema, execute: invoke("browser.act") });
    pi.registerTool({ name: "browser_debug", label: "Debug browser", description: "Use bounded advanced browser operations in explicit debug mode.", parameters: BrowserDebugSchema, execute: invoke("browser.debug") });
    pi.registerTool({ name: "artifact_read", label: "Read WebX artifact", description: "Read an owner-visible content-addressed artifact with bounded exact recovery pages.", parameters: ArtifactReadSchema, execute: invoke("artifact.read") });

    pi.registerCommand("web", {
      description: "Set Pi WebX mode: /web off|read|browser|debug|status",
      handler: async (args, ctx) => {
        assertTrusted(ctx);
        const requested = args.trim() || "status";
        if (requested === "status") {
          ctx.ui.notify(diagnostic, capabilities ? "info" : "error");
          return;
        }
        if (!(["off", "read", "browser", "debug"] as const).includes(requested as WebMode)) {
          ctx.ui.notify("Usage: /web off|read|browser|debug|status", "warning");
          return;
        }
        mode = requested as WebMode;
        if (mode !== "off" && !capabilities) await refresh(ctx);
        applyTools();
        ctx.ui.setStatus(STATUS_KEY, capabilities ? `WebX ${mode}` : "WebX unavailable");
      },
    });

    const workspace = async (args: string, ctx: ExtensionContext) => {
      assertTrusted(ctx);
      if (!sdk || !capabilities || !lifecycle || !activeOwner || !activeCwd) throw new Error(diagnostic);
      const words = args.trim().split(/\s+/).filter(Boolean);
      const action = words[0] ?? "show";
      if (!["show", "hide", "list", "attach", "profile", "takeover", "return"].includes(action)) {
        ctx.ui.notify("Usage: /browser show|hide|list|attach|profile|takeover|return [id]", "warning");
        return;
      }
      const result = await sdk.request("browser.workspace", { action, values: words.slice(1) }, {
        signal: lifecycle.signal,
        idempotencyKey: `command:${randomUUID()}`,
        ownerId: activeOwner,
        cwd: activeCwd,
      });
      ctx.ui.notify(result.summary, "info");
    };

    pi.registerCommand("browser", {
      description: "Show or control the owned Pi Browser Workspace",
      handler: workspace,
    });
    pi.registerShortcut("ctrl+alt+g", {
      description: "Raise the owned Pi Browser Workspace",
      handler: async (ctx) => workspace("show", ctx),
    });

    pi.on("session_start", async (_event, ctx) => {
      if (!ctx.isProjectTrusted()) {
        setUnavailable("Pi WebX did not start because this project is not trusted.", ctx);
        return;
      }
      lifecycle = new AbortController();
      activeOwner = ownerId(ctx);
      activeCwd = ctx.cwd;
      try {
        sdk = sdkFactory();
        await sdk.start({ signal: lifecycle.signal, ownerId: activeOwner, cwd: activeCwd });
        await refresh(ctx);
        scheduleRefresh(ctx);
      } catch (error) {
        setUnavailable(`Pi WebX startup failed: ${error instanceof Error ? error.message : String(error)}. Direct fallback is disabled.`, ctx);
      }
    });

    pi.on("session_shutdown", async () => {
      if (refreshTimer) clearTimeout(refreshTimer);
      lifecycle?.abort();
      if (sdk && activeOwner) {
        try {
          await sdk.stop({ ownerId: activeOwner });
        } catch {
          // Shutdown is best-effort after local cancellation. A new runtime must probe again.
        }
      }
      sdk = undefined;
      capabilities = undefined;
      activeOwner = undefined;
      activeCwd = undefined;
      refreshTimer = undefined;
      lifecycle = undefined;
    });
  };
}

export default createPiWebxExtension();
