import test from 'node:test';
import assert from 'node:assert/strict';

import { RISCV_LP64D_ABI } from '../../../js/targets/abi/riscv-lp64.js';

// #5628: standard RVV tuple typedefs spell `m<LMUL>x<NFIELDS>` (e.g.
// vint32m2x3_t). The type-string recognizer only matched `m<LMUL>` followed by
// `_t`/boundary and had no NFIELDS path, so a 6-register tuple collapsed to
// one register while still reporting exact:true. Per the psABI vector calling
// convention variant a tuple needs LMUL x NFIELDS consecutive vector
// registers, and explicit metadata must keep outranking the spelling.
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

test('#5628 vint32m2x3_t allocates six consecutive grouped registers', () => {
  const result = classify([{ type: 'vint32m2x3_t', abiClass: 'vector' }]);
  assert.deepEqual(regsOf(result, 0), ['v8', 'v9', 'v10', 'v11', 'v12', 'v13'],
    'LMUL=2 x NFIELDS=3 needs 6 consecutive registers from v8');
  const first = result.arguments.find((entry) => entry?.index === 0);
  assert.deepEqual(first.vector, { mask: false, lmul: 2, tupleCount: 3, fixedLength: false });
});

test('#5628 the next tuple argument continues after the previous group', () => {
  const result = classify([
    { type: 'vint32m2x3_t', abiClass: 'vector' },
    { type: 'vint32m2x2_t', abiClass: 'vector' },
  ]);
  assert.deepEqual(regsOf(result, 1), ['v14', 'v15', 'v16', 'v17'],
    'NFIELDS=2 at LMUL=2 needs 4 registers after v8..v13');
});

test('#5628 explicit metadata still outranks the type-string spelling', () => {
  const result = classify([{ type: 'vint32m2x3_t', abiClass: 'vector', lmul: 1, tupleCount: 2 }]);
  assert.equal(regsOf(result, 0).length, 2, 'explicit lmul/tupleCount metadata stays authoritative');
});

test('#5628 non-tuple vector spellings keep their previous recognition', () => {
  const result = classify([{ type: 'vint32m4_t', abiClass: 'vector' }]);
  assert.equal(regsOf(result, 0).length, 4, 'm4 without xN stays a 4-register group');
});

test('#5628 tuple returns reserve LMUL x NFIELDS result registers', () => {
  const returned = RISCV_LP64D_ABI.classifyFunctionReturn({
    functionPrototype: { returnType: 'vint32m2x3_t', abiClass: 'vector', callingConvention: VECTOR_CC },
  });
  assert.deepEqual(returned.regs, ['v8', 'v9', 'v10', 'v11', 'v12', 'v13'],
    'a 6-register tuple return must be reported as such');
});
