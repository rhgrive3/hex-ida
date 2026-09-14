import assert from 'node:assert/strict';
import test from 'node:test';

import { RISCV_LP64_ABI, RISCV_LP64D_ABI } from '../../../js/targets/abi/riscv-lp64.js';

/* A struct Big { uint64_t a,b,c; } is 24 bytes > 2*XLEN, so the psABI returns
 * it in memory and the caller passes its storage pointer as the implicit first
 * integer argument (a0/x10). The argument classifier must derive that hidden
 * pointer from the same canonical return decision as the return classifier,
 * without requiring the provider to duplicate `indirectResult:true`. */
const BIG_RETURN = {
  returnType:'struct Big',
  aggregate:true,
  returnBits:192,
  bits:192,
  bytes:24,
  members:[
    { bits:64, bytes:8, byteOffset:0 },
    { bits:64, bytes:8, byteOffset:8 },
    { bits:64, bytes:8, byteOffset:16 },
  ],
  padding:[],
  returnsValue:true,
};

for (const [label, abi] of [['riscv-lp64', RISCV_LP64_ABI], ['riscv-lp64d', RISCV_LP64D_ABI]]) {
  test(`${label}: proven large aggregate return inserts the hidden a0 result pointer`, () => {
    const result = abi.classifyArguments({ callPrototype:{ ...BIG_RETURN, args:[{ type:'uint64_t', bits:64 }] } });
    const hidden = result.arguments.find((entry) => entry?.role === 'indirect-result');
    assert.ok(hidden, 'hidden indirect-result entry must be published');
    assert.equal(hidden.reg, 'x10');
    assert.equal(hidden.abiName, 'a0');
    assert.equal(hidden.pointer, true);
    assert.equal(hidden.hidden, true);

    const firstUser = result.arguments.find((entry) => entry?.index === 0);
    assert.equal(firstUser?.reg, 'x11', 'first user argument must move to a1/x11');
    assert.equal(firstUser?.abiName, 'a1');
    assert.equal(firstUser?.mustUse, true);
    assert.equal(firstUser?.exact, true);
    assert.equal(result.partial, false);
    assert.equal(result.completeness, 'exact');
  });

  test(`${label}: four user arguments shift the whole register frontier`, () => {
    const result = abi.classifyArguments({
      callPrototype:{
        ...BIG_RETURN,
        args:[
          { type:'uint64_t' }, { type:'uint64_t' }, { type:'uint64_t' }, { type:'uint64_t' },
        ],
      },
    });
    const userRegs = result.arguments
      .filter((entry) => Number.isInteger(entry?.index) && entry.index >= 0)
      .map((entry) => entry.reg);
    assert.deepEqual(userRegs, ['x11', 'x12', 'x13', 'x14'],
      'user arguments must occupy a1-a4 after the hidden result pointer');
    assert.equal(result.partial, false);
  });

  test(`${label}: explicit indirectResult provider metadata still wins unchanged`, () => {
    const result = abi.classifyArguments({
      callPrototype:{ ...BIG_RETURN, indirectResult:true, args:[{ type:'uint64_t' }] },
    });
    const hidden = result.arguments.find((entry) => entry?.role === 'indirect-result');
    assert.ok(hidden, 'explicit indirect-result metadata must keep inserting a0');
    assert.equal(hidden.reg, 'x10');
    const firstUser = result.arguments.find((entry) => entry?.index === 0);
    assert.equal(firstUser?.reg, 'x11');
    assert.equal(result.returnClassification, 'indirect');
  });

  test(`${label}: unproven aggregate return size fails argument placement closed`, () => {
    const result = abi.classifyArguments({
      callPrototype:{
        ...BIG_RETURN,
        // No bits/bytes/member evidence: return size is unproven, so the
        // hidden-result presence itself is unknown.
        returnBits:undefined,
        bits:undefined,
        bytes:undefined,
        members:undefined,
        padding:undefined,
        args:[{ type:'uint64_t' }],
      },
    });
    assert.equal(result.partial, true, 'unproven return size must make classification partial');
    assert.equal(result.completeness, 'partial');
    const exactEntries = result.arguments.filter((entry) => entry?.exact === true || entry?.mustUse === true);
    assert.deepEqual(exactEntries, [],
      'no exact/must-use argument placement may be minted while the hidden-result presence is unknown');
  });

  test(`${label}: small proven aggregate return keeps direct placement without a hidden pointer`, () => {
    const result = abi.classifyArguments({
      callPrototype:{
        returnType:'struct Pair',
        aggregate:true,
        returnBits:128,
        bits:128,
        bytes:16,
        members:[{ bits:64, bytes:8, byteOffset:0 }, { bits:64, bytes:8, byteOffset:8 }],
        padding:[],
        returnsValue:true,
        args:[{ type:'uint64_t' }],
      },
    });
    const hidden = result.arguments.find((entry) => entry?.role === 'indirect-result');
    assert.equal(hidden, undefined, 'a <=2*XLEN return never takes a hidden result pointer');
    const firstUser = result.arguments.find((entry) => entry?.index === 0);
    assert.equal(firstUser?.reg, 'x10', 'first user argument stays in a0');
    assert.equal(result.partial, false);
  });
}
