import fs from 'node:fs';
import assert from 'node:assert/strict';
import { sha256 } from './jev-realgame-final-contract.mjs';

const root = new URL('../', import.meta.url);
const report = new URL('reports/investigations/jev-realgame-final/stability-v2/', root);

export function assertStabilityExecution({ snapshots = [], freeze = null } = {}) {
  const execution = freeze ?? JSON.parse(fs.readFileSync(new URL('execution-freeze.json', report)));
  const policyBytes = fs.readFileSync(new URL('policy-freeze.json', report)), policy = JSON.parse(policyBytes);
  assert.equal(execution.policySha256, sha256(policyBytes), 'execution policy drift');
  for (const file of ['scripts/evaluate-jev-realgame-stability.mjs', 'scripts/verify-jev-realgame-stability.mjs',
    'scripts/run-jev-stability-controls.mjs', 'scripts/jev-realgame-final-client.mjs',
    'scripts/jev-realgame-stability-contract.mjs', 'scripts/jev-stability-execution-guard.mjs'])
    assert.match(execution.sourceHashes[file] ?? '', /^[0-9a-f]{64}$/, 'missing frozen execution source');
  for (const [file, hash] of Object.entries(execution.sourceHashes))
    assert.equal(sha256(fs.readFileSync(new URL(file, root))), hash, `frozen execution drift: ${file}`);
  assert.equal(execution.maxAttempts, 1); assert.equal(execution.totalTimeoutMs, 15000);
  assert.equal(execution.primaryRepeat, policy.primaryRepeat); assert.equal(execution.repeats, policy.repeats);
  assert.equal(execution.controlRepeats, 5);
  for (const snapshot of snapshots) {
    assert.equal(snapshot.productSha, execution.collectionProductSha, 'unfrozen collection product');
    assert.equal(snapshot.policySha256, execution.policySha256, 'unfrozen collection policy');
  }
  return execution;
}
