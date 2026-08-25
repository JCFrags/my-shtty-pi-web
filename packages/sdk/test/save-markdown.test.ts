import { createHash } from "node:crypto";
import { lstat, mkdtemp, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { rm } from "node:fs/promises";
import { renderSavedMarkdown, saveReadMarkdown, validateRelativeMarkdownPath } from "../src/save-markdown.js";
import type { BoundedContent } from "../src/types.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

function content(overrides: Partial<BoundedContent> = {}): BoundedContent {
  return { title: "A \"quoted\" title\nnext", url: "https://example.test/page", untrustedContent: "# Body\n\nUseful text.", truncated: false, visibility: "public", ...overrides };
}

async function root(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), "webx-save-"));
  roots.push(value);
  return value;
}

describe("Markdown save", () => {
  it("renders deterministic safe front matter and preserves the body", () => {
    const markdown = renderSavedMarkdown(content(), "https://requested.test/", new Date("2026-08-25T12:34:56.000Z"));
    expect(markdown).toContain('title: "A \\"quoted\\" title\\nnext"');
    expect(markdown).toContain('source_url: "https://example.test/page"');
    expect(markdown).toContain('retrieved_at: "2026-08-25T12:34:56.000Z"');
    expect(markdown).toContain("complete: true\n---\n\n# Body\n\nUseful text.\n");
  });

  it("writes a private file and returns exact metadata", async () => {
    const exportRoot = await root();
    const result = await saveReadMarkdown(content(), "https://requested.test/", { path: "notes/page.md" }, exportRoot, new Date("2026-08-25T12:34:56.000Z"));
    const body = await readFile(result.path, "utf8");
    expect(result.relativePath).toBe("notes/page.md");
    expect(result.bytes).toBe(Buffer.byteLength(body));
    expect(result.characters).toBe(body.length);
    expect(result.sha256).toBe(createHash("sha256").update(body).digest("hex"));
    expect(result.complete).toBe(true);
    expect((await lstat(result.path)).mode & 0o777).toBe(0o600);
    expect((await lstat(join(exportRoot, "notes"))).mode & 0o777).toBe(0o700);
  });

  it("refuses replacement by default and atomically replaces when explicit", async () => {
    const exportRoot = await root();
    await saveReadMarkdown(content({ untrustedContent: "first" }), "https://example.test/", { path: "page.md" }, exportRoot);
    await expect(saveReadMarkdown(content({ untrustedContent: "second" }), "https://example.test/", { path: "page.md" }, exportRoot)).rejects.toThrow("already exists");
    expect(await readFile(join(exportRoot, "page.md"), "utf8")).toContain("first");
    await saveReadMarkdown(content({ untrustedContent: "second" }), "https://example.test/", { path: "page.md", overwrite: true }, exportRoot);
    expect(await readFile(join(exportRoot, "page.md"), "utf8")).toContain("second");
  });

  it("rejects traversal, absolute paths, non-Markdown files, and symbolic links", async () => {
    for (const path of ["../page.md", "/tmp/page.md", "a/../page.md", "page.txt", "a\\page.md", "./page.md"]) expect(() => validateRelativeMarkdownPath(path)).toThrow();
    const exportRoot = await root();
    const outside = await root();
    await mkdir(join(exportRoot, "safe"));
    await symlink(outside, join(exportRoot, "linked"));
    await expect(saveReadMarkdown(content(), "https://example.test/", { path: "linked/page.md" }, exportRoot)).rejects.toThrow("symbolic link");
    await writeFile(join(exportRoot, "target.md"), "old");
    await symlink(join(exportRoot, "target.md"), join(exportRoot, "alias.md"));
    await expect(saveReadMarkdown(content(), "https://example.test/", { path: "alias.md", overwrite: true }, exportRoot)).rejects.toThrow("symbolic link");
  });

  it("marks a bounded extraction as incomplete", async () => {
    const exportRoot = await root();
    const result = await saveReadMarkdown(content({ truncated: true }), "https://example.test/", { path: "partial.md" }, exportRoot);
    expect(result.complete).toBe(false);
    expect(await readFile(result.path, "utf8")).toContain("complete: false");
  });
});
