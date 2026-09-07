import assert from 'node:assert/strict';
import { after, test } from 'node:test';

import { setSemanticMigrationMode } from '../../../js/ir.js';
import { buildSemanticModel, attachTexts } from '../../../js/blocks.js';
import { decompile } from '../../../js/decompile.js';
import { semanticAbiAdapter } from '../../../js/analysis/semantic-function.js';
import { AAPCS64_ABI } from '../../../js/targets/abi/index.js';
import { evaluateExpression } from '../../../js/decompiler/verify/equivalence.js';
import { formatDecompilerSource } from '../../../js/decompiler/provenance.js';

const ABI = semanticAbiAdapter(AAPCS64_ABI);
setSemanticMigrationMode('legacy-v1');
after(() => setSemanticMigrationMode('semantic-v2-compat'));

function modelFor(lines, { base, name }) {
  const raw = lines.map((text, row) => {
    const split = text.indexOf(' ');
    return {
      row,
      address:base + BigInt(row * 4),
      mn:split < 0 ? text : text.slice(0, split),
      ops:split < 0 ? '' : text.slice(split + 1),
    };
  });
  const rowOfAddress = (address) => {
    const delta = BigInt(address) - base;
    return delta >= 0n && delta < BigInt(raw.length * 4) ? Number(delta / 4n) : null;
  };
  return {
    model:buildSemanticModel(raw, {
      startRow:0,
      endRow:raw.length - 1,
      rowOfAddress,
      name,
    }),
    rowOfAddress,
  };
}

test('legacy apply_damage carries the ABI return and exact forwarded field proof', () => {
  const base = 0x100000490n;
  const puts = 0x100001000n;
  const { model, rowOfAddress } = modelFor([
    'stp x29, x30, [sp, #-32]!',
    'mov x29, sp',
    'str x0, [sp, #16]',
    'ldr w8, [x0, #0x20]',
    'ldr w9, [x0, #0x24]',
    'mul w9, w1, w9',
    'sub w8, w8, w9',
    'str w8, [x0, #0x20]',
    'cmp w8, #0',
    'b.gt #0x1000004C4',
    'mov w8, #0',
    'ldr x0, [sp, #16]',
    'str w8, [x0, #0x20]',
    'str w8, [sp, #12]',
    'adrp x0, #0x100000000',
    'add x0, x0, #0x5B4',
    `bl #0x${puts.toString(16)}`,
    'ldr w0, [sp, #12]',
    'ldp x29, x30, [sp], #32',
    'ret',
  ], { base, name:'apply_damage' });
  attachTexts(model, new Map([['4294968756', 'damage dealt to enemy']]));

  const result = decompile(model, {
    abiAdapter:ABI,
    addr:base,
    name:'apply_damage',
    rowOfAddress,
    returnType:'int32',
    receiverType:'Unit',
    functionPrototype:{ returnType:'int32', parameters:[{ type:'Unit *' }, { type:'int32' }] },
    fieldFor:(_base, offset) => offset === 0x20n ? { name:'hp', type:'int32' }
      : offset === 0x24n ? { name:'damageRate', type:'uint32' } : null,
    symbolFor:(address) => BigInt(address) === puts ? '_puts' : null,
  });

  assert.equal(result.semantic, true, result.warnings?.join('\n'));
  assert.doesNotMatch(result.pseudocode, /\b(?:var_|local_phi|phi_)\w*/i, result.pseudocode);
  const ret = result.ir.instructions.find((instruction) => instruction.op === 'ret');
  assert.equal(ret.extra.returnReg, 'x0');
  assert.equal(ret.extra.returnEvidence, 'prototype');
  assert.ok(ret.args?.[0]?.value, 'legacy RET must carry the ABI-proven reaching value');
  const zeroStore = result.lines.find((line) => /self->hp\s*=\s*0;/.test(line.text));
  assert.ok(zeroStore, result.pseudocode);
  assert.equal(formatDecompilerSource(zeroStore), '000498 · 0004B8–0004C0');
});

function selectModel(name, branch) {
  const base = 0x200000000n;
  const merge = base + 14n * 4n;
  const first = base + 8n * 4n;
  return modelFor([
    'sub sp, sp, #16',
    'str w0, [sp, #12]',
    'str w1, [sp, #8]',
    'ldr w8, [sp, #12]',
    'ldr w9, [sp, #8]',
    'subs w8, w8, w9',
    `${branch} #0x${(base + 11n * 4n).toString(16)}`,
    `b #0x${first.toString(16)}`,
    'ldr w8, [sp, #12]',
    'str w8, [sp, #4]',
    `b #0x${merge.toString(16)}`,
    'ldr w8, [sp, #8]',
    'str w8, [sp, #4]',
    `b #0x${merge.toString(16)}`,
    'ldr w0, [sp, #4]',
    'add sp, sp, #16',
    'ret',
  ], { base, name });
}

function signed32(value) { return BigInt.asIntN(32, BigInt(value)); }
function unsigned32(value) { return BigInt.asUintN(32, BigInt(value)); }

for (const [name, branch, expected] of [
  ['max_i32', 'b.le', (a, b) => signed32(a) > signed32(b) ? a : b],
  ['min_i32', 'b.ge', (a, b) => signed32(a) < signed32(b) ? a : b],
]) {
  test(`legacy ${name} resolves nested branch spills at -O0`, () => {
    const { model, rowOfAddress } = selectModel(name, branch);
    const result = decompile(model, {
      abiAdapter:ABI,
      addr:0x200000000n,
      name,
      rowOfAddress,
      returnType:'int32',
      deterministicTransforms:true,
      decompilerTimeBudgetMs:120,
    });
    assert.equal(result.semantic, true, result.warnings?.join('\n'));
    const expression = result.semanticAst.outputs.find((output) => output.name === 'return')?.expression;
    assert.ok(expression, result.pseudocode);
    assert.notEqual(expression.kind, 'load', result.pseudocode);
    for (const [a, b] of [[0n, 1n], [-2n, 1n], [0x80000000n, 0x7fffffffn], [0xffffffffn, 2n]]) {
      const actual = evaluateExpression(expression, { a1:a, a2:b });
      assert.notEqual(actual, null, `${name} must remain evaluable: ${result.pseudocode}`);
      assert.equal(unsigned32(actual), unsigned32(expected(a, b)));
    }
  });
}

console.log('t011 legacy product regressions: ok');
