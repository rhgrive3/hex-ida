import test from 'node:test';
import assert from 'node:assert/strict';
import { createSemanticCfg } from '../../js/semantics/cfg/index.js';
import { createSemanticSsaContract } from '../../js/semantics/ssa/contract.js';
import { createMemorySsaContract } from '../../js/semantics/memoryssa/contract.js';
import { validateMemorySsa } from '../../js/semantics/memoryssa/validate.js';

const origin = { instructionIds: ['instruction:3908'] };
const cfg = createSemanticCfg({ functionId: 'owner', entryBlockId: 'entry', blocks: [{ id: 'entry', successors: [] }] });
const memoryInput = {
  functionId: 'owner', regions: [{ id: 'r', kind: 'stack-fixed', functionId: 'owner', offset: 0 }],
  definitions: [{ id: 'e', kind: 'entry', regionId: 'r', blockId: 'entry', origin }], uses: [],
};
const ssaInput = {
  functionId: 'owner',
  definitions: [{ definitionId: 'd', valueId: 'v', kind: 'entry', blockId: 'entry', origin }], uses: [],
};
for (const [label, build, input] of [
  ['MemorySSA', createMemorySsaContract, memoryInput],
  ['SSA', createSemanticSsaContract, ssaInput],
]) {
  test(`#3908 ${label}: same block IDs do not authorize a foreign function`, () => {
    assert.throws(() => build(input, { cfg: { ...cfg, functionId: 'foreign' } }), /cfg-function-mismatch/);
  });
  test(`#3908 ${label}: malformed CFG identities cannot alias the owner`, () => {
    let coerced = 0;
    for (const functionId of [undefined, null, '', ' ', ['owner'], 1, { toString() { coerced++; return 'owner'; } }]) {
      assert.throws(() => build(input, { cfg: { ...cfg, functionId } }), /cfg-function-mismatch/);
    }
    assert.equal(coerced, 0);
  });
  test(`#3908 ${label}: matching canonical CFG and omitted CFG remain valid`, () => {
    assert.equal(build(input, { cfg }).functionId, 'owner');
    assert.equal(build({ ...input, functionId: ' owner ' }, { cfg }).functionId, 'owner');
    assert.equal(build(input).functionId, 'owner');
    assert.equal(build(input, { cfg: null }).functionId, 'owner');
  });
}
test('#3908 validator rejects foreign CFG for a previously canonical MemorySSA', () => {
  const artifact = createMemorySsaContract(memoryInput, { cfg });
  assert.doesNotThrow(() => validateMemorySsa(artifact, { cfg }));
  assert.throws(() => validateMemorySsa(artifact, { cfg: { ...cfg, functionId: 'foreign' } }), /cfg-function-mismatch/);
});
