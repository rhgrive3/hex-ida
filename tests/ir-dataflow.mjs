/* Regression tests for the incremental IR -> dataflow migration. */
import { buildSemanticModel } from '../js/blocks.js';
import { findValueUpdates, findValueUpdatesLegacy, traceOrigin } from '../js/dataflow.js';
import { irFor, irText, readModifyWrite, OP, MK } from '../js/ir.js';

let passed = 0;
const failures = [];
function test(name, fn) {
  try { fn(); passed++; process.stdout.write('  ok  ' + name + '\n'); }
  catch (err) { failures.push({ name, err }); process.stdout.write('FAIL  ' + name + '\n      ' + err.message + '\n'); }
}
function ok(v, msg) { if (!v) throw new Error(msg || 'expected truthy'); }
function eq(a, b, msg) { if (a !== b) throw new Error((msg || 'not equal') + ': got ' + String(a) + ', want ' + String(b)); }

const BASE = 0x100000000n;
function modelOf(lines) {
  const rows = lines.map((line, i) => {
    const s = line.trim();
    const p = s.indexOf(' ');
    return { row: i, address: BASE + BigInt(i * 4), mn: p < 0 ? s : s.slice(0, p), ops: p < 0 ? '' : s.slice(p + 1) };
  });
  const rowOfAddress = (addr) => {
    const d = addr - BASE;
    if (d < 0n || d >= BigInt(lines.length * 4)) return null;
    return Number(d / 4n);
  };
  return buildSemanticModel(rows, { startRow: 0, endRow: rows.length - 1, rowOfAddress });
}

test('linear RMW keeps the public shape and is proven by IR', () => {
  const model = modelOf([
    'ldr w8, [x19, #0x20]',
    'add w8, w8, #10',
    'str w8, [x19, #0x20]',
    'ret',
  ]);
  const updates = findValueUpdates(model);
  const u = updates.find((x) => x.store && x.store.row === 2);
  ok(u, 'update exists');
  eq(u.kind, 'read-modify-write');
  eq(u.engine, 'ir-ssa');
  eq(u.location.disp, 0x20n);
  ok(u.steps.some((s) => s.op === 'add'), 'add step survives adapter');
  ok(u.evidence.some((e) => e && e.detail && e.detail.engine === 'ir-ssa'), 'IR provenance is visible');
  const factKeys = u.evidence.map((e) => String(e.code) + ':' + String(e.row));
  eq(new Set(factKeys).size, factKeys.length, 'same machine evidence is not counted twice');
  eq(factKeys.filter((k) => k === 'load:0').length, 1, 'one load fact');
  eq(factKeys.filter((k) => k === 'compute:1').length, 1, 'one compute fact');
  eq(factKeys.filter((k) => k === 'store:2').length, 1, 'one store fact');
});

test('SSA can prove an RMW across a control-flow join that legacy refuses to cross', () => {
  const model = modelOf([
    'ldr w8, [x19, #0x20]',
    'cmp w0, #0',
    'b.eq #0x100000014',
    'add w8, w8, #1',
    'b #0x100000018',
    'add w8, w8, #2',
    'str w8, [x19, #0x20]',
    'ret',
  ]);
  const legacy = findValueUpdatesLegacy(model);
  const modern = findValueUpdates(model);
  ok(!legacy.some((u) => u.store && u.store.row === 6 && u.kind === 'read-modify-write'),
    'legacy stays conservative at the join');
  const u = modern.find((x) => x.store && x.store.row === 6 && x.kind === 'read-modify-write');
  if (!u) {
    const ir = irFor(model);
    const rmw = ir ? readModifyWrite(ir) : [];
    throw new Error('SSA/phi proves the joined update; directRmw=' + rmw.length + '\n' + (ir ? irText(ir) : '<no ir>'));
  }
  eq(u.engine, 'ir-ssa');
});

test('different load/store locations are not promoted to RMW by IR', () => {
  const model = modelOf([
    'ldr w8, [x19, #0x20]',
    'add w8, w8, #1',
    'str w8, [x19, #0x30]',
    'ret',
  ]);
  const updates = findValueUpdates(model);
  ok(!updates.some((u) => u.store && u.store.row === 2 && u.engine === 'ir-ssa'),
    'IR does not claim a same-location cycle');
});

test('indexed/unknown memory is never upgraded to a concrete IR field update', () => {
  const model = modelOf([
    'ldr w8, [x19, x1, lsl #2]',
    'add w8, w8, #1',
    'str w8, [x19, x1, lsl #2]',
    'ret',
  ]);
  const updates = findValueUpdates(model);
  ok(!updates.some((u) => u.engine === 'ir-ssa'), 'unknown aliases stay unproven');
});

test('absolute global RMW stays in IR but is not adapted as a legacy field candidate', () => {
  const model = modelOf([
    'adr x19, #0x100001000',
    'ldr w8, [x19, #0x20]',
    'add w8, w8, #1',
    'str w8, [x19, #0x20]',
    'ret',
  ]);
  const ir = irFor(model);
  const globalRmw = readModifyWrite(ir).find((r) => r.location && r.location.kind === MK.GLOBAL);
  ok(globalRmw, 'IR retains the absolute-global update');
  const updates = findValueUpdates(model);
  ok(!updates.some((u) => u.engine === 'ir-ssa' && u.location && u.location.irKind === MK.GLOBAL),
    'legacy field API does not receive a global as +0');
});

test('unknown indexed store clobbers an older concrete Memory-SSA store', () => {
  const model = modelOf([
    'str w1, [x19, #0x20]',
    'str w2, [x19, x3, lsl #2]',
    'ldr w8, [x19, #0x20]',
    'ret',
  ]);
  const ir = irFor(model);
  const load = ir.instructions.find((i) => i.op === OP.LOAD && i.row === 2);
  ok(load, 'load exists');
  ok(!load.reachingStore, 'stale concrete store is blocked');
  ok(load.memUse && load.memUse.kind === 'clobber' && load.memUse.unknownAlias,
    'unknown store is recorded as the barrier');
  eq(ir.memorySafety.blockedLoads, 1);
});

test('unknown indexed store after a load cannot create structural exactness', () => {
  const model = modelOf([
    'str w1, [x19, #0x20]',
    'ldr w8, [x19, #0x20]',
    'str w2, [x19, x3, lsl #2]',
    'ret',
  ]);
  const ir = irFor(model);
  const load = ir.instructions.find((i) => i.op === OP.LOAD && i.row === 1);
  ok(load, 'load exists');
  ok(!load.reachingStore, 'structural reachingStore is never published as an exact fact');
  ok(load.memoryForwarding?.status !== 'exact', 'the load has no canonical exact proof');
  ok(load.memUse?.kind === 'store', 'the canonical MemorySSA use still records the prior store');
});

test('legacy traceOrigin applies MOVZ shift before reporting a constant', () => {
  const model = modelOf([
    'movz x8, #1, lsl #16',
    'ret',
  ]);
  const origin = traceOrigin(model, 1, 'x8');
  ok(origin && origin.kind === 'imm', 'MOVZ remains a proven immediate');
  eq(origin.value, 0x10000n, 'MOVZ shift is part of the completed value');
});

test('legacy traceOrigin applies MOVN inversion at destination width', () => {
  const x = modelOf([
    'movn x8, #0',
    'ret',
  ]);
  const wx = modelOf([
    'movn w8, #0',
    'ret',
  ]);
  eq(traceOrigin(x, 1, 'x8')?.value, 0xffffffffffffffffn, 'X-form MOVN');
  eq(traceOrigin(wx, 1, 'x8')?.value, 0xffffffffn, 'W-form MOVN');
});

test('legacy traceOrigin never treats a standalone MOVK immediate as the completed value', () => {
  const model = modelOf([
    'movz x8, #0x5678',
    'movk x8, #0x1234, lsl #16',
    'ret',
  ]);
  const origin = traceOrigin(model, 2, 'x8');
  ok(origin, 'MOVK origin is still reported conservatively');
  eq(origin.kind, 'computed', 'MOVK must not become a false proven immediate');
  eq(origin.op, 'movk');
  ok(origin.imm !== 0x12345678n, 'MOVK does not invent a reconstructed constant');
});

process.stdout.write('\n' + passed + ' passed, ' + failures.length + ' failed\n');
if (failures.length) process.exit(1);
