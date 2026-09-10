import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { WebxClient } from '../source/packages/sdk/src/client.js';
import { UnixSocketTransport } from '../source/packages/sdk/src/transport.js';
import { nodeNdjsonConnectionFactory } from '../source/packages/sdk/src/node-unix.js';
import { WebxFacadeClient } from '../source/packages/sdk/src/facade.js';

const candidate = process.env.WEB_RESEARCH_CANDIDATE;
if (!candidate) throw new Error('WEB_RESEARCH_CANDIDATE must name the isolated built candidate');
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const manifest = JSON.parse(await readFile(join(candidate, 'manifest.json'), 'utf8'));
for (const [name, digest] of Object.entries(manifest.files)) assert.equal(hash(await readFile(join(candidate, name))), digest);
const { WebxdRuntime, sameUserPiActorAuthenticator } = await import(pathToFileURL(join(candidate, 'research-api.mjs')).href);

test('candidate uses the real Unix binding, research routes, persisted content and unchanged request bounds', async () => {
  const home = await mkdtemp('/var/tmp/web-research-runtime-');
  const runtimeDirectory = join(home, 'runtime');
  await mkdir(runtimeDirectory);
  const previousRuntime = process.env.XDG_RUNTIME_DIR;
  process.env.XDG_RUNTIME_DIR = runtimeDirectory;
  let reads = 0;
  const server = createServer(async (request, response) => {
    response.setHeader('content-type', 'application/json');
    if (request.url === '/config') return response.end(JSON.stringify({ engines: [] }));
    if (request.url === '/health') return response.end(JSON.stringify({ ok: true }));
    if (request.url?.startsWith('/search?')) return response.end(JSON.stringify({ results: [{ url: 'https://example.test/article', title: 'Synthetic research', content: 'A synthetic search result.', score: 1 }] }));
    if (request.url === '/v1/read') {
      reads++;
      let raw = '';
      for await (const chunk of request) raw += chunk;
      const body = JSON.parse(raw);
      if (body.url.endsWith('/failure')) { response.statusCode = 502; return response.end(JSON.stringify({ error: 'synthetic reader failure' })); }
      return response.end(JSON.stringify({ url: body.url, title: 'Synthetic article', content: 'Alpha paragraph.\n\nBeta paragraph for stored selection.\n\nGamma conclusion.', mediaType: 'text/plain', source: 'fixture', truncated: false, metadata: {} }));
    }
    response.statusCode = 404; response.end('{}');
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  assert(address && typeof address !== 'string');
  const backend = `http://127.0.0.1:${address.port}`;
  const socket = join(runtimeDirectory, 'research.sock');
  const options = { socketPath: socket, sources: [], searxUrl: backend, readerUrl: backend, cacheDirectory: join(home, 'responses'), contentDirectory: join(home, 'content'), authenticateActor: sameUserPiActorAuthenticator };
  let runtime = new WebxdRuntime(options);
  let client: WebxClient | undefined;
  let facade: WebxFacadeClient | undefined;
  try {
    await runtime.start();
    client = new WebxClient(new UnixSocketTransport(socket, nodeNdjsonConnectionFactory));
    await client.bind('synthetic-owner');
    const capabilities = await client.capabilities();
    assert.deepEqual(capabilities.capabilities.map(x => x.id), ['search', 'read']);
    assert.deepEqual(capabilities.browserPaths, []);
    assert(capabilities.capabilities.every(x => x.healthy));
    const execute = promisify(execFile);
    const cliEnvironment = { ...process.env, WEBXD_SOCKET: socket, PI_WEB_AUDIT_DIR: join(home, 'audit') };
    const doctor = await execute(join(candidate, 'pi-web'), ['doctor', '--json'], { env: cliEnvironment });
    const health = JSON.parse(doctor.stdout);
    assert.equal(health.ok, true);
    assert.deepEqual(health.findings.map((item: { category: string }) => item.category), ['authority', 'search', 'read']);
    const audit = await execute(join(candidate, 'pi-web'), ['audit', 'list'], { env: cliEnvironment });
    assert.equal(JSON.parse(audit.stdout).count, 0);
    await assert.rejects(execute(join(candidate, 'pi-web'), ['workspace'], { env: cliEnvironment }), (error: any) => error.code === 2);
    await assert.rejects(execute(join(candidate, 'pi-web'), ['install'], { env: cliEnvironment }), (error: any) => error.code === 2);
    const search = await client.search({ query: 'synthetic research' }, { idempotencyKey: 'search-0001' });
    assert.equal(search.hits[0]?.url, 'https://example.test/article');
    const read = await client.read({ url: 'https://example.test/article', maxChars: 12 }, { idempotencyKey: 'read-00001' });
    assert.equal(read.untrustedContent.length, 12);
    assert(read.metadata.contentId);
    const readCount = reads;
    const content = await client.content({ contentId: read.metadata.contentId, query: 'Beta', limit: 100 }, { idempotencyKey: 'content-001' });
    assert.match(content.untrustedContent, /Beta/);
    assert.equal(reads, readCount);
    const batch = await client.readBatch({ items: [{ url: 'https://example.test/article' }, { url: 'https://example.test/other' }, { url: 'https://example.test/failure' }] }, { idempotencyKey: 'batch-00001' });
    assert.equal(batch.results.length, 3);
    assert.equal(batch.results[0]?.ok, true);
    assert.equal(batch.results[1]?.ok, true);
    assert.equal(batch.results[2]?.ok, false);
    const transport = new UnixSocketTransport(socket, nodeNdjsonConnectionFactory);
    await transport.bind('synthetic-owner');
    for (const path of ['/v1/browser/sessions', '/v1/browser/workspace', '/v1/browser/operations/x/cancel']) {
      const response = await transport.request({ method: 'POST', path, headers: { 'idempotency-key': 'absent-' + path }, body: {}, maxResponseBytes: 1000 });
      assert.equal(response.status, 404);
    }
    await transport.close();
    facade = new WebxFacadeClient(socket, join(home, 'exports'));
    const requestOptions = { ownerId: 'synthetic-owner', cwd: home, signal: new AbortController().signal, idempotencyKey: 'facade-0001' };
    await facade.start(requestOptions);
    await assert.rejects(facade.request('browser.open', {}, requestOptions), /not in the facade inventory/);
    const saved = await facade.request('web.read', { url: 'https://example.test/article', save: { path: 'synthetic.md' } }, requestOptions);
    assert(saved.data);
    assert.match(await readFile(join(home, 'exports/synthetic.md'), 'utf8'), /Gamma conclusion/);
    await facade.stop({ ownerId: 'synthetic-owner' }); facade = undefined;
    await client.close(); client = undefined;
    await runtime.stop();
    runtime = new WebxdRuntime(options); await runtime.start();
    client = new WebxClient(new UnixSocketTransport(socket, nodeNdjsonConnectionFactory));
    await client.bind('synthetic-owner');
    const persisted = await client.content({ contentId: read.metadata.contentId, offset: 0, limit: 100 }, { idempotencyKey: 'persist-001' });
    assert.match(persisted.untrustedContent, /Gamma/);
    const foreign = new WebxClient(new UnixSocketTransport(socket, nodeNdjsonConnectionFactory));
    await foreign.bind('different-owner');
    await assert.rejects(foreign.content({ contentId: read.metadata.contentId }, { idempotencyKey: 'foreign-001' }));
    await foreign.close();
    assert.deepEqual((await readdir(runtimeDirectory)).sort(), ['research.sock', 'research.sock.owner']);
    const childSocket = join(runtimeDirectory, 'child.sock');
    const child = spawn(process.execPath, [join(candidate, 'webxd.mjs')], { env: { ...process.env, WEBXD_SOCKET: childSocket, WEBX_SEARX_URL: backend, WEBX_READER_URL: backend, WEBX_CACHE_DIR: join(home, 'child-responses'), WEBX_CONTENT_DIR: join(home, 'child-content'), WEBX_BROWSER_BACKEND: 'removed-invalid-value', BROWSERD_DESCRIPTOR: join(home, 'absent-descriptor'), WEBXD_WORKSPACE_RUNTIME_DIR: join(home, 'must-not-exist') }, stdio: 'ignore' });
    const childExit = once(child, 'exit');
    try {
      let ready = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        if ((await readdir(runtimeDirectory)).includes('child.sock')) { ready = true; break; }
        await delay(20);
      }
      assert(ready, 'Candidate main must start without obsolete configuration');
      const childDoctor = await execute(join(candidate, 'pi-web'), ['doctor', '--json'], { env: { ...cliEnvironment, WEBXD_SOCKET: childSocket } });
      assert.equal(JSON.parse(childDoctor.stdout).ok, true);
      assert(!(await readdir(home)).includes('must-not-exist'));
    } finally { child.kill('SIGTERM'); await childExit; }
  } finally {
    await facade?.stop({ ownerId: 'synthetic-owner' });
    await client?.close();
    await runtime.stop();
    await new Promise<void>(done => server.close(() => done()));
    if (previousRuntime === undefined) delete process.env.XDG_RUNTIME_DIR; else process.env.XDG_RUNTIME_DIR = previousRuntime;
    await rm(home, { recursive: true, force: true });
  }
});

test('exact candidate extension registers research only and preserves unrelated browser tools', async () => {
  const fixture = await mkdtemp(join(dirname(fileURLToPath(import.meta.url)), '.candidate-'));
  try {
    const bytes = await readFile(join(candidate, 'extension.mjs'));
    await writeFile(join(fixture, 'extension.mjs'), bytes);
    const extension = await import(pathToFileURL(join(fixture, 'extension.mjs')).href);
    const tools: Array<{ name: string }> = [];
    const commands: string[] = [];
    const events = new Map<string, Function>();
    let active = ['bash', 'browser_open', 'browser_control'];
    const sdk = { start: async () => {}, stop: async () => {}, capabilities: async () => ({ apiVersion: '3.0.0', daemon: 'ready', groups: { search: true, read: true, browser: false, browserDebug: false }, browserPathIds: [] }) };
    extension.createPiWebxExtension(() => sdk, { record: async () => {} })({
      registerTool: (tool: { name: string }) => tools.push(tool),
      registerCommand: (name: string) => commands.push(name),
      registerShortcut: () => assert.fail('No old browser shortcut is allowed'),
      on: (name: string, handler: Function) => events.set(name, handler),
      getActiveTools: () => active,
      setActiveTools: (names: string[]) => { active = names; },
    });
    assert.deepEqual(tools.map(x => x.name), ['web_search', 'web_read', 'web_read_batch', 'web_content']);
    assert.deepEqual(commands, ['web']);
    await events.get('session_start')?.({}, { cwd: fixture, isProjectTrusted: () => true, sessionManager: { getSessionId: () => 'fixture-owner' }, hasUI: false, ui: { setStatus: () => {}, notify: () => {} } });
    assert(active.includes('browser_open')); assert(active.includes('browser_control'));
    await events.get('session_shutdown')?.();
  } finally { await rm(fixture, { recursive: true, force: true }); }
});
