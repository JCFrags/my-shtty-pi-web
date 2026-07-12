import { defineConfig } from "@pixel/db/config";

export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./migrations",
  alias: "@pixel/db",
});
