import assert from 'node:assert/strict';

import { buildLocalFunctionSummary } from '../../../js/analysis/summary/local.js';

const base = { id: 'load-1', kind: 'load', memory: { addressSpace: 'memory' }, origin: { instructionIds: [] } };
const irWith = (origin) => ({ functionId: 'fn-A', values: [], nodes: [{ ...base, origin }] });
const readEvidence = (result) => result.summary.memoryReadRegions[0]?.evidenceIds;

const canonical = buildLocalFunctionSummary(
  irWith({ instructionIds: ['insn-1', 'insn-2', 'insn-1'] }),
  null, null, null, { snapshotId: 'snapshot-1' },
);
assert.deepEqual(readEvidence(canonical), ['insn-1', 'insn-2'], 'primitive non-empty instruction IDs keep working and dedupe');

const empty = buildLocalFunctionSummary(irWith({}), null, null, null, { snapshotId: 'snapshot-1' });
assert.deepEqual(readEvidence(empty), [], 'absent instruction origin stays empty');

const missingOrigin = buildLocalFunctionSummary(
  { functionId: 'fn-A', values: [], nodes: [{ id: 'load-1', kind: 'load', memory: { addressSpace: 'memory' } }] },
  null, null, null, { snapshotId: 'snapshot-1' },
);
assert.deepEqual(readEvidence(missingOrigin), [], 'missing origin stays empty');

for (const malformedElement of [['insn-1'], [{ id: 'insn-1' }], [42], [true], [null], [''], [NaN]]) {
  assert.throws(
    () => buildLocalFunctionSummary(irWith({ instructionIds: [malformedElement] }), null, null, null, { snapshotId: 'snapshot-1' }),
    /summary-invalid-instruction-evidence/,
    `malformed instruction evidence element ${JSON.stringify(malformedElement)} must fail closed`,
  );
}

assert.throws(
  () => buildLocalFunctionSummary(irWith({ instructionIds: 'insn-1' }), null, null, null, { snapshotId: 'snapshot-1' }),
  /summary-invalid-instruction-evidence/,
  'a bare string is not an instruction evidence array',
);

console.log('#5776 local summary instruction evidence fail-closed: PASS');
