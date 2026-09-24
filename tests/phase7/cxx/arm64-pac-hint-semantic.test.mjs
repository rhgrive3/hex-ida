import test from 'node:test';
import assert from 'node:assert/strict';
import { buildIR } from '../../../js/ir.js';
import { buildSemanticModel } from '../../../js/blocks.js';
import { decompile } from '../../../js/decompile-base.js';

test('AAPCS64 paciasp / autiasp HINT instructions on system without PAC do not force legacy fallback', () => {
  const rows = [
    { row: 0, address: 0x1000n, mn: 'paciasp', ops: '' },
    { row: 1, address: 0x1004n, mn: 'mov', ops: 'x0, #0' },
    { row: 2, address: 0x1008n, mn: 'autiasp', ops: '' },
    { row: 3, address: 0x100cn, mn: 'ret', ops: '' },
  ];
  const rowOfAddress = (address) => rows.find((r) => r.address === BigInt(address))?.row ?? null;
  const model = buildSemanticModel(rows, { rowOfAddress, startRow: 0, endRow: rows.length - 1 });

  const ir = buildIR(model, {
    rowOfAddress,
    semanticMigrationMode: 'semantic-v2-compat',
  });
  assert.ok(ir);
  // UNKNOWN count for paciasp/autiasp should be 0 when treated as architectural NOP
  const pacUnknowns = ir.instructions.filter((i) => i.text && i.text.includes('arm64-pac-runtime-state-unresolved'));
  assert.equal(pacUnknowns.length, 0);

  const dec = decompile(model, { addr: 0x1000n });
  assert.equal(dec.semantic, true);
});
