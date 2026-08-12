import process from "node:process";
import { IsolatedQualificationDestinationAuthority } from "./destination-authority.js";
import { WebxdRuntime, sameUserPiActorAuthenticator } from "./runtime.js";

const qualificationRoot = process.env.PI_WEB_QUALIFICATION_ROOT;
const runtimeDirectory = process.env.XDG_RUNTIME_DIR;
if (
  qualificationRoot === undefined ||
  runtimeDirectory === undefined ||
  process.env.PI_WEB_QUALIFICATION_DESTINATION_AUTHORITY !== "isolated-loopback-fixtures-v1" ||
  !qualificationRoot.startsWith("/tmp/pi-web-complete-actual.") ||
  runtimeDirectory !== `${qualificationRoot}/runtime` ||
  process.env.HOME !== `${qualificationRoot}/home` ||
  process.env.XDG_CONFIG_HOME !== `${qualificationRoot}/config` ||
  process.env.XDG_DATA_HOME !== `${qualificationRoot}/data` ||
  process.env.XDG_CACHE_HOME !== `${qualificationRoot}/cache`
) {
  throw new Error("isolated qualification destination authority requires the exact temporary runtime layout");
}

const runtime = new WebxdRuntime({
  socketPath: process.env.WEBXD_SOCKET ?? `${runtimeDirectory}/pi-web/webxd.sock`,
  browserSocketPath: process.env.BROWSERD_SOCKET ?? `${runtimeDirectory}/pi-web/browserd.sock`,
  cwd: process.cwd(),
  authenticateActor: sameUserPiActorAuthenticator,
  browserDestinationAuthority: new IsolatedQualificationDestinationAuthority(),
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
