import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PROFILE_EVIDENCE_RUN_ROOT,
  PROFILE_EVIDENCE_RUN_SCHEMA,
  PROFILE_UNIT_PROOF_RULES,
  PROFILE_UNIT_PROOF_SCHEMA,
  inspectProfileEvidencePrerequisites,
} from '../../tools/validation/stage2/profile-evidence-collector.mjs';

assert.equal(PROFILE_EVIDENCE_RUN_SCHEMA, 'hex-stage2-profile-evidence-run/v1');
assert.equal(PROFILE_UNIT_PROOF_SCHEMA, 'hex-stage2-profile-unit-proof/v1');
assert.equal(PROFILE_EVIDENCE_RUN_ROOT, 'reports/stage2/profile-evidence-runs');
assert.deepEqual(Object.keys(PROFILE_UNIT_PROOF_RULES).sort(), ['S2-A7-NATIVE', 'S2-M6-CIL', 'S2-M6-DEX', 'S2-M6-JVM', 'S2-M6-WASM']);
for (const rule of Object.values(PROFILE_UNIT_PROOF_RULES)) {
  assert.ok(rule.sourceRefs.length > 0 && rule.testRefs.length > 0);
  for (const ref of [...rule.sourceRefs, ...rule.testRefs]) assert.ok(fs.existsSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', ref)), `allowlisted proof ref exists: ${ref}`);
}

const prerequisites = inspectProfileEvidencePrerequisites();
assert.equal(prerequisites.managed.has('dex'), true, 'canonical real DEX fixture is present');
assert.equal(prerequisites.failures.includes('missing-real-compiled-fixture:dex'), false);
if (prerequisites.failures.some((failure) => failure.startsWith('known-a2-gap:'))) assert.equal(prerequisites.ok, false, 'known A2 denominator gaps block collection');
assert.ok(prerequisites.failures.includes('known-f6-gap:macho:64:layout-and-structure'), 'known F6 implementation gaps block collection');
assert.ok(prerequisites.failures.includes('known-phase12-gap:remote.remote-canonical-transport'), 'known Phase12 transport gaps block collection');
if (prerequisites.f6.missing.length) assert.equal(prerequisites.ok, false, 'missing F6 real fixtures block collection');
console.log('[stage2] profile evidence producer boundary tests passed');
