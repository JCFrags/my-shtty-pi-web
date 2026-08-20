export const TOOL_NAMES = [
    "web_upgrade",
    "web_search",
    "web_research",
    "web_recall",
    "web_recall_get",
    "web_recall_forget",
    "web_read",
    "browser_open",
    "browser_tabs",
    "browser_observe",
    "browser_act",
    "browser_debug",
    "artifact_read",
];
const rank = { off: 0, read: 1, browser: 2, debug: 3 };
export function availableTools(mode, capabilities) {
    if (!capabilities || capabilities.daemon !== "ready" || mode === "off")
        return [];
    const tools = [];
    if (capabilities.groups.web) {
        tools.push("web_upgrade", "web_search", "web_research", "web_recall", "web_recall_get", "web_recall_forget", "web_read");
    }
    if (capabilities.groups.artifacts)
        tools.push("artifact_read");
    if (rank[mode] >= rank.browser && capabilities.groups.browser) {
        tools.push("browser_open", "browser_tabs", "browser_observe", "browser_act");
    }
    if (mode === "debug" && capabilities.groups.browserDebug)
        tools.push("browser_debug");
    return tools;
}
export function planUpgrade(current, target) {
    if (current === "off") {
        throw new Error("Web tools were explicitly disabled with /web off. Only the user can enable them.");
    }
    return rank[target] > rank[current] ? target : current;
}
