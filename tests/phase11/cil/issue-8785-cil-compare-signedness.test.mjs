import assert from 'node:assert/strict';
import { buildCil } from '../fixtures/medium-cil.mjs';
import { parseCil } from '../../../js/managed/cil/parser.js';
import { liftCilMethod } from '../../../js/managed/cil/lifter.js';
import { lowerVMEffectsToSemanticIr, decompileManagedMethod } from '../../../js/managed/index.js';

console.log('[phase11] running CIL clt/cgt/ceq compare signedness regression (#8785)...');

const VOID = [0x00, 0x00, 0x01];

function loweredPipeline(body) {
  const image = parseCil(buildCil({ methods: [{ name: 'F', body, signature: VOID }] }).bytes);
  const fn = liftCilMethod(0, image);
  const lowered = lowerVMEffectsToSemanticIr(fn);
  return {
    fn,
    lowered,
    bundle: (mnemonic) => fn.bundles.find(b => b.mnemonic === mnemonic) ?? null,
    node: (mnemonic) => lowered.semanticIr.nodes.find(n => n.metadata?.mnemonic === mnemonic) ?? null,
    pseudocode: () => decompileManagedMethod(lowered).pseudocode,
  };
}

const POP_RET = [0x26, 0x2a];
const CLT = 0xfe04, CGT = 0xfe02, CEQ = 0xfe01;

// 1. Signed integer compares carry structured compare authority all the way to a
// canonical Semantic IR operator, and stay exact.
{
  const cases = [
    ['clt', CLT, 'lt', 'signed', 'slt', '-1 < 0'],
    ['cgt', CGT, 'gt', 'signed', 'sgt', '-1 > 0'],
    ['ceq', CEQ, 'eq', null, 'eq', null],
  ];
  for (const [mnemonic, subOp, predicate, signedness, operator, rendered] of cases) {
    const run = loweredPipeline([0x15, 0x16, subOp >>> 8, subOp & 0xff, ...POP_RET]);
    assert.deepEqual(run.bundle(mnemonic).compare,
      { predicate, signedness, operandBits: 32, arity: 2 }, `${mnemonic}: bundle authority`);
    const node = run.node(mnemonic);
    assert.equal(node.kind, 'compare', `${mnemonic}: node kind`);
    assert.equal(node.operator, operator, `${mnemonic}: canonical operator`);
    assert.equal(node.completeness, 'complete', `${mnemonic}: within budget the compare stays exact`);
    assert.equal(run.lowered.semanticIr.completeness, 'complete', `${mnemonic}: function completeness`);
    if (rendered != null) {
      const compareLine = run.pseudocode().split('\n')
        .find(line => /[<>]/.test(line) && !line.includes('pop(')) ?? '';
      assert.ok(compareLine.includes(rendered), `${mnemonic}: renders ${rendered}, got ${compareLine}`);
      // The signed comparison must not print its operands as unsigned literals,
      // which is what inverted the reported high-bit signed comparison.
      assert.ok(!/0x[0-9A-Fa-f]{8}/.test(compareLine), `${mnemonic}: no unsigned-literal misrender at the compare`);
    }
  }
}

// 2. The inversion the report measured is gone in both directions: -1 < 0 is
// true and -1 > 0 is false for signed int32, never the 0xFFFFFFFF reading.
{
  const clt = loweredPipeline([0x15, 0x16, 0xfe, 0x04, ...POP_RET]);
  const cgt = loweredPipeline([0x15, 0x16, 0xfe, 0x02, ...POP_RET]);
  assert.ok(clt.pseudocode().includes('-1 < 0'));
  assert.ok(!clt.pseudocode().includes('0xFFFFFFFF < 0'));
  assert.ok(cgt.pseudocode().includes('-1 > 0'));
  assert.ok(!cgt.pseudocode().includes('0xFFFFFFFF > 0'));
}

// 3. 64-bit integer operands keep their own width authority.
{
  const run = loweredPipeline([
    0x21, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, // ldc.i8 -1
    0x21, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, // ldc.i8 0
    0xfe, 0x04, ...POP_RET, // clt
  ]);
  assert.deepEqual(run.bundle('clt').compare, { predicate: 'lt', signedness: 'signed', operandBits: 64, arity: 2 });
  assert.equal(run.node('clt').operator, 'slt');
  assert.ok(run.pseudocode().includes('-1 < 0'));
}

// 4. Mixed-width operands cannot be pinned to one signed integer domain.
{
  const run = loweredPipeline([
    0x20, 0x00, 0x00, 0x00, 0x00, // ldc.i4 0
    0x21, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, // ldc.i8 0
    0xfe, 0x04, ...POP_RET,
  ]);
  const node = run.node('clt');
  assert.equal(node.operator, null);
  assert.equal(node.completeness, 'partial');
  assert.ok(run.lowered.semanticIr.unknowns.some(u => u.reason === 'cil-compare-operand-authority-unresolved'));
}

// 5. A reference comparison never inherits integer signedness: it fails closed
// instead of publishing kind=compare with operator=null as complete.
{
  const run = loweredPipeline([0x14, 0x14, 0xfe, 0x04, ...POP_RET]); // ldnull, ldnull, clt
  assert.equal(run.bundle('clt').compare ?? null, null, 'no compare authority is minted for references');
  const node = run.node('clt');
  assert.equal(node.kind, 'compare');
  assert.equal(node.operator, null);
  assert.notEqual(node.completeness, 'complete', 'an unauthorized compare spelling is never complete');
  assert.equal(node.completeness, 'partial');
  assert.equal(run.lowered.semanticIr.completeness, 'partial');
  assert.ok(run.lowered.semanticIr.unknowns.some(u => u.reason === 'cil-compare-operand-authority-unresolved'));
}

// 6. A compare result is an int32 flag, so a chained compare keeps its authority.
{
  const run = loweredPipeline([0x15, 0x16, 0xfe, 0x04, 0x16, 0xfe, 0x01, ...POP_RET]);
  // ldc.i4.m1, ldc.i4.0, clt, ldc.i4.0, ceq
  assert.equal(run.node('clt').operator, 'slt');
  assert.deepEqual(run.bundle('ceq').compare, { predicate: 'eq', signedness: null, operandBits: 32, arity: 2 });
  assert.equal(run.node('ceq').operator, 'eq');
  assert.equal(run.lowered.semanticIr.completeness, 'complete');
}

console.log('  ok CIL clt/cgt/ceq compare signedness regression passed');
