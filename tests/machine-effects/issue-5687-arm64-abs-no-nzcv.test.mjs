import assert from 'node:assert/strict';
import test from 'node:test';

import { buildSemanticModel } from '../../js/blocks.js';
import { buildIR } from '../../js/ir.js';

/* AArch64 `ABS` (Advanced SIMD/scalar) computes an absolute value and never
 * updates PSTATE.NZCV; `FABS` is likewise flag-free. Only real flag-setting
 * unary forms such as `NEGS` write NZCV. The compat lifter guessed flag
 * updates from the mnemonic's trailing "s" and minted a fake NZCV write for
 * every `ABS`, detaching later conditional branches from the real CMP
 * definition (#5687). */

const BASE = 0x100000000n;

function lift(lines) {
  const rows = lines.map((line, index) => {
    const s = line.trim();
    const p = s.indexOf(' ');
    return { row: index, address: BASE + BigInt(index * 4), mn: p < 0 ? s : s.slice(0, p), ops: p < 0 ? '' : s.slice(p + 1) };
  });
  const rowOfAddress = (addr) => {
    const d = addr - BASE;
    return d >= 0n && d < BigInt(lines.length * 4) ? Number(d / 4n) : null;
  };
  const model = buildSemanticModel(rows, {
    startRow: 0, endRow: rows.length - 1, rowOfAddress, symbolFor: () => null, name: null,
  });
  return buildIR(model, { rowOfAddress, semanticMigrationMode: 'legacy-v1' });
}

const flagWritesBeforeRow = (ir, row) => (ir?.instructions || [])
  .filter((inst) => inst.op === 'cmp' && inst.row < row);

test('ABS does not mint an NZCV write (CMP -> ABS keeps CMP as the only definition)', () => {
  const ir = lift(['cmp x0, x1', 'abs v0.4s, v1.4s', 'b.eq #0x100000010']);
  const writes = flagWritesBeforeRow(ir, 2);
  assert.equal(writes.length, 1, 'only the CMP defines NZCV');
  assert.equal(writes[0].row, 0);
});

test('scalar ABS keeps its flag-free contract', () => {
  const ir = lift(['cmp x0, x1', 'abs d0, d1', 'b.eq #0x100000010']);
  assert.equal(flagWritesBeforeRow(ir, 2).length, 1);
  assert.equal((ir?.instructions || []).filter((inst) => inst.row === 1 && inst.op === 'cmp').length, 0);
});

test('NEGS keeps its NZCV write', () => {
  const ir = lift(['negs x0, x1']);
  assert.equal(flagWritesBeforeRow(ir, 1).length, 1, 'negs is a real flag-setting unary form');
});

test('FABS behavior is unchanged', () => {
  const ir = lift(['cmp x0, x1', 'fabs d0, d1', 'b.eq #0x100000010']);
  assert.equal(flagWritesBeforeRow(ir, 2).length, 1);
  assert.equal((ir?.instructions || []).filter((inst) => inst.row === 1 && inst.op === 'cmp').length, 0);
});
