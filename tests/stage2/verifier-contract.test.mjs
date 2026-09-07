import assert from 'node:assert/strict';
import fs from 'node:fs';
import { isStage2RepositoryFile, minimumVerdictCounts, parseNonNegativeInteger, physicalEvidenceArtifactPathAllowed, stage2CanonicalBuildIdentity, stage2KnownDenominatorGaps, validateScopeAndLedger, verifyStage2 } from '../../tools/validation/stage2/verify.mjs';

const knownGaps = stage2KnownDenominatorGaps();
assert.equal(knownGaps.includes('arm64:a64:all-decoder-encodings-and-aliases'), false, 'terminal ARM64 decoder denominator is no longer a gap');
assert.equal(knownGaps.includes('x86_64:long-64:effect-family:atomic'), false, 'proven exact x86 atomic denominator is no longer a gap');
assert.equal(knownGaps.includes('x86_64:long-64:effect-family:fp'), false, 'closed x86 fp denominator must not remain a known gap');
assert.equal(knownGaps.includes('x86_64:long-64:effect-family:simd'), false, 'closed x86 simd denominator must not remain a known gap');
assert.equal(knownGaps.includes('x86_64:long-64:effect-family:system'), false, 'closed x86 system denominator must not remain a known gap');
assert.equal(knownGaps.includes('remote.remote-canonical-transport'), false, 'active canonical remote transport is no longer a denominator gap');
assert.equal(knownGaps.some((gap) => /^(?:macho|elf|pe):/.test(gap)), false, 'unsigned preservation writers with independent full-report comparison close all F6 invariant cells');
for (const capability of ['attach', 'cancel', 'pause']) assert.equal(knownGaps.includes(`a7-unsupported-capability:${capability}`), false, `A7 active-provider proof closes ${capability} without a static unsupported declaration`);
assert.match(stage2CanonicalBuildIdentity(), /^userscript-release:[0-9a-f]{64}:build:[0-9a-f]{24}:serial:\d+$/);

const scope = JSON.parse(fs.readFileSync('tools/validation/stage2/completion-scope.lock.json', 'utf8'));
const ledger = JSON.parse(fs.readFileSync('tools/validation/stage2/closure-ledger.json', 'utf8'));
const scopeLedger = validateScopeAndLedger('HEAD', { scope, ledger });
assert.doesNotMatch(scopeLedger.errors.join('\n'), /phase12-profile-(unmapped|out-of-scope)/, 'every locked Phase12 capability profile must have explicit ledger ownership');
const missingLocal = structuredClone(ledger);
missingLocal.items.find((item) => item.id === 'S2-P12-COLLAB-REMOTE').scopeProfiles = ['collaboration:remote-security-v1'];
const missingLocalResult = validateScopeAndLedger('HEAD', { scope, ledger: missingLocal });
assert.ok(missingLocalResult.errors.includes('phase12-profile-unmapped:collaboration:local-v1'), 'removing local collaboration ownership must block the ledger');
const staleBaselineTree = structuredClone(scope);
staleBaselineTree.baselineTree = '0'.repeat(40);
assert.ok(validateScopeAndLedger('HEAD', { scope: staleBaselineTree, ledger }).errors.includes('scope-baseline-tree-mismatch'), 'baseline tree must match the frozen baseline commit');

const missingField = structuredClone(ledger);
delete missingField.items[0].owner;
assert.ok(validateScopeAndLedger('HEAD', { scope, ledger: missingField }).errors.includes('ledger-field-invalid:S1-A2-NATIVE:owner'));
const wrongScopeProfile = structuredClone(ledger);
wrongScopeProfile.items[0].scopeProfile = 'smaller-denominator';
assert.ok(validateScopeAndLedger('HEAD', { scope, ledger: wrongScopeProfile }).errors.includes('ledger-scope-profile-invalid:S1-A2-NATIVE'));
const wildcardWithoutMatches = structuredClone(ledger);
wildcardWithoutMatches.items[0].testRefs = ['tests/does-not-exist/**'];
assert.ok(validateScopeAndLedger('HEAD', { scope, ledger: wildcardWithoutMatches }).errors.includes('ledger-ref-missing:S1-A2-NATIVE:tests/does-not-exist/**'));
const extraItem = structuredClone(ledger);
extraItem.items.push({ ...structuredClone(ledger.items[0]), id: 'S2-UNSCOPED' });
assert.ok(validateScopeAndLedger('HEAD', { scope, ledger: extraItem }).errors.includes('ledger-unexpected-id:S2-UNSCOPED'));
const manuallyProven = structuredClone(ledger);
manuallyProven.items[0].status = 'PROVEN';
manuallyProven.items[0].proofIdentity = 'caller-minted';
assert.ok(validateScopeAndLedger('HEAD', { scope, ledger: manuallyProven }).errors.includes('ledger-declared-proof-invalid:S1-A2-NATIVE'));
assert.equal(isStage2RepositoryFile('README.md'), true);
assert.equal(isStage2RepositoryFile('../README.md'), false);
assert.equal(isStage2RepositoryFile('/tmp/stage2-evidence.json'), false);
const artifact = (relative) => `artifact:${relative}@sha256:${'a'.repeat(64)}`;
assert.equal(physicalEvidenceArtifactPathAllowed(artifact('README.md'), 'physical-ipad-fixture'), false, 'arbitrary repository artifacts cannot stand in for the physical fixture');
assert.equal(physicalEvidenceArtifactPathAllowed(artifact('tests/phase5/corpus/fixtures/vertical-sysv-amd64.elf'), 'physical-ipad-fixture'), true);
assert.equal(physicalEvidenceArtifactPathAllowed(artifact('README.md'), 'physical-ipad-scenario-output'), false, 'arbitrary JSON-free artifacts cannot stand in for scenario output');
assert.equal(physicalEvidenceArtifactPathAllowed(artifact('reports/stage2/physical-ipad/run-1/scenario.json'), 'physical-ipad-scenario-output'), true);
assert.equal(physicalEvidenceArtifactPathAllowed(artifact('reports/stage2/physical-ipad/run-1/nested/scenario.json'), 'physical-ipad-scenario-output'), false);
assert.throws(() => parseNonNegativeInteger('--release-blocking-issue-count', ['--release-blocking-issue-count', '']), /release-blocking-issue-count-invalid/);
assert.throws(() => verifyStage2({ finalMode: true, expectedSha: '' }), /stage2-exact-head-required/);

const passed = (command) => ({ command, status: 'passed' });
const complete = minimumVerdictCounts({
  structural: { errors: [] }, sourceAudit: { ok: true },
  commands: [passed('node tests/stage2/run.mjs'), passed('npm run check'), passed('npm run benchmark:baseline')],
  profiles: { status: 'passed', failures: [] }, physical: { status: 'passed' },
  ledger: { unmappedCount: 0, unresolved: [] }, generatedOutput: { status: 'passed' },
  candidateMerge: { status: 'passed' }, releaseBlockingIssueCount: 0,
});
const requiredFields = [
  'unmappedCount', 'unprovenCount', 'scopeReductionCount', 'promotedFallbackCount',
  'coverageDenominatorMisses', 'requiredValidatorMisses', 'fuzzOrPropertyFailures',
  'mutationSelfTestFailures', 'realFixtureFailures', 'performanceBudgetFailures',
  'requiredTargetPlatformFailures', 'supportProjectionMismatches',
  'releaseBlockingIssueCount', 'staleEvidenceCount',
];
assert.deepEqual(Object.keys(complete), requiredFields);
assert.equal(Object.values(complete).every((value) => Number.isSafeInteger(value) && value === 0), true, 'COMPLETE inputs produce only numeric zero counts');

const missing = minimumVerdictCounts({
  structural: { errors: ['scope-baseline-not-ancestor'] }, sourceAudit: { ok: false }, commands: [],
  profiles: { status: 'failed', failures: ['S1-A2-NATIVE:denominator-not-complete'] },
  physical: { status: 'failed' }, ledger: { unmappedCount: 1, unresolved: [{}] },
  generatedOutput: { status: 'blocked-by-preflight' }, candidateMerge: { status: 'failed' },
  releaseBlockingIssueCount: null,
});
for (const field of requiredFields) assert.ok(missing[field] > 0, `${field} must fail closed when its proof is absent`);

const untrackedProbe = 'stage2-untracked-verifier-probe.tmp';
try {
  fs.writeFileSync(untrackedProbe, 'must block exact-tree verification\n');
  assert.throws(() => verifyStage2(), /stage2-worktree-not-clean:[\s\S]*stage2-untracked-verifier-probe\.tmp/);
} finally {
  fs.rmSync(untrackedProbe, { force: true });
}

console.log('[stage2] H16 machine verdict fields fail closed');
