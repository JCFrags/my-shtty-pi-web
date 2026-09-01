import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const vendorRoot = join(root, "packages/browser-runtime/src/vendor/agentcursor");
const attributionRoot = join(root, "packages/browser-runtime/third_party/agentcursor");
const expectedLicenseSha256 = "ef63ccb76b8e7ec24f9e0bb175fa21ee7de3ac99c11562e062856f274c963360";
const expectedVendorSha256 = "b37f058d396229cdcc5027a2eba9eb4b4679c1d8b197ce7fbd413073609c47f9";
const approvedProductionLicenses = new Set(["MIT", "Apache-2.0 OR MIT"]);

let licenseReportText = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) licenseReportText += chunk;
assert.notEqual(licenseReportText.trim(), "", "pnpm production license report is empty");
const licenseReport = JSON.parse(licenseReportText);
for (const [license, packages] of Object.entries(licenseReport)) {
  assert(approvedProductionLicenses.has(license), `unreviewed production dependency license: ${license}`);
  assert(Array.isArray(packages) && packages.length > 0, `license group ${license} has no packages`);
  for (const dependency of packages) {
    assert.equal(typeof dependency.name, "string", `dependency under ${license} has no name`);
    assert(Array.isArray(dependency.versions) && dependency.versions.length > 0, `${dependency.name} has no resolved version`);
  }
}

const licensePath = join(attributionRoot, "LICENSE");
assert.equal((await lstat(licensePath)).isFile(), true, "AgentCursor license must be a regular file");
const licenseSha256 = createHash("sha256").update(await readFile(licensePath)).digest("hex");
assert.equal(licenseSha256, expectedLicenseSha256, "AgentCursor license digest changed without review");

/** @type {string[]} */
const pendingDirectories = [vendorRoot];
/** @type {string[]} */
const vendorFiles = [];
while (pendingDirectories.length > 0) {
  const directory = pendingDirectories.pop();
  if (directory === undefined) throw new Error("vendored source traversal lost its directory");
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) pendingDirectories.push(path);
    else if (entry.isFile()) vendorFiles.push(path);
    else throw new Error(`unsupported vendored source entry: ${relative(root, path)}`);
  }
}
const vendorHash = createHash("sha256");
for (const path of vendorFiles.sort()) {
  assert.equal((await lstat(path)).isFile(), true, `vendored source is not a regular file: ${relative(root, path)}`);
  vendorHash.update(relative(vendorRoot, path).replaceAll("\\", "/"));
  vendorHash.update("\0");
  vendorHash.update(await readFile(path));
  vendorHash.update("\0");
}
const vendoredSourceSha256 = vendorHash.digest("hex");

const upstream = await readFile(join(attributionRoot, "UPSTREAM.md"), "utf8");
assert.match(upstream, /Repository: https:\/\/github\.com\/kumard3\/agentcursor/);
assert.match(upstream, /Commit: `b23c633c66fd240f836f5edd1034f6fcf678e237`/);
assert.match(upstream, /Version: `0\.3\.0`/);
assert.match(upstream, new RegExp(`Vendored source SHA-256: \`${expectedVendorSha256}\``));
assert.equal(vendoredSourceSha256, expectedVendorSha256, "AgentCursor vendored source digest changed without provenance review");

process.stdout.write(JSON.stringify({
  ok: true,
  productionLicenseGroups: Object.keys(licenseReport).sort(),
  agentCursorLicenseSha256: licenseSha256,
  agentCursorVendoredSourceSha256: vendoredSourceSha256,
}) + "\n");
