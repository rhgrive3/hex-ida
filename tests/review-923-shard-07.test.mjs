import test from 'node:test';
import assert from 'node:assert/strict';

import { stableSerialize, shortHash } from '../js/ai/tools/paging/cursor.js';
import { jsonSafe } from '../js/ai/validation.js';
import { align } from '../js/binary/reader.js';
import { fingerprintImage } from '../js/binary/fingerprint.js';
import { stringLookup } from '../js/role.js';
import { validateSatModel } from '../js/symbolic/verify/validate-model.js';
import { createSolverResult, SOLVER_STATUS } from '../js/symbolic/solver/result.js';
import { PROOF_AUTHORITY } from '../js/symbolic/solver/backend.js';
import { COMPLETENESS_STATUS } from '../js/symbolic/translate/support-matrix.js';
import {
  computeProofCacheKey,
  computeVerifierFingerprint,
  isCacheableProof,
} from '../js/symbolic/evidence/cache-policy.js';
import {
  createSymbolicEvidence,
  isProvedEvidence,
  EVIDENCE_VERDICT,
  PRECONDITION_STATUS,
  VALIDATION_STATUS,
} from '../js/symbolic/evidence/symbolic-evidence.js';
import { ABIPlugin } from '../js/targets/abi/registry.js';
import { DARWIN_PLATFORM, LINUX_PLATFORM } from '../js/targets/platform/index.js';
import { dispatchX86TerminalResidualEffects } from '../js/targets/architecture/x86_64/effects/terminal-residual.js';
import { RuntimeProviderProtocolClient } from '../js/runtime/provider-protocol.js';
import { createLazyAppAnalysisQueryAPI } from '../js/analysis/query/lazy-app-adapter.js';
import { parseHexProject, serializeHexProject, createHexProject, ProjectFormatError } from '../js/project/index.js';
import { createPackageEnvelope, importPhase12Package, createPackageBudget } from '../js/phase12/package-envelope.js';
import { layoutNodes, routeEdges } from '../js/graph-routing.js';

const ALL_COMPLETE = Object.freeze({
  translation: COMPLETENESS_STATUS.COMPLETE,
  controlFlow: COMPLETENESS_STATUS.COMPLETE,
  memoryEffects: COMPLETENESS_STATUS.COMPLETE,
  pathCoverage: COMPLETENESS_STATUS.COMPLETE,
  queryScope: COMPLETENESS_STATUS.COMPLETE,
});

test('P1-S07-008: cursor stableSerialize and shortHash handle undefined without crashing or colliding', () => {
  assert.equal(stableSerialize(undefined), 'undefined');
  assert.notEqual(stableSerialize([undefined]), stableSerialize([]));
  const h = shortHash(undefined);
  assert.equal(typeof h, 'string');
  assert.equal(h.length, 14);
});

test('P1-S09-014: ai/validation jsonSafe formats negative BigInt as -0x...', () => {
  assert.equal(jsonSafe(-16n), '-0x10');
  assert.equal(jsonSafe(16n), '0x10');
});

test('P1-S06-032: binary/reader align rounds negative values toward +Infinity', () => {
  assert.equal(align(-5n, 4n), -4n);
  assert.equal(align(-8n, 4n), -8n);
  assert.equal(align(5n, 4n), 8n);
  assert.equal(align(0n, 4n), 0n);
});

test('P2-S06-018: fingerprintImage handles unrepresentable mappings, signal, and maxBytes', () => {
  const image = {
    bytes: new Uint8Array([1, 2, 3, 4]),
    segments: [
      { name: '__text', address: 0x1000n, fileOffset: 0n, fileSize: 4n, perms: { execute: true }, executable: true },
      { name: '__bss', address: 0x2000n, fileOffset: null, fileSize: 16n, perms: { execute: true }, executable: true },
    ],
  };
  const fp = fingerprintImage(image);
  assert.equal(fp.bytes, 4);
  assert.equal(typeof fp.hash, 'string');

  const ac = new AbortController();
  ac.abort();
  assert.throws(() => fingerprintImage(image, { signal: ac.signal }), { name: 'AbortError' });
  assert.throws(() => fingerprintImage(image, { maxBytes: 2 }), RangeError);
});

test('P2-S02-031: role stringLookup refreshes when underlying array is mutated', () => {
  const arr = [{ addr: 0x1000n, text: 'hello' }];
  const lookup1 = stringLookup(arr);
  assert.equal(lookup1(0x1000n)?.text, 'hello');
  assert.equal(lookup1(0x2000n), null);
  arr.push({ addr: 0x2000n, text: 'world' });
  const lookup2 = stringLookup(arr);
  assert.equal(lookup2(0x2000n)?.text, 'world');
});

test('P1-S03-035: validateSatModel fails closed on empty query and null constraint', () => {
  assert.equal(validateSatModel({}, new Map()).valid, false);
  assert.equal(validateSatModel({ constraints: [null] }, new Map()).valid, false);
});

test('P1-S10-020: createSolverResult marks late lifecycle as non-publishable', () => {
  const res = createSolverResult({
    status: SOLVER_STATUS.UNSAT,
    lifecycle: { late: true },
  });
  assert.equal(res.lifecycle.late, true);
  assert.equal(res.lifecycle.publishable, false);
});

test('P2-S06-011 & P2-S06-021: cache-policy delimiter injection, precondition gate, and canonicalizeValue', () => {
  const k1 = computeProofCacheKey({ queryHash: 'q', verifierFingerprint: 'vf1', binaryIdentity: 'binA::rev1', analysisRevision: 'r' });
  const k2 = computeProofCacheKey({ queryHash: 'q', verifierFingerprint: 'vf1', binaryIdentity: 'binA', analysisRevision: 'rev1::r' });
  assert.notEqual(k1, k2);

  const kNull = computeProofCacheKey({ queryHash: 'q', verifierFingerprint: 'vf1', binaryIdentity: null });
  const kLit = computeProofCacheKey({ queryHash: 'q', verifierFingerprint: 'vf1', binaryIdentity: 'binary:unknown' });
  assert.notEqual(kNull, kLit);

  assert.equal(isCacheableProof({
    verdict: 'proved',
    solverStatus: SOLVER_STATUS.UNSAT,
    completeness: ALL_COMPLETE,
    preconditionStatus: null,
    proofAuthority: PROOF_AUTHORITY.EXACT,
    capabilityFingerprint: 'fp',
    backendId: 'b',
    backendVersion: '1',
  }), false);

  const fpBig = computeVerifierFingerprint({
    backendId: 'b', backendVersion: '1', semanticIrVersion: '1', queryKind: 'k',
    proofAuthority: PROOF_AUTHORITY.EXACT, capabilityFingerprint: 'cf', architecture: 'arm64',
    assumptionsFingerprint: 'af', solverOptions: { bound: 1n },
  });
  const fpStr = computeVerifierFingerprint({
    backendId: 'b', backendVersion: '1', semanticIrVersion: '1', queryKind: 'k',
    proofAuthority: PROOF_AUTHORITY.EXACT, capabilityFingerprint: 'cf', architecture: 'arm64',
    assumptionsFingerprint: 'af', solverOptions: { bound: '0x1' },
  });
  assert.notEqual(fpBig, fpStr);

  const cyc = {};
  cyc.self = cyc;
  assert.throws(() => computeVerifierFingerprint({
    backendId: 'b', backendVersion: '1', semanticIrVersion: '1', queryKind: 'k',
    proofAuthority: PROOF_AUTHORITY.EXACT, capabilityFingerprint: 'cf', architecture: 'arm64',
    assumptionsFingerprint: 'af', solverOptions: cyc,
  }), TypeError);
});

test('P2-S06-012 & P1-S06-037: symbolic-evidence binds proofStatement/assumptions and rejects non-object witnessModel', () => {
  const ev = createSymbolicEvidence({
    queryKind: 'reachability',
    claimKind: 'unreachable',
    proofStatement: 'x != 0',
    targetEntities: ['fn_1'],
    queryHash: 'qh1',
    backendId: 'bitblast',
    backendVersion: '1.0',
    proofAuthority: PROOF_AUTHORITY.EXACT,
    capabilityFingerprint: 'cap-1',
    solverStatus: SOLVER_STATUS.UNSAT,
    preconditionStatus: PRECONDITION_STATUS.SATISFIABLE,
    completeness: ALL_COMPLETE,
    assumptions: [{ kind: 'non-null', var: 'p' }],
    verdict: EVIDENCE_VERDICT.PROVED,
    architecture: 'arm64',
    bitWidth: 64,
  });
  assert.equal(isProvedEvidence(ev), true);
  assert.equal(isProvedEvidence({ ...ev, proofStatement: 'tampered' }), false);
  assert.equal(isProvedEvidence({ ...ev, assumptions: [] }), false);

  assert.throws(() => createSymbolicEvidence({
    queryKind: 'reachability',
    claimKind: 'unreachable',
    proofStatement: 'x != 0',
    targetEntities: ['fn_1'],
    queryHash: 'qh2',
    backendId: 'bitblast',
    backendVersion: '1.0',
    proofAuthority: PROOF_AUTHORITY.EXACT,
    capabilityFingerprint: 'cap-1',
    solverStatus: SOLVER_STATUS.SAT,
    preconditionStatus: PRECONDITION_STATUS.SATISFIABLE,
    validationStatus: VALIDATION_STATUS.VALIDATED,
    completeness: ALL_COMPLETE,
    verdict: EVIDENCE_VERDICT.REFUTED,
    witnessModel: 'not-an-object',
    architecture: 'arm64',
    bitWidth: 64,
  }));
});

test('P2-S15-022: ABIPlugin does not invoke bound hook callbacks during construction', () => {
  let called = 0;
  const hook = function () { called++; return null; }.bind(null);
  new ABIPlugin({
    id: 'test-no-probe-abi',
    architectureId: 'arm64',
    platforms: ['linux'],
    classifyArguments: hook,
  });
  assert.equal(called, 0);
});

test('P1-S07-030: PlatformProfile.defaultABI handles missing argument', () => {
  assert.equal(DARWIN_PLATFORM.defaultABI(), null);
  assert.equal(LINUX_PLATFORM.defaultABI(), null);
});

test('P2-S01-018: x86_64 terminal-residual rejects Object.prototype family keys cleanly', () => {
  const res = dispatchX86TerminalResidualEffects({ instructionFamily: 'toString', mnemonic: 'toString', bytes: [] });
  assert.equal(res, null);
});

test('P1-S14-020: RuntimeProviderProtocolClient.setEpoch enforces monotonic epoch', () => {
  const client = new RuntimeProviderProtocolClient({ send() {}, onMessage() { return () => {}; } });
  assert.equal(client.setEpoch(2), 2);
  assert.throws(() => client.setEpoch(1), RangeError);
});

test('P1-S12-031 & P2-S12-014: lazy-app-adapter does not load adapter on toJSON/toString/unknown properties', () => {
  let loaded = 0;
  const api = createLazyAppAnalysisQueryAPI({}, async () => { loaded++; return {}; });
  assert.equal(api.toJSON, undefined);
  assert.equal(api.nonExistentMethod, undefined);
  assert.equal(typeof api.toString, 'function');
  assert.equal(loaded, 0);
});

test('P2-S11-002 & P2-S11-010: project/index strips confirmed/evidence verified status and bounds recursion depth', () => {
  const proj = createHexProject({
    confirmedFindings: [{ id: 'f1', status: 'verified' }],
    evidence: [{ id: 'e1', status: 'verified' }],
  });
  const parsed = parseHexProject(serializeHexProject(proj));
  assert.equal(parsed.findings.confirmed[0].status, 'supported');
  assert.equal(parsed.findings.evidence[0].status, 'supported');

  let deep = 'leaf';
  for (let i = 0; i < 200; i++) deep = { a: deep };
  const rawDeep = JSON.stringify({ format: 'hexproj', version: 2, bigIntEncoding: 1, extra: deep });
  assert.throws(() => parseHexProject(rawDeep), ProjectFormatError);
});

test('P2-S10-003 & P1-S10-014: phase12 package-envelope clones binary buffers and preserves maxBytes default', () => {
  const buf = new Uint8Array([1, 2, 3, 4]);
  const env = createPackageEnvelope({
    kind: 'knowledge',
    packageId: 'pkg-clone-test',
    packageVersion: '1.0.0',
    payload: { raw: buf },
    provenance: { source: 'test' },
    license: 'MIT',
    requiredSemanticVersions: { knowledge: '1' },
  });
  const mutableCopy = { ...env, payload: { raw: new Uint8Array([1, 2, 3, 4]) } };
  const imported = importPhase12Package(mutableCopy);
  mutableCopy.payload.raw[0] = 99;
  assert.equal(imported.payload.raw[0], 1);

  const budget = createPackageBudget({ maxBytes: undefined });
  assert.ok(budget.limits.maxBytes >= 32 * 1024 * 1024);
});

test('P1-S05-042: graph-routing handles empty graph without crashing', () => {
  const layout = layoutNodes([], [], new Map());
  const routed = routeEdges([], layout);
  assert.ok(routed);
});
