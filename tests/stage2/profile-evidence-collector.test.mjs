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
import { STAGE2_PROFILE_EVIDENCE_IDS } from '../../js/platform/stage2-profile-evidence.js';

assert.equal(PROFILE_EVIDENCE_RUN_SCHEMA, 'hex-stage2-profile-evidence-run/v1');
assert.equal(PROFILE_UNIT_PROOF_SCHEMA, 'hex-stage2-profile-unit-proof/v1');
assert.equal(PROFILE_EVIDENCE_RUN_ROOT, 'reports/stage2/profile-evidence-runs');
assert.deepEqual(Object.keys(PROFILE_UNIT_PROOF_RULES).sort(), ['S2-A7-NATIVE', 'S2-F6-ELF', 'S2-F6-MACHO', 'S2-F6-PE', 'S2-M6-CIL', 'S2-M6-DEX', 'S2-M6-JVM', 'S2-M6-WASM', 'S2-P12-KNOWLEDGE', 'S2-P12-PATTERNS', 'S2-P12-RULES']);
assert.deepEqual(
  STAGE2_PROFILE_EVIDENCE_IDS.filter((itemId) => !Object.hasOwn(PROFILE_UNIT_PROOF_RULES, itemId)),
  ['S1-A2-NATIVE', 'S2-P12-COLLAB-REMOTE'],
  'the producer must expose an explicit blocker for every denominator item it cannot assemble',
);
for (const rule of Object.values(PROFILE_UNIT_PROOF_RULES)) {
  assert.ok(rule.sourceRefs.length > 0 && rule.testRefs.length > 0);
  for (const ref of [...rule.sourceRefs, ...rule.testRefs]) assert.ok(fs.existsSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', ref)), `allowlisted proof ref exists: ${ref}`);
}
for (const itemId of ['S2-P12-KNOWLEDGE', 'S2-P12-RULES', 'S2-P12-PATTERNS']) {
  const rule = PROFILE_UNIT_PROOF_RULES[itemId];
  assert.equal(rule.realFixtureRefs.length, 1, `${itemId}: exactly one unique real input fixture is bound`);
  assert.equal(rule.negativeTestRefs.length, 1, `${itemId}: negative test identity is explicitly bound`);
  for (const ref of rule.realFixtureRefs) assert.ok(fs.existsSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', ref)), `canonical profile fixture exists: ${ref}`);
}
for (const itemId of ['S2-F6-MACHO', 'S2-F6-ELF', 'S2-F6-PE']) {
  const rule = PROFILE_UNIT_PROOF_RULES[itemId];
  assert.deepEqual(rule.commandIds, ['f6-real-rebuild'], `${itemId}: canonical real rebuild command`);
  assert.deepEqual(rule.independentOracleCommandIds, ['f6-real-rebuild'], `${itemId}: LLVM oracle-bearing command identity`);
  assert.ok(rule.f6Profiles.length >= 1, `${itemId}: exact locked format profiles are bound`);
}
const a7Rule = PROFILE_UNIT_PROOF_RULES['S2-A7-NATIVE'];
assert.deepEqual(a7Rule.requiredProfileIds, ['arm64:a64', 'arm64e:a64+pac', 'x86_64:long-64', 'riscv64:rv64imc']);
assert.deepEqual(a7Rule.realFixtureRefsByProfile['x86_64:long-64'], ['tests/phase5/corpus/fixtures/vertical-sysv-amd64.elf']);
assert.equal(a7Rule.providerProofCommandIdsByProfile['x86_64:long-64'], 'a7-lldb-real-fixture');
assert.ok(a7Rule.commandIds.includes('a7-lldb-real-fixture'));

const prerequisites = inspectProfileEvidencePrerequisites();
assert.equal(prerequisites.managed.has('dex'), true, 'canonical real DEX fixture is present');
assert.equal(prerequisites.failures.includes('missing-real-compiled-fixture:dex'), false);
if (prerequisites.failures.some((failure) => failure.startsWith('known-a2-gap:'))) assert.equal(prerequisites.ok, false, 'known A2 denominator gaps block collection');
assert.ok(prerequisites.failures.includes('known-f6-gap:macho:64:layout-and-structure'), 'known F6 implementation gaps block collection');
assert.ok(prerequisites.failures.includes('known-phase12-gap:remote.remote-canonical-transport'), 'known Phase12 transport gaps block collection');
for (const profileId of ['arm64:a64', 'arm64e:a64+pac', 'riscv64:rv64imc']) {
  assert.ok(prerequisites.failures.includes(`missing-real-profile-fixture:S2-A7-NATIVE:${profileId}`), `A7 ${profileId}: real target fixture cannot be deferred until publication`);
  assert.ok(prerequisites.failures.includes(`missing-active-provider-proof:S2-A7-NATIVE:${profileId}`), `A7 ${profileId}: active provider proof cannot be deferred until publication`);
}
assert.equal(prerequisites.failures.includes('missing-real-profile-fixture:S2-A7-NATIVE:x86_64:long-64'), false, 'bounded x86 LLDB proof binds a real fixture');
assert.equal(prerequisites.failures.includes('missing-active-provider-proof:S2-A7-NATIVE:x86_64:long-64'), false, 'bounded x86 LLDB proof binds an active provider command');
for (const itemId of STAGE2_PROFILE_EVIDENCE_IDS.filter((id) => !Object.hasOwn(PROFILE_UNIT_PROOF_RULES, id))) {
  assert.ok(prerequisites.failures.includes(`missing-profile-proof-rule:${itemId}`), `${itemId}: missing canonical rule blocks partial publication`);
}
if (prerequisites.f6.missing.length) assert.equal(prerequisites.ok, false, 'missing F6 real fixtures block collection');
console.log('[stage2] profile evidence producer boundary tests passed');
