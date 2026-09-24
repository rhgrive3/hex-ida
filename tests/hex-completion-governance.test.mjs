import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  loadManifest,
  permitsFile,
  validateInventory,
  runNegativeSelfCheck,
} from '../tools/validation/hex-completion-ownership.mjs';

import {
  computeMergeTree,
  validateShadowEvidence,
  verifyCandidateMergeTree,
} from '../tools/validation/hex-completion-merge-tree.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TEMP_DIR = path.join(ROOT, 'tmp-governance-test-' + Date.now());

test('hex-completion manifest self-consistency and negative self-checks', () => {
  const manifest = loadManifest();
  assert.equal(manifest.schema, 'hex-completion-ownership/v1');
  assert.equal(manifest.integrationLane, 'integration');

  const selfCheck = runNegativeSelfCheck(manifest);
  assert.equal(selfCheck.valid, true, `Negative self checks failed: ${JSON.stringify(selfCheck.failures)}`);
});

test('generated output is owned exclusively by integration lane', () => {
  const manifest = loadManifest();
  const generated = 'userscript/hex.user.template.js';

  // Integration lane is permitted
  assert.equal(permitsFile(manifest, 'integration', generated), true);

  // All other component lanes MUST be rejected
  const nonIntegrationLanes = Object.keys(manifest.lanes).filter((l) => l !== 'integration');
  for (const lane of nonIntegrationLanes) {
    assert.equal(
      permitsFile(manifest, lane, generated),
      false,
      `Lane ${lane} must not be permitted to own generated output ${generated}`,
    );
    const result = validateInventory(manifest, lane, [generated]);
    assert.equal(result.valid, false);
    assert.equal(result.verdict, 'BLOCKING');
    assert.deepEqual(result.violations, [generated]);
  }
});

test('cross-lane modifications are rejected by default', () => {
  const manifest = loadManifest();

  // Test deterministic lane trying to modify jev or output files
  const deterministicRejected = validateInventory(manifest, 'deterministic', [
    'js/binary/elf-budget.js', // permitted
    'js/pinpoint/heuristics.js', // forbidden cross-lane
  ]);
  assert.equal(deterministicRejected.valid, false);
  assert.equal(deterministicRejected.verdict, 'BLOCKING');
  assert.deepEqual(deterministicRejected.violations, ['js/pinpoint/heuristics.js']);

  // Test cxx lane trying to touch x86
  const cxxRejected = validateInventory(manifest, 'cxx', [
    'js/rtti.js', // permitted
    'js/targets/architecture/x86/decoder.js', // forbidden cross-lane
  ]);
  assert.equal(cxxRejected.valid, false);
  assert.deepEqual(cxxRejected.violations, ['js/targets/architecture/x86/decoder.js']);

  // Test path traversal or absolute paths fail closed
  assert.equal(permitsFile(manifest, 'deterministic', '../secret.js'), false);
  assert.equal(permitsFile(manifest, 'deterministic', '/etc/passwd'), false);
  assert.equal(permitsFile(manifest, 'deterministic', 'js/binary/../../secret.js'), false);
});

test('candidate merge-tree computation works cleanly on git commits', () => {
  // 58712d348 is living integration head, 2bf303289 is parent
  const res = computeMergeTree('2bf303289', '58712d348', ROOT);
  assert.equal(res.success, true);
  assert.match(res.treeSha, /^[0-9a-f]{40}$/i);
});

test('candidate merge-tree verifier fails closed on moving-base mismatch', () => {
  const manifest = loadManifest();
  const res = verifyCandidateMergeTree({
    lane: 'deterministic',
    baseSha: '58712d348df3894bb3f137513aa8d7ded4ade925',
    expectedBaseSha: '0000000000000000000000000000000000000000', // Stale/mismatched base
    headSha: '58712d348df3894bb3f137513aa8d7ded4ade925',
    expectedHeadSha: '58712d348df3894bb3f137513aa8d7ded4ade925',
    manifest,
    requireShadowEvidence: false,
    repoDir: ROOT,
  });

  assert.equal(res.valid, false);
  assert.equal(res.verdict, 'BLOCKING');
  assert.ok(res.errors.some((e) => e.code === 'MOVING_HEAD_MISMATCH'));
});

test('candidate merge-tree verifier fails closed on component head mismatch', () => {
  const manifest = loadManifest();
  const res = verifyCandidateMergeTree({
    lane: 'deterministic',
    baseSha: '58712d348df3894bb3f137513aa8d7ded4ade925',
    expectedBaseSha: '58712d348df3894bb3f137513aa8d7ded4ade925',
    headSha: '58712d348df3894bb3f137513aa8d7ded4ade925',
    expectedHeadSha: '1111111111111111111111111111111111111111', // Stale/moved component head
    manifest,
    requireShadowEvidence: false,
    repoDir: ROOT,
  });

  assert.equal(res.valid, false);
  assert.equal(res.verdict, 'BLOCKING');
  assert.ok(res.errors.some((e) => e.code === 'COMPONENT_HEAD_MISMATCH'));
});

test('candidate merge-tree verifier fails closed on candidate tree mismatch', () => {
  const manifest = loadManifest();
  const res = verifyCandidateMergeTree({
    lane: 'deterministic',
    baseSha: '2bf303289d11efe331e26697055be804d24b1d90',
    expectedBaseSha: '2bf303289d11efe331e26697055be804d24b1d90',
    headSha: '58712d348df3894bb3f137513aa8d7ded4ade925',
    expectedHeadSha: '58712d348df3894bb3f137513aa8d7ded4ade925',
    expectedCandidateTree: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef', // Incorrect expected tree
    manifest,
    requireShadowEvidence: false,
    repoDir: ROOT,
  });

  assert.equal(res.valid, false);
  assert.equal(res.verdict, 'BLOCKING');
  assert.ok(res.errors.some((e) => e.code === 'CANDIDATE_TREE_MISMATCH'));
});

test('candidate merge-tree verifier fails closed on ownership violation in candidate diff', () => {
  const manifest = loadManifest();
  // 58712d348 touched reports/hex-completion-20260924/CHECKPOINT.md and MAIN_RECONCILIATION.json
  // If we claim this was done by lane 'deterministic', it MUST fail with OWNERSHIP_VIOLATION
  const res = verifyCandidateMergeTree({
    lane: 'deterministic',
    baseSha: '2bf303289d11efe331e26697055be804d24b1d90',
    expectedBaseSha: '2bf303289d11efe331e26697055be804d24b1d90',
    headSha: '58712d348df3894bb3f137513aa8d7ded4ade925',
    expectedHeadSha: '58712d348df3894bb3f137513aa8d7ded4ade925',
    manifest,
    requireShadowEvidence: false,
    repoDir: ROOT,
  });

  assert.equal(res.valid, false);
  assert.equal(res.verdict, 'BLOCKING');
  assert.ok(res.errors.some((e) => e.code === 'OWNERSHIP_VIOLATION'));
});

test('candidate merge-tree verifier fails closed on missing, malformed, or mismatched independent shadow evidence', () => {
  fs.mkdirSync(TEMP_DIR, { recursive: true });

  const dummyHead = '58712d348df3894bb3f137513aa8d7ded4ade925';
  const dummyTree = 'aabbccddeeff00112233445566778899aabbccdd';

  try {
    // 1. Missing evidence file
    const missingRes = validateShadowEvidence({
      evidencePath: path.join(TEMP_DIR, 'non-existent.json'),
      expectedCandidateHead: dummyHead,
      expectedCandidateTree: dummyTree,
    });
    assert.equal(missingRes.valid, false);
    assert.equal(missingRes.reason, 'MISSING_SHADOW_EVIDENCE');

    // 2. Malformed JSON
    const malformedFile = path.join(TEMP_DIR, 'malformed.json');
    fs.writeFileSync(malformedFile, '{ not valid json');
    const malformedRes = validateShadowEvidence({
      evidencePath: malformedFile,
      expectedCandidateHead: dummyHead,
      expectedCandidateTree: dummyTree,
    });
    assert.equal(malformedRes.valid, false);
    assert.equal(malformedRes.reason, 'MALFORMED_SHADOW_EVIDENCE');

    // 3. Candidate head mismatch
    const mismatchedHeadFile = path.join(TEMP_DIR, 'mismatched-head.json');
    fs.writeFileSync(mismatchedHeadFile, JSON.stringify({
      candidateHead: '1111111111111111111111111111111111111111',
      candidateTree: dummyTree,
      verdict: 'PASS',
    }));
    const headRes = validateShadowEvidence({
      evidencePath: mismatchedHeadFile,
      expectedCandidateHead: dummyHead,
      expectedCandidateTree: dummyTree,
    });
    assert.equal(headRes.valid, false);
    assert.equal(headRes.reason, 'CANDIDATE_HEAD_MISMATCH');

    // 4. Candidate tree mismatch
    const mismatchedTreeFile = path.join(TEMP_DIR, 'mismatched-tree.json');
    fs.writeFileSync(mismatchedTreeFile, JSON.stringify({
      candidateHead: dummyHead,
      candidateTree: '2222222222222222222222222222222222222222',
      verdict: 'PASS',
    }));
    const treeRes = validateShadowEvidence({
      evidencePath: mismatchedTreeFile,
      expectedCandidateHead: dummyHead,
      expectedCandidateTree: dummyTree,
    });
    assert.equal(treeRes.valid, false);
    assert.equal(treeRes.reason, 'CANDIDATE_MERGE_TREE_MISMATCH');

    // 5. Non-passing verdict
    const nonPassingFile = path.join(TEMP_DIR, 'non-passing.json');
    fs.writeFileSync(nonPassingFile, JSON.stringify({
      candidateHead: dummyHead,
      candidateTree: dummyTree,
      verdict: 'FAIL',
    }));
    const verdictRes = validateShadowEvidence({
      evidencePath: nonPassingFile,
      expectedCandidateHead: dummyHead,
      expectedCandidateTree: dummyTree,
    });
    assert.equal(verdictRes.valid, false);
    assert.equal(verdictRes.reason, 'SHADOW_VERIFICATION_FAILED');

    // 6. Valid shadow evidence passes
    const validFile = path.join(TEMP_DIR, 'valid.json');
    fs.writeFileSync(validFile, JSON.stringify({
      candidateHead: dummyHead,
      candidateTree: dummyTree,
      verdict: 'PASS',
    }));
    const validRes = validateShadowEvidence({
      evidencePath: validFile,
      expectedCandidateHead: dummyHead,
      expectedCandidateTree: dummyTree,
    });
    assert.equal(validRes.valid, true);
    assert.equal(validRes.reason, null);

  } finally {
    fs.rmSync(TEMP_DIR, { recursive: true, force: true });
  }
});
