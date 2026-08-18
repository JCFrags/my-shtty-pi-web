import process from "node:process";
import { WebxdRuntime, sameUserPiActorAuthenticator } from "./runtime.js";

const runtimeDirectory = process.env.XDG_RUNTIME_DIR;
if (runtimeDirectory === undefined) throw new Error("XDG_RUNTIME_DIR is required for the same-user WebX runtime");

const runtime = new WebxdRuntime({
  socketPath: process.env.WEBXD_SOCKET ?? `${runtimeDirectory}/pi-web/webxd.sock`,
  browserSocketPath: process.env.BROWSERD_SOCKET ?? `${runtimeDirectory}/pi-web/browserd.sock`,
  cwd: process.cwd(),
  searxUrl: process.env.WEBX_SEARX_URL ?? "http://127.0.0.1:8888",
  readerUrl: process.env.WEBX_READER_URL ?? "http://127.0.0.1:8787",
  authenticateActor: sameUserPiActorAuthenticator,
});

let stopping = false;
const stop = () => {
  if (stopping) return;
  stopping = true;
  void runtime.stop().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
};

process.on("SIGINT", stop);
process.on("SIGTERM", stop);
await runtime.start();
