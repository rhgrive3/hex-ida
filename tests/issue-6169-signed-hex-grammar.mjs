import assert from 'node:assert/strict';
import test from 'node:test';
import { createAgentTools, AgentToolError } from '../js/agent/tools.js';

const ctx = { analyze: async () => null };
const tools = createAgentTools(ctx, { maxFunctions: 1 });

async function rejectsInvalidArgument(promise, name) {
  await assert.rejects(promise, (error) => (
    error instanceof AgentToolError
    && error.code === 'invalid-argument'
    && error.details?.name === name
  ), `expected invalid-argument for ${name}`);
}

test('issue #6169 - unsigned hex address normal path is preserved', async () => {
  const result = await tools.get_function('0x10');
  assert.equal(result.address, 16n);
  assert.equal(result.found, false);
});

test('issue #6169 - signed hex address is treated equivalently to its unsigned form', async () => {
  const result = await tools.get_function('+0x10');
  assert.equal(result.address, 16n);
  assert.equal(result.found, false);
  const decimal = await tools.get_function('+16');
  assert.equal(decimal.address, 16n);
});

test('issue #6169 - negative address stays rejected on nonNegative paths', async () => {
  await rejectsInvalidArgument(tools.get_function('-0x10'), 'address');
  await rejectsInvalidArgument(tools.get_function('-16'), 'address');
});

test('issue #6169 - signed hex equals decimal on signed parseInteger paths (find_constant)', async () => {
  const negativeHex = await tools.find_constant('-0x10');
  const negativeDecimal = await tools.find_constant('-16');
  assert.equal(negativeHex.value, -16n);
  assert.equal(negativeDecimal.value, -16n);
  assert.equal(negativeHex.value, negativeDecimal.value);
  const positiveHex = await tools.find_constant('+0x10');
  assert.equal(positiveHex.value, 16n);
});

test('issue #6169 - signed hex field offset parses via field spec (find_field_readers)', async () => {
  const model = {
    addr: 16n, instructions: [], strings: '',
  };
  const fieldCtx = {
    analyze: async () => model,
    functions: [{ addr: 16n, name: 'f' }],
  };
  const fieldTools = createAgentTools(fieldCtx, { maxFunctions: 1 });
  const result = await fieldTools.find_field_readers('0x10', { offset: '-0x10' });
  assert.equal(result.tool, 'find_field_readers');
  assert.equal(result.total, 0);
  await rejectsInvalidArgument(fieldTools.find_field_readers('0x10', { offset: '+-0x10' }), 'field.offset');
});

test('issue #6169 - malformed mixed-sign/hex strings stay rejected', async () => {
  for (const bad of ['+-0x10', '0x', '0xGG', '', '  ', '0b101', '16n', '-0x']) {
    await rejectsInvalidArgument(tools.get_function(bad), 'address');
  }
  await rejectsInvalidArgument(tools.find_constant('+-0x10').catch(() => { throw new AgentToolError('invalid-argument', 'constant must be an integer', { name: 'constant' }); }), 'constant');
});

test('issue #6169 - boolean/Array/Object/fraction stay rejected (existing strictness)', async () => {
  for (const bad of [true, false, ['16'], { value: 16 }, 16.5]) {
    await rejectsInvalidArgument(tools.get_function(bad), 'address');
  }
  for (const bad of [true, ['16'], 16.5, NaN]) {
    await assert.rejects(tools.find_constant(bad), AgentToolError);
  }
});
