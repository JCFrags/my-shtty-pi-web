// Change this versioned file name when the vendored facade changes so /reload imports new bytes.
import { WebxFacadeClient } from "../vendor/sdk/facade-structured-v2.js";
export const SUPPORTED_API_MAJOR = 1;
export function createSdkClient() {
    const runtimeDirectory = process.env.XDG_RUNTIME_DIR;
    if (runtimeDirectory === undefined || runtimeDirectory.length === 0) {
        throw new Error("XDG_RUNTIME_DIR is required for the same-user WebX runtime.");
    }
    return new WebxFacadeClient(process.env.WEBXD_SOCKET ?? `${runtimeDirectory}/pi-web/webxd.sock`);
}
export function apiMajor(version) {
    const match = /^(\d+)\./.exec(version);
    if (!match?.[1])
        return undefined;
    const major = Number.parseInt(match[1], 10);
    return Number.isSafeInteger(major) ? major : undefined;
}
