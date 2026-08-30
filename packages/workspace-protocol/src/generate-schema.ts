import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { WorkspaceProtocolSchemaDocument } from "./schema.js";

const here = dirname(fileURLToPath(import.meta.url));
const output = resolve(here, "../schema/workspace-protocol.schema.json");
const rendered = `${JSON.stringify(WorkspaceProtocolSchemaDocument, null, 2)}\n`;
if (process.argv.includes("--check")) {
  if (await readFile(output, "utf8") !== rendered) throw new Error("workspace protocol schema is stale; run pnpm schema:generate");
} else await writeFile(output, rendered, { mode: 0o644 });
