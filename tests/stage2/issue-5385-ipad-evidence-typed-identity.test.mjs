import assert from 'node:assert/strict';
import {
  createPhysicalIPadScenarioOutput,
  REQUIRED_IPAD_CHECKS,
} from '../../js/platform/physical-ipad-evidence.js';

// Issue #5385: identity-authority fields (commitSha, treeSha, deviceModel,
// observedAt, …) entered the release-grade evidence digest through a
// String()-coercing helper. A one-element array or a custom {toString} holder
// laundered into the same canonical text — and therefore the same scenario
// identity — as a legitimately attested record.

const passingChecks = Object.fromEntries(REQUIRED_IPAD_CHECKS.map((key) => [key, {
  status: 'passed',
  observedAt: '2026-01-01T00:00:00Z',
  observationIdentity: 'obs:x',
}]));

const base = {
  commitSha: 'a'.repeat(40),
  treeSha: 'b'.repeat(40),
  buildIdentity: 'build:x',
  runtimeIdentity: 'runtime:x',
  deviceModel: 'iPad13,4',
  iPadOSVersion: '17.0',
  webKitVersion: '617.1',
  startedAt: '2026-01-01T00:00:00Z',
  completedAt: '2026-01-01T00:01:00Z',
  fixtureIdentity: 'fixture:x',
  checks: passingChecks,
};

const legit = createPhysicalIPadScenarioOutput(base);
assert.equal(legit.commitSha, base.commitSha, 'primitive-string authority fields still pass');

for (const [field, structured] of [
  ['commitSha', ['A'.repeat(40)]],
  ['treeSha', { toString: () => 'B'.repeat(40) }],
  ['deviceModel', 1234],
  ['startedAt', true],
  ['buildIdentity', ['build:x']],
  ['fixtureIdentity', ['fixture:x']],
  ['iPadOSVersion', { toString: () => '17.0' }],
  ['completedAt', ['2026-01-01T00:01:00Z']],
]) {
  assert.throws(() => createPhysicalIPadScenarioOutput({ ...base, [field]: structured }),
    (error) => error instanceof TypeError,
    `structured ${field} must be rejected, not String()-coerced into the evidence identity`);
}

// Check-level identity fields are equally authoritative.
for (const [field, structured] of [
  ['observedAt', ['2026-01-01T00:00:00Z']],
  ['observationIdentity', ['obs:x']],
]) {
  const checks = Object.fromEntries(REQUIRED_IPAD_CHECKS.map((key) => [key, {
    status: 'passed', observedAt: '2026-01-01T00:00:00Z', observationIdentity: 'obs:x',
    [field]: structured,
  }]));
  assert.throws(() => createPhysicalIPadScenarioOutput({ ...base, checks }),
    (error) => error instanceof TypeError,
    `structured check ${field} must be rejected`);
}

console.log('issue #5385 physical-iPad evidence typed-identity regression: PASS');
