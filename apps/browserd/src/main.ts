import { BrowserdServer } from "./server.js";

const egressProxy = parseEgressProxy(process.env.BROWSERD_EGRESS_PROXY);
const screenshotObservationTtlMs = parseObservationTtl(process.env.BROWSERD_SCREENSHOT_OBSERVATION_TTL_MS, "BROWSERD_SCREENSHOT_OBSERVATION_TTL_MS", 60_000);
const domObservationTtlMs = parseObservationTtl(process.env.BROWSERD_DOM_OBSERVATION_TTL_MS, "BROWSERD_DOM_OBSERVATION_TTL_MS", 60_000);
const server = new BrowserdServer({ screenshotObservationTtlMs, domObservationTtlMs, ...(egressProxy === undefined ? {} : { chrome: { egressProxy } }) });
await server.start();

let stopping = false;
const stop = async (): Promise<void> => {
  if (stopping) return;
  stopping = true;
  await server.stop();
};
process.once("SIGINT", () => { void stop().finally(() => process.exit(0)); });
process.once("SIGTERM", () => { void stop().finally(() => process.exit(0)); });

function parseObservationTtl(value: string | undefined, name: string, fallback: number): number {
  if (value === undefined) return fallback;
  if (!/^[1-9][0-9]*$/u.test(value)) throw new Error(`${name} must be an integer from 10000 to 120000`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 10_000 || parsed > 120_000) throw new Error(`${name} must be an integer from 10000 to 120000`);
  return parsed;
}

function parseEgressProxy(value: string | undefined): { host: "127.0.0.1" | "::1"; port: number } | undefined {
  if (value === undefined) return undefined;
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw new Error("BROWSERD_EGRESS_PROXY must be a plain loopback HTTP proxy URL"); }
  if (parsed.protocol !== "http:" || (parsed.hostname !== "127.0.0.1" && parsed.hostname !== "[::1]") || parsed.username !== "" || parsed.password !== "" || parsed.pathname !== "/" || parsed.search !== "" || parsed.hash !== "") throw new Error("BROWSERD_EGRESS_PROXY must be a plain loopback HTTP proxy URL");
  const port = parsed.port === "" ? 80 : Number(parsed.port);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("BROWSERD_EGRESS_PROXY port is invalid");
  return { host: parsed.hostname === "[::1]" ? "::1" : "127.0.0.1", port };
}
