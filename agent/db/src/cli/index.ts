import { randomUUID } from "node:crypto";
import { loadSchema } from "./config";
import { serializeSchema, emptySnapshot } from "./serializer";
import { diffSnapshots } from "./differ";
import { generate, readJournal, getLastSnapshot, getSnapshotAtIndex } from "./generator";
import { runDb } from "./db";

function printUsage() {
  console.log(`
Usage: kyju <command> [options]

Commands:
  generate    Generate a migration from schema changes
  db          Inspect and operate on a database

Options:
  --config <path>   Path to kyju config file (default: auto-detect)
  --name <tag>      Custom migration name
  --custom          Generate migration with editable migrate() function
  --amend           Replace the last migration instead of creating a new one
  --help            Show this help message
`);
}

function parseArgs(argv: string[]): {
  command: string | null;
  config?: string;
  name?: string;
  custom: boolean;
  amend: boolean;
  help: boolean;
} {
  const result = { command: null as string | null, config: undefined as string | undefined, name: undefined as string | undefined, custom: false, amend: false, help: false };

  let i = 0;
  while (i < argv.length) {
    const arg = argv[i]!;
    if (arg === "--help" || arg === "-h") {
      result.help = true;
    } else if (arg === "--config") {
      result.config = argv[++i];
    } else if (arg === "--name") {
      result.name = argv[++i];
    } else if (arg === "--custom") {
      result.custom = true;
    } else if (arg === "--amend") {
      result.amend = true;
    } else if (!arg.startsWith("-") && !result.command) {
      result.command = arg;
    }
    i++;
  }

  return result;
}

/**
 * Programmatic entry for the migration generator. Takes already-resolved
 * absolute paths so callers (including `zen db generate`) can drive the
 * generator without going through a `db.config.ts` file. The plugin manifest
 * (`schema` + `migrations`) is the canonical source of these paths.
 */
export async function generateMigration(opts: {
  schemaPath: string;
  outPath: string;
  alias?: string;
  name?: string;
  custom?: boolean;
  amend?: boolean;
}): Promise<void> {
  const { schemaPath, outPath } = opts;
  const amend = !!opts.amend;
  const custom = !!opts.custom;

  console.log(`Schema: ${schemaPath}`);
  console.log(`Output: ${outPath}`);

  const schema = await loadSchema(schemaPath);
  const journal = readJournal(outPath);

  let prevSnapshot;
  if (amend && journal.entries.length >= 2) {
    prevSnapshot =
      getSnapshotAtIndex(outPath, journal, journal.entries.length - 2) ??
      emptySnapshot;
  } else if (amend) {
    prevSnapshot = emptySnapshot;
  } else {
    prevSnapshot = getLastSnapshot(outPath, journal) ?? emptySnapshot;
  }

  const currentSnapshot = serializeSchema(
    schema,
    randomUUID(),
    prevSnapshot.id,
  );

  const ops = diffSnapshots(prevSnapshot, currentSnapshot);

  if (ops.length === 0 && !amend) {
    console.log("\nNo schema changes detected.");
    return;
  }

  console.log(`\nDetected ${ops.length} change(s):`);
  for (const op of ops) {
    if (op.op === "add") {
      console.log(`  + ${op.key} (${op.kind})`);
    } else if (op.op === "remove") {
      console.log(`  - ${op.key} (${op.kind})`);
    } else if (op.op === "alter") {
      console.log(`  ~ ${op.key} (altered)`);
    }
  }

  const hasAlter = ops.some((o) => o.op === "alter");
  if (hasAlter) {
    console.log(
      "\n⚠ Field type changes detected. Generating custom migration skeleton.",
    );
  }

  const result = generate({
    outPath,
    snapshot: currentSnapshot,
    ops,
    name: opts.name,
    custom,
    amend,
    alias: opts.alias,
  });

  console.log(`\n${amend ? "Amended" : "Generated"}:`);
  console.log(`  Migration: ${result.migrationPath}`);
  console.log(`  Snapshot:  ${result.snapshotPath}`);
}

export async function run(argv: string[]): Promise<void> {
  if (argv[0] === "db") {
    runDb(argv.slice(1));
    return;
  }

  const args = parseArgs(argv);

  if (args.help || !args.command) {
    printUsage();
    process.exit(args.help ? 0 : 1);
  }

  if (args.command === "generate") {
    // The legacy CLI entry kept for direct `kyju generate --config <db.config.ts>`
    // invocations. `zen db generate` no longer uses this path; it resolves
    // schema + migrations from the nearest `zenbu.plugin.json` and calls
    // `generateMigration` directly.
    const { findConfigFile, loadConfig } = await import("./config");
    const configPath = args.config ?? findConfigFile(process.cwd());
    const resolved = await loadConfig(configPath);
    await generateMigration({
      schemaPath: resolved.schemaPath,
      outPath: resolved.outPath,
      alias: resolved.alias,
      name: args.name,
      custom: args.custom,
      amend: args.amend,
    });
  } else {
    console.error(`Unknown command: ${args.command}`);
    printUsage();
    process.exit(1);
  }
}

// Auto-run when invoked as the entry point (bun packages/kyju/src/cli/index.ts).
// Safe to import; nothing runs on import.
// Bun populates import.meta.main; Node 22+ supports it too.
if ((import.meta as any).main) {
  run(process.argv.slice(2)).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
