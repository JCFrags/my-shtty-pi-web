const assert = require('node:assert/strict');
const test = require('node:test');
const { agentCommand } = require('../dist/agent.js');

test('upload CLI rejects malformed, missing and excessive file paths before routing', async () => {
  for (const value of ['invalid', 'null', '[]', '[4]', JSON.stringify(Array(17).fill('file.txt'))]) {
    await assert.rejects(agentCommand(null, ['upload', 'e1', '--files-json', value, '--observation', 'obs', '--control-epoch', '1']), /files|upload/);
  }
  await assert.rejects(agentCommand(null, ['upload', '--files-json', '["file.txt"]', '--observation', 'obs', '--control-epoch', '1']), /needs a ref/);
});
