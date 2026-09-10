import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { repository } from "./dist-sandbox.mjs";

export function preparePiHost() {
  const source = fs.realpathSync(process.env.TERMINAL_BROWSER_PI_ROOT ?? path.join(repository, "pi-extension/node_modules/@earendil-works/pi-coding-agent"));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "packaged-pi-host-"));
  const copied = new Map();
  function copy(directory) {
    directory = fs.realpathSync(directory);
    if (copied.has(directory)) return copied.get(directory);
    const target = path.join(home, String(copied.size));
    copied.set(directory, target);
    fs.cpSync(directory, target, { recursive: true, dereference: true, filter: file => path.basename(file) !== "node_modules" });
    const metadata = JSON.parse(fs.readFileSync(path.join(directory, "package.json")));
    const require = createRequire(path.join(directory, "package.json"));
    for (const name of new Set([...Object.keys(metadata.dependencies ?? {}), ...Object.keys(metadata.optionalDependencies ?? {}), ...Object.keys(metadata.peerDependencies ?? {})])) {
      const dependency = require.resolve.paths(name)?.map(base => path.join(base, name)).find(candidate => fs.existsSync(path.join(candidate, "package.json")));
      if (!dependency) {
        assert(metadata.optionalDependencies?.[name] || metadata.peerDependenciesMeta?.[name]?.optional, `unprepared Pi host dependency: ${name}`);
        continue;
      }
      const retained = copy(dependency);
      const link = path.join(target, "node_modules", name);
      fs.mkdirSync(path.dirname(link), { recursive: true });
      fs.symlinkSync(path.relative(path.dirname(link), retained), link);
    }
    return target;
  }
  const root = copy(source);
  return { binding: [home, "/pi-host"], root: "/pi-host/" + path.basename(root), version: JSON.parse(fs.readFileSync(path.join(source, "package.json"))).version };
}
