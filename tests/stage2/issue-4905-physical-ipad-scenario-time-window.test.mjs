import assert from 'node:assert/strict';
import {
  REQUIRED_IPAD_CHECKS,
  createPhysicalIPadScenarioOutput,
  validatePhysicalIPadScenarioOutput,
} from '../../js/platform/physical-ipad-evidence.js';

const commitSha = 'a'.repeat(40);
const treeSha = 'b'.repeat(40);
const fixtureIdentity = 'artifact:reports/stage2/fixture.bin@sha256:' + 'c'.repeat(64);
const startedAt = '2026-09-03T10:00:00.000Z';
const completedAt = '2026-09-03T11:00:00.000Z';

function scenarioWithObservedAt(observedAt, { start = startedAt, end = completedAt, checkTimes = null } = {}) {
  const checks = Object.fromEntries(REQUIRED_IPAD_CHECKS.map((key, index) => [key, {
    status: 'passed',
    observedAt: checkTimes?.[key] ?? observedAt,
    observationIdentity: `observation-${index}`,
  }]));
  return createPhysicalIPadScenarioOutput({
    commitSha,
    treeSha,
    buildIdentity: 'build-A',
    runtimeIdentity: 'runtime-A',
    deviceModel: 'iPad Pro',
    iPadOSVersion: '26.0',
    webKitVersion: '620',
    startedAt: start,
    completedAt: end,
    fixtureIdentity,
    checks,
  });
}

for (const observedAt of [
  startedAt,
  '2026-09-03T10:30:00.000Z',
  completedAt,
  '2026-09-03T06:00:00.000-04:00', // Same instant as startedAt.
]) {
  assert.equal(validatePhysicalIPadScenarioOutput(scenarioWithObservedAt(observedAt)).ok, true);
}

for (const [observedAt, expectedCheck] of [
  ['2026-09-03T09:59:59.999Z', REQUIRED_IPAD_CHECKS[0]],
  ['2026-09-03T11:00:00.001Z', REQUIRED_IPAD_CHECKS[0]],
  ['2000-01-01T00:00:00.000Z', REQUIRED_IPAD_CHECKS[0]],
  ['2099-01-01T00:00:00.000Z', REQUIRED_IPAD_CHECKS[0]],
]) {
  const result = validatePhysicalIPadScenarioOutput(scenarioWithObservedAt(observedAt));
  assert.deepEqual(
    { ok: result.ok, reason: result.reason, check: result.check },
    { ok: false, reason: 'ipad-scenario-check-time-outside-run', check: expectedCheck },
  );
}

{
  const checkTimes = Object.fromEntries(REQUIRED_IPAD_CHECKS.map((key) => [key, '2026-09-03T10:30:00.000Z']));
  checkTimes.cancellation = '2026-09-03T09:59:59.999Z';
  const result = validatePhysicalIPadScenarioOutput(scenarioWithObservedAt('2026-09-03T10:30:00.000Z', { checkTimes }));
  assert.equal(result.reason, 'ipad-scenario-check-time-outside-run');
  assert.equal(result.check, 'cancellation');
}

{
  const result = validatePhysicalIPadScenarioOutput(scenarioWithObservedAt('not-a-date'));
  assert.equal(result.reason, 'ipad-scenario-check-time-invalid');
}

{
  const instant = '2026-09-03T10:00:00.000Z';
  assert.equal(validatePhysicalIPadScenarioOutput(scenarioWithObservedAt(instant, { start: instant, end: instant })).ok, true);
  assert.equal(
    validatePhysicalIPadScenarioOutput(scenarioWithObservedAt('2026-09-03T09:59:59.999Z', { start: instant, end: instant })).reason,
    'ipad-scenario-check-time-outside-run',
  );
}

console.log('[issue-4905] physical iPad check timestamps are contained by the scenario run');
