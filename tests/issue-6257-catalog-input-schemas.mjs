/**
 * #6257 regression: agent-exposed built-in capabilities must publish an
 * input schema that matches the executor's real argument contract, so that
 * missing required fields are rejected as invalid_tool_call by assertSchema
 * instead of surfacing as native TypeError from BigInt(undefined) deeper in
 * the executor.
 */
import assert from 'node:assert/strict';
import { HEX_CAPABILITIES } from '../js/ai/capabilities/catalog.js';
import { validateSchema } from '../js/ai/validation.js';
import { CapabilityExecutor } from '../js/ai/capabilities/executor.js';

const byId = new Map(HEX_CAPABILITIES.map((entry) => [entry.id, entry]));

/* required-field contracts per built-in capability, matching executeBuiltIn */
const REQUIRED_FIELDS = Object.freeze({
  'annotation.rename': ['address', 'value'],
  'annotation.comment': ['address', 'value'],
  'annotation.set-type': ['address', 'value'],
  'annotation.struct-field': ['offset'],
  'patch.create': ['address', 'before', 'after'],
  'patch.preview': ['address', 'before', 'after'],
  'patch.revert': ['fileOffset'],
  'runtime.memory-read': ['address'],
  'runtime.memory-write': ['address', 'bytes', 'expectedBefore'],
  'runtime.experiment': ['experiment'],
  'project.restore-known': ['project'],
});

/* 1. every agent-exposed built-in has a real input schema object */
for (const entry of HEX_CAPABILITIES) {
  if (!entry.agentExposed || entry.agentTool || entry.actionKind) continue;
  assert.ok(entry.inputSchema && typeof entry.inputSchema === 'object', `${entry.id} must publish an input schema`);
}

/* 2. missing required args are rejected by the schema, not by native TypeError */
for (const [id, fields] of Object.entries(REQUIRED_FIELDS)) {
  const entry = byId.get(id);
  assert.ok(entry, `catalog entry ${id} must exist`);
  for (const field of fields) {
    const args = {};
    const checked = validateSchema(args, entry.inputSchema);
    assert.equal(checked.ok, false, `${id}: {} must be invalid when ${field} is required`);
    assert.ok(
      checked.errors.some((message) => message.includes(field) && message.includes('required')),
      `${id}: empty args must report ${field} is required, got ${JSON.stringify(checked.errors)}`,
    );
  }
}

/* 3. schema rejects the wrong primitive for known fields (no silent coercion) */
{
  const checked = validateSchema({ address: true, value: 'x' }, byId.get('annotation.rename').inputSchema);
  assert.equal(checked.ok, false, 'boolean must not pass as an address');
  const checked2 = validateSchema({ address: '4096', value: 42 }, byId.get('annotation.rename').inputSchema);
  assert.equal(checked2.ok, false, 'number must not pass as a string value');
}

/* 4. valid inputs still reach the executor end-to-end */
{
  const names = new Map();
  const app = {
    notes: { setName: (address, value) => names.set(String(address), value), nameOf: (address) => names.get(String(address)) || null },
    symbols: { rename: (address, value) => names.set(String(address), `sym:${value}`) },
    viewer: { setSymbols() {} }, updateChrome() {},
  };
  const executor = new CapabilityExecutor({ catalog: { get: (id) => byId.get(id) || null }, app });
  const result = await executor.execute('annotation.rename', { address: '4096', value: 'renamed' }, { authorization: { kind: 'proposal', token: '0123456789abcdef' } });
  assert.equal(result.ok, true);
  assert.equal(names.get('4096'), 'sym:renamed');
}

/* 5. executor turns missing args into invalid_tool_call, never native TypeError */
{
  const app = { notes: { setName() {} }, symbols: { rename() {} }, viewer: { setSymbols() {} }, updateChrome() {} };
  const executor = new CapabilityExecutor({ catalog: { get: (id) => byId.get(id) || null }, app });
  await assert.rejects(
    () => executor.execute('annotation.rename', {}, { authorization: { kind: 'proposal', token: '0123456789abcdef' } }),
    (error) => error.type === 'invalid_tool_call' && /address/.test(error.message),
    'missing address must be an invalid_tool_call domain error',
  );
}

console.log('issue-6257-catalog-input-schemas: ok');
