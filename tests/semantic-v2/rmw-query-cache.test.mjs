import assert from 'node:assert/strict';

import { buildSemanticModel } from '../../js/blocks.js';
import { findValueUpdates } from '../../js/dataflow.js';
import { findIrValueUpdates } from '../../js/dataflow-ir.js';
import { findIrSemanticUpdates } from '../../js/dataflow-semantic.js';
import { irFor, readModifyWrite } from '../../js/ir.js';
import { semanticFacts } from '../../js/semantic.js';

const BASE = 0x100000000n;
const lines = [
  'ldr w8, [x19, #0x20]',
  'add w8, w8, #1',
  'str w8, [x19, #0x20]',
  'ret',
];

function fixture() {
  const rows = lines.map((line, row) => {
    const split = line.indexOf(' ');
    return {
      row,
      address: BASE + BigInt(row * 4),
      mn: split < 0 ? line : line.slice(0, split),
      ops: split < 0 ? '' : line.slice(split + 1),
    };
  });
  const rowOfAddress = (address) => {
    const delta = address - BASE;
    return delta < 0n || delta >= BigInt(rows.length * 4) ? null : Number(delta / 4n);
  };
  const model = buildSemanticModel(rows, { startRow: 0, endRow: rows.length - 1, rowOfAddress });
  const ir = irFor(model, { rowOfAddress });
  assert.ok(ir, 'fixture must build canonical IR');
  return { model, ir };
}

const valueFixture = fixture();
const valueProofs = readModifyWrite(valueFixture.ir);
assert.ok(valueProofs.length > 0, 'fixture must contain an RMW proof');
const baselineValueUpdates = findIrValueUpdates(valueFixture.model, null, { ir: valueFixture.ir });
const reusedValueUpdates = findIrValueUpdates(valueFixture.model, null, {
  ir: valueFixture.ir,
  readModifyWriteProofs: valueProofs,
});
assert.deepEqual(reusedValueUpdates, baselineValueUpdates,
  'threading a query-scoped RMW proof into the value adapter must preserve its exact result');

// Exercise the semantic-fact adapter on separate equivalent IR objects so the
// fact WeakMap cannot make the comparison pass by returning the same cached array.
const semanticBaselineFixture = fixture();
const semanticBaselineUpdates = findIrSemanticUpdates(
  semanticBaselineFixture.model,
  null,
  findIrValueUpdates(semanticBaselineFixture.model, null, { ir: semanticBaselineFixture.ir }),
  { ir: semanticBaselineFixture.ir },
);
const semanticReuseFixture = fixture();
const semanticReuseProofs = readModifyWrite(semanticReuseFixture.ir);
const semanticReuseRmw = findIrValueUpdates(semanticReuseFixture.model, null, {
  ir: semanticReuseFixture.ir,
  readModifyWriteProofs: semanticReuseProofs,
});
const semanticReuseUpdates = findIrSemanticUpdates(
  semanticReuseFixture.model,
  null,
  semanticReuseRmw,
  { ir: semanticReuseFixture.ir, readModifyWriteProofs: semanticReuseProofs },
);
assert.deepEqual(semanticReuseUpdates, semanticBaselineUpdates,
  'threading the same query-scoped proof into semantic facts must preserve adapter output');

const factBaselineFixture = fixture();
const factReuseFixture = fixture();
const baselineFacts = semanticFacts(factBaselineFixture.ir);
const reusedFacts = semanticFacts(factReuseFixture.ir, {
  readModifyWriteProofs: readModifyWrite(factReuseFixture.ir),
});
assert.deepEqual(reusedFacts, baselineFacts,
  'precomputed RMW input must not change the canonical semantic fact set');

const publicFixture = fixture();
const publicUpdates = findValueUpdates(publicFixture.model);
assert.ok(publicUpdates.some((update) => update.kind === 'read-modify-write'),
  'the public dataflow query must still expose the fixture RMW result');

console.log('semantic query-scoped RMW reuse contract: PASS');
