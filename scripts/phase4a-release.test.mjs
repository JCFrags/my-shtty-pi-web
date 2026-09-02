import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, chown, copyFile, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { releaseInternals } from "./phase4a-release.mjs";

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const gitSha = "a".repeat(40);

/** @param {string} releaseId @param {string} sha @param {Array<{path: string, sha256: string, bytes: number}>} immutableFiles */
function completeManifest(releaseId, sha, immutableFiles) {
  return {
    schemaVersion: 1, releaseId, gitSha: sha, dirtyTree: false, buildTimestamp: "2026-01-01T00:00:00Z",
    toolchain: { node: "24.0.0", pnpm: "10.13.1", rust: "rustc 1.88.0", tauriCli: "tauri-cli 2", tauriLibrary: "2.0.0" },
    versions: { publicWebX: "3.0.0", publicBrowserContract: "3.0.0", browserPrivateProtocol: "browser.v3", workspacePrivateProtocol: "workspace.v2" },
    agentCursor: { repository: "https://github.com/kumard3/agentcursor", version: "0.3.0", commit: "b".repeat(40), vendoredSourceSha256: "c".repeat(64) },
    packageLockSha256: "d".repeat(64), supportedFedora: [44], testedBrowser: "test fixture", buildMode: "release", backendDefault: "legacy",
    packaging: { node: "fixture", proxy: "fixture", tauri: "fixture", checksumAlgorithm: "sha256", checksumScopeExcludes: ["checksums.json"] },
    immutableFiles,
    compatibility: { node: { minimumMajor: 24, maximumMajor: 24 }, rustBuild: "1.88.0", fedora: [44], webXApiMajor: 3, browserContractMajor: 3, browserPrivateProtocol: "browser.v3", workspacePrivateProtocol: "workspace.v2", defaultBackend: "legacy", candidateBackend: "agentcursor" },
    artifacts: { binary: "bin/pi-browser-workspace", qualificationBinary: "bin/pi-browser-workspace-qualification", rpm: "share/artifacts/pi-browser-workspace.rpm" },
  };
}

/** @param {string} [forbiddenMarker] */
async function syntheticRelease(forbiddenMarker) {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "pi-web-release-test-"));
  const releaseRoot = join(temporaryRoot, `phase4a-${gitSha}`);
  await Promise.all([
    mkdir(join(releaseRoot, "bin"), { recursive: true }),
    mkdir(join(releaseRoot, "share/pi-webx"), { recursive: true }),
    mkdir(join(releaseRoot, "share/artifacts"), { recursive: true }),
    mkdir(join(releaseRoot, "share/icons"), { recursive: true }),
    mkdir(join(releaseRoot, "share/deploy/config"), { recursive: true }),
    mkdir(join(releaseRoot, "share/deploy/systemd"), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(join(releaseRoot, "bin/pi-web-browserd.mjs"), `${forbiddenMarker === undefined ? "" : `// ${forbiddenMarker}\n`}export {};\n`),
    writeFile(join(releaseRoot, "bin/pi-web-webxd.mjs"), "export {};\n"),
    writeFile(join(releaseRoot, "bin/pi-web-egress-proxy"), "#!/usr/bin/python3\npass\n"),
    writeFile(join(releaseRoot, "bin/pi-web-qualification-proxy"), "#!/usr/bin/python3\npass\n"),
    writeFile(join(releaseRoot, "bin/pi-web-qualification-atspi.py"), "#!/usr/bin/python3\npass\n"),
    writeFile(join(releaseRoot, "bin/pi-web-qualification-runner.mjs"), "const mode = process.argv.length === 3 ? 'soak-4h' : 'acceptance'; const seconds = 14400; const sessions = { kind: 'session.list' }; const tabs = { kind: 'tab.list', controlEpoch: 1 }; export { mode, seconds, sessions, tabs };\n"),
    writeFile(join(releaseRoot, "bin/pi-web-qualification-pi-worker.mjs"), "export {};\n"),
    writeFile(join(releaseRoot, "bin/pi-browser-workspace"), "workspace fixture\n"),
    writeFile(join(releaseRoot, "bin/pi-browser-workspace-qualification"), "workspace qualification fixture\n"),
    writeFile(join(releaseRoot, "share/artifacts/pi-browser-workspace.rpm"), "rpm fixture\n"),
    copyFile(join(sourceRoot, "scripts/pi-webctl.mjs"), join(releaseRoot, "bin/pi-webctl.mjs")),
    copyFile(join(sourceRoot, "scripts/phase4a-release-format.mjs"), join(releaseRoot, "bin/phase4a-release-format.mjs")),
    writeFile(join(releaseRoot, "share/pi-webx/extension.mjs"), "export default function extension() {}\n"),
    writeFile(join(releaseRoot, "share/icons/pi-web-workspace.png"), "png fixture\n"),
    copyFile(join(sourceRoot, "scripts/phase4a-config.mjs"), join(releaseRoot, "share/deploy/phase4a-config.mjs")),
    copyFile(join(sourceRoot, "deploy/phase4a/config/default.json"), join(releaseRoot, "share/deploy/config/default.json")),
    ...["pi-web-agentcursor-egress-proxy.service", "pi-web-agentcursor-browserd.service", "webxd.service", "pi-web-qualification-egress-proxy.service", "pi-web-qualification-browserd.service", "pi-web-qualification-webxd.service"].map(async (name) => await copyFile(join(sourceRoot, `deploy/phase4a/systemd/${name}.in`), join(releaseRoot, `share/deploy/systemd/${name}.in`))),
  ]);
  const immutableFiles = await releaseInternals.immutablePayloadDigests(releaseRoot);
  await writeFile(join(releaseRoot, "manifest.json"), `${JSON.stringify(completeManifest(`phase4a-${gitSha}`, gitSha, immutableFiles), null, 2)}\n`);
  await releaseInternals.setImmutableModes(releaseRoot);
  await releaseInternals.writeChecksums(releaseRoot);
  await chmod(join(releaseRoot, "checksums.json"), 0o444);
  await chmod(releaseRoot, 0o555);
  return { temporaryRoot, releaseRoot };
}

test("release CLI rejects unknown and duplicate options", () => {
  assert.throws(() => releaseInternals.parse(["build", "--output-root", "/tmp/out", "--bogus", "x"]), /unsupported build option/u);
  assert.throws(() => releaseInternals.parse(["verify", "--release-root", "/tmp/a", "--release-root", "/tmp/b"]), /duplicate release option/u);
});

test("publishing atomically renames and reseals an immutable release root", async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "pi-web-publish-test-"));
  const staged = join(temporaryRoot, "staged");
  const published = join(temporaryRoot, "published");
  try {
    await mkdir(staged);
    await chmod(staged, 0o555);
    await releaseInternals.publishImmutableRelease(staged, published);
    await assert.rejects(lstat(staged), /ENOENT/u);
    assert.equal((await lstat(published)).mode & 0o777, 0o555);
  } finally {
    await releaseInternals.removeOwnedTree(temporaryRoot);
  }
});

test("proxy packaging replaces an env shebang with the fixed Fedora interpreter", () => {
  assert.equal(
    releaseInternals.withFixedPythonInterpreter("#!/usr/bin/env python3\nprint('ok')\n"),
    "#!/usr/bin/python3\nprint('ok')\n",
  );
  assert.equal(releaseInternals.withFixedPythonInterpreter("print('ok')\n"), "#!/usr/bin/python3\nprint('ok')\n");
});

test("build identity refuses dirty, missing, and mismatched Git identities", () => {
  assert.throws(() => releaseInternals.validateBuildIdentity("bad", gitSha, ""), /forty lowercase/u);
  assert.throws(() => releaseInternals.validateBuildIdentity(gitSha, "b".repeat(40), ""), /does not match HEAD/u);
  assert.throws(() => releaseInternals.validateBuildIdentity(gitSha, gitSha, " M package.json"), /clean Git tree/u);
  releaseInternals.validateBuildIdentity(gitSha, gitSha, "");
});

test("both workspace binaries use the Tauri build context and only the primary build bundles", () => {
  assert.deepEqual(releaseInternals.tauriBuildArguments("tauri.mjs", "release.json", false), [
    "tauri.mjs", "build", "--config", "release.json", "--bundles", "rpm",
  ]);
  assert.deepEqual(releaseInternals.tauriBuildArguments("tauri.mjs", "release.json", true), [
    "tauri.mjs", "build", "--config", "release.json", "--features", "installed-qualification", "--no-bundle",
  ]);
});

test("output paths cannot enter the checkout lexically or through a symlink", async () => {
  assert.throws(() => releaseInternals.assertAbsoluteOutsideSource("relative", "output root"), /must be absolute/u);
  assert.throws(() => releaseInternals.assertAbsoluteOutsideSource(join(sourceRoot, "release"), "output root"), /outside the source checkout/u);
  const temporaryRoot = await mkdtemp(join(tmpdir(), "pi-web-release-link-test-"));
  try {
    const link = join(temporaryRoot, "checkout");
    await symlink(sourceRoot, link, "dir");
    await assert.rejects(releaseInternals.resolvedOutsideSource(join(link, "nested-output"), "output root"), /resolves into the source checkout/u);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("production Node bundles have a closed syntax-checked dependency and license set", async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "pi-web-bundle-test-"));
  try {
    await Promise.all([
      mkdir(join(temporaryRoot, "bin"), { recursive: true }),
      mkdir(join(temporaryRoot, "share/build"), { recursive: true }),
      mkdir(join(temporaryRoot, "share/licenses"), { recursive: true }),
      mkdir(join(temporaryRoot, "share/pi-webx"), { recursive: true }),
    ]);
    const metafiles = await releaseInternals.buildNodeBundles(temporaryRoot);
    const licenses = await releaseInternals.writeBundledLicenses(temporaryRoot, metafiles);
    assert.ok(licenses.length > 0, "bundled dependency licenses must not be empty");
    for (const relativePath of ["bin/pi-web-browserd.mjs", "bin/pi-web-webxd.mjs", "bin/pi-web-qualification-runner.mjs", "share/pi-webx/extension.mjs"]) {
      const path = join(temporaryRoot, relativePath);
      execFileSync(process.execPath, ["--check", path], { cwd: tmpdir(), stdio: "pipe" });
      assert.equal((await readFile(path)).includes(Buffer.from(sourceRoot)), false, `${relativePath} contains the source checkout path`);
    }
    releaseInternals.validateFixedQualificationRunner(await readFile(join(temporaryRoot, "bin/pi-web-qualification-runner.mjs"), "utf8"));
    const extension = await readFile(join(temporaryRoot, "share/pi-webx/extension.mjs"), "utf8");
    assert.match(extension, /from "@earendil-works\/pi-ai"/u);
    assert.match(extension, /from "@earendil-works\/pi-tui"/u);
    assert.match(extension, /from "typebox"/u);
  } finally {
    await releaseInternals.removeOwnedTree(temporaryRoot);
  }
});

test("fixed qualification runner verification requires immutable four-hour mode and exact tab authority", () => {
  const authority = "const sessions = { kind: 'session.list' }; const tabs = { kind: 'tab.list', controlEpoch: 1 };";
  releaseInternals.validateFixedQualificationRunner(`const mode = process.argv.length === 3 ? 'soak-4h' : 'acceptance'; const seconds = 14400; ${authority}`);
  assert.throws(() => releaseInternals.validateFixedQualificationRunner(`const mode = process.argv.length === 3 ? 'soak' : 'acceptance'; const seconds = 14400; ${authority}`), /fixed four-hour/u);
  assert.throws(() => releaseInternals.validateFixedQualificationRunner(`const mode = process.argv.length === 3 ? 'soak-4h' : 'acceptance'; const seconds = 14400; const option = '--duration'; ${authority}`), /arbitrary duration/u);
  assert.throws(() => releaseInternals.validateFixedQualificationRunner("const mode = process.argv.length === 3 ? 'soak-4h' : 'acceptance'; const seconds = 14400; const tabs = { kind: 'tab.list', controlEpoch: 1 };"), /exact tab-list authority/u);
  assert.throws(() => releaseInternals.validateFixedQualificationRunner("const mode = process.argv.length === 3 ? 'soak-4h' : 'acceptance'; const seconds = 14400; const sessions = { kind: 'session.list' }; const tabs = { kind: 'tab.list' };"), /exact tab-list authority/u);
});

test("detached verification accepts a complete immutable inventory and detects tampering", async () => {
  const { temporaryRoot, releaseRoot } = await syntheticRelease();
  try {
    const result = await releaseInternals.verifyRelease(releaseRoot, gitSha);
    assert.equal(result.manifest.gitSha, gitSha);
    await assert.rejects(releaseInternals.verifyRelease(releaseRoot, "b".repeat(40)), /expected Git SHA/u);
    assert.match(result.manifestSha256, /^[0-9a-f]{64}$/u);

    const browserd = join(releaseRoot, "bin/pi-web-browserd.mjs");
    await chmod(browserd, 0o755);
    await writeFile(browserd, "export const tampered = true;\n");
    await chmod(browserd, 0o555);
    await assert.rejects(releaseInternals.verifyRelease(releaseRoot, gitSha), /release checksum failed/u);
  } finally {
    await releaseInternals.removeOwnedTree(temporaryRoot);
  }
});

test("detached verification rejects non-primary release groups", async (context) => {
  const alternateGroup = process.getgroups?.().find((group) => group !== process.getgid?.());
  if (alternateGroup === undefined) { context.skip("no supplementary group is available"); return; }
  const { temporaryRoot, releaseRoot } = await syntheticRelease();
  try {
    await chown(join(releaseRoot, "bin/pi-web-browserd.mjs"), process.getuid?.() ?? -1, alternateGroup);
    await assert.rejects(releaseInternals.verifyRelease(releaseRoot, gitSha), /release file mode or ownership is invalid/u);
  } finally {
    await releaseInternals.removeOwnedTree(temporaryRoot);
  }
});

test("detached verification rejects mutable nested release directories", async () => {
  const { temporaryRoot, releaseRoot } = await syntheticRelease();
  try {
    await chmod(join(releaseRoot, "share/deploy"), 0o755);
    await assert.rejects(releaseInternals.verifyRelease(releaseRoot, gitSha), /release directory mode or ownership is invalid/u);
  } finally {
    await releaseInternals.removeOwnedTree(temporaryRoot);
  }
});

test("release verification rejects an injected absolute build path", async () => {
  const forbiddenMarker = "/private/build-machine/cargo-home";
  const { temporaryRoot, releaseRoot } = await syntheticRelease(forbiddenMarker);
  try {
    await assert.rejects(releaseInternals.verifyRelease(releaseRoot, gitSha, [forbiddenMarker]), /absolute build path/u);
  } finally {
    await releaseInternals.removeOwnedTree(temporaryRoot);
  }
});

test("detached verification rejects incomplete checksum inventories", async () => {
  const { temporaryRoot, releaseRoot } = await syntheticRelease();
  try {
    await chmod(releaseRoot, 0o755);
    await writeFile(join(releaseRoot, "unlisted.txt"), "not checksummed\n");
    await chmod(join(releaseRoot, "unlisted.txt"), 0o444);
    await chmod(releaseRoot, 0o555);
    await assert.rejects(releaseInternals.verifyRelease(releaseRoot, gitSha), /checksum inventory is incomplete/u);
  } finally {
    await releaseInternals.removeOwnedTree(temporaryRoot);
  }
});

test("qualification units are static and execute exact production bundles", async () => {
  const units = {
    "pi-web-qualification-egress-proxy.service.in": "ExecStart=/usr/bin/python3 @CURRENT_RELEASE@/bin/pi-web-qualification-proxy",
    "pi-web-qualification-browserd.service.in": "ExecStart=/usr/bin/node @CURRENT_RELEASE@/bin/pi-web-browserd.mjs",
    "pi-web-qualification-webxd.service.in": "ExecStart=/usr/bin/node @CURRENT_RELEASE@/bin/pi-web-webxd.mjs",
  };
  for (const [name, expectedExecStart] of Object.entries(units)) {
    const source = await readFile(join(sourceRoot, "deploy/phase4a/systemd", name), "utf8");
    assert.match(source, new RegExp(`^${expectedExecStart.replaceAll("/", "\\/")}\\s*$`, "mu"));
    assert.doesNotMatch(source, /^\[Install\]$/mu);
    assert.doesNotMatch(source, /(?:tsx|node_modules|target\/|scripts\/phase4a)/u);
  }
  const webxd = await readFile(join(sourceRoot, "deploy/phase4a/systemd/pi-web-qualification-webxd.service.in"), "utf8");
  assert.doesNotMatch(webxd, /pi-web-(?:reader|searxng)\.service/u);
});

test("qualification proxy is lease-bound, closed, and deterministic", () => {
  execFileSync("/usr/bin/python3", ["scripts/phase4a-qualification-proxy.test.py"], {
    cwd: sourceRoot,
    env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" },
    stdio: "pipe",
    timeout: 30_000,
  });
});
