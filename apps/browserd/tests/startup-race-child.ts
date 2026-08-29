import { BrowserProtocolError } from "@webx/browser-protocol";
import { BrowserdServer } from "../src/server.js";

const runtimeDirectory = process.argv[2];
if (runtimeDirectory === undefined) throw new Error("runtime directory is required");
const server = new BrowserdServer({ runtimeDirectory });
let stopped = false;
const stop = async (): Promise<void> => {
  if (stopped) return;
  stopped = true;
  await server.stop();
};
try {
  const descriptor = await server.start();
  process.stdout.write(`${JSON.stringify({ state: "ready", descriptor })}\n`);
  process.once("SIGTERM", () => { void stop().finally(() => process.exit(0)); });
  process.once("SIGINT", () => { void stop().finally(() => process.exit(0)); });
  setInterval(() => undefined, 1_000).unref();
} catch (error) {
  const code = error instanceof BrowserProtocolError ? error.code : "INTERNAL_ERROR";
  process.stdout.write(`${JSON.stringify({ state: "failed", code })}\n`);
  await stop().catch(() => undefined);
  process.exitCode = 2;
}
