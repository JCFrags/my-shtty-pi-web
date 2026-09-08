import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';

const [input, output, dependencies] = process.argv.slice(2);
if (!input || !output || !dependencies || existsSync(output)) throw new Error('Usage: node prune.mjs HISTORICAL_SOURCE NEW_OUTPUT DEPENDENCY_ROOT');
const require = createRequire(join(resolve(dependencies), 'package.json'));
const ts = require('typescript');
if (ts.version !== '6.0.3') throw new Error('TypeScript 6.0.3 required');
const paths = [
  ...['authority', 'cache', 'content-store', 'fixtures', 'local-json-client', 'main', 'passage-selector', 'ports', 'runtime'].map(x => `apps/webxd/src/${x}.ts`),
  ...['audit', 'index', 'modes', 'output', 'schemas', 'sdk'].map(x => `apps/pi-webx/src/${x}.ts`),
  ...['client', 'errors', 'facade', 'index', 'node-unix', 'save-markdown', 'transport', 'types'].map(x => `packages/sdk/src/${x}.ts`),
  'packages/policy/storage.mjs',
  'scripts/pi-web-audit.mjs',
  'scripts/pi-web-doctor.mjs',
];
const digest = s => createHash('sha256').update(s).digest('hex');
const originalInputs = JSON.parse(readFileSync(new URL('./original-inputs.json', import.meta.url), 'utf8'));
function declarations(value) {
  const source = ts.createSourceFile('source.ts', value, ts.ScriptTarget.Latest, true);
  const result = new Map();
  function visit(node) {
    const topFunction = ts.isFunctionDeclaration(node) && ts.isSourceFile(node.parent);
    const method = (ts.isMethodDeclaration(node) || ts.isConstructorDeclaration(node)) && ts.isClassDeclaration(node.parent);
    const topVariable = ts.isVariableDeclaration(node) && node.parent.parent.parent && ts.isSourceFile(node.parent.parent.parent);
    if ((topFunction || method || topVariable) && (node.name || ts.isConstructorDeclaration(node))) {
      const name = (method ? `${node.parent.name.text}.` : '') + (node.name?.getText(source) ?? 'constructor');
      if (result.has(name)) throw new Error(`Duplicate declaration: ${name}`);
      result.set(name, digest(node.getText(source)));
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return result;
}
const provenance = [];
let text;
function replace(old, value = '') {
  if (text.split(old).length !== 2) throw new Error(`Nonunique source match: ${old.slice(0, 100)}`);
  text = text.replace(old, value);
}
function cut(start, end) {
  const a = text.indexOf(start), b = text.indexOf(end, a + start.length);
  if (a < 0 || b < 0) throw new Error(`Missing source range: ${start}`);
  replace(text.slice(a, b));
}
function lines(pattern) { text = text.split('\n').filter(line => !pattern.test(line)).join('\n'); }
function removeNodes(names) {
  const source = ts.createSourceFile('source.ts', text, ts.ScriptTarget.Latest, true);
  const edits = [];
  function visit(node) {
    if (node.name && names.includes(node.name.getText(source)) && (ts.isMethodDeclaration(node) || ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node))) {
      edits.push([node.getFullStart(), node.end]); return;
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  for (const [start, end] of edits.sort((a, b) => b[0] - a[0])) text = text.slice(0, start) + text.slice(end);
  if (edits.length !== names.length) throw new Error(`Expected ${names.length} declarations, removed ${edits.length}: ${names}`);
}
for (const path of paths) {
  const original = readFileSync(join(input, path), 'utf8');
  if (digest(original) !== originalInputs[path]) throw new Error(`Historical input hash mismatch: ${path}`);
  text = original;
  if (path === 'scripts/pi-web-doctor.mjs') {
    replace('import { existsSync, lstatSync, readFileSync, realpathSync }', 'import { realpathSync }');
    lines(/^import \{ readFile \}|^import \{ spawnSync \}|^const LEGACY_UNITS|^const VALIDATED_MODEL_ASSET_SETS|const browserRequired|capabilityFinding\("browser"/);
    cut('  if (profile !== undefined) {', '  return { schemaVersion: 1, ok: findings.every');
    removeNodes(['serviceStatusReport', 'commandAvailable', 'documentAssetReadiness', 'profileDoctorChecks']);
    text = text.replaceAll(', profile = undefined', '').replaceAll(', profile);', ');');
    replace('if (args.some((item) => item !== "--json" && item !== "--status") || args.filter((item) => item === "--json").length > 1 || args.filter((item) => item === "--status").length > 1)', 'if (args.some((item) => item !== "--json") || args.length > 1)');
    replace('usage: pi-web doctor [--json] | pi-web status [--json]', 'usage: pi-web doctor [--json]');
    cut('  const profilePath =', '  const report =');
    replace('args.includes("--status") ? serviceStatusReport(profile) : ');
  }
  if (path === 'apps/webxd/src/main.ts') {
    lines(/browserBackendSelection|proxyBoundDestinationAuthorityFromUrl|const proxyUrl|const destinationAuthority|const browserBackend|const browserRuntimeDirectory|browserSocketPath:|^  browserBackend,|^  browserRuntimeDirectory,|browserDescriptorPath:|workspaceRuntimeDirectory:|browserDestinationAuthority:/);
  }
  if (path === 'apps/webxd/src/runtime.ts') {
    lines(/^import .*browser|^import .*destination-authority|^import .*WorkspaceGateway|readonly browser|readonly workspace|readonly #browser:|readonly #workspace\?|browser: this.#browser|AgentCursorBrowserPort \?|this.#workspace ===|await this.#workspace\?\.start/);
    cut('    const backend =', '    this.#authority =');
    removeNodes(['createBrowserRpcConnectionFactory', 'PersistentBrowserConnection']);
    lines(/this.cleanupStage\("workspace"|this.cleanupStage\("browser"/);
    replace('"bindings" | "workspace" | "browser" | "socket"', '"bindings" | "socket"');
    text = text.replaceAll('bindings: false, workspace: false, browser: false, socket: false', 'bindings: false, socket: false');
    replace(', "browser.read", "browser.write", "browser.control", "browser.debug"');
  }
  if (path === 'apps/webxd/src/authority.ts') {
    lines(/^  Browser|readonly browser:|#browserOwners =|import \{ BrowserPortError|if \(error instanceof BrowserPortError\)|if \(segments\[1\] === "browser"\)/);
    replace('AuthorityIdSource, BrowserDaemonPort, IndexedSource', 'AuthorityIdSource, IndexedSource');
    replace('const [search, read, browser]', 'const [search, read]');
    lines(/this.browserHealth\(request.signal\)|id: "browser", enabled:/);
    replace('browserPaths: browser.paths', 'browserPaths: []');
    removeNodes(['browserHealth', 'browser', 'assertBrowserOwner', 'isSafeDebugOperation', 'healthProbeSignal', 'pathId', 'operationId']);
    lines(/^const DEFAULT_CONTENT_CHARS|^const MAX_CONTENT_CHARS|^const HEALTH_PROBE_TIMEOUT_MS|^  const path = new URL\(request.path/);
    lines(/\\\/v1\\\/browser/);
    replace('retry with a section query, or use browser_open when rendering or interaction is required', 'retry with a section query');
    replace('browser or authority backend failed', 'authority backend failed');
  }
  if (path === 'apps/webxd/src/ports.ts') {
    cut('import type {', 'export interface AuthorityActor');
    text = 'import type { Visibility } from "../../../packages/sdk/src/index.js";\n\n' + text;
    removeNodes(['BrowserPortError', 'BrowserDaemonPort', 'isBrowserPathId']);
  }
  if (path === 'packages/sdk/src/client.ts') {
    lines(/^  type Browser/);
    cut('  createBrowserSession(', '  private ');
  }
  if (path === 'packages/sdk/src/facade.ts') {
    replace('BoundedContent, BrowserAction, BrowserPathId, ContentRequest', 'BoundedContent, ContentRequest');
    lines(/^  "browser\.|#browserPathId\?:|const paths = catalog.browserPaths|const selected = paths.length|this.#browserPathId = selected|const browser = healthy|if \(operation === "browser\.|^      this.#browserPathId = undefined;/);
    replace('const healthy = (id: "search" | "read" | "browser")', 'const healthy = (id: "search" | "read")');
    replace('browser, browserDebug: browser && this.#browserPathId === "agent-browser/chrome" }, browserPathIds: paths', 'browser: false, browserDebug: false }, browserPathIds: []');
    replace('this.#browserPathId = undefined; ');
    removeNodes(['selectedBrowserPath', 'browserTabs', 'observe', 'browserAction', 'workspace', 'observationView', 'debugOperation', 'workspaceAction', 'canonicalImageBase64', 'optionalObject', 'boundedString', 'requiredNumber', 'pointerButton', 'coordinateSpace', 'sha256']);
    lines(/^import \{ createHash \}/);
  }
  if (path === 'packages/sdk/src/types.ts') {
    replace('export const BROWSER_PATH_IDS = ["agentcursor/chrome", "agent-browser/chrome"] as const;\n');
    replace('export type BrowserPathId = (typeof BROWSER_PATH_IDS)[number];\n');
    cut('export interface BrowserSessionRequest', 'export interface WebxProblem');
    replace('readonly pathId: BrowserPathId;', 'readonly pathId: never;');
  }
  if (path === 'apps/pi-webx/src/schemas.ts') {
    text = text.slice(0, text.indexOf('export const BrowserOpenSchema'));
    cut('const id =', 'export const WebSearchSchema');
  }
  if (path === 'apps/pi-webx/src/modes.ts') {
    replace('"off" | "read" | "browser" | "debug"', '"off" | "read"');
    lines(/^  "browser_|^const rank:/);
    cut('  if (rank[mode]', '  return tools;');
  }
  if (path === 'apps/pi-webx/src/index.ts') {
    lines(/^import .*WorkspaceLauncher|^  Browser|^const WORKSPACE_ACTIONS|^type WorkspaceAction|^  ".*browser (workspace|session)|^- Use browser_open|^- The browser tool|if \(operation === "browser.debug"\)|if \(operation.startsWith\("browser\."\)\)|readonly workspaceLauncher|^  const workspaceLauncher|pi.registerTool\(\{ name: "browser_/);
    replace('["off", "read", "browser", "debug"]', '["off", "read"]');
    replace('let mode: WebMode = "browser"', 'let mode: WebMode = "read"');
    replace('  /** Test seam for the user-only fixed workspace process launcher. */\n');
    text = text.replaceAll('; paths ${next.browserPathIds.join(", ")}', '').replaceAll('; paths ${capabilities.browserPathIds.join(", ")}', '');
    cut('    const workspace =', '    const showSettings =');
    cut('      const actionByChoice:', '    };\n\n    pi.registerCommand');
    cut('        if (words[0] === "workspace")', '        ctx.ui.notify("Run /web');
    cut('    pi.registerShortcut(', '    pi.on("session_start"');
    replace('Open WebX settings for capability modes and browser workspace controls', 'Open WebX research settings');
    replace('Run /web with no options to open WebX settings. Direct options are /web mode off|read|browser|debug, /web status, and /web workspace show|hide|attach <sessionId> [tabId]|takeover <sessionId> [tabId]|return. Human control is explicit and user-only. WebX is automatic: use web_read for a known URL or API, web_search for discovery, and browser tools only for dynamic pages or interaction.', 'Run /web for research settings. Direct options are /web mode off|read, /web status, and /web help. Use web_read for a known URL or API and web_search for discovery.');
    replace('Usage: /web mode off|read|browser|debug', 'Usage: /web mode off|read');
  }
  const destination = join(output, path);
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, text);
  const before = declarations(original);
  const preservedDeclarations = Object.fromEntries([...declarations(text)].filter(([name, hash]) => before.get(name) === hash));
  provenance.push({ path, originalSha256: digest(original), retainedSha256: digest(text), originalBytes: Buffer.byteLength(original), retainedBytes: Buffer.byteLength(text), changed: text !== original, preservedDeclarations });
}
writeFileSync(join(output, 'provenance.json'), JSON.stringify({ gitSha: '70ca901e35473a53bf2a37284235fb7714972ee8', files: provenance }, null, 2) + '\n');
