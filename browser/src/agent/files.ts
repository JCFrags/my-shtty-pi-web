import fs from "node:fs";
import path from "node:path";

export const UPLOAD_LIMITS = { count: 16, fileBytes: 32 * 1024 * 1024, totalBytes: 64 * 1024 * 1024 };

function inside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function secret(candidate: string): boolean {
  return candidate.split(/[\\/]/).some(component => /^(?:\.env(?:\..*)?|\.ssh|\.gnupg|\.aws|\.azure|\.kube|\.config|\.git|\.npmrc|\.netrc|auth\.json|(?:.*[-_.])?(?:passwords?|tokens?|secrets?)(?:[-_.].*)?|credentials?(?:\..*)?|id_(?:rsa|dsa|ecdsa|ed25519)(?:\..*)?|.*\.(?:pem|key|p12|pfx|kdbx))$/i.test(component));
}

export function validateUploadFiles(projectRoot: string | null, values: unknown): string[] {
  if (!projectRoot) throw new Error("uploads require an owning Pi project");
  if (!Array.isArray(values) || !values.length || values.length > UPLOAD_LIMITS.count) throw new Error("upload requires 1 to 16 files");
  const root = owningProjectRoot(projectRoot);
  let total = 0;
  return values.map(value => {
    if (typeof value !== "string" || !value || value.length > 4096 || /[\x00-\x1f\x7f]/.test(value)) throw new Error("invalid upload path");
    const resolved = path.resolve(root, value);
    if (!inside(root, resolved)) throw new Error("upload path is outside the owning project; reopen the companion to use a different project root");
    if (secret(resolved)) throw new Error("upload secret paths are not allowed");
    let canonical: string;
    let stat: fs.Stats;
    try { canonical = fs.realpathSync(resolved); stat = fs.statSync(canonical); }
    catch { throw new Error("upload file does not exist"); }
    if (!inside(root, canonical)) throw new Error("upload path is outside the owning project; reopen the companion to use a different project root");
    if (secret(canonical)) throw new Error("upload secret paths are not allowed");
    if (!stat.isFile()) throw new Error("upload requires regular files");
    total += stat.size;
    if (stat.size > UPLOAD_LIMITS.fileBytes || total > UPLOAD_LIMITS.totalBytes) throw new Error("upload size limit exceeded");
    return canonical;
  });
}

export function reserveDownloadPath(projectRoot: string, filename: string): string {
  const root = owningProjectRoot(projectRoot);
  const directory = path.join(root, ".terminal-browser-downloads");
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (fs.lstatSync(directory).isSymbolicLink() || fs.realpathSync(directory) !== directory) throw new Error("unsafe download directory");
  const location = fs.mkdtempSync(path.join(directory, "item-"));
  fs.chmodSync(location, 0o700);
  return path.join(location, downloadFilename(filename));
}

export function downloadFilename(filename: string): string {
  const name = path.basename(filename.replace(/\\/g, "/")).replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 160);
  return !name || /^\.+$/.test(name) ? "download" : name;
}

function owningProjectRoot(projectRoot: string): string {
  let canonical: string;
  try { canonical = fs.realpathSync(projectRoot); } catch { throw new Error("owning project root is unavailable; reopen the companion"); }
  if (canonical !== path.resolve(projectRoot)) throw new Error("owning project root changed; reopen the companion");
  return canonical;
}
