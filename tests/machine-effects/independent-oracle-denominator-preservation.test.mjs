import assert from 'node:assert/strict';

import {
  a2DenominatorReport,
  loadA2DenominatorInventory,
} from '../../tools/validation/machine-effects/a2-denominator.mjs';
import {
  compareA2DenominatorSnapshots,
  createA2DenominatorSnapshot,
} from '../../tools/validation/machine-effects/oracle-report.mjs';

const inventory = loadA2DenominatorInventory();
const before = createA2DenominatorSnapshot(inventory);
const report = a2DenominatorReport(inventory);
const after = createA2DenominatorSnapshot(inventory);
const preserved = compareA2DenominatorSnapshots(before, after);

assert.equal(report.validation.valid, true);
assert.equal(before.oracleRole, 'production-effect-registry-denominator-with-explicit-profile-gaps');
assert.equal(before.denominatorDigest, after.denominatorDigest);
assert.deepEqual(before.rowIds, after.rowIds);
assert.deepEqual(before.architectureIds, after.architectureIds);
assert.equal(preserved.preserved, true);
assert.equal(preserved.reason, null);

const shrunk = {
  ...after,
  rowIds: after.rowIds.slice(0, -1),
  rowCount: after.rowCount - 1,
};
assert.equal(compareA2DenominatorSnapshots(before, shrunk).preserved, false);

const rewritten = {
  ...after,
  denominatorDigest: `sha256:${'0'.repeat(64)}`,
};
assert.equal(compareA2DenominatorSnapshots(before, rewritten).preserved, false);

console.log(`machine-effects independent oracle denominator preservation: PASS (${before.rowCount} rows; digest stable)`);
