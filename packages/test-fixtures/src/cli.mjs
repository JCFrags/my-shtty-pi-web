import process from "node:process";
import { createFixtureOrigin } from "./server.mjs";

const fixture = createFixtureOrigin({
  host: process.env.WEBX_FIXTURE_HOST ?? "127.0.0.1",
  port: Number(process.env.WEBX_FIXTURE_PORT ?? "0"),
});

const address = await fixture.start();
process.stdout.write(`${JSON.stringify({ ...address, fixtureVersion: fixture.manifest.fixtureVersion })}\n`);

let stopping = false;
async function stop(signal) {
  if (stopping) return;
  stopping = true;
  await fixture.stop();
  process.stderr.write(`fixture origin stopped: ${signal}\n`);
}

process.once("SIGINT", () => void stop("SIGINT"));
process.once("SIGTERM", () => void stop("SIGTERM"));
