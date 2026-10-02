import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const temporary = mkdtempSync(join(tmpdir(), 'pi-web-research-test-'));
const candidate = join(temporary, 'candidate');
const environment = { ...process.env, WEB_RESEARCH_CANDIDATE: candidate };
function run(args) {
  const result = spawnSync(process.execPath, args, { cwd: root, env: environment, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Verification failed (${result.status ?? result.signal}): ${args.join(' ')}`);
}
try {
  run(['build.mjs', candidate, root]);
  const manifestHash = createHash('sha256').update(readFileSync(join(candidate, 'manifest.json'))).digest('hex');
  assert.equal(manifestHash, '578092a8ea6aeb478eb02827276485c9972103922ac0a6f19eb6b69dcd59aa27', 'Candidate must match the frozen research release');
  run(['--import', 'tsx', '--test', 'test/candidate.test.ts', 'test/extension.test.ts', 'test/preservation.test.ts']);
  run(['node_modules/vitest/vitest.mjs', 'run', 'test/authority.test.ts', 'test/cache.test.ts', 'test/content-store.test.ts', 'test/local-json-client.test.ts', 'test/passage-selector.test.ts']);
  run(['node_modules/typescript/bin/tsc', '--noEmit', '--module', 'esnext', '--moduleResolution', 'bundler', '--target', 'es2024', '--allowJs', '--skipLibCheck', '--strict', '--noUnusedLocals', 'source/apps/webxd/src/main.ts', 'source/apps/pi-webx/src/index.ts']);
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
