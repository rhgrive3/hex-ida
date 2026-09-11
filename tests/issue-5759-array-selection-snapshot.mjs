// Regression for #5759: snapshotSelection() only accepted the object form
// `{ instructions: [...] }`; a bare instruction array (the shape the
// workbench and compactSelection() also produce) was treated as an
// instruction-less selection, so the turn snapshot lost the selection
// boundaries (`start`/`end` became null and `instructions` was empty) and
// selection scope broke.
import assert from 'node:assert/strict';

import { createTurnSnapshot } from '../js/ai/control/snapshot.js';

const instruction = (address, mnemonic, operands) => ({ address, mnemonic, operands });

{
  // Bare-array selection keeps its boundaries and rows.
  const snapshot = createTurnSnapshot({
    selection: [instruction(0x1000n, 'push', 'rbp'), instruction(0x1004n, 'mov', 'rbp, rsp')],
  }, {});
  assert.ok(snapshot.selection, 'an array selection must survive snapshotting');
  assert.equal(snapshot.selection.start, '0x1000');
  assert.equal(snapshot.selection.end, '0x1004');
  assert.equal(snapshot.selection.instructions.length, 2);
  assert.equal(snapshot.selection.instructions[0].mnemonic, 'push');
  assert.equal(snapshot.selection.truncated, false);
}

{
  // The object form keeps its existing behavior.
  const snapshot = createTurnSnapshot({
    selection: {
      start: 0x2000n,
      end: 0x2010n,
      instructions: [instruction(0x2000n, 'ret', '')],
    },
  }, {});
  assert.equal(snapshot.selection.start, '0x2000');
  assert.equal(snapshot.selection.end, '0x2010');
  assert.equal(snapshot.selection.instructions.length, 1);
}

{
  // Truncation is preserved for oversized array selections.
  const instructions = [];
  for (let index = 0; index < 90; index += 1) instructions.push(instruction(0x3000n + BigInt(index * 4), 'nop', ''));
  const snapshot = createTurnSnapshot({ selection: instructions }, {});
  assert.equal(snapshot.selection.instructions.length, 80);
  assert.equal(snapshot.selection.truncated, true);
}
