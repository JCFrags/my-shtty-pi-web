import type { IndexedSource } from "./ports.js";

export const PUBLIC_SOURCES: readonly IndexedSource[] = [
  {
    hitId: "hit-webx-001",
    ownerPrincipalId: "fixture-owner",
    title: "WebX deterministic public fixture",
    url: "https://fixture.invalid/webx",
    content: "WebX routes search, read, research, short-lived caching, and browser work through one local authority.",
    visibility: "public",
  },
  {
    hitId: "hit-browser-001",
    ownerPrincipalId: "fixture-owner",
    title: "Browser path fixture",
    url: "https://fixture.invalid/browser",
    content: "The required visual browser path is agent-browser/chrome. Optional adapters do not block startup.",
    visibility: "public",
  },
];
