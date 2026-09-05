import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { stableDigest } from '../../js/core/identity/index.js';
import { verifyMainReconciliation } from '../../tools/validation/final-closure/preflight.mjs';

// Real Git objects exercise merge/parent/blob authority; they are verifier unit
// fixtures, never runtime or release evidence.
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hex-reviewed-main-'));
  const env = { ...process.env, GIT_AUTHOR_NAME: 'Hex test', GIT_AUTHOR_EMAIL: 'test@example.invalid',
    GIT_COMMITTER_NAME: 'Hex test', GIT_COMMITTER_EMAIL: 'test@example.invalid',
    GIT_INDEX_FILE: path.join(root, 'fixture-index') };
  const git = (args, input, statuses = [0]) => {
    const result = spawnSync('git', args, { cwd: root, env, input, encoding: 'utf8' });
    assert.ok(statuses.includes(result.status), `${args.join(' ')}: ${result.stderr}`);
    return result.stdout.trim();
  };
  git(['init', '-q']);
  const blob = (text) => git(['hash-object', '-w', '--stdin'], text);
  const source = 'js/ai/control/snapshot.js';
  const inventory = 'specs/005-analysis-final-closure/contracts/integration-inventory.json';
  const ownership = 'specs/005-analysis-final-closure/contracts/task-ownership.json';
  const tree = (entries) => {
    git(['read-tree', '--empty']);
    for (const [name, oid] of Object.entries(entries)) git(['update-index', '--add', '--cacheinfo', `100644,${oid},${name}`]);
    return git(['write-tree']);
  };
  const commit = (entries, parents = []) => git(['commit-tree', tree(entries), ...parents.flatMap((p) => ['-p', p])], 'fixture\n');
  const original = { [source]: blob('export const value = 0;\n'), 'clean.txt': blob('base\n'),
    [inventory]: blob(JSON.stringify({ entries: [{ path: source, ownerTaskId: 'T051' }] })),
    [ownership]: blob(JSON.stringify({ tasks: { T051: { allowedPaths: [source] } } })) };
  const base = commit(original);
  const leftEntries = { ...original, [source]: blob('export const value = 1;\n') };
  const rightEntries = { ...original, [source]: blob('export const value = 2;\n'), 'clean.txt': blob('main update\n') };
  const left = commit(leftEntries, [base]);
  const right = commit(rightEntries, [base]);
  const autoTree = git(['merge-tree', '--write-tree', left, right], undefined, [1]).split(/\s+/)[0];
  const resolvedEntries = { ...rightEntries, [source]: leftEntries[source] };
  const merged = commit(resolvedEntries, [left, right]);
  const record = {
    schemaVersion: 'hex-final-closure-main-reconciliation/v2', mode: 'REVIEWED_MERGE',
    previousEvidenceSha: left, currentMainSha: right, integrationHeadSha: merged,
    integrationHeadTreeSha: git(['rev-parse', `${merged}^{tree}`]), autoMergeTreeSha: autoTree,
    adjustmentPaths: [source], adjustmentStableDigest: stableDigest([source]),
    conflictResolutions: [{ path: source, ownerTaskId: 'T051',
      integrationBlobSha: leftEntries[source], mainBlobSha: rightEntries[source],
      resolvedBlobSha: leftEntries[source], selectedParent: 'INTEGRATION' }],
  };
  const verify = (row = record, head = merged) => verifyMainReconciliation(root, row, {
    expectedPreviousEvidenceSha: left, expectedIntegrationHeadSha: head,
    requiredCurrentMainSha: right, sequence: 3,
  });
  return { root, git, blob, commit, source, left, right, leftEntries, rightEntries,
    resolvedEntries, record, verify };
}

test('reviewed main conflict keeps exact parent blobs and clean main changes', () => {
  const f = fixture();
  try {
    assert.equal(f.verify().mode, 'REVIEWED_MERGE');
    for (const mutate of [
      (r) => { r.conflictResolutions = []; },
      (r) => { r.conflictResolutions.push({ ...r.conflictResolutions[0] }); },
      (r) => { r.conflictResolutions[0].resolvedBlobSha = 'a'.repeat(40); },
      (r) => { r.conflictResolutions[0].ownerTaskId = 'T059'; },
      (r) => { r.conflictResolutions[0].selectedParent = 'MAIN'; },
      (r) => { r.currentMainSha = f.left; },
      (r) => { r.autoMergeTreeSha = 'b'.repeat(40); },
    ]) {
      const row = structuredClone(f.record); mutate(row);
      assert.throws(() => f.verify(row), /checkpoint-main-reconciliation/);
    }
    for (const entries of [
      { ...f.resolvedEntries, [f.source]: f.blob('export const value = 3;\n') },
      { ...f.resolvedEntries, 'clean.txt': f.leftEntries['clean.txt'] },
      { ...f.resolvedEntries, 'unrelated.txt': f.blob('unowned\n') },
    ]) {
      const head = f.commit(entries, [f.left, f.right]);
      const row = { ...f.record, integrationHeadSha: head,
        integrationHeadTreeSha: f.git(['rev-parse', `${head}^{tree}`]) };
      assert.throws(() => f.verify(row, head), /checkpoint-main-reconciliation/);
    }
    const reversed = f.commit(f.resolvedEntries, [f.right, f.left]);
    assert.throws(() => f.verify({ ...f.record, integrationHeadSha: reversed }, reversed), /parents-invalid/);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});
