import assert from 'node:assert/strict';
import { buildSemanticModel } from '../js/blocks.js';
import { buildIR, OP } from '../js/ir.js';
import { stackPointerProvenanceOf } from '../js/ir-core.js';
import { restoreLegacyPrivateStackForwarding } from '../js/legacy-stack-compat-repair.js';

const BASE = 0x100000000n;
function modelOf(lines) {
  const rows = lines.map((line, i) => {
    const s = String(line).trim();
    const p = s.indexOf(' ');
    return { row:i, address:BASE + BigInt(i * 4), mn:p < 0 ? s : s.slice(0, p), ops:p < 0 ? '' : s.slice(p + 1) };
  });
  const rowOfAddress = (addr) => {
    const d = BigInt(addr) - BASE;
    if (d < 0n || d >= BigInt(lines.length * 4)) return null;
    return Number(d / 4n);
  };
  return buildSemanticModel(rows, { startRow:0, endRow:rows.length - 1, rowOfAddress });
}
function irOf(lines, options = {}) {
  const model = modelOf(lines);
  const rowOfAddress = (addr) => {
    const d = BigInt(addr) - BASE;
    if (d < 0n || d >= BigInt(lines.length * 4)) return null;
    return Number(d / 4n);
  };
  return buildIR(model, { rowOfAddress, ...options });
}
function loadAt(ir, row) { return ir.instructions.find((i) => i.op === OP.LOAD && i.row === row); }
function callAt(ir, row) { return ir.instructions.find((i) => i.op === OP.CALL && i.row === row); }

// No opaque consumer: keep precise stack reaching-store information.
{
  const ir = irOf(['str w1, [sp, #0x18]','add x9, sp, #0x18','mov x10, x9','ldr w2, [sp, #0x18]','ret']);
  assert.equal(loadAt(ir, 3)?.reachingStore?.row, 0);
}

// Legacy-v1: a normal frame-record save is private stack state, not an escape.
{
  const ir = irOf([
    'stp x29, x30, [sp, #-32]!',
    'mov x29, sp',
    'str w1, [sp, #0x0c]',
    'bl 0x100001000',
    'ldr w2, [sp, #0x0c]',
    'ldp x29, x30, [sp], #32',
    'ret',
  ], { semanticMigrationMode:'legacy-v1' });
  assert.equal(loadAt(ir, 4)?.reachingStore?.row, 2);
  assert.ok(!(callAt(ir, 3)?.memKills || []).some((loc) => loc?.kind === 'stack'));
}

// Legacy-v1: a direct stack-derived argument remains an escape.
{
  const ir = irOf([
    'str w1, [sp, #0x18]',
    'add x0, sp, #0x18',
    'bl 0x100001000',
    'ldr w2, [sp, #0x18]',
    'ret',
  ], { semanticMigrationMode:'legacy-v1' });
  const load = loadAt(ir, 3);
  assert.ok(load, 'direct stack-escape fixture must still contain the projected load');
  assert.equal(load.reachingStore, undefined);
  assert.equal(load.memUse?.kind, 'clobber');
}

// Legacy-v1: spilling then reloading a stack pointer does not launder escape provenance.
{
  const ir = irOf([
    'str w1, [sp, #0x18]',
    'mov x9, sp',
    'str x9, [sp, #0x10]',
    'ldr x0, [sp, #0x10]',
    'bl 0x100001000',
    'ldr w2, [sp, #0x18]',
    'ret',
  ], { semanticMigrationMode:'legacy-v1' });
  const load = loadAt(ir, 5);
  assert.ok(load, 'reloaded stack-escape fixture must still contain the projected load');
  assert.equal(load.reachingStore, undefined);
  assert.equal(load.memUse?.kind, 'clobber');
}

// Direct AAPCS64 argument escape must be represented as a CALL SSA use.
{
  const ir = irOf(['str w1, [sp, #0x18]','add x0, sp, #0x18','bl 0x100001000','ldr w2, [sp, #0x18]','ret']);
  const call = callAt(ir, 2);
  const load = loadAt(ir, 3);
  assert.ok(call?.args?.some((a) => a.value?.reg === 'x0'));
  assert.ok(load, 'AAPCS64 argument-escape fixture must still contain the projected load');
  assert.equal(load.reachingStore, undefined);
  assert.equal(load.memUse?.kind, 'clobber');
}

// MOV propagation must not hide the escape.
{
  const ir = irOf(['str w1, [sp, #0x18]','add x9, sp, #0x18','mov x0, x9','bl 0x100001000','ldr w2, [sp, #0x18]','ret']);
  const load = loadAt(ir, 4);
  assert.ok(load, 'MOV stack-escape fixture must still contain the projected load');
  assert.equal(load.reachingStore, undefined);
  assert.equal(load.memUse?.kind, 'clobber');
}

// PHI provenance is tested independently of text-fixture CFG construction: a
// may-stack incoming value is enough to classify the merged pointer as escaped.
{
  const sp = { id:900, kind:'arg', reg:'sp', def:null };
  const imm = { id:901, kind:'const', const:0x18n, def:null };
  const addDef = { op:OP.BIN, sub:'add', args:[{ value:sp }, { value:imm }] };
  const derived = { id:902, kind:'def', reg:'x9', def:addDef };
  const movDef = { op:OP.MOV, args:[{ value:derived }] };
  const moved = { id:903, kind:'def', reg:'x0', def:movDef };
  const unrelated = { id:904, kind:'arg', reg:'x3', def:null };
  const phiDef = { op:OP.PHI, args:[{ value:moved }, { value:unrelated }] };
  const merged = { id:905, kind:'phi', reg:'x0', def:phiDef };
  const provenance = stackPointerProvenanceOf(merged);
  assert.equal(provenance?.via, 'phi');
  assert.equal(provenance?.must, false, 'one non-stack predecessor makes PHI provenance may-stack');
  assert.equal(provenance?.offset, 0x18n);

  const stackLoc = { key:'stack:24', kind:'stack', size:4 };
  const call = { id:906, op:'call', row:0, block:0, args:[{ value:merged }], memKills:[stackLoc] };
  const projected = {
    values:[sp, imm, derived, moved, unrelated, merged],
    locations:new Map([[stackLoc.key, stackLoc]]),
    instructions:[call],
    blocks:[{ index:0, insts:[call] }],
  };
  restoreLegacyPrivateStackForwarding(projected, stackPointerProvenanceOf);
  assert.deepEqual(call.memKills, [stackLoc], 'may-stack PHI passed to a call must remain an escape barrier');
}

// Legacy-v1 repair must never pair different-width accesses solely because
// their stack offset key matches.
{
  const value = { id:910, kind:'arg', reg:'x3', def:null };
  const storeLoc = { key:'stack:24', kind:'stack', size:4 };
  const loadLoc = { key:'stack:24', kind:'stack', size:8 };
  const memDef = { kind:'store', definitionId:'d910' };
  const store = { id:911, op:'store', row:0, block:0, loc:storeLoc, args:[{ value }], memDef };
  const call = { id:912, op:'call', row:1, block:0, args:[], memKills:[loadLoc] };
  const clobber = { kind:'clobber', inst:call };
  const load = { id:913, op:'load', row:2, block:0, loc:loadLoc, args:[], memUse:clobber };
  const projected = {
    values:[value],
    locations:new Map([[loadLoc.key, loadLoc]]),
    instructions:[store, call, load],
    blocks:[{ index:0, insts:[store, call, load] }],
  };
  restoreLegacyPrivateStackForwarding(projected, stackPointerProvenanceOf);
  assert.equal(load.reachingStore, undefined, 'partial-width store cannot become the reaching store');
  assert.equal(load.memUse, clobber, 'mismatched-width load must retain the conservative clobber');
}

// An ambiguous store is a hard barrier even when an untrusted location reuses
// the exact stack key and width. It must never become authoritative.
{
  const value = { id:920, kind:'arg', reg:'x4', def:null };
  const loadLoc = { key:'stack:32', kind:'stack', size:8 };
  const ambiguousLoc = { key:'stack:32', kind:'unknown', size:8 };
  const memDef = { kind:'store', definitionId:'d920' };
  const ambiguousStore = { id:921, op:'store', row:0, block:0, loc:ambiguousLoc, args:[{ value }], memDef };
  const call = { id:922, op:'call', row:1, block:0, args:[], memKills:[loadLoc] };
  const clobber = { kind:'clobber', inst:call };
  const load = { id:923, op:'load', row:2, block:0, loc:loadLoc, args:[], memUse:clobber };
  const projected = {
    values:[value],
    locations:new Map([[loadLoc.key, loadLoc]]),
    instructions:[ambiguousStore, call, load],
    blocks:[{ index:0, insts:[ambiguousStore, call, load] }],
  };
  restoreLegacyPrivateStackForwarding(projected, stackPointerProvenanceOf);
  assert.equal(load.reachingStore, undefined, 'unknown-kind store cannot become the reaching store');
  assert.equal(load.memUse, clobber, 'ambiguous store must preserve the conservative clobber');
}

function phiFieldSpillFixture(secondFieldKey = 'field:self+32') {
  const root = { id:930, vid:1, kind:'arg', reg:'x0', semanticValueId:'self', def:null, uses:[], bits:64 };
  const left = { id:931, vid:2, kind:'def', reg:'w8', def:null, uses:[], bits:32 };
  const right = { id:932, vid:3, kind:'def', reg:'w8', def:null, uses:[], bits:32 };
  const phi = { id:933, vid:4, kind:'phi', reg:'w8', def:null, uses:[], bits:32 };
  const phiDef = {
    id:934, op:OP.PHI, block:2, row:4, args:[], dst:phi,
    incoming:[{ from:0, value:left }, { from:1, value:right }],
  };
  phi.def = phiDef;

  const fieldA = { key:'field:self+32', kind:'field', baseEntityId:'self', base:root, disp:32n, size:4 };
  const fieldB = { key:secondFieldKey, kind:'field', baseEntityId:'self', base:root,
    disp:secondFieldKey === fieldA.key ? 32n : 36n, size:4 };
  const stackLoc = { key:'stack:-20', kind:'stack', disp:-20n, size:4 };
  const storeA = { id:935, op:'store', row:0, block:0, loc:fieldA,
    addr:{ base:root, baseReg:'x0', disp:32n, size:4 }, args:[{ value:left, bits:32 }] };
  const branchA = { id:936, op:'cbr', row:1, block:0, args:[] };
  const storeB = { id:937, op:'store', row:2, block:1, loc:fieldB,
    addr:{ base:root, baseReg:'x0', disp:fieldB.disp, size:4 }, args:[{ value:right, bits:32 }] };
  const branchB = { id:938, op:'br', row:3, block:1, args:[] };
  const memDef = { kind:'store', definitionId:'stack-phi-spill' };
  const stackStore = { id:939, op:'store', row:4, block:2, loc:stackLoc,
    addr:{ disp:-20n, size:4 }, args:[{ value:phi, bits:32 }], memDef };
  const call = { id:940, op:'call', row:5, block:2, args:[], memKills:[stackLoc] };
  const clobber = { kind:'clobber', inst:call };
  const load = { id:941, op:'load', row:6, block:2, loc:stackLoc,
    addr:{ disp:-20n, size:4 }, args:[], memUse:clobber, dst:null };
  left.uses.push(storeA, phiDef);
  right.uses.push(storeB, phiDef);
  phi.uses.push(stackStore);

  return {
    root, phi, stackStore, load,
    projected:{
      values:[root, left, right, phi],
      locations:new Map([[stackLoc.key, stackLoc]]),
      instructions:[storeA, branchA, storeB, branchB, stackStore, call, load],
      blocks:[
        { index:0, pred:[], succ:[2], insts:[storeA, branchA] },
        { index:1, pred:[], succ:[2], insts:[storeB, branchB] },
        { index:2, pred:[0,1], succ:[], phis:[phiDef], insts:[stackStore, call, load] },
      ],
    },
  };
}

// A CFG-merged scalar that every predecessor has already committed to the same
// exact field may use that field identity for a private legacy return spill.
{
  const { root, phi, stackStore, load, projected } = phiFieldSpillFixture();
  restoreLegacyPrivateStackForwarding(projected, stackPointerProvenanceOf);
  const compatible = stackStore.args[0]?.value;
  assert.notEqual(compatible?.id, phi.id, 'raw scalar PHI must not leak through the private spill');
  assert.equal(compatible?.def?.op, OP.LOAD);
  assert.equal(compatible?.def?.loc?.kind, 'field');
  assert.equal(compatible?.def?.loc?.key, 'field:self+32');
  assert.equal(compatible?.def?.loc?.base, root, 'field view must stay attached to the canonical root');
  assert.equal(compatible?.bits, 32);
  assert.equal(load.reachingStore, stackStore, 'post-call stack load keeps the exact private spill');
}

// Different predecessor fields are not one memory identity, even when their
// scalar values feed the same PHI. The compatibility layer must fail closed.
{
  const { phi, stackStore, projected } = phiFieldSpillFixture('field:self+36');
  restoreLegacyPrivateStackForwarding(projected, stackPointerProvenanceOf);
  assert.equal(stackStore.args[0]?.value, phi, 'different committed fields must preserve the raw PHI spill');
}

console.log('issue #430 stack escape regressions passed');
