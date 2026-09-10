const assert = require('node:assert/strict');
const test = require('node:test');
const { agentCommand } = require('../dist/agent.js');

test('dialog CLI requires exact context, identity and explicit decision before routing', async () => {
  await assert.rejects(agentCommand(null, ['dialog', '--control-epoch', '1', '--accept']), /dialog requires/);
  await assert.rejects(agentCommand(null, ['dialog', '--tab', '1', '--dialog-id', 'd', '--control-epoch', '1', '--accept', '--dismiss']), /exactly one/);
  await assert.rejects(agentCommand(null, ['dialog', '--tab', '1', '--dialog-id', 'd', '--control-epoch', '1', '--accept', '--text', 'x', '--stdin']), /choose/);
});
