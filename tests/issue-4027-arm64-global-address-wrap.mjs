/* #4027: constant base + signed displacement must normalize to the canonical
 * unsigned 64-bit effective address; `0 + (-8)` and `(-8) + 0` may not split
 * into two MK.GLOBAL identities. */
import assert from 'node:assert/strict';
import { buildSemanticModel } from '../js/blocks.js';
import { buildIR, mayAlias } from '../js/ir.js';

let passed = 0;
const failures = [];
function test(name, fn) {
  try { fn(); passed++; process.stdout.write('  ok  ' + name + '\n'); }
  catch (err) { failures.push({ name, err }); process.stdout.write('FAIL  ' + name + '\n      ' + err.message + '\n'); }
}

const BASE = 0x100000000n;
const WRAPPED = 0xfffffffffffffff8n;

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

function lift(lines) {
  return buildIR(modelOf(lines), { semanticMigrationMode: 'legacy-v1' });
}

function instAt(ir, row) {
  const inst = ir.instructions.find((x) => x.row === row);
  assert.ok(inst, `instruction at row ${row} missing`);
  return inst;
}

test('0 + (-8) is canonicalized to the unsigned 64-bit effective address', () => {
  const ir = lift(['mov x0, #0', 'ldur x1, [x0, #-8]', 'ret']);
  const load = instAt(ir, 1);
  assert.equal(load.loc.kind, 'global');
  assert.equal(load.loc.address, WRAPPED, `address ${load.loc.address} must be 0xfffffffffffffff8`);
  assert.equal(load.loc.key, 'global:fffffffffffffff8:size:8');
  assert.equal(load.globalAddress, WRAPPED);
});

test('wrapped and non-wrapped spellings share one GLOBAL identity', () => {
  const ir = lift([
    'mov x0, #0',
    'ldur x1, [x0, #-8]',
    'mov x2, #-8',
    'ldur x3, [x2, #0]',
    'ret',
  ]);
  const a = instAt(ir, 1);
  const b = instAt(ir, 3);
  assert.equal(a.loc.kind, 'global');
  assert.equal(b.loc.kind, 'global');
  assert.equal(a.loc.key, b.loc.key, `${a.loc.key} vs ${b.loc.key}`);
  assert.equal(a.loc.address, WRAPPED);
  assert.equal(b.loc.address, WRAPPED);
  assert.equal(a.globalAddress, b.globalAddress);
});

test('same effective address is not proven non-alias by range comparison', () => {
  const ir = lift([
    'mov x0, #0',
    'ldur x1, [x0, #-8]',
    'mov x2, #-8',
    'ldur x3, [x2, #0]',
    'ret',
  ]);
  const a = instAt(ir, 1);
  const b = instAt(ir, 3);
  assert.equal(mayAlias(a.loc, b.loc), true);
});

test('positive base + positive/negative offsets keep existing results', () => {
  const ir = lift([
    'mov x4, #0x1000',
    'ldr x5, [x4, #0x10]',
    'ldur x6, [x4, #-0x10]',
    'ret',
  ]);
  const up = instAt(ir, 1);
  const down = instAt(ir, 2);
  assert.equal(up.loc.address, 0x1010n);
  assert.equal(up.loc.key, 'global:1010:size:8');
  assert.equal(down.loc.address, 0xff0n);
  assert.equal(down.loc.key, 'global:ff0:size:8');
});

test('stack-relative location identity is unchanged', () => {
  const ir = lift(['sub sp, sp, #0x20', 'str x6, [sp, #8]', 'ret']);
  const store = instAt(ir, 1);
  assert.equal(store.loc.kind, 'stack');
  assert.match(store.loc.key, /^stack:sp:[^:]+:s8$/);
});

if (failures.length) {
  process.stdout.write(`${failures.length} failing, ${passed} passing\n`);
  process.exit(1);
}
process.stdout.write(`issue-4027: ${passed} passing\n`);
