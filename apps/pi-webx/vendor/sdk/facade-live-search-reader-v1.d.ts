import type { BrowserVisualFrame } from "./types.js";
export declare const FACADE_OPERATION_INVENTORY: {
    readonly "web.search": "search";
    readonly "web.read": "read";
    readonly "web.research": "research";
    readonly "library.search": "searchPages";
    readonly "library.get": "getPage";
    readonly "library.forget": "forgetPage";
    readonly "artifact.read": "getArtifactExcerpt";
    readonly "browser.open": "createBrowserSession";
    readonly "browser.tabs": "list/closeBrowserTab/closeBrowserSession; discard and restore unavailable";
    readonly "browser.observe": "observeBrowser plus getBrowserVisualFrame for visual binding";
    readonly "browser.act": "actBrowser with semantic or bound visual actions";
    readonly "browser.debug": "debugBrowser; secret-bearing operations refused";
    readonly "browser.workspace": "manageBrowserWorkspace";
};
export interface FacadeRequestOptions {
    readonly signal: AbortSignal;
    readonly idempotencyKey: string;
    readonly ownerId: string;
    readonly cwd: string;
}
export interface FacadeResult {
    readonly title?: string;
    readonly url?: string;
    readonly summary: string;
    readonly data?: unknown;
    readonly artifacts?: readonly {
        readonly id: string;
        readonly kind?: string;
    }[];
    readonly artifactPayload?: {
        readonly artifactId: string;
        readonly mediaType: string;
        readonly dataBase64: string;
        readonly size: number;
        readonly complete: boolean;
        readonly mode: "image" | "raw";
        readonly offset?: number;
        readonly nextOffset?: number | null;
        readonly eof?: boolean;
    };
    readonly trust?: "untrusted-external" | "local";
}
export interface FacadeCapabilities {
    readonly apiVersion: string;
    readonly daemon: "ready" | "unavailable";
    readonly groups: {
        readonly web: boolean;
        readonly browser: boolean;
        readonly browserDebug: boolean;
        readonly artifacts: boolean;
    };
    readonly browserPathIds: readonly [string, string];
}
/** SDK adapter for the singular Pi facade operation names. */
export declare class WebxFacadeClient {
    #private;
    private readonly socketPath;
    constructor(socketPath: string);
    start(options: {
        signal: AbortSignal;
        ownerId: string;
        cwd: string;
    }): Promise<void>;
    capabilities(options: {
        signal: AbortSignal;
        ownerId: string;
    }): Promise<FacadeCapabilities>;
    request(operation: string, input: unknown, options: FacadeRequestOptions): Promise<FacadeResult>;
    decideApproval(): Promise<FacadeResult>;
    stop(options: {
        ownerId: string;
    }): Promise<void>;
    /** Import one visual binding only for deterministic cross-owner refusal tests. */
    importObservationBindingForTest(observationId: string, ownerId: string, sessionId: string, frame: BrowserVisualFrame): void;
    private client;
    private artifact;
    private browserTabs;
    private observe;
    private browserAction;
    private resolveGuard;
    private workspace;
}
