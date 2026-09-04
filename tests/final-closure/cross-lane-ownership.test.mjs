import assert from 'node:assert/strict';

import {
  githubEvent as phase11GithubEvent,
  phase11CrossLaneIntegration,
  phase11OwnershipViolation,
} from '../../tools/validation/phase11/ownership-check.mjs';
import {
  githubEvent as phase12GithubEvent,
  phase12CrossLaneIntegration,
  shouldSkipPhase12Ownership,
  validateAggregateFiles,
  validateFiles,
  loadManifest,
} from '../../tools/validation/phase12/ownership.mjs';

const crossLaneEvent = { pull_request: { labels: [{ name: 'cross-lane-integration' }] } };
const missingLabelEvent = { pull_request: {} };
const wrongLabelEvent = { pull_request: { labels: [{ name: 'integration' }] } };
const malformedLabelEvent = { pull_request: { labels: 'cross-lane-integration' } };

for (const predicate of [phase11CrossLaneIntegration, phase12CrossLaneIntegration]) {
  assert.equal(predicate(crossLaneEvent), true, 'the exact cross-lane label must opt in');
  assert.equal(predicate(missingLabelEvent), false, 'a missing label must not opt in');
  assert.equal(predicate(wrongLabelEvent), false, 'a different label must not opt in');
  assert.equal(predicate(malformedLabelEvent), false, 'malformed labels must fail closed');
  assert.equal(predicate(null), false, 'a missing event must fail closed');
}

for (const readEvent of [phase11GithubEvent, phase12GithubEvent]) {
  assert.deepEqual(
    readEvent({ env: { GITHUB_EVENT_PATH: 'injected-event.json' }, readFile: () => JSON.stringify(crossLaneEvent) }),
    crossLaneEvent,
    'event parsing must accept an injected event reader',
  );
  assert.equal(
    readEvent({ env: { GITHUB_EVENT_PATH: 'injected-event.json' }, readFile: () => '{malformed' }),
    null,
    'malformed event JSON must fail closed',
  );
  assert.equal(readEvent({ env: {} }), null, 'a missing event path must fail closed');
}

const phase11Manifest = {
  allowedExact: ['owned.js'],
  allowedPrefixes: ['owned/'],
  forbiddenPrefixes: ['forbidden/'],
};
assert.equal(phase11OwnershipViolation('campaign/spec.md', phase11Manifest), 'unowned:campaign/spec.md');
assert.equal(
  phase11OwnershipViolation('campaign/spec.md', phase11Manifest, {
    allowUnowned: phase11CrossLaneIntegration(crossLaneEvent),
  }),
  null,
  'the exact cross-lane label may admit an unowned Phase 11 path',
);
assert.equal(
  phase11OwnershipViolation('forbidden/escape.js', phase11Manifest, { allowUnowned: true }),
  'forbidden:forbidden/escape.js',
  'the cross-lane opt-in must not bypass forbidden Phase 11 paths',
);

const phase12Manifest = loadManifest();
const allowUnowned = phase12CrossLaneIntegration(crossLaneEvent);
const laneWithoutOptIn = validateFiles(['campaign/spec.md'], 'p12-integration', phase12Manifest);
assert.equal(laneWithoutOptIn.ok, false);
assert.ok(laneWithoutOptIn.violations.some((item) => item.category === 'unowned'));
const laneWithOptIn = validateFiles(['campaign/spec.md'], 'p12-integration', phase12Manifest, { allowUnowned });
assert.equal(laneWithOptIn.ok, true, 'the exact cross-lane label may admit an unowned Phase 12 lane path');
const forbiddenLane = validateFiles(['js/binary/escape.js'], 'p12-integration', phase12Manifest, { allowUnowned });
assert.ok(forbiddenLane.violations.some((item) => item.category === 'forbidden'));
const generatedLane = validateFiles(['reports/phase12/phase12-release-evidence.json'], 'p12-k', phase12Manifest, { allowUnowned });
assert.ok(generatedLane.violations.some((item) => item.category === 'generated'));
const releaseOnlyManifest = { ...phase12Manifest, generatedPaths: [] };
const releaseLane = validateFiles(['reports/phase12/phase12-release-evidence.json'], 'p12-k', releaseOnlyManifest, { allowUnowned });
assert.ok(releaseLane.violations.some((item) => item.category === 'release'));

const aggregateWithoutOptIn = validateAggregateFiles(['campaign/spec.md'], phase12Manifest);
assert.equal(aggregateWithoutOptIn.ok, false);
assert.ok(aggregateWithoutOptIn.violations.some((item) => item.category === 'unowned'));
const aggregateWithOptIn = validateAggregateFiles(['campaign/spec.md'], phase12Manifest, { allowUnowned });
assert.equal(aggregateWithOptIn.ok, true, 'the exact cross-lane label may admit an unowned aggregate path');
const forbiddenAggregate = validateAggregateFiles(['js/architecture/escape.js'], phase12Manifest, { allowUnowned });
assert.ok(forbiddenAggregate.violations.some((item) => item.category === 'forbidden'));

assert.equal(
  shouldSkipPhase12Ownership({ eventName: 'pull_request', headRef: 'dev-agent-hardening/example' }),
  true,
  'Dev Agent ownership skip must remain unchanged',
);

console.log('cross-lane Phase 11/12 ownership contract: PASS');
