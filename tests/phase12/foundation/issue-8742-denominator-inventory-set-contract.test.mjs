import assert from 'node:assert/strict';
import {
  DEFAULT_INVENTORY_PATH,
  loadPhase12DenominatorInventory,
  validatePhase12DenominatorInventory,
} from '../../../tools/validation/phase12/denominator.mjs';

const base = loadPhase12DenominatorInventory(DEFAULT_INVENTORY_PATH);
const copy = () => structuredClone(base);
function unit(id, inv = copy()) {
  return inv.categories.flatMap((category) => category.units).find((item) => item.id === id);
}

// #8742: the current main inventory must validate green again after the
// raw-binary preflight reordering and packageVersion canonicalization hardening.
const current = validatePhase12DenominatorInventory(base);
assert.equal(current.ok, true, `current inventory must be green: ${JSON.stringify(current.failures)}`);
assert.equal(current.terminalEligible, true);
assert.equal(current.blockingGapCount, 0);

const rejectionUnitId = 'remote.security.rejection-classes';
const rejectionCheck = (id, inv = copy()) => unit(id, inv).check;
const baseline = rejectionCheck(rejectionUnitId, base).expected.slice();

// Branch-aware set contract: emission order is not authoritative. Moving a
// legitimately shared reason (raw-binary preflight) to the head of the list
// is a sync, not a regression, so it must still validate.
const reordered = copy();
rejectionCheck(rejectionUnitId, reordered).expected = [...baseline];
rejectionCheck(rejectionUnitId, reordered).expected.unshift(
  rejectionCheck(rejectionUnitId, reordered).expected.pop(),
);
assert.notDeepEqual(rejectionCheck(rejectionUnitId, reordered).expected, baseline);
const reorderResult = validatePhase12DenominatorInventory(reordered);
assert.equal(reorderResult.ok, true, 'order-only change must pass under the set contract');

// Non-weakening: dropping a rejection class (removal or rename) is still drift.
const removed = copy();
rejectionCheck(rejectionUnitId, removed).expected = baseline.filter(
  (reason) => reason !== 'remote-transport-proof-rejected',
);
const removedResult = validatePhase12DenominatorInventory(removed);
assert.equal(removedResult.ok, false);
assert.ok(removedResult.failures.some((failure) => failure.startsWith(`${rejectionUnitId}:source-collection-drift:`)));

// Non-weakening: adding an unobserved reason (or a rename seen as add+remove) is still drift.
const renamed = copy();
rejectionCheck(rejectionUnitId, renamed).expected = [
  ...baseline.filter((reason) => reason !== 'remote-transport-proof-rejected'),
  'remote-transport-proof-renamed',
];
const renamedResult = validatePhase12DenominatorInventory(renamed);
assert.equal(renamedResult.ok, false);
assert.ok(renamedResult.failures.some((failure) => failure.startsWith(`${rejectionUnitId}:source-collection-drift:`)));

// #8742 dependency identity: the source marker is synced to the current
// canonical-string comparison. The semantic fail-closed authority (reject an
// unpinned / mismatched packageVersion dependency) is independently proven by
// the behavior unit, so tightening or loosening the source spelling cannot hide
// a real regression in the pinning contract.
const dependencyUnitId = 'knowledge.package-envelope.dependency-identity';
assert.ok(
  unit(dependencyUnitId, base).check.markers.includes('found.packageVersion !== dependency.packageVersion'),
  'dependency-identity marker must track the current canonical comparison',
);
const staleMarker = copy();
unit(dependencyUnitId, staleMarker).check.markers = [
  ...unit(dependencyUnitId, staleMarker).check.markers,
  'String(found.packageVersion) !== dependency.packageVersion',
];
const staleResult = validatePhase12DenominatorInventory(staleMarker);
assert.equal(staleResult.ok, false);
assert.ok(staleResult.failures.some((failure) => failure.startsWith(`${dependencyUnitId}:source-drift:`)));

const behavior = unit('knowledge.behavior.dependency-pinning', base).check;
assert.equal(behavior.type, 'behavior');
assert.deepEqual(behavior.expected.slice().sort(), ['exact-resolution', 'wrong-hash-rejected', 'wrong-version-rejected']);

console.log('[phase12] #8742 denominator inventory set-contract + non-weakening regressions passed');
