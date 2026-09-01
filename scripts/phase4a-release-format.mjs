// @ts-check

const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const GIT_SHA_PATTERN = /^[0-9a-f]{40}$/u;
const RELEASE_ID_PATTERN = /^phase4a-[0-9a-f]{40}$/u;

/** @param {string} message @returns {never} */
function fail(message) { throw new Error(message); }
/** @param {unknown} value @param {string} name */
function object(value, name) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail(`${name} must be an object`);
  return /** @type {Record<string, unknown>} */ (value);
}
/** @param {Record<string, unknown>} value @param {string[]} keys @param {string} name */
function exactKeys(value, keys, name) {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) fail(`${name} fields are invalid`);
}
/** @param {unknown} value @param {string} name */
function nonemptyString(value, name) {
  if (typeof value !== "string" || value.length === 0 || /[\0\r\n]/u.test(value)) fail(`${name} is invalid`);
  return value;
}
/** @param {unknown} value @param {string} name */
function sha256(value, name) {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) fail(`${name} is invalid`);
  return value;
}
/** @param {unknown} value @param {string} name */
function safeInteger(value, name) {
  if (!Number.isSafeInteger(value) || /** @type {number} */ (value) < 0) fail(`${name} is invalid`);
  return /** @type {number} */ (value);
}
/** @param {unknown} value @param {string} name */
function releasePath(value, name) {
  const path = nonemptyString(value, name);
  const parts = path.split("/");
  if (path.startsWith("/") || path.includes("\\") || parts.some((part) => part === "" || part === "." || part === "..")) fail(`${name} is unsafe`);
  return path;
}
/** @param {unknown} value @param {string} name */
function positiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || /** @type {number} */ (value) <= 0) fail(`${name} is invalid`);
  return /** @type {number} */ (value);
}

/**
 * Validate the complete closed Phase 4A release manifest.
 * @param {unknown} value
 */
export function validateReleaseManifest(value) {
  const manifest = object(value, "release manifest");
  exactKeys(manifest, ["schemaVersion", "releaseId", "gitSha", "dirtyTree", "buildTimestamp", "toolchain", "versions", "agentCursor", "packageLockSha256", "supportedFedora", "testedBrowser", "buildMode", "backendDefault", "packaging", "immutableFiles", "compatibility", "artifacts"], "release manifest");
  if (manifest.schemaVersion !== 1 || manifest.dirtyTree !== false || manifest.backendDefault !== "legacy" || manifest.buildMode !== "release") fail("release manifest identity is invalid");
  const releaseId = nonemptyString(manifest.releaseId, "release ID");
  const gitSha = nonemptyString(manifest.gitSha, "release Git SHA");
  if (!RELEASE_ID_PATTERN.test(releaseId) || !GIT_SHA_PATTERN.test(gitSha) || releaseId !== `phase4a-${gitSha}`) fail("release manifest identity is invalid");
  nonemptyString(manifest.buildTimestamp, "build timestamp");
  sha256(manifest.packageLockSha256, "package lock digest");
  nonemptyString(manifest.testedBrowser, "tested browser");
  if (JSON.stringify(manifest.supportedFedora) !== JSON.stringify([44])) fail("supported Fedora releases are invalid");

  const toolchain = object(manifest.toolchain, "release toolchain");
  exactKeys(toolchain, ["node", "pnpm", "rust", "tauriCli", "tauriLibrary"], "release toolchain");
  for (const [name, item] of Object.entries(toolchain)) nonemptyString(item, `toolchain ${name}`);

  const versions = object(manifest.versions, "release versions");
  exactKeys(versions, ["publicWebX", "publicBrowserContract", "browserPrivateProtocol", "workspacePrivateProtocol"], "release versions");
  for (const [name, item] of Object.entries(versions)) nonemptyString(item, `version ${name}`);

  const agentCursor = object(manifest.agentCursor, "AgentCursor identity");
  exactKeys(agentCursor, ["repository", "version", "commit", "vendoredSourceSha256"], "AgentCursor identity");
  if (agentCursor.repository !== "https://github.com/kumard3/agentcursor" || typeof agentCursor.commit !== "string" || !GIT_SHA_PATTERN.test(agentCursor.commit)) fail("AgentCursor identity is invalid");
  nonemptyString(agentCursor.version, "AgentCursor version");
  sha256(agentCursor.vendoredSourceSha256, "AgentCursor vendored-source digest");

  const packaging = object(manifest.packaging, "release packaging");
  exactKeys(packaging, ["node", "proxy", "tauri", "checksumAlgorithm", "checksumScopeExcludes"], "release packaging");
  for (const name of ["node", "proxy", "tauri"]) nonemptyString(packaging[name], `packaging ${name}`);
  if (packaging.checksumAlgorithm !== "sha256" || JSON.stringify(packaging.checksumScopeExcludes) !== JSON.stringify(["checksums.json"])) fail("release packaging checksum policy is invalid");

  const compatibility = object(manifest.compatibility, "release compatibility");
  exactKeys(compatibility, ["node", "rustBuild", "fedora", "webXApiMajor", "browserContractMajor", "browserPrivateProtocol", "workspacePrivateProtocol", "defaultBackend", "candidateBackend"], "release compatibility");
  const node = object(compatibility.node, "Node compatibility");
  exactKeys(node, ["minimumMajor", "maximumMajor"], "Node compatibility");
  if (positiveInteger(node.minimumMajor, "minimum Node major") > positiveInteger(node.maximumMajor, "maximum Node major")) fail("Node compatibility is invalid");
  if (JSON.stringify(compatibility.fedora) !== JSON.stringify([44]) || compatibility.defaultBackend !== "legacy" || compatibility.candidateBackend !== "agentcursor") fail("release backend compatibility is invalid");
  for (const name of ["rustBuild", "browserPrivateProtocol", "workspacePrivateProtocol"]) nonemptyString(compatibility[name], `compatibility ${name}`);
  positiveInteger(compatibility.webXApiMajor, "WebX API major");
  positiveInteger(compatibility.browserContractMajor, "browser contract major");

  const artifacts = object(manifest.artifacts, "release artifacts");
  exactKeys(artifacts, ["binary", "rpm"], "release artifacts");
  releasePath(artifacts.binary, "Tauri binary path");
  releasePath(artifacts.rpm, "Tauri RPM path");

  if (!Array.isArray(manifest.immutableFiles)) fail("release immutable-file inventory is invalid");
  const immutableFiles = manifest.immutableFiles.map((itemValue, index) => {
    const item = object(itemValue, `immutable file ${index}`);
    exactKeys(item, ["path", "sha256", "bytes"], `immutable file ${index}`);
    return { path: releasePath(item.path, `immutable file ${index} path`), sha256: sha256(item.sha256, `immutable file ${index} digest`), bytes: safeInteger(item.bytes, `immutable file ${index} bytes`) };
  });
  if (new Set(immutableFiles.map((item) => item.path)).size !== immutableFiles.length) fail("release immutable-file inventory contains duplicates");
  return Object.freeze(/** @type {Record<string, unknown> & {releaseId: string, gitSha: string, immutableFiles: Array<{path: string, sha256: string, bytes: number}>, artifacts: {binary: string, rpm: string}}} */ ({ ...manifest, releaseId, gitSha, immutableFiles, artifacts: { binary: /** @type {string} */ (artifacts.binary), rpm: /** @type {string} */ (artifacts.rpm) } }));
}

/**
 * Validate the complete closed Phase 4A checksum document.
 * @param {unknown} value
 */
export function validateReleaseChecksums(value) {
  const checksums = object(value, "release checksums");
  exactKeys(checksums, ["schemaVersion", "algorithm", "excludes", "files"], "release checksums");
  if (checksums.schemaVersion !== 1 || checksums.algorithm !== "sha256" || JSON.stringify(checksums.excludes) !== JSON.stringify(["checksums.json"]) || !Array.isArray(checksums.files)) fail("release checksum document is invalid");
  const files = checksums.files.map((itemValue, index) => {
    const item = object(itemValue, `checksum record ${index}`);
    exactKeys(item, ["path", "sha256", "bytes", "mode"], `checksum record ${index}`);
    const mode = safeInteger(item.mode, `checksum record ${index} mode`);
    if (mode !== 0o444 && mode !== 0o555) fail(`checksum record ${index} mode is invalid`);
    return { path: releasePath(item.path, `checksum record ${index} path`), sha256: sha256(item.sha256, `checksum record ${index} digest`), bytes: safeInteger(item.bytes, `checksum record ${index} bytes`), mode };
  });
  if (new Set(files.map((item) => item.path)).size !== files.length) fail("release checksum inventory contains duplicates");
  return Object.freeze({ schemaVersion: 1, algorithm: "sha256", excludes: ["checksums.json"], files });
}
