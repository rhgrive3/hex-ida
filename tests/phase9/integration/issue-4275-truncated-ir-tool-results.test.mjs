import assert from 'node:assert/strict';
import test from 'node:test';
import { buildSemanticModel } from '../../../js/blocks.js';
import { irFor } from '../../../js/ir.js';
import { semanticFacts } from '../../../js/semantic.js';
import { createAgentTools } from '../../../js/agent/tools.js';

const address = 0x1000n;
function fixture(truncated, positive = false) {
  const instructions = positive
    ? [['mov', 'w2, #7'], ['ldr', 'w8, [x0, #0x30]'], ['add', 'w8, w8, #5'], ['str', 'w8, [x0, #0x30]'], ['cmp', 'w8, #10'], ['ret', '']]
    : [['ret', '']];
  const model = buildSemanticModel(instructions.map(([mn, ops], row) => ({ mn, ops, row, address: address + BigInt(row * 4) })), [], []);
  irFor(model).truncated = truncated;
  return { model, tools: createAgentTools({ analyze: async () => model, candidateFunctions: [address] }) };
}
const singleQueries = [
  ['find_field_writers', { offset: 0x30 }], ['find_field_readers', { offset: 0x30 }],
  ['find_thresholds'], ['get_semantic_facts'], ['verify_field_update', { offset: 0x30 }],
];
for (const [name, arg] of singleQueries) {
  test(`${name} does not treat truncated IR as exhaustive`, async () => {
    const { tools } = fixture(true);
    const result = await tools[name](address, arg);
    assert.equal(result.complete, false);
    assert.equal(result.truncated, true);
    assert.equal(result.total, null);
    assert.equal(result.reason, 'semantic-ir-truncated');
    assert.notEqual(result.coverage, 1);
  });
  test(`${name} preserves complete source results`, async () => {
    const { tools } = fixture(false);
    const result = await tools[name](address, arg);
    assert.equal(result.complete, true);
    assert.equal(result.total, name === 'get_semantic_facts' ? result.results.length : 0);
  });
}

test('observed RMW remains positive evidence, never exhaustive coverage', async () => {
  const { tools } = fixture(true, true);
  const result = await tools.verify_field_update(address, { offset: 0x30 });
  assert.equal(result.verified, true);
  assert.ok(result.updates.length > 0);
  assert.ok(result.evidence.length > 0);
  assert.equal(result.complete, false);
  assert.equal(result.total, null);
});

test('constant and evidence searches propagate source truncation across functions', async () => {
  const { model, tools } = fixture(true, true);
  const constants = await tools.find_constant(7n);
  assert.ok(constants.results.length > 0);
  assert.equal(constants.complete, false);
  assert.equal(constants.total, null);
  assert.equal(constants.reason, 'semantic-ir-truncated');
  const ids = semanticFacts(irFor(model)).flatMap(f => (f.evidence || []).map(e => e.id));
  assert.ok(ids.length > 0);
  const result = await tools.explain_evidence(ids);
  assert.ok(result.results.length > 0);
  assert.equal(result.complete, false);
  assert.equal(result.total, null);
  assert.equal(result.reason, 'semantic-ir-truncated');
});

test('missing model is unavailable evidence, not a complete zero', async () => {
  const tools = createAgentTools({ analyze: async () => null });
  const result = await tools.get_semantic_facts(address);
  assert.equal(result.complete, false);
  assert.equal(result.reason, 'semantic-ir-unavailable');
});

test('result pagination remains partial even on a complete source', async () => {
  const { tools } = fixture(false, true);
  const result = await tools.get_semantic_facts(address, { limit: 1 });
  assert.ok(result.total > 1);
  assert.equal(result.returned, 1);
  assert.equal(result.complete, false);
  assert.equal(result.reason, 'result-limit');
});
