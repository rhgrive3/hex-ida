import assert from 'node:assert/strict';
import { buildSemanticModel, attachTexts } from '../../js/blocks.js';
import { decompile } from '../../js/decompile.js';
import { setSemanticMigrationMode } from '../../js/ir.js';
import { semanticAbiAdapter } from '../../js/analysis/semantic-function.js';
import { AAPCS64_ABI } from '../../js/targets/abi/index.js';

setSemanticMigrationMode('legacy-v1');

const base = 0x100000490n;
const puts = 0x100001000n;
const lines = [
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
];
const raw = lines.map((text, row) => {
  const p = text.indexOf(' ');
  return {
    row,
    address: base + BigInt(row * 4),
    mn: p < 0 ? text : text.slice(0, p),
    ops: p < 0 ? '' : text.slice(p + 1),
  };
});
const rowOfAddress = (addr) => {
  const d = BigInt(addr) - base;
  return d >= 0n && d < BigInt(raw.length * 4) ? Number(d / 4n) : null;
};
const model = buildSemanticModel(raw, {
  startRow: 0,
  endRow: raw.length - 1,
  rowOfAddress,
  symbolFor: (addr) => BigInt(addr) === puts ? '_puts' : null,
  name: 'apply_damage',
});
attachTexts(model, new Map([['4294968756', 'damage dealt to enemy']]));
const result = decompile(model, {
  abiAdapter: semanticAbiAdapter(AAPCS64_ABI),
  addr: base,
  name: 'apply_damage',
  rowOfAddress,
  returnType: 'int32',
  receiverType: 'Unit',
  beginner: false,
  deterministicTransforms: true,
  functionPrototype: { returnType: 'int32', parameters: [{ type: 'Unit *' }, { type: 'int32' }] },
  symbolFor: (addr) => BigInt(addr) === puts ? '_puts' : null,
  fieldFor: (_base, off) => off === 0x20n ? { name: 'hp', type: 'int32' }
    : off === 0x24n ? { name: 'damageRate', type: 'uint32' } : null,
});

const scalar = (value) => {
  if (typeof value === 'bigint') return value.toString();
  return ['string', 'number', 'boolean'].includes(typeof value) ? value : null;
};
const blockId = (block) => scalar(block) ?? scalar(block?.key) ?? scalar(block?.id) ?? scalar(block?.label);
const locShape = (loc) => {
  if (!loc) return null;
  if (scalar(loc) != null) return scalar(loc);
  return {
    kind: scalar(loc.kind),
    base: scalar(loc.base) ?? scalar(loc.base?.id) ?? scalar(loc.base?.reg),
    offset: scalar(loc.offset),
    size: scalar(loc.size),
  };
};
const instShape = (inst) => {
  if (!inst) return null;
  if (scalar(inst) != null) return scalar(inst);
  return {
    id: scalar(inst.id),
    op: scalar(inst.op),
    row: scalar(inst.row),
    block: blockId(inst.block),
  };
};
const arg = (entry) => ({
  kind: scalar(entry?.kind),
  bits: scalar(entry?.bits),
  valueId: scalar(entry?.value?.id),
  valueReg: scalar(entry?.value?.reg),
  valueDefOp: scalar(entry?.value?.def?.op),
  valueDefRow: scalar(entry?.value?.def?.row),
});
const values = (result.ir?.values || [])
  .filter((value) => value?.def?.op === 'phi' || value?.def?.op === 'load')
  .map((value) => ({
    id: scalar(value.id),
    reg: scalar(value.reg),
    bits: scalar(value.bits),
    def: {
      id: scalar(value.def?.id),
      op: scalar(value.def?.op),
      row: scalar(value.def?.row),
      block: blockId(value.def?.block),
      loc: locShape(value.def?.loc),
      args: (value.def?.args || []).map(arg),
      incoming: (value.def?.incoming || []).map((incoming) => ({
        from: blockId(incoming?.from),
        valueId: scalar(incoming?.value?.id),
        valueReg: scalar(incoming?.value?.reg),
        valueBits: scalar(incoming?.value?.bits),
        valueDefOp: scalar(incoming?.value?.def?.op),
        valueDefRow: scalar(incoming?.value?.def?.row),
      })),
    },
  }));
const instructions = (result.ir?.instructions || [])
  .filter((inst) => ['store', 'load', 'call', 'phi'].includes(inst?.op))
  .map((inst) => ({
    id: scalar(inst.id),
    op: scalar(inst.op),
    row: scalar(inst.row),
    block: blockId(inst.block),
    loc: locShape(inst.loc),
    args: (inst.args || []).map(arg),
    memDef: instShape(inst.memDef),
    memKills: Array.from(inst.memKills || []).map(locShape),
  }));
const diagnostic = { pseudocode: result.pseudocode, values, instructions };
console.error('LEGACY_APPLY_DAMAGE_PROVENANCE ' + JSON.stringify(diagnostic, null, 2));
assert.fail('intentional legacy apply_damage provenance diagnostic');
