#!/usr/bin/env node

import { execFileSync, spawnSync } from 'node:child_process';
import { stableDigest } from '../../../js/core/identity/index.js';
import { functionCandidates } from '../../../js/analysis/index.js';
import { discoveryArtifactForRebuild } from '../../../js/analysis/discovery/artifact.js';
import { canonicalTypedDigest } from '../../../js/analysis/discovery/canonical-value.js';
import { verifyX03Ownership, X03_BASE_SHA } from './x03-ownership.mjs';

const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const tree = execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { encoding: 'utf8' }).trim();
const test = spawnSync(process.execPath, ['--test', 'tests/phase7/discovery/ambiguity-matrix.test.mjs'], {
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe'],
});

const bytes = Uint8Array.from([1, 2, 3, 4]);
const binding = {
  binaryId: 'bin-x03-verifier',
  sourceHash: `bytes:${stableDigest(Array.from(bytes))}`,
  snapshotId: 'snapshot-x03-verifier',
  architectureId: 'arm64',
};
const result = functionCandidates({
  input: {
    image: {
      functions: [
        { address: 0x1000, source: 'function_starts', sizeBytes: 0x100 },
        { address: 0x1080, source: 'function_starts', sizeBytes: 0x40 },
      ],
      relocationTargets: [{
        id: 'reloc.verifier', address: 0x1060, sourceAddress: 0x2000,
        symbolicExpression: { kind: 'symbol-plus-addend', symbol: 'verifier', addend: 4 },
      }],
      byteIntervals: [{ start: 0x1040, end: 0x1050, kind: 'data', producerId: 'discovery.loader', producerVersion: '1', evidenceIds: ['verifier:data'] }],
    },
  },
  ...binding,
});
const rebuildBinding = result.artifact.publication.status === 'complete'
  ? discoveryArtifactForRebuild(result.artifact, binding)
  : null;
const ownership = verifyX03Ownership();
const assertions = {
  focusedTestsPassed: test.status === 0,
  analysisComplete: result.status.completeness === 'complete',
  artifactPublishable: result.artifact.publication.status === 'complete',
  alternativesRetained: result.artifact.collisionSets.length >= 3,
  symbolicRelocationRetained: result.artifact.references.some((item) => item.relocationId === 'reloc.verifier'
    && canonicalTypedDigest(item.symbolicExpression) === canonicalTypedDigest({
      kind: 'symbol-plus-addend', symbol: 'verifier', addend: 4,
    })),
  producerCountsBound: result.artifact.producerRuns.every((run) => Number.isSafeInteger(run.evidenceCount)
    && Number.isSafeInteger(run.intervalCount)),
  resourceAuthorityBound: result.artifact.resource?.ok === true
    && Number(result.artifact.resource.observed?.collisionWork) > 0,
  rebuildBindingComplete: rebuildBinding?.collisionSets?.length === result.artifact.collisionSets.length,
  ownershipClean: ownership.ok,
};
const passed = Object.values(assertions).every(Boolean);
const evidence = {
  schemaVersion: 'hex-x03-local-verification/v1',
  baseCommit: X03_BASE_SHA,
  candidateCommit: head,
  candidateTree: tree,
  verifier: 'tools/validation/discovery/x03-verify.mjs',
  verifierDigest: stableDigest({ source: execFileSync('git', ['show', `HEAD:tools/validation/discovery/x03-verify.mjs`], { encoding: 'utf8' }) }),
  artifactId: result.artifact.artifactId,
  collisionIds: result.artifact.collisionSets.map((item) => item.collisionId),
  producerRuns: result.artifact.producerRuns,
  assertions,
  ownership,
  verdict: passed ? 'READY' : 'BLOCKED',
  diagnostics: test.status === 0 ? [] : [test.stderr || test.stdout].filter(Boolean).map((item) => item.slice(-4000)),
};
process.stdout.write(`${JSON.stringify(evidence, null, 2)}\nX03_VERDICT=${evidence.verdict}\n`);
if (!passed) process.exitCode = 1;
