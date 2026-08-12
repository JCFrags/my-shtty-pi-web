import type { IndexedSource } from "./ports.js";

export const PUBLIC_SOURCES: readonly IndexedSource[] = [
  {
    hitId: "hit-webx-001",
    ownerPrincipalId: "fixture-owner",
    title: "WebX deterministic public fixture",
    url: "https://fixture.invalid/webx",
    content: "WebX routes search, read, research, page library, artifacts, and browser work through one local authority.",
    visibility: "public",
    pageId: "page-webx-001",
    artifactId: "artifact-webx-001",
  },
  {
    hitId: "hit-browser-001",
    ownerPrincipalId: "fixture-owner",
    title: "Browser path fixture",
    url: "https://fixture.invalid/browser",
    content: "The supported browser paths are agent-browser/chrome and pinchtab/chrome. There is no silent fallback.",
    visibility: "public",
    pageId: "page-browser-001",
    artifactId: "artifact-browser-001",
  },
];

export const PUBLIC_ARTIFACTS = PUBLIC_SOURCES.map((source) => ({
  artifactId: source.artifactId,
  ownerPrincipalId: source.ownerPrincipalId,
  mediaType: "text/markdown",
  sha256: source.artifactId === "artifact-webx-001" ? "b94bec401ece903a9a7dabf81c31504c5c17f7270c4659b5ad2393d72aac1e5e" : "a5aca7b00edb434d396460dfe3ae0f27ddb74b94761a15458bb661c4d235efac",
  content: source.content,
  visibility: source.visibility,
}));
