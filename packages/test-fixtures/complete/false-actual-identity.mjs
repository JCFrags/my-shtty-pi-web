#!/usr/bin/env node
import { createInterface } from "node:readline";

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of input) {
  const request = JSON.parse(line);
  if (request.type !== "handshake") continue;
  process.stdout.write(`${JSON.stringify({ id: request.id, result: {
    ok: true,
    protocol: "pi-web-qualification/1",
    product: {
      protocolMajor: 2,
      shippedEntrypoint: false,
      supportedPaths: ["agent-browser/chrome", "pinchtab/chrome"],
    },
  } })}\n`);
}
