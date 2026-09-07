const assert = require('node:assert/strict');
const test = require('node:test');
const { agentCommand } = require('../dist/agent.js');

test('CLI rejects invalid or combined locator arguments before routing', async () => {
  for (const action of ['click', 'hover', 'type', 'upload']) {
    const extra = action === 'type' ? ['--text', 'Ada'] : action === 'upload' ? ['--files-json', '["file.txt"]'] : [];
    for (const value of ['broken', '{}', '[]', JSON.stringify(Array(17).fill({ kind: 'text', value: 'Save' }))]) {
      await assert.rejects(agentCommand(null, [action, '--locator-json', value, ...extra]), /locator/);
    }
    await assert.rejects(agentCommand(null, [action, 'e1', '--locator-json', '[{"kind":"text","value":"Save"}]', ...extra]), /locator/);
  }
  await assert.rejects(agentCommand(null, ['drag', '--from-locator-json', '[]']), /locator/);
  await assert.rejects(agentCommand(null, ['observe', '--filter-json', '{}']), /locator/);
  await assert.rejects(agentCommand(null, ['wait-for', '--condition', 'actionable', '--text', 'ready']), /needs --ref/);
});
