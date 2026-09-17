import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import test from 'node:test';

const evidencePath = new URL('./fixtures/x02-h02-independent-oracle-20260916.json', import.meta.url);
const matrixPath = new URL('./fixtures/x02-prior120-apple-version-matrix.json', import.meta.url);
const fixturePath = new URL('../phase12/rebuild/fixtures/vertical-macho-x86_64.o', import.meta.url);

const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const evidence = JSON.parse(fs.readFileSync(evidencePath));
const matrixBytes = fs.readFileSync(matrixPath);
const matrix = JSON.parse(matrixBytes);
const fixtureBytes = fs.readFileSync(fixturePath);

test('X02-H-02 pinned exact LLVM 18.1.3 independent-oracle evidence is complete and frozen', () => {
  assert.equal(evidence.schemaVersion, 'hex-x02-h02-independent-oracle-evidence/v1');
  assert.equal(evidence.source.workflowRunId, 35124413027);
  assert.equal(evidence.source.artifactId, 10458469080);
  assert.equal(evidence.source.artifactDigest, 'sha256:3c1c46de539fce1640e26a254d281f63caac787c25d69bf34d30a15dfcd33c20');
  assert.equal(evidence.source.githubSha, 'f165b0097f9f5bd859187332b7aae93d7b81a200');

  assert.equal(sha256(matrixBytes), evidence.frozenMatrix.sha256);
  assert.equal(evidence.frozenMatrix.sha256, 'c95ea2ba89d072fe9110565072462d5efca496b72a66ff365d8b8d15a95274ad');
  const row = matrix.rows.find(item => item.id === 'X02-H-02');
  assert.ok(row);
  assert.equal(row.check, 'llvm-environment');
  assert.equal(row.expectedDisposition, evidence.frozenMatrix.historicalDisposition);
  assert.equal(row.expectedContract.requiredVersion, evidence.oracle.requiredVersion);

  assert.equal(evidence.oracle.identity, 'external:llvm-readobj');
  assert.equal(evidence.oracle.executableSha256, '8ed942a8c33f191480253ff7f236b7e49966c7441d12063d49dce9743aba9a6d');
  assert.match(evidence.oracle.version, /^Ubuntu LLVM version 18\.1\.3\b/);
  assert.equal(evidence.oracle.requiredVersion, 'Ubuntu LLVM version 18.1.3');

  assert.equal(sha256(fixtureBytes), evidence.input.sha256);
  assert.equal(evidence.input.sha256, row.inputSha256);
  assert.equal(evidence.result.classification, 'pass');
  assert.equal(evidence.result.observedStatus, 'independent-reparse');
  assert.equal(evidence.result.format, 'macho');
  assert.equal(evidence.result.architecture, 'x86_64');
  assert.equal(evidence.result.independentOraclePassed, true);
  assert.deepEqual(evidence.result.prior120, { tests: 120, pass: 120, fail: 0 });
});
