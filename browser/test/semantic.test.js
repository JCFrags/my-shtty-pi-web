const assert = require('node:assert/strict');
const { test } = require('node:test');
const { parseLocator } = require('../dist/agent/locator.js');
const { TargetPreparation } = require('../dist/agent/target-preparation.js');
const { TerminalBrowserDriver } = require('../dist/agent/terminal-browser-driver.js');
const { createSlowNaturalPersona } = require('../dist/agent/interaction-profile.js');
const { parseTypeRequest, parseHoverRequest, parseDragRequest, parseWaitForRequest } = require('../dist/agent/protocol.js');

const locator = [{ kind: 'role', value: 'button', name: 'Save', exact: true }];
function state(overrides = {}) {
  return { ref: 'e1', rect: { x: 10, y: 10, width: 100, height: 30 }, bounds: { x: 10, y: 10, width: 100, height: 30 },
    visible: true, enabled: true, editable: true, hit: true, focused: true,
    text: 'Save', tag: 'button', name: 'Save', role: 'button', ...overrides };
}
function preparationFixture() {
  let now = 0;
  let current = state();
  let count = 1;
  let documentId = 'doc';
  let onSleep = () => {};
  const abort = new AbortController();
  const observer = {
    queryLocator: async () => ({ documentId, count, matches: current ? [current] : [] }),
    elementState: async ref => ({ documentId, state: current?.ref === ref ? current : null }),
  };
  const preparation = new TargetPreparation(observer, 'doc', () => abort.signal.throwIfAborted(), async ms => { now += ms; onSleep(); }, () => now);
  return { preparation, observer, abort, setState: value => { current = value; }, setCount: value => { count = value; },
    setDocument: value => { documentId = value; }, onSleep: callback => { onSleep = callback; } };
}

test('native locator arrays validate every bounded step without coercion', () => {
  const spec = [...locator, { kind: 'css', value: '.panel' }, { kind: 'label', value: 'Name' },
    { kind: 'text', value: 'label', exact: false }, { kind: 'placeholder', value: 'Search' },
    { kind: 'testid', value: 'send' }, { kind: 'filter', hasText: 'Save' }, { kind: 'nth', index: -1 }];
  assert.deepEqual(parseLocator(spec), spec);
  for (const bad of [[], Array(17).fill(locator[0]), [{ kind: 'nth', index: 0 }], [{ kind: 'css', value: '' }],
    [{ kind: 'text', value: 'x', exact: 'true' }], [{ kind: 'css', value: 'x', extra: true }],
    [{ kind: 'text', value: 'x'.repeat(1025) }], [{ kind: 'text', value: 'a\0b' }],
    [...locator, { kind: 'nth', index: 0.5 }]]) assert.throws(() => parseLocator(bad), /locator/);
});

test('wire protocols keep native locator arrays for type, hover, drag and actionable wait', () => {
  const base = { tab: 1, observationId: 'obs', expectedControlEpoch: 1 };
  assert.deepEqual(parseTypeRequest({ ...base, locator, text: 'Ada' }).request.locator, locator);
  assert.deepEqual(parseHoverRequest({ ...base, locator }).request.target, { locator });
  assert.deepEqual(parseDragRequest({ ...base, fromLocator: locator, toRef: 'e2' }).request.from, { locator });
  assert.equal(parseWaitForRequest({ ...base, locator, condition: 'actionable' }).request.condition, 'actionable');
  assert.throws(() => parseTypeRequest({ ...base, locator, ref: 'e1', text: 'x' }), /exactly one/);
  assert.throws(() => parseHoverRequest({ ...base, locator, x: 1, y: 2 }), /coordinates/);
  assert.throws(() => parseWaitForRequest({ ...base, condition: 'actionable', text: 'x' }), /needs a ref/);
});

test('native resolution returns count and stable handle without requiring uniqueness', async () => {
  const fixture = preparationFixture();
  fixture.setCount(2);
  const match = await fixture.preparation.resolveLocator(locator, 0);
  assert.deepEqual(match, { handle: 'e1', rect: state().bounds, count: 2, visible: true, text: 'Save' });
  await assert.rejects(fixture.preparation.prepare({ locator }), /ambiguous locator.*e1/);
  fixture.setState(null); fixture.setCount(0);
  assert.equal((await fixture.preparation.resolveLocator(locator, 0)).count, 0);
});

test('preparation waits for enablement and stable geometry and stops on cancellation', async () => {
  const fixture = preparationFixture();
  fixture.setState(state({ enabled: false }));
  fixture.onSleep(() => fixture.setState(state()));
  assert.equal((await fixture.preparation.prepare({ locator })).state.ref, 'e1');
  fixture.setState(state({ enabled: false }));
  fixture.onSleep(() => fixture.abort.abort(new Error('cancelled')));
  await assert.rejects(fixture.preparation.prepare({ locator }), /cancelled/);
});

test('locator can re-resolve before input but ref never changes identity or crosses documents', async () => {
  const fixture = preparationFixture();
  const prepared = await fixture.preparation.prepare({ locator });
  fixture.setState(state({ ref: 'e2', rect: { x: 200, y: 10, width: 100, height: 30 } }));
  assert.equal(await fixture.preparation.check(prepared, { x: 20, y: 20 }), false);
  const next = await fixture.preparation.refresh(prepared, { x: 20, y: 20 });
  assert.equal(prepared.state.ref, 'e2');
  assert.equal(next.x, 210);
  prepared.committed = true;
  await assert.rejects(fixture.preparation.refresh(prepared, next), /not retried/);
  await assert.rejects(fixture.preparation.prepare({ ref: 'e1' }), /stale or unknown ref/);
  fixture.setDocument('other');
  await assert.rejects(fixture.preparation.prepare({ locator }), /page changed/);
});

test('final driver check naturally reapproaches a moved target and clicks exactly once', async () => {
  const fixture = preparationFixture();
  const prepared = await fixture.preparation.prepare({ locator });
  const events = [];
  const target = { agentPointer: event => events.push({ ...event }), releaseAgentInput() {}, viewportSize: () => ({ width: 400, height: 300 }) };
  const driver = new TerminalBrowserDriver(target, fixture.observer, { sleep: async () => {} });
  driver.usePersona(await createSlowNaturalPersona({ seed: 42 }));
  driver.bindTargets(fixture.preparation, prepared);
  fixture.setState(state({ rect: { x: 200, y: 10, width: 100, height: 30 } }));
  const point = { x: 20, y: 20 };
  await driver.click({ samples: [{ ...point, t: 0 }], target: point, button: 'left', dblclick: false, preClickDwellMs: 0, pressMs: 0, mode: 'content' });
  assert.equal(events.filter(event => event.kind === 'down').length, 1);
  assert.equal(events.filter(event => event.kind === 'up').length, 1);
  assert(events.filter(event => event.kind === 'move').length > 2);
  assert.equal(events.find(event => event.kind === 'down').x, 210);
});

test('obstruction at the actual point and lost insertion focus prevent side effects', async () => {
  const fixture = preparationFixture();
  const prepared = await fixture.preparation.prepare({ locator });
  fixture.setState(state({ hit: false }));
  const events = [];
  const target = { agentPointer: event => events.push(event), releaseAgentInput() {}, viewportSize: () => ({ width: 400, height: 300 }),
    agentSelectAll: async () => events.push('select'), agentInsertText: async () => events.push('insert') };
  const driver = new TerminalBrowserDriver(target, fixture.observer, { sleep: async () => {} });
  driver.bindTargets(fixture.preparation, prepared);
  await assert.rejects(driver.click({ samples: [], target: { x: 20, y: 20 }, button: 'left', dblclick: false, preClickDwellMs: 0, pressMs: 0, mode: 'content' }), /obstructed/);
  assert.equal(events.length, 0);
  fixture.setState(state({ focused: false }));
  await assert.rejects(driver.type({ text: 'secret', replace: true, perKeyMinMs: 1, perKeyMaxMs: 2, mode: 'content' }), /focus changed/);
  assert.deepEqual(events, []);
});

test('preparation interrupts a pending renderer wait and blocks its late mutation', async () => {
  const fixture = preparationFixture();
  let resume;
  let mutated = false;
  fixture.observer.elementState = async (_ref, options) => {
    await new Promise(resolve => { resume = resolve; });
    options.guard();
    mutated = true;
    return { documentId: 'doc', state: state() };
  };
  const pending = fixture.preparation.prepare({ ref: 'e1' });
  fixture.abort.abort(new Error('cancelled pending geometry'));
  await assert.rejects(pending, /cancelled pending geometry/);
  resume();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(mutated, false);
});

test('ambiguous editable locator after input reports possible delivery and no retry', async () => {
  const fixture = preparationFixture();
  const prepared = await fixture.preparation.prepare({ locator }, 'editable');
  prepared.committed = true;
  fixture.setCount(2);
  await assert.rejects(fixture.preparation.assertFocused(prepared), /ambiguous locator.*input may have been delivered.*not retried/);
});

test('preparation timeout also blocks a late mutation when the operation guard remains healthy', async () => {
  let now = 0, resume, mutated = false;
  const observer = { elementState: async (_ref, options) => {
    await new Promise(resolve => { resume = resolve; });
    options.guard();
    mutated = true;
    return { documentId: 'doc', state: state() };
  } };
  const preparation = new TargetPreparation(observer, 'doc', () => {}, async () => {}, () => now);
  const pending = preparation.prepare({ ref: 'e1' });
  now = 10_000;
  await assert.rejects(pending, /preparation timed out/);
  resume();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(mutated, false);
});
