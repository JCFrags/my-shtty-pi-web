import { createHash, randomBytes } from "node:crypto";
import { chmod, link, lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, normalize, resolve, sep } from "node:path";
import type { BoundedContent, ReadSaveOptions, SavedReadResponse } from "./types.js";

export function defaultExportRoot(): string {
  const dataHome = process.env.XDG_DATA_HOME?.trim();
  return resolve(dataHome && isAbsolute(dataHome) ? dataHome : join(homedir(), ".local", "share"), "pi-web", "exports");
}

export function renderSavedMarkdown(content: BoundedContent, requestedUrl: string, retrievedAt = new Date()): string {
  const frontMatter = [
    "---",
    `title: ${yamlString(content.title)}`,
    `source_url: ${yamlString(content.url || requestedUrl)}`,
    `retrieved_at: ${yamlString(retrievedAt.toISOString())}`,
    `complete: ${content.truncated ? "false" : "true"}`,
    "---",
    "",
    "",
  ].join("\n");
  return `${frontMatter}${content.untrustedContent.replace(/^\uFEFF/u, "")}${content.untrustedContent.endsWith("\n") ? "" : "\n"}`;
}

export async function saveReadMarkdown(
  content: BoundedContent,
  requestedUrl: string,
  save: ReadSaveOptions,
  exportRoot = defaultExportRoot(),
  retrievedAt = new Date(),
): Promise<SavedReadResponse> {
  const relativePath = validateRelativeMarkdownPath(save.path);
  const root = resolve(exportRoot);
  await ensureOwnedDirectory(root, true);
  const destination = join(root, relativePath);
  const parent = dirname(destination);
  await ensureDescendantDirectories(root, parent);
  await rejectSymbolicLink(destination, true);

  const markdown = renderSavedMarkdown(content, requestedUrl, retrievedAt);
  const bytes = Buffer.from(markdown, "utf8");
  const temporary = join(parent, `.${relativePath.split(sep).at(-1)}.webx-${process.pid}-${randomBytes(8).toString("hex")}.tmp`);
  let temporaryExists = false;
  try {
    const handle = await open(temporary, "wx", 0o600);
    temporaryExists = true;
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await chmod(temporary, 0o600);
    await rejectDescendantSymlinks(root, parent);
    if (save.overwrite === true) {
      await rejectSymbolicLink(destination, true);
      await rename(temporary, destination);
      temporaryExists = false;
    } else {
      try {
        await link(temporary, destination);
      } catch (error) {
        if (errorCode(error) === "EEXIST") throw new Error(`Markdown destination already exists: ${relativePath}. Set overwrite=true only when replacement is intended.`, { cause: error });
        if (errorCode(error) === "EPERM" || errorCode(error) === "EOPNOTSUPP" || errorCode(error) === "ENOTSUP") throw new Error("The WebX export filesystem does not support safe no-overwrite publication.", { cause: error });
        throw error;
      }
      await unlink(temporary);
      temporaryExists = false;
    }
    await syncDirectory(parent);
  } finally {
    if (temporaryExists) await unlink(temporary).catch(() => undefined);
  }

  return {
    saved: true,
    path: destination,
    relativePath,
    bytes: bytes.byteLength,
    characters: markdown.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    complete: !content.truncated,
    source: { requestedUrl, finalUrl: content.url || requestedUrl, title: content.title },
  };
}

export function validateRelativeMarkdownPath(value: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 4096 || value.includes("\0") || value.includes("\\")) throw new TypeError("save.path must be a non-empty relative Markdown path");
  if (isAbsolute(value) || normalize(value) !== value) throw new TypeError("save.path must be a normalized relative path below the WebX export directory");
  const segments = value.split(sep);
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) throw new TypeError("save.path contains an invalid path segment");
  if (!value.toLowerCase().endsWith(".md")) throw new TypeError("save.path must end in .md");
  return value;
}

function yamlString(value: string): string {
  const cleaned = Array.from(value).filter((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code === 9 || code === 10 || code === 13 || (code >= 32 && code !== 127);
  }).join("");
  return JSON.stringify(cleaned);
}

async function ensureOwnedDirectory(path: string, createParents: boolean): Promise<void> {
  let stat;
  try {
    stat = await lstat(path);
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
    await mkdir(path, { recursive: createParents, mode: 0o700 });
    stat = await lstat(path);
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("WebX export path contains a symbolic link or non-directory component");
  await chmod(path, 0o700);
}

async function ensureDescendantDirectories(root: string, parent: string): Promise<void> {
  const relative = parent.slice(root.length).replace(/^\/+/, "");
  let current = root;
  for (const segment of relative ? relative.split(sep) : []) {
    current = join(current, segment);
    await ensureOwnedDirectory(current, false);
  }
}

async function rejectDescendantSymlinks(root: string, parent: string): Promise<void> {
  await rejectSymbolicLink(root, false);
  const relative = parent.slice(root.length).replace(/^\/+/, "");
  let current = root;
  for (const segment of relative ? relative.split(sep) : []) {
    current = join(current, segment);
    await rejectSymbolicLink(current, false);
  }
}

async function rejectSymbolicLink(path: string, missingAllowed: boolean): Promise<void> {
  try {
    const stat = await lstat(path);
    if (stat.isSymbolicLink()) throw new Error("WebX export path contains a symbolic link");
  } catch (error) {
    if (missingAllowed && errorCode(error) === "ENOENT") return;
    throw error;
  }
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error ? String((error as { code?: unknown }).code) : undefined;
}
