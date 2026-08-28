import process from "node:process";
import { ProxyBoundBrowserDestinationAuthority } from "./destination-authority.js";
import { WebxdRuntime, sameUserPiActorAuthenticator } from "./runtime.js";

const runtimeDirectory = process.env.XDG_RUNTIME_DIR;
if (runtimeDirectory === undefined) throw new Error("XDG_RUNTIME_DIR is required for the same-user WebX runtime");

const cacheHome = process.env.XDG_CACHE_HOME ?? `${process.env.HOME ?? process.cwd()}/.cache`;
const proxyUrl = process.env.WEBX_EGRESS_PROXY;
const destinationAuthority = proxyUrl === undefined ? undefined : proxyDestinationAuthority(proxyUrl);

const runtime = new WebxdRuntime({
  socketPath: process.env.WEBXD_SOCKET ?? `${runtimeDirectory}/pi-web/webxd.sock`,
  browserSocketPath: process.env.BROWSERD_SOCKET ?? `${runtimeDirectory}/pi-web/browserd.sock`,
  cwd: process.cwd(),
  searxUrl: process.env.WEBX_SEARX_URL ?? "http://127.0.0.1:8888",
  readerUrl: process.env.WEBX_READER_URL ?? "http://127.0.0.1:8787",
  crawlUrl: process.env.WEBX_CRAWL_URL ?? "http://127.0.0.1:8793",
  cacheDirectory: process.env.WEBX_CACHE_DIR ?? `${cacheHome}/pi-web/responses`,
  contentDirectory: process.env.WEBX_CONTENT_DIR ?? `${cacheHome}/pi-web/content`,
  authenticateActor: sameUserPiActorAuthenticator,
  browserDestinationAuthority: destinationAuthority,
});

function proxyDestinationAuthority(raw: string): ProxyBoundBrowserDestinationAuthority {
  const parsed = new URL(raw);
  if (parsed.protocol !== "http:" || parsed.username !== "" || parsed.password !== "" || parsed.pathname !== "/" || parsed.search !== "" || parsed.hash !== "") {
    throw new Error("WEBX_EGRESS_PROXY must be a plain loopback HTTP proxy URL");
  }
  return new ProxyBoundBrowserDestinationAuthority(parsed.hostname, parsed.port === "" ? 80 : Number(parsed.port));
}

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
