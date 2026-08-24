import { type ArtifactExcerpt, type BoundedContent, type BrowserAction, type BrowserControlResult, type BrowserDebugRequest, type BrowserDebugResult, type BrowserObservation, type BrowserOperationResult, type BrowserSession, type BrowserSessionRequest, type BrowserSessionList, type BrowserVisualFrame, type BrowserWorkspaceRequest, type BrowserWorkspaceResult, type CapabilityCatalog, type ReadRequest, type RequestOptions, type ResearchRequest, type ResearchResponse, type SearchRequest, type SearchResponse, type VersionInfo, type WebxTransport } from "./types.js";
export interface WebxClientOptions {
    readonly maxResponseBytes?: number;
}
export declare class WebxClient {
    #private;
    private readonly transport;
    constructor(transport: WebxTransport, options?: WebxClientOptions);
    bind(ownerId: string, signal?: AbortSignal): Promise<void>;
    version(signal?: AbortSignal): Promise<VersionInfo>;
    negotiate(signal?: AbortSignal): Promise<VersionInfo>;
    capabilities(options?: RequestOptions): Promise<CapabilityCatalog>;
    search(request: SearchRequest, options: RequestOptions): Promise<SearchResponse>;
    read(request: ReadRequest, options: RequestOptions): Promise<BoundedContent>;
    research(request: ResearchRequest, options: RequestOptions): Promise<ResearchResponse>;
    getArtifactExcerpt(artifactId: string, offset?: number, maxBytes?: number, options?: RequestOptions): Promise<ArtifactExcerpt>;
    createBrowserSession(request: BrowserSessionRequest, options: RequestOptions): Promise<BrowserSession>;
    listBrowserSessions(options?: RequestOptions): Promise<BrowserSessionList>;
    manageBrowserWorkspace(request: BrowserWorkspaceRequest, options: RequestOptions): Promise<BrowserWorkspaceResult>;
    closeBrowserTab(sessionId: string, tabId: string, options: RequestOptions): Promise<void>;
    getBrowserSession(sessionId: string, options?: RequestOptions): Promise<BrowserSession>;
    observeBrowser(sessionId: string, view: "main" | "interactive" | "visual" | "full" | "diff", maxChars: number, options: RequestOptions): Promise<BrowserObservation>;
    getBrowserVisualFrame(sessionId: string, options: RequestOptions): Promise<BrowserVisualFrame>;
    actBrowser(sessionId: string, action: BrowserAction, options: RequestOptions): Promise<BrowserOperationResult>;
    debugBrowser(sessionId: string, request: BrowserDebugRequest, options: RequestOptions): Promise<BrowserDebugResult>;
    setBrowserControl(sessionId: string, controller: "human" | "agent", options: RequestOptions): Promise<BrowserControlResult>;
    cancelBrowserOperation(operationId: string, options: RequestOptions): Promise<BrowserOperationResult>;
    closeBrowserSession(sessionId: string, options: RequestOptions): Promise<void>;
    private call;
}
