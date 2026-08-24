import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

const runtimeGlobals = Object.fromEntries(
  [
    "AbortController",
    "AbortSignal",
    "Buffer",
    "DOMException",
    "Event",
    "TextDecoder",
    "TextEncoder",
    "URL",
    "URLSearchParams",
    "WebSocket",
    "btoa",
    "clearInterval",
    "clearTimeout",
    "console",
    "fetch",
    "performance",
    "process",
    "setInterval",
    "setTimeout",
    "structuredClone",
  ].map((name) => [name, "readonly"]),
);

export default tseslint.config(
  {
    ignores: ["**/node_modules/**", "**/.venv/**", "**/dist/**", "**/coverage/**"],
  },
  eslint.configs.recommended,
  ...tseslint.configs.strict,
  {
    files: ["**/*.{js,mjs,ts}"],
    languageOptions: { globals: runtimeGlobals },
  },
  {
    files: ["components/browser/**/*.{mjs,js,ts,tsx}"],
    rules: {
      "@typescript-eslint/no-unused-expressions": "off",
      "@typescript-eslint/no-unused-vars": "off",
      "no-control-regex": "off",
      "no-empty": "off",
      "preserve-caught-error": "off",
    },
  },
  {
    files: ["apps/pi-webx/tests/**/*.ts"],
    rules: { "@typescript-eslint/no-unsafe-function-type": "off" },
  },
  {
    files: ["apps/webxd/src/browser-daemon-port.ts"],
    rules: { "prefer-const": "off" },
  },
  {
    files: ["components/browser/apps/workspace/src/main.tsx"],
    rules: { "@typescript-eslint/no-non-null-assertion": "off" },
  },
  {
    files: ["components/browser/fixtures/browser-extension/**/*.js"],
    languageOptions: {
      globals: { chrome: "readonly", document: "readonly", window: "readonly" },
    },
  },
  {
    files: ["**/*.d.ts"],
    rules: { "no-unused-private-class-members": "off" },
  },
  {
    files: ["packages/test-fixtures/test/*.mjs"],
    languageOptions: { globals: {} },
    rules: { "no-redeclare": "off" },
  },
);
