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
    tabId: number;
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
export type BrowserActionTarget = {
    ref: string;
} | {
    x: number;
    y: number;
};
export type BrowserAction = {
    action: "click";
    ref: string;
} | {
    action: "hover";
    target: BrowserActionTarget;
} | {
    action: "drag";
    from: BrowserActionTarget;
    to: BrowserActionTarget;
    button?: "left" | "middle" | "right";
} | {
    action: "type";
    ref: string;
    text: string;
    replace?: boolean;
} | {
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
    text?: string;
    condition?: "exists" | "visible" | "text";
    timeoutMs?: number;
};
interface ControlStatus {
    state: "agent" | "human" | "paused";
    controlEpoch: number;
    reason: string | null;
    busy: boolean;
    interactionStyle: "slow-natural";
}
export declare class PiBrowserClient {
    private readonly runner;
    private observation;
    constructor(runner?: CommandRunner);
    open(context: ToolContext, options: {
        url?: string;
        newTab?: boolean;
        focus?: boolean;
    }): Promise<{
        action: unknown;
        tabs: {
            id: unknown;
            url: string;
            title: string;
            active: boolean;
        }[];
    }>;
    tabs(context: ToolContext, request: {
        action: "list" | "activate" | "open" | "close";
        tabId?: number;
        url?: string;
    }): Promise<{
        tabs: {
            id: unknown;
            url: string;
            title: string;
            active: boolean;
        }[];
    }>;
    observe(context: ToolContext, options?: {
        maxElements?: number;
        includeText?: boolean;
        view?: "semantic" | "visual" | "both";
        scope?: "viewport" | "element";
        ref?: string;
    }): Promise<{
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
    } | {
        image?: {
            data: string;
            mimeType: "image/png";
        } | undefined;
        visual?: Record<string, unknown> | undefined;
        url: string;
        title: string;
        viewport: unknown;
    }>;
    private status;
    control(context: ToolContext, action: "status" | "pause" | "resume"): Promise<ControlStatus | {
        observationReady: boolean;
        url: string;
        state: "agent" | "human" | "paused";
        controlEpoch: number;
        reason: string | null;
        busy: boolean;
        interactionStyle: "slow-natural";
    }>;
    act(context: ToolContext, request: BrowserAction): Promise<{
        url: string;
        matched?: undefined;
        condition?: undefined;
        action?: undefined;
        completed?: undefined;
    } | {
        matched: boolean;
        condition: unknown;
        url?: undefined;
        action?: undefined;
        completed?: undefined;
    } | {
        action: "click" | "hover" | "drag" | "type" | "press_key" | "scroll" | "navigate";
        completed: boolean;
        url?: undefined;
        matched?: undefined;
        condition?: undefined;
    }>;
}
export {};
