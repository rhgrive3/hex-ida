import assert from 'node:assert/strict';
import test from 'node:test';

import { stableDigest } from '../../js/core/identity/index.js';
import {
  REQUIRED_IPAD_CHECKS,
  createPhysicalIPadScenarioOutput,
  validatePhysicalIPadScenarioOutput,
} from '../../js/platform/physical-ipad-evidence.js';

const startedAt = '2026-09-03T10:00:00.000Z';
const completedAt = '2026-09-03T11:00:00.000Z';

function canonicalScenario() {
  return createPhysicalIPadScenarioOutput({
    commitSha: 'a'.repeat(40),
    treeSha: 'b'.repeat(40),
    buildIdentity: 'build-A',
    runtimeIdentity: 'runtime-A',
    deviceModel: 'iPad Pro',
    iPadOSVersion: '26.0',
    webKitVersion: '620',
    startedAt,
    completedAt,
    fixtureIdentity: `artifact:fixture@sha256:${'c'.repeat(64)}`,
    checks: Object.fromEntries(REQUIRED_IPAD_CHECKS.map((key, index) => [key, {
      status: 'passed',
      observedAt: '2026-09-03T10:30:00.000Z',
      observationIdentity: `observation-${index}`,
    }])),
  });
}

function resign(record) {
  const payload = {
    schemaVersion: record.schemaVersion,
    commitSha: record.commitSha,
    treeSha: record.treeSha,
    buildIdentity: record.buildIdentity,
    runtimeIdentity: record.runtimeIdentity,
    deviceModel: record.deviceModel,
    iPadOSVersion: record.iPadOSVersion,
    webKitVersion: record.webKitVersion,
    startedAt: record.startedAt,
    completedAt: record.completedAt,
    fixtureIdentity: record.fixtureIdentity,
    checks: record.checks,
  };
  return { ...record, scenarioId: `physical-ipad-scenario:${stableDigest(payload)}` };
}

test('#4905 validator rejects structured scenario window timestamps even when re-signed', () => {
  const canonical = canonicalScenario();
  for (const field of ['startedAt', 'completedAt']) {
    const tampered = resign({ ...structuredClone(canonical), [field]: [canonical[field]] });
    assert.deepEqual(validatePhysicalIPadScenarioOutput(tampered), {
      ok: false,
      reason: 'ipad-scenario-time-invalid',
    });
  }
});

test('#4905 validator rejects structured check observedAt even when re-signed', () => {
  const canonical = structuredClone(canonicalScenario());
  const key = REQUIRED_IPAD_CHECKS[0];
  canonical.checks[key].observedAt = [canonical.checks[key].observedAt];
  const tampered = resign(canonical);
  assert.deepEqual(validatePhysicalIPadScenarioOutput(tampered), {
    ok: false,
    reason: 'ipad-scenario-check-time-invalid',
    check: key,
  });
});
