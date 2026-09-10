import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
export declare const DEFAULT_WEB_RESEARCH_EXTENSION: string;
/** Load Pi Web's research tools while retiring its previous browser provider. */
export declare function loadWebResearch(pi: ExtensionAPI, extensionPath?: string): Promise<boolean>;
