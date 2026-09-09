import test from 'node:test';
import assert from 'node:assert/strict';

import { RISCV_LP64D_ABI } from '../../../js/targets/abi/riscv-lp64.js';

// #5615: the psABI vector calling convention allocator must re-scan from v8
// for every argument (a smaller later argument may take the alignment hole a
// larger earlier one left behind) and must give only the FIRST mask argument
// v0 — later masks allocate a normal unused group from v8..v23.

const VECTOR_CC = 'riscv_vector_cc';

function classify(args) {
  return RISCV_LP64D_ABI.classifyArguments({
    callPrototype: { args, callingConvention: VECTOR_CC },
  });
}

function regsOf(result, index) {
  const argument = result.arguments.find((entry) => entry?.index === index);
  assert.ok(argument, `argument ${index} must classify`);
  return argument.regs ?? (argument.reg ? [argument.reg] : []);
}

test('#5615 a smaller later argument reuses the alignment hole from v8', () => {
  // psABI's own shape: m1 -> v8; m2 -> v10-v11 (v9 is an alignment hole for
  // an LMUL=2 start); the final m1 must re-scan from v8 and take v9.
  const result = classify([
    { type: 'vint32m1_t', abiClass: 'vector' },
    { type: 'vint32m2_t', abiClass: 'vector' },
    { type: 'vint32m1_t', abiClass: 'vector' },
  ]);
  assert.deepEqual(regsOf(result, 0), ['v8']);
  assert.deepEqual(regsOf(result, 1), ['v10', 'v11']);
  assert.deepEqual(regsOf(result, 2), ['v9'],
    'the allocator must restart its search at v8 instead of only looking past the cursor');
});

test('#5615 only the first mask argument takes v0; later masks allocate from v8', () => {
  const result = classify([
    { type: 'vbool64_t', abiClass: 'vector' },
    { type: 'vbool64_t', abiClass: 'vector' },
  ]);
  assert.deepEqual(regsOf(result, 0), ['v0'], 'the first mask argument is v0');
  assert.deepEqual(regsOf(result, 1), ['v8'],
    'a second mask argument is a regular v8..v23 group, not v0 again');
});

test('#5615 exhausted register space still fails closed', () => {
  // v8..v23 hold exactly sixteen LMUL=1 groups; a seventeenth cannot fit and
  // must fail closed instead of minting an exact slot.
  const args = Array.from({ length: 17 }, () => ({ type: 'vint32m1_t', abiClass: 'vector' }));
  const result = classify(args);
  const seventeenth = result.arguments.find((entry) => entry?.index === 16);
  assert.ok(seventeenth, 'the seventeenth argument must still classify');
  assert.equal(seventeenth.exact, false, 'no exact slot may be minted past the vector registers');
});
