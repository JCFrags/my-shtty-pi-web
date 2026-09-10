import fs from "node:fs";
import path from "node:path";

export interface Installation {
  schemaVersion: 1;
  namespace: string;
  paths: {
    dataHome: string;
    stateHome: string;
    cacheHome: string;
    runtimeHome: string;
    appData: string;
    interopState: string;
    interopShare: string;
  };
}

export function readInstallation(): Installation | null {
  const dist = process.env.TERMINAL_BROWSER_DIST_ROOT;
  const inferred = dist && /^[a-f0-9]{64}$/.test(path.basename(path.dirname(dist))) && path.basename(path.dirname(path.dirname(dist))) === "releases";
  const file = process.env.TERMINAL_BROWSER_INSTALLATION ?? (inferred ? path.resolve(dist!, "../../../installation.json") : undefined);
  if (!file) return null;
  const stat = fs.lstatSync(file);
  if (!path.isAbsolute(file) || !stat.isFile() || stat.isSymbolicLink() || stat.size > 16384 || stat.uid !== process.getuid?.() || (stat.mode & 0o077)) throw new Error("invalid installation receipt permissions");
  const value = JSON.parse(fs.readFileSync(file, "utf8")) as Installation;
  if (value.schemaVersion !== 1 || !/^terminal-browser(?:-dev)?-[a-f0-9]{8}$/.test(value.namespace)) throw new Error("invalid installation namespace");
  for (const key of ["dataHome", "stateHome", "cacheHome", "runtimeHome", "appData", "interopState", "interopShare"] as const) {
    const directory = value.paths?.[key];
    if (typeof directory !== "string" || !path.isAbsolute(directory) || path.normalize(directory) !== directory || /[\0\r\n]/.test(directory) || (dist && (directory === dist || directory.startsWith(`${dist}/`)))) throw new Error("invalid installation state path");
  }
  for (const [key, directory] of Object.entries(value.paths)) {
    if (fs.existsSync(directory) && fs.realpathSync(directory) !== directory) throw new Error("installation state base is not a physical path");
    if (["dataHome", "stateHome", "cacheHome", "runtimeHome", "appData"].includes(key)) {
      const namespace = path.join(directory, value.namespace);
      if (fs.existsSync(namespace) && fs.realpathSync(namespace) !== namespace) throw new Error("installation state namespace is not a physical path");
    }
  }
  return value;
}

export const INSTALLATION = (() => {
  try { return readInstallation(); }
  catch {
    if (process.argv[2] === "doctor") return null;
    throw new Error("installation receipt is invalid; inspect doctor before explicit recovery");
  }
})();
