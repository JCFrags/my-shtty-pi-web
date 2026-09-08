import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { sandbox, repository } from "./dist-sandbox.mjs";
import { preparePiHost } from "./pi-host.mjs";
import { validateArchive, validateBundle } from "../dist-manifest.mjs";

const outputs = process.argv.slice(2).map(output => fs.realpathSync(output));
assert.equal(outputs.length, 2, "usage: recovery-dist.mjs OUTPUT_A OUTPUT_B");
const pi = preparePiHost();
const bindings = [pi.binding];
const manifests = outputs.map((output, index) => {
  const file = path.join(output, "manifest-linux-x64.json");
  const manifest = JSON.parse(fs.readFileSync(file));
  validateArchive(path.join(output, manifest.file), file);
  bindings.push([file, `/archives/${index ? "b" : "a"}/manifest-linux-x64.json`], [path.join(output, manifest.file), `/archives/${index ? "b" : "a"}/${manifest.file}`]);
  return manifest;
});
assert.notEqual(manifests[0].artifactId, manifests[1].artifactId, "two separately sealed releases required");
const bootstrap = path.join(outputs[0], manifests[0].artifactId, "terminal-browser");
validateBundle(bootstrap);
bindings.push([bootstrap, "/bootstrap"]);
for (const name of ["packaged-recovery.mjs", "packaged-runtime.mjs", "packaged-pi.mjs", "pty-fixture.py"]) bindings.push([path.join(repository, "scripts/test", name), `/test/${name}`]);
bindings.push([path.join(repository, "browser/test/fixtures/dynamic-live.cjs"), "/test/dynamic-live.cjs"]);
sandbox("await import('/test/packaged-recovery.mjs');", bindings, { PI_ROOT: pi.root });
for (let index = 0; index < outputs.length; index++) validateArchive(path.join(outputs[index], manifests[index].file), path.join(outputs[index], "manifest-linux-x64.json"));
