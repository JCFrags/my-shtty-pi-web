import { defineConfig } from "tsdown";

export default defineConfig({
  entry: {
    main: "src/main.tsx",
  },
  format: "esm",
  platform: "node",
  target: "node20",
  dts: false,
  clean: true,
  outDir: "dist",
  outExtensions: () => ({ js: ".mjs" }),
});
