import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
export declare function observationResult(value: Record<string, unknown>): {
    content: ({
        type: "text";
        text: string;
    } | {
        type: "image";
        data: string;
        mimeType: string;
    })[];
    details: {
        [x: string]: unknown;
    };
};
export default function terminalBrowserExtension(pi: ExtensionAPI): Promise<void>;
