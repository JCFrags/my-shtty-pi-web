import { defineConfig } from "tsdown";

export default defineConfig({
  entry: {
    index: "src/v2/index.ts",
    effect: "src/v2/effect.ts",
    react: "src/v2/react/index.ts",
    schema: "src/v2/db/schema.ts",
    migrations: "src/v2/migrations.ts",
    config: "src/cli/config.ts",
    cli: "src/cli/index.ts",
    loader: "src/cli/loader.ts",
    transport: "src/v2/transport.ts",
    "cli-bin": "src/cli/bin.ts",
  },
  format: "esm",
  platform: "node",
  target: "node20",
  dts: { eager: true },
  clean: true,
  outDir: "dist",
  outExtensions: () => ({ js: ".mjs" }),
});
