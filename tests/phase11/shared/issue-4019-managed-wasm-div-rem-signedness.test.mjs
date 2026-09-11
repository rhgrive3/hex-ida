import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createManagedMethodId, createVMEffectBundle, createVMEffectFunction,
  createVMOperationId, decompileManagedMethod, lowerVMEffectsToSemanticIr,
} from '../../../js/managed/index.js';
import { evalBinary } from '../../../js/decompiler/truth/integer.js';

function lower(mnemonic, bits = 32) {
  const methodId = createManagedMethodId(`issue-4019-${mnemonic}-${bits}`, 'binary');
  const bundle = (offset, input) => createVMEffectBundle({
    frontendId: 'wasm', methodId,
    operationId: createVMOperationId(methodId, offset), bytecodeOffset: offset,
    completeness: 'exact', ...input,
  });
  const fn = createVMEffectFunction({
    frontendId: 'wasm', methodId, aggregateCompleteness: 'exact', resolutionCompleteness: 'complete',
    bundles: [
      bundle(0, { mnemonic: `i${bits}.const`, producedValues: [{ bits, constant: bits === 64 ? 0xffffffffffffffffn : 0xffffffff }] }),
      bundle(1, { mnemonic: `i${bits}.const`, producedValues: [{ bits, constant: 2 }] }),
      bundle(2, { mnemonic, consumedValues: [{ id: 'rhs', bits }, { id: 'lhs', bits }], producedValues: [{ bits }] }),
      bundle(3, { mnemonic: 'return', consumedValues: [{ id: 'result', bits }], controlEffects: [{ kind: 'return' }] }),
    ],
  });
  return lowerVMEffectsToSemanticIr(fn);
}

function decompile(mnemonic, bits = 32) { return decompileManagedMethod(lower(mnemonic, bits)); }

for (const bits of [32, 64]) {
  test(`WASM i${bits} div/rem signedness survives Semantic IR -> AST`, () => {
    const cases = [
      [`i${bits}.div_u`, /\(uint(?:32|64)_t\)/, /\(int(?:32|64)_t\)/],
      [`i${bits}.div_s`, /\(int(?:32|64)_t\)|-1 \/ 2/, /\(uint(?:32|64)_t\)/],
      [`i${bits}.rem_u`, bits === 64 ? /0xFFFFFFFFFFFFFFFF % 2/ : /0xFFFFFFFF % 2/, /-1 % 2/],
      [`i${bits}.rem_s`, /-1 % 2/, bits === 64 ? /0xFFFFFFFFFFFFFFFF % 2/ : /0xFFFFFFFF % 2/],
    ];
    for (const [mnemonic, yes, no] of cases) {
      const lowered = lower(mnemonic, bits);
      const n = lowered.semanticIr.nodes.find((x) => x.metadata?.mnemonic === mnemonic);
      assert.equal(n.kind, 'binary');
      assert.equal(n.metadata.mnemonic, mnemonic);
      const out = decompileManagedMethod(lowered).pseudocode;
      assert.match(out, yes, mnemonic);
      assert.doesNotMatch(out, no, mnemonic);
    }
  });
}

test('high-bit concrete truth distinguishes unsigned from signed div/rem', () => {
  assert.equal(evalBinary('udiv', 0xffffffffn, 2n, 32), 0x7fffffffn);
  assert.equal(evalBinary('sdiv', 0xffffffffn, 2n, 32), 0n);
  assert.equal(evalBinary('umod', 0xffffffffn, 2n, 32), 1n);
  assert.equal(evalBinary('smod', 0xffffffffn, 2n, 32), 0xffffffffn);
  assert.equal(evalBinary('udiv', 0xffffffffffffffffn, 2n, 64), 0x7fffffffffffffffn);
  assert.equal(evalBinary('sdiv', 0xffffffffffffffffn, 2n, 64), 0n);
});

test('unknown or contradictory WASM div authority fails closed', () => {
  const unknown = decompile('i32.div_future').pseudocode;
  assert.match(unknown, /i32_div_future\(/);
  assert.doesNotMatch(unknown, / [/%] /);

  const generic = structuredClone(lower('i32.div_u'));
  const gn = generic.semanticIr.nodes.find((x) => x.metadata?.mnemonic === 'i32.div_u');
  gn.operator = 'div';
  assert.match(decompileManagedMethod(generic).pseudocode, /\(uint32_t\)/);

  const conflict = structuredClone(lower('i32.div_u'));
  const cn = conflict.semanticIr.nodes.find((x) => x.metadata?.mnemonic === 'i32.div_u');
  cn.operator = 'sdiv';
  const out = decompileManagedMethod(conflict).pseudocode;
  assert.match(out, /i32_div_u\(/);
  assert.doesNotMatch(out, / [/%] /);

  const divRemConflict1 = structuredClone(lower('i32.div_u'));
  const drc1 = divRemConflict1.semanticIr.nodes.find((x) => x.metadata?.mnemonic === 'i32.div_u');
  drc1.operator = 'rem';
  const out1 = decompileManagedMethod(divRemConflict1).pseudocode;
  assert.match(out1, /i32_div_u\(/);
  assert.doesNotMatch(out1, / [/%] /);

  const divRemConflict2 = structuredClone(lower('i32.rem_u'));
  const drc2 = divRemConflict2.semanticIr.nodes.find((x) => x.metadata?.mnemonic === 'i32.rem_u');
  drc2.operator = 'div';
  const out2 = decompileManagedMethod(divRemConflict2).pseudocode;
  assert.match(out2, /i32_rem_u\(/);
  assert.doesNotMatch(out2, / [/%] /);
});
