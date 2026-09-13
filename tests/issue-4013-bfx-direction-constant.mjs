/* #4013: provenConstant() must honor OP.BFX toward/signed metadata; UBFIZ/SBFIZ
 * must not be evaluated as a right shift-extract, and unprovable metadata must
 * stay unknown (null), never a false constant. */
import assert from 'node:assert/strict';
import { buildSemanticModel } from '../js/blocks.js';
import { buildIR as compatBuildIR, OP } from '../js/architecture/compat/ir-core-arm64-aapcs64-v1.js';
import { constantComparisons } from '../js/dataflow.js';
import { findIrConstantComparisons } from '../js/dataflow-ir-compare.js';

const BASE = 0x100000000n;
let failures = 0;
function check(name, fn) {
  try { fn(); process.stdout.write('  ok  ' + name + '\n'); }
  catch (err) { failures++; process.stdout.write('FAIL  ' + name + '\n      ' + err.message + '\n'); }
}
function rowOfAddress(addr) {
  const d = addr - BASE;
  if (d < 0n || d >= 16n * 4n) return null;
  return Number(d / 4n);
}
function modelOf(lines) {
  const rows = lines.map((line, i) => {
    const s = line.trim();
    const p = s.indexOf(' ');
    return { row: i, address: BASE + BigInt(i * 4), mn: p < 0 ? s : s.slice(0, p), ops: p < 0 ? '' : s.slice(p + 1) };
  });
  return buildSemanticModel(rows, { startRow: 0, endRow: rows.length - 1, rowOfAddress });
}
function compatProjectionOf(lines) {
  const model = modelOf(lines);
  const ir = compatBuildIR(model, { rowOfAddress });
  ir.compat = { projection: 'semantic-ir-v2-to-v1' };
  ir.semanticIrVersion = 'compat-v1';
  return ir;
}
function threshold(model) {
  const rows = findIrConstantComparisons(model, {});
  return rows.length === 1 ? rows[0].value : rows;
}

check('UBFIZ is proven as a left-placed field (0x100), not a zeroed right extract', () => {
  const got = threshold(compatProjectionOf(['mov w9, #1', 'ubfiz w10, w9, #8, #8', 'cmp w8, w10', 'ret']));
  assert.equal(got, 0x100n);
});

check('UBFX keeps the existing right-extract semantics', () => {
  const got = threshold(compatProjectionOf(['mov w9, #0x1f', 'ubfx w10, w9, #4, #2', 'cmp w8, w10', 'ret']));
  assert.equal(got, 1n);
});

check('SBFIZ with a set sign bit sign-extends the placed field', () => {
  const got = threshold(compatProjectionOf(['mov w9, #0xff', 'sbfiz w10, w9, #8, #8', 'cmp w8, w10', 'ret']));
  assert.equal(got, 0xffffff00n);
});

check('SBFX with a set sign bit sign-extends the extracted field', () => {
  const got = threshold(compatProjectionOf(['mov w9, #0xff', 'sbfx w10, w9, #0, #8', 'cmp w8, w10', 'ret']));
  assert.equal(got, 0xffffffffn);
});

check('UBFX still recovers the threshold through the public comparison API', () => {
  const rows = constantComparisons(modelOf(['mov w9, #0x1f', 'ubfx w10, w9, #4, #2', 'cmp w8, w10', 'ret']));
  const fact = rows.find((r) => r.row === 2);
  assert.ok(fact, 'threshold present');
  assert.equal(fact.value, 1n);
});

check('unknown BFX direction fails closed to no proven threshold', () => {
  const src = { id: 1, bits: 32, const: 1n };
  const bfx = { op: OP.BFX, row: 0, args: [{ value: src }], extra: { lsb: 8, width: 8, signed: false, toward: 'sideways' } };
  const placed = { id: 2, bits: 32, def: bfx };
  const cmp = {
    op: OP.CMP, row: 1, address: BASE + 4n,
    args: [{ value: { id: 3, bits: 32, reg: 'x8' } }, { value: placed }],
  };
  const model = {
    compat: { projection: 'semantic-ir-v2-to-v1' },
    semanticIrVersion: 'unit-fixture',
    instructions: [cmp], blocks: [], defUse: () => [],
  };
  assert.deepEqual(findIrConstantComparisons(model, {}), []);
});

check('out-of-range BFX metadata fails closed to no proven threshold', () => {
  const src = { id: 1, bits: 32, const: 0x1234n };
  const bfx = { op: OP.BFX, row: 0, args: [{ value: src }], extra: { lsb: 28, width: 8, signed: false, toward: 'right' } };
  const placed = { id: 2, bits: 32, def: bfx };
  const cmp = {
    op: OP.CMP, row: 1, address: BASE + 4n,
    args: [{ value: { id: 3, bits: 32, reg: 'x8' } }, { value: placed }],
  };
  const model = {
    compat: { projection: 'semantic-ir-v2-to-v1' },
    semanticIrVersion: 'unit-fixture',
    instructions: [cmp], blocks: [], defUse: () => [],
  };
  assert.deepEqual(findIrConstantComparisons(model, {}), []);
});

process.stdout.write('\n' + (failures ? failures + ' failed\n' : 'all passed\n'));
if (failures) process.exit(1);
