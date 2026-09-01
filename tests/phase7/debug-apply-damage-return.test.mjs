import { appendFileSync } from 'node:fs';
import { buildSemanticModel, attachTexts } from '../../js/blocks.js';
import { decompile } from '../../js/decompile.js';
import { semanticAbiAdapter } from '../../js/analysis/semantic-function.js';
import { AAPCS64_ABI } from '../../js/targets/abi/index.js';

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
  return { row, address:base + BigInt(row * 4), mn:p < 0 ? text : text.slice(0, p), ops:p < 0 ? '' : text.slice(p + 1) };
});
const rowOfAddress = (addr) => {
  const d = BigInt(addr) - base;
  return d >= 0n && d < BigInt(raw.length * 4) ? Number(d / 4n) : null;
};
const model = buildSemanticModel(raw, {
  startRow:0, endRow:raw.length - 1, rowOfAddress,
  symbolFor:(addr) => BigInt(addr) === puts ? '_puts' : null,
  name:'apply_damage',
});
attachTexts(model, new Map([['4294968756', 'damage dealt to enemy']]));
const r = decompile(model, {
  abiAdapter:semanticAbiAdapter(AAPCS64_ABI), addr:base, name:'apply_damage', rowOfAddress,
  returnType:'int32', receiverType:'Unit', beginner:false, deterministicTransforms:true,
  functionPrototype:{ returnType:'int32', parameters:[{ type:'Unit *' }, { type:'int32' }] },
  symbolFor:(addr) => BigInt(addr) === puts ? '_puts' : null,
  fieldFor:(_base, off) => off === 0x20n ? { name:'hp', type:'int32' }
    : off === 0x24n ? { name:'damageRate', type:'uint32' } : null,
});

const values = (r.ir?.values || []).filter((v) => v?.def?.op === 'phi' || (v?.def?.op === 'load' && v.def.loc?.kind === 'stack'))
  .map((v) => ({ id:v.id, reg:v.reg, bits:v.bits, def:{ id:v.def?.id, op:v.def?.op, row:v.def?.row, block:v.def?.block, loc:v.def?.loc, extra:v.def?.extra, incoming:v.def?.incoming?.map((x) => ({ from:x.from, valueId:x.value?.id, valueReg:x.value?.reg, valueDef:{ id:x.value?.def?.id, op:x.value?.def?.op, row:x.value?.def?.row } })) } }));
const stores = (r.ir?.instructions || []).filter((i) => i?.op === 'store')
  .map((i) => ({ id:i.id, row:i.row, block:i.block, loc:i.loc, valueId:i.args?.[0]?.value?.id, valueReg:i.args?.[0]?.value?.reg, memDef:i.memDef, extra:i.extra }));
const blocks = (r.ir?.blocks || []).map((b) => ({ index:b.index, startRow:b.startRow, endRow:b.endRow, pred:b.pred, succ:b.succ, idom:b.idom, insts:(b.insts || []).map((i) => ({ id:i.id, row:i.row, op:i.op, loc:i.loc?.key ?? null })) }));
const astStores = (r.semanticAst?.stores || []).map((s) => ({ location:s.location, source:s.source, value:s.value }));
const outputs = (r.semanticAst?.outputs || []).map((o) => ({ name:o.name, expression:o.expression }));
const debug = JSON.stringify({ pseudocode:r.pseudocode, values, stores, blocks, astStores, outputs }, (_k, v) => typeof v === 'bigint' ? v.toString() : v, 2);
console.error('APPLY_DAMAGE_DEBUG ' + debug);
appendFileSync('reports/phase7/phase7-release-evidence.md', `\n\n## APPLY_DAMAGE_DEBUG\n\n\`\`\`json\n${debug}\n\`\`\`\n`);
throw new Error('intentional apply_damage provenance diagnostic');
