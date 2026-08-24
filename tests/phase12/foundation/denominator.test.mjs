import assert from 'node:assert/strict';
import {
  DEFAULT_INVENTORY_PATH,
  PHASE12_DENOMINATOR_CATEGORIES,
  loadPhase12DenominatorInventory,
  phase12DenominatorReport,
  validatePhase12DenominatorInventory,
} from '../../../tools/validation/phase12/denominator.mjs';

const inventory = loadPhase12DenominatorInventory(DEFAULT_INVENTORY_PATH);
const checked = validatePhase12DenominatorInventory(inventory);
assert.equal(checked.ok, true);
assert.deepEqual(PHASE12_DENOMINATOR_CATEGORIES, ['knowledge', 'rules', 'patterns', 'remote-collaboration']);
assert.equal(checked.categoryCount, 4);
assert.equal(checked.unitCount, 68);
assert.equal(checked.exactCount, 63);
assert.equal(checked.exclusionCount, 5);
assert.equal(checked.nonExactCount, 5);
assert.equal(checked.blockingGapCount, 0);
assert.equal(checked.terminalEligible, true);
assert.deepEqual(checked.normativeExclusions, [
  'knowledge.external-confirmation-authority',
  'patterns.mutation',
  'patterns.network-and-arbitrary-javascript',
  'remote.derived-analysis-egress',
  'rules.ai-capability-minting',
]);
assert.deepEqual(checked.blockingGaps, []);
assert.deepEqual(checked.remainingGaps, [
  'knowledge.external-confirmation-authority',
  'patterns.mutation',
  'patterns.network-and-arbitrary-javascript',
  'remote.derived-analysis-egress',
  'rules.ai-capability-minting',
]);
assert.equal(checked.promotion.allowed, false);
assert.equal(checked.promotion.reason, 'inventory-does-not-promote-support');

for (const category of inventory.categories) {
  for (const unit of category.units) assert.ok(
    unit.classification === 'EXACT'
      || unit.classification === 'PREEXISTING_NORMATIVE_EXCLUSION'
      || unit.classification === 'BLOCKING_GAP',
    `${unit.id} must be exact, a blocking gap, or an explicit preexisting exclusion`,
  );
}

const report = phase12DenominatorReport(inventory);
assert.equal(report.schemaVersion, 'phase12-denominator-report/v2');
assert.equal(report.valid, true);
assert.equal(report.terminalEligible, true);
assert.equal(report.blockingGapCount, 0);
assert.equal(report.promotion.allowed, false);

function copy() { return structuredClone(inventory); }
function unit(id, value = copy()) {
  return value.categories.flatMap((category) => category.units).find((item) => item.id === id);
}

const providerSchemaDrift = copy();
unit('knowledge.package-envelope.provider-output-schema', providerSchemaDrift).check.expected = 'provider-v2';
const providerFailure = validatePhase12DenominatorInventory(providerSchemaDrift);
assert.equal(providerFailure.ok, false);
assert.ok(providerFailure.failures.includes('knowledge.package-envelope.provider-output-schema:export-drift:PHASE12_PROVIDER_OUTPUT_SCHEMA'));

const fallbackDrift = copy();
unit('knowledge.provider-output.entry-fallback', fallbackDrift).check.markers = ['const entries = Array.isArray(value.items) ? value.items : [];'];
const fallbackFailure = validatePhase12DenominatorInventory(fallbackDrift);
assert.equal(fallbackFailure.ok, false);
assert.ok(fallbackFailure.failures.some((failure) => failure.startsWith('knowledge.provider-output.entry-fallback:source-drift:')));

const schemaCollectionDrift = copy();
unit('remote.security.rejection-classes', schemaCollectionDrift).check.expected.push('remote-new-reason');
const collectionFailure = validatePhase12DenominatorInventory(schemaCollectionDrift);
assert.equal(collectionFailure.ok, false);
assert.ok(collectionFailure.failures.some((failure) => failure.startsWith('remote.security.rejection-classes:source-collection-drift:')));

const denominatorShrink = copy();
const knowledge = denominatorShrink.categories.find((category) => category.id === 'knowledge');
knowledge.units = knowledge.units.filter((item) => item.id !== 'knowledge.recognition.match-tiers');
const shrinkFailure = validatePhase12DenominatorInventory(denominatorShrink);
assert.equal(shrinkFailure.ok, false);
assert.ok(shrinkFailure.failures.includes('knowledge:unit-set-invalid'));
assert.ok(shrinkFailure.failures.includes('knowledge.recognition.match-tiers:required-unit-missing'));

const exactAsExclusion = copy();
unit('remote.remote-canonical-transport', exactAsExclusion).classification = 'PREEXISTING_NORMATIVE_EXCLUSION';
const promotionFailure = validatePhase12DenominatorInventory(exactAsExclusion);
assert.equal(promotionFailure.ok, false);
assert.ok(promotionFailure.failures.includes('remote.remote-canonical-transport:classification-invalid'));

const exclusionAsGap = copy();
unit('rules.ai-capability-minting', exclusionAsGap).classification = 'BLOCKING_GAP';
const exclusionFailure = validatePhase12DenominatorInventory(exclusionAsGap);
assert.equal(exclusionFailure.ok, false);
assert.ok(exclusionFailure.failures.includes('rules.ai-capability-minting:classification-invalid'));

const truthDrift = copy();
truthDrift.truth.expected.collaboration.status = 'supported';
const truthFailure = validatePhase12DenominatorInventory(truthDrift);
assert.equal(truthFailure.ok, false);
assert.ok(truthFailure.failures.includes('inventory-truth-expectation-drift'));

console.log('[phase12] denominator inventory and drift regressions passed');
