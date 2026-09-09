import assert from 'node:assert/strict';
import { adaptPatchSetToRebuildPlan } from '../../../js/rebuild/index.js';
import { PatchSet } from '../../../js/patch.js';

const input = { binaryId:'bin', sourceHash:'hash' };
for (const patchSet of [null, undefined, {}, { list:true }, { list:{} }, { list:[] }, { list:'x' }]) {
  assert.throws(
    () => adaptPatchSetToRebuildPlan(patchSet, input),
    (error) => error instanceof TypeError && error.message === 'PatchSet required',
    `non-callable list must fail at the adapter boundary: ${String(patchSet?.list)}`,
  );
}

const duck = adaptPatchSetToRebuildPlan({ list(){ return []; } }, input);
assert.equal(duck.binaryId, 'bin');
assert.equal(duck.sourceHash, 'hash');
assert.deepEqual(duck.operations, []);

const concrete = adaptPatchSetToRebuildPlan(new PatchSet(), input);
assert.deepEqual(concrete.operations, []);

console.log('issue #4142 callable PatchSet list contract: PASS');
