import path from "node:path";
import fs from "node:fs";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import type { Schema } from "../v2/db/schema";

export type KyjuConfig = {
  schema: string;
  out?: string;
  /** Import alias for the kyju package (e.g. "#zenbu/kyju"). When set, generated
   *  migrations use `import type { KyjuMigration } from "<alias>"` instead of
   *  inlining the type definitions. */
  alias?: string;
};

export function defineConfig(config: KyjuConfig): KyjuConfig {
  return config;
}

export type ResolvedConfig = {
  schemaPath: string;
  outPath: string;
  alias?: string;
};

const localRequire = createRequire(import.meta.url);

const CONFIG_NAMES = ["db.config.ts", "db.config.js", "db.config.mjs"];

export function findConfigFile(cwd: string): string {
  for (const name of CONFIG_NAMES) {
    const p = path.join(cwd, name);
    if (fs.existsSync(p)) return p;
  }
  throw new Error(
    `No db config found. Expected one of: ${CONFIG_NAMES.join(", ")}`,
  );
}

export async function loadConfig(configPath: string): Promise<ResolvedConfig> {
  const dir = path.dirname(path.resolve(configPath));

  const mod = await loadModule(path.resolve(configPath));
  const config: KyjuConfig = mod.default ?? mod;

  if (!config.schema) {
    throw new Error("db config must specify a 'schema' path");
  }

  return {
    schemaPath: path.resolve(dir, config.schema),
    outPath: path.resolve(dir, config.out ?? "./db"),
    alias: config.alias,
  };
}

export async function loadSchema(schemaPath: string): Promise<Schema> {
  const mod = await loadModule(schemaPath);
  const schema = mod.schema ?? mod.default;

  if (!schema || !schema.shape) {
    throw new Error(
      `Schema file must export a 'schema' (via named export or default) created with createSchema(). Got: ${typeof schema}`,
    );
  }

  return schema;
}

/**
 * Load a user-authored TS/ESM module (config, schema, migrations entry).
 * Uses tsx's ESM loader (registered once, lazily) so the loaded module can
 * `import` from packages whose `exports` map only declares an ESM `import`
 * condition — like `@zenbujs/core/db`. The legacy CJS path was incompatible
 * with ESM-only deps because `require()` won't resolve `.mjs` files.
 */
export async function loadModule(modulePath: string): Promise<any> {
  await ensureTsxRegistered();
  const absPath = path.resolve(modulePath);
  return import(pathToFileURL(absPath).href);
}

let tsxRegistered: Promise<void> | null = null;

function ensureTsxRegistered(): Promise<void> {
  if (tsxRegistered) return tsxRegistered;
  tsxRegistered = (async () => {
    try {
      const tsxApi: any = localRequire("tsx/esm/api");
      if (typeof tsxApi.register === "function") tsxApi.register();
    } catch {
      // tsx not available — caller's TS files must already be transpiled.
    }
  })();
  return tsxRegistered;
}
