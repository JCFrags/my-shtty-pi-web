export interface ToolContext {
    cwd: string;
    sessionId: string;
    signal?: AbortSignal;
}
export interface CommandRequest {
    args: string[];
    context: ToolContext;
    stdin?: string;
    timeoutMs?: number;
}
export type CommandRunner = (request: CommandRequest) => Promise<unknown>;
export declare const defaultCommandRunner: CommandRunner;
export interface BrowserStateCache {
    contextId: number;
    observationId: string;
    controlEpoch: number;
    visual?: {
        width: number;
        height: number;
        rect: {
            x: number;
            y: number;
            width: number;
            height: number;
        };
    };
}
export type LocatorSpec = Array<{
    kind: "css" | "testid";
    value: string;
} | {
    kind: "role";
    value: string;
    name?: string;
    exact?: boolean;
} | {
    kind: "text" | "label" | "placeholder";
    value: string;
    exact?: boolean;
} | {
    kind: "filter";
    hasText: string;
} | {
    kind: "nth";
    index: number;
}>;
export type BrowserElementTarget = {
    ref: string;
} | {
    locator: LocatorSpec;
};
export type BrowserActionTarget = BrowserElementTarget | {
    x: number;
    y: number;
};
export type BrowserAction = {
    action: "dialog";
    contextId?: number;
    dialogId: string;
    accept: boolean;
    text?: string;
} | ({
    action: "upload";
    files: string[];
} & BrowserElementTarget) | ({
    action: "click";
} & BrowserElementTarget) | {
    action: "hover";
    target: BrowserActionTarget;
} | {
    action: "drag";
    from: BrowserActionTarget;
    to: BrowserActionTarget;
    button?: "left" | "middle" | "right";
} | ({
    action: "type";
    text: string;
    replace?: boolean;
} & BrowserElementTarget) | {
    action: "press_key";
    key: string;
} | {
    action: "scroll";
    dy: number;
    dx?: number;
} | {
    action: "navigate";
    url: string;
} | {
    action: "get_url";
} | {
    action: "wait_for";
    ref?: string;
    locator?: LocatorSpec;
    text?: string;
    condition?: "exists" | "visible" | "text" | "actionable";
    timeoutMs?: number;
};
export declare class PiBrowserClient {
    private readonly runner;
    private observation;
    private contextId;
    private pendingDialog;
    private cacheDialog;
    constructor(runner?: CommandRunner);
    open(context: ToolContext, options: {
        url?: string;
        newTab?: boolean;
        focus?: boolean;
    }): Promise<{
        action: unknown;
        tabs: {
            id: unknown;
            contextId: unknown;
            openerId: unknown;
            kind: unknown;
            url: string;
            title: string;
            active: boolean;
        }[];
    }>;
    tabs(context: ToolContext, request: {
        action: "list" | "activate" | "open" | "close" | "wait" | "downloads" | "download_wait" | "download_cancel";
        downloadId?: string;
        contextId?: number;
        url?: string;
        afterId?: number;
        timeoutMs?: number;
    }): Promise<{
        projectRoot: string | undefined;
        downloads: {
            id: string;
            contextId: number;
            state: string;
            received: number;
            total: number;
            name: string;
            savePath: string;
        }[];
        download?: undefined;
    } | {
        projectRoot: string | undefined;
        download: {
            id: string;
            contextId: number;
            state: string;
            received: number;
            total: number;
            name: string;
            savePath: string;
        };
        downloads?: undefined;
    } | {
        matched?: boolean | undefined;
        dialog?: {
            [x: string]: unknown;
        } | undefined;
        completed?: boolean | undefined;
        tabs: {
            id: unknown;
            contextId: unknown;
            openerId: unknown;
            kind: unknown;
            url: string;
            title: string;
            active: boolean;
        }[];
        projectRoot?: undefined;
        downloads?: undefined;
        download?: undefined;
    }>;
    observe(context: ToolContext, options?: {
        contextId?: number;
        maxElements?: number;
        includeText?: boolean;
        view?: "semantic" | "visual" | "both";
        scope?: "viewport" | "element";
        filter?: LocatorSpec;
        ref?: string;
    }): Promise<{
        contextId: unknown;
        dialog: {
            [x: string]: unknown;
        };
        completed: boolean;
    } | {
        image?: {
            data: string;
            mimeType: "image/png";
        } | undefined;
        visual?: Record<string, unknown> | undefined;
        truncated: boolean;
        text?: string | undefined;
        url: string;
        title: string;
        viewport: unknown;
        elements: any[];
        contextId: number;
        dialog?: undefined;
        completed?: undefined;
    } | {
        image?: {
            data: string;
            mimeType: "image/png";
        } | undefined;
        visual?: Record<string, unknown> | undefined;
        url: string;
        title: string;
        viewport: unknown;
        contextId: number;
        dialog?: undefined;
        completed?: undefined;
    }>;
    private status;
    control(context: ToolContext, action: "status" | "pause" | "resume"): Promise<{
        state: "agent" | "human" | "paused";
        reason: string | null;
        busy: boolean;
        interactionStyle: "slow-natural";
    } | {
        dialog?: {
            [x: string]: unknown;
        } | undefined;
        observationReady: boolean;
        url: string | undefined;
        state: "agent" | "human" | "paused";
        reason: string | null;
        busy: boolean;
        interactionStyle: "slow-natural";
    }>;
    act(context: ToolContext, request: BrowserAction): Promise<{
        contextId: number;
        completed: boolean;
        action?: undefined;
        dialog?: undefined;
        openedContextId?: undefined;
        url?: undefined;
        matched?: undefined;
        condition?: undefined;
    } | {
        action: "upload" | "click" | "hover" | "drag" | "type" | "press_key" | "scroll" | "navigate" | "get_url" | "wait_for";
        completed: boolean;
        contextId: unknown;
        dialog: {
            [x: string]: unknown;
        };
        openedContextId?: undefined;
        url?: undefined;
        matched?: undefined;
        condition?: undefined;
    } | {
        action: "upload" | "click" | "hover" | "drag" | "type" | "press_key" | "scroll" | "navigate" | "get_url" | "wait_for";
        completed: boolean;
        openedContextId: {};
        contextId?: undefined;
        dialog?: undefined;
        url?: undefined;
        matched?: undefined;
        condition?: undefined;
    } | {
        url: string;
        contextId?: undefined;
        completed?: undefined;
        action?: undefined;
        dialog?: undefined;
        openedContextId?: undefined;
        matched?: undefined;
        condition?: undefined;
    } | {
        matched: boolean;
        condition: unknown;
        contextId?: undefined;
        completed?: undefined;
        action?: undefined;
        dialog?: undefined;
        openedContextId?: undefined;
        url?: undefined;
    } | {
        action: "upload" | "click" | "hover" | "drag" | "type" | "press_key" | "scroll" | "navigate";
        completed: boolean;
        contextId?: undefined;
        dialog?: undefined;
        openedContextId?: undefined;
        url?: undefined;
        matched?: undefined;
        condition?: undefined;
    }>;
}
