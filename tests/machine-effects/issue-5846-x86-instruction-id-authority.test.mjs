import assert from 'node:assert/strict';

import { createX86DecodedInstruction } from '../../js/targets/architecture/x86_64/decoded-instruction.js';
import { createX86EffectContext } from '../../js/targets/architecture/x86_64/effects/common.js';

function probe(overrides = {}) {
  return {
    address:0n,
    length:1,
    rawBytes:Uint8Array.of(0x90),
    mode:'long-64',
    instructionCode:1,
    instructionFamily:'probe',
    mnemonic:'probe',
    detailAvailable:true,
    detailStatus:'complete',
    detail:{ operandCount:0, operands:[] },
    ...overrides,
  };
}

const explicit = createX86DecodedInstruction(probe({ instructionId:'  x86:explicit  ' }));
assert.equal(explicit.instructionId, 'x86:explicit');

const withoutId = createX86DecodedInstruction(probe());
assert.equal(withoutId.instructionId, undefined);

const context = createX86EffectContext(withoutId, { instructionId:'  x86:context  ' });
assert.equal(context.instructionId, 'x86:context');
assert.equal(context.instruction.instructionId, 'x86:context');
assert.match(context.temporary(8, 'probe').temporaryId, /^x86:context:probe:/);

const defaultOriginBundle = context.finish({
  statePreservation:{ proven:true, reason:'issue-5846-default-origin-probe' },
});
assert.equal(defaultOriginBundle.instructionId, 'x86:context');
assert.deepEqual(defaultOriginBundle.origin.instructionIds, ['x86:context']);

const explicitOriginContext = createX86EffectContext(probe({
  instructionId:'  x86:origin  ',
  origin:{ instructionIds:['  x86:origin  '] },
}));
const explicitOriginBundle = explicitOriginContext.finish({
  statePreservation:{ proven:true, reason:'issue-5846-explicit-origin-probe' },
});
assert.equal(explicitOriginBundle.instructionId, 'x86:origin');
assert.deepEqual(explicitOriginBundle.origin.instructionIds, ['x86:origin']);

let coercions = 0;
const hostile = {
  toString() {
    coercions++;
    return 'x86:laundered';
  },
};

for (const malformed of [
  ['x86:array'],
  hostile,
  true,
  1,
  Symbol('x86:symbol'),
  '',
  '   ',
]) {
  assert.throws(
    () => createX86DecodedInstruction(probe({ instructionId:malformed })),
    /x86-decoded-instruction-invalid-instruction-id/,
  );
}
assert.equal(coercions, 0, 'instructionId validation must not invoke user coercion hooks');

for (const malformed of [
  ['x86:context-array'],
  hostile,
  false,
  7,
]) {
  assert.throws(
    () => createX86EffectContext(probe(), { instructionId:malformed }),
    /x86-decoded-instruction-invalid-instruction-id/,
  );
}
assert.equal(coercions, 0, 'context fallback must use the same non-coercing authority gate');
