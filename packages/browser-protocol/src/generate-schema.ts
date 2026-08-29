import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ProtocolSchemaDocument } from "./schema.js";

const here = dirname(fileURLToPath(import.meta.url));
const output = resolve(here, "../schema/browser-protocol.schema.json");
const rendered = `${JSON.stringify(ProtocolSchemaDocument, null, 2)}\n`;
if (process.argv.includes("--check")) {
  const existing = await readFile(output, "utf8");
  if (existing !== rendered) throw new Error("browser protocol schema is stale; run pnpm schema:generate");
} else {
  await writeFile(output, rendered, { mode: 0o644 });
}
