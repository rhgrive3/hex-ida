import test from 'node:test';
import assert from 'node:assert/strict';

import { createProjectOperation } from '../js/collaboration/index.js';
import { ArtifactAnalysisOrchestrator, createWorkerAnalysisArtifactDescriptor } from '../js/cache/artifact-orchestration.js';
import { AnalysisResumeStore } from '../js/cache/analysis-resume.js';
import { KnowledgeDB } from '../js/knowledge/index.js';
import { compileCapabilityRule, evaluateCapabilityRule } from '../js/knowledge/phase12-rules.js';
import { recognizeWithKnowledgeDB } from '../js/knowledge/phase12-recognition.js';

const CANONICAL_BIN = 'bin_sha256_' + 'a'.repeat(64);

// ============================================================================
// 1. [P1] js/collaboration/index.js: canonicalImmutableContent __proto__ safety
// ============================================================================
test('[W2-AreaI-1][P1] createProjectOperation preserves __proto__ as own enumerable data property without prototype pollution', () => {
  const payload = JSON.parse('{"__proto__":{"polluted":true},"normal":42}');
  const op = createProjectOperation({
    operationId: 'op-proto-1',
    projectIdentity: 'proj-1',
    targetEntityId: 'fn:0x1000',
    factKind: 'annotation',
    action: 'set',
    payload,
  });

  assert.equal(Object.prototype.polluted, undefined, 'Object.prototype must not be polluted');
  assert.equal(Object.getPrototypeOf(op.payload), Object.prototype, 'op.payload prototype must remain Object.prototype');
  assert.equal(Object.hasOwn(op.payload, '__proto__'), true, '__proto__ must be an own property on op.payload');
  assert.deepEqual(Object.getOwnPropertyDescriptor(op.payload, '__proto__')?.value, { polluted: true });
  assert.equal(op.payload.normal, 42);
});

// ============================================================================
// 2. [P1] js/cache/artifact-orchestration.js: chargeWorkerPayloadMaterialization fail-closed on state.stopped
// ============================================================================
test('[W2-AreaI-2][P1] chargeWorkerPayloadMaterialization charges observed viewBytes and fails closed even when state.stopped is true', async () => {
  const consumed = [];
  const budget = {
    consume(kind, amount) {
      consumed.push({ kind, amount });
      if (amount > 2 * 1024 * 1024) {
        const err = new Error('budget exceeded');
        err.name = 'BudgetExceededError';
        throw err;
      }
    },
  };
  const store = { get: () => null, put: async () => {} };
  const orchestrator = new ArtifactAnalysisOrchestrator({
    store,
    scheduler: {
      store,
      request: async ({ produce }) => {
        const payload = await produce({ budget });
        return { reused: false, payload };
      },
    },
  });

  const big = new Uint8Array(1024 * 1024);
  const many = new Array(4_200_000).fill(1);

  const descriptor = createWorkerAnalysisArtifactDescriptor({
    binaryId: CANONICAL_BIN,
    sliceIndex: 0,
    architecture: 'arm64',
    artifactKind: 'cfg',
    producerVersion: '1',
    loaderVersion: '1',
    architectureSemanticVersion: '1',
    abiSemanticVersion: '1',
    semanticSchemaVersion: '1',
  });

  await assert.rejects(
    () => orchestrator.request({
      descriptor,
      budget,
      produce: async () => ({ big, many }),
    }),
    (err) => err?.name === 'BudgetExceededError',
  );
  assert.equal(consumed.length, 1, 'budget.consume must be called even when walk stops on a later node');
  assert.equal(consumed[0].kind, 'residentBytes');
  assert.ok(consumed[0].amount >= 4096 + 1024 * 1024 * 4);
});

test('[W2-AreaI-2b][P1] chargeWorkerPayloadMaterialization throws abort error when state.stopped is true under budget', async () => {
  const consumed = [];
  const budget = {
    consume(kind, amount) {
      consumed.push({ kind, amount });
    },
  };
  const store = { get: () => null, put: async () => {} };
  const orchestrator = new ArtifactAnalysisOrchestrator({
    store,
    scheduler: {
      store,
      request: async ({ produce }) => {
        const payload = await produce({ budget });
        return { reused: false, payload };
      },
    },
  });

  const big = new Uint8Array(1024 * 1024);
  const many = new Array(4_200_000).fill(1);

  const descriptor = createWorkerAnalysisArtifactDescriptor({
    binaryId: CANONICAL_BIN,
    sliceIndex: 0,
    architecture: 'arm64',
    artifactKind: 'cfg',
    producerVersion: '1',
    loaderVersion: '1',
    architectureSemanticVersion: '1',
    abiSemanticVersion: '1',
    semanticSchemaVersion: '1',
  });

  await assert.rejects(
    () => orchestrator.request({
      descriptor,
      budget,
      produce: async () => ({ big, many }),
    }),
    /analysis-artifact-payload-charge-aborted/,
  );
  assert.equal(consumed.length, 1);
});

// ============================================================================
// 3. [P2] js/cache/analysis-resume.js: load() & delete() serialized on writeChain with stale-delete guard
// ============================================================================
test('[W2-AreaI-3][P2] AnalysisResumeStore.load serializes corrupt cleanup on writeChain and does not delete a concurrently saved valid record', async () => {
  const backing = new Map();
  const store = new AnalysisResumeStore();
  store.analysisIdentity = 'test-identity-v1';
  store.get = async (key) => backing.get(key) ?? null;
  store.put = async (key, value) => { backing.set(key, value); return true; };
  store.deleteKey = async (key) => backing.delete(key);

  const key = 'session:bin-1:0';
  backing.set(key, {
    schemaVersion: 2,
    analysisIdentity: 'stale-identity',
    binaryId: 'bin-1',
    sliceIndex: 0,
    savedAt: 100,
  });

  let releaseSave;
  const gate = new Promise((r) => { releaseSave = r; });
  const origPut = store.put;
  store.put = async (k, v) => {
    await gate;
    return origPut(k, v);
  };

  const savePromise = store.save('bin-1', 0, { progress: 50 });
  const loadPromise = store.load('bin-1', 0);

  releaseSave();
  await savePromise;
  const loaded = await loadPromise;

  assert.equal(loaded, null, 'initial read saw stale record and returned null');
  const finalRecord = backing.get(key);
  assert.ok(finalRecord, 'concurrently saved valid record must NOT be deleted by load() cleanup');
  assert.equal(finalRecord.analysisIdentity, 'test-identity-v1');
  assert.equal(finalRecord.progress, 50);

  store.put = async (k, v) => {
    await new Promise((r) => setTimeout(r, 15));
    return origPut(k, v);
  };
  const pSave2 = store.save('bin-1', 0, { progress: 99 });
  const pDelete = store.delete('bin-1', 0);
  await Promise.all([pSave2, pDelete]);
  assert.equal(backing.get(key), undefined, 'delete() queued after save() must execute after save() completes');
});

// ============================================================================
// 4. [P2] js/knowledge/index.js: findMatches() and query() pass sourceBinaryHash to isRejected()
// ============================================================================
test('[W2-AreaI-4][P2] KnowledgeDB findMatches and query honor address-only rejections via sourceBinaryHash', async () => {
  const db = new KnowledgeDB({ memoryOnly: true });
  const targetFn = {
    address: 0x401000n,
    name: 'awardCoins',
    sourceBinaryHash: 'bin-hash-abc',
    bytes: new Uint8Array([
      0xfd, 0x7b, 0xbf, 0xa9,
      0x80, 0x0c, 0x80, 0xd2,
      0xfe, 0x03, 0x00, 0x94,
      0x00, 0x04, 0x00, 0x91,
      0xfd, 0x7b, 0xc1, 0xa8,
      0xc0, 0x03, 0x5f, 0xd6,
    ]),
    instructions: [
      { addr: 0x401000n, mn: 'stp', ops: 'x29, x30, [sp, #-16]!' },
      { addr: 0x401004n, mn: 'mov', ops: 'x0, #100' },
      { addr: 0x401008n, mn: 'bl', ops: '#0x402000' },
      { addr: 0x40100cn, mn: 'add', ops: 'x0, x0, #1' },
      { addr: 0x401010n, mn: 'ldp', ops: 'x29, x30, [sp], #16' },
      { addr: 0x401014n, mn: 'ret', ops: '' },
    ],
    strings: ['award_coins_reward'],
    calls: ['grantReward'],
    xrefs: [],
    blocks: [{ start: 0x401000n, end: 0x401018n }],
  };

  const saved = await db.remember({
    ...targetFn,
    names: ['awardCoins'],
    confirmation: 'user-confirmed',
    confidence: 0.95,
  });

  await db.reject({
    sourceBinaryHash: 'bin-hash-abc',
    address: 0x401000n,
    candidateName: 'awardCoins',
    candidateIdentity: saved.identityKey,
  });

  const matchesSameBinary = await db.findMatches(targetFn);
  assert.equal(matchesSameBinary.length, 0, 'findMatches must filter out address-rejected candidate on same sourceBinaryHash');

  const matchesOtherBinary = await db.findMatches({ ...targetFn, sourceBinaryHash: 'bin-hash-other' });
  assert.equal(matchesOtherBinary.length, 1, 'findMatches must still match on a different sourceBinaryHash');

  const querySameBinary = await db.query('awardCoins', [targetFn]);
  assert.equal(querySameBinary[0]?.knowledge ?? null, null, 'query must not attach prior-knowledge from address-rejected candidate on same sourceBinaryHash');

  const queryOtherBinary = await db.query('awardCoins', [{ ...targetFn, sourceBinaryHash: 'bin-hash-other' }]);
  assert.ok(queryOtherBinary[0]?.knowledge, 'query must attach prior-knowledge on a different sourceBinaryHash');
});

// ============================================================================
// 5. [P2] js/knowledge/phase12-rules.js: numericValue() rejects empty/whitespace strings
// ============================================================================
test('[W2-AreaI-5][P2] numericValue in phase12-rules does not treat empty or whitespace strings as 0', () => {
  const lteRule = compileCapabilityRule({
    id: 'rule-lte-num',
    version: '1.0.0',
    scope: 'function',
    capabilityId: 'cap-lte-num',
    expression: { op: 'lte', path: 'count', value: 0 },
  });
  assert.equal(evaluateCapabilityRule(lteRule, { count: '' }).verdict, 'not-detected', 'empty string must not satisfy lte 0');
  assert.equal(evaluateCapabilityRule(lteRule, { count: '  \t ' }).verdict, 'not-detected', 'whitespace string must not satisfy lte 0');
  assert.equal(evaluateCapabilityRule(lteRule, { count: '0' }).verdict, 'supported', 'literal "0" must still match lte 0');

  const gteRule = compileCapabilityRule({
    id: 'rule-gte-num',
    version: '1.0.0',
    scope: 'function',
    capabilityId: 'cap-gte-num',
    expression: { op: 'gte', path: 'count', value: 0 },
  });
  assert.equal(evaluateCapabilityRule(gteRule, { count: '' }).verdict, 'not-detected', 'empty string must not satisfy gte 0');
  assert.equal(evaluateCapabilityRule(gteRule, { count: '   ' }).verdict, 'not-detected', 'whitespace string must not satisfy gte 0');
});

// ============================================================================
// 6. [P2] js/knowledge/phase12-recognition.js: normalized-identical maps to relocation-normalized
// ============================================================================
test('[W2-AreaI-6][P2] recognizeWithKnowledgeDB maps normalized-identical identity to relocation-normalized tier', async () => {
  const mockDb = {
    async findMatches() {
      const batch = [{
        record: { id: 'rec-1', identityKey: 'id-1', names: ['fnA'] },
        confidence: 0.91,
        identity: 'normalized-identical',
        reasons: ['normalized-bytes'],
        evidence: [{ id: 'ev-1' }],
      }];
      batch.truncated = false;
      return batch;
    },
  };

  const result = await recognizeWithKnowledgeDB({
    db: mockDb,
    input: { sourceEntityId: 'fn:0x1000', packageEntryId: 'id-1', address: 0x1000n },
    packageEnvelope: { contentHash: 'sha256:' + 'b'.repeat(64) },
  });

  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].tier, 'relocation-normalized');
});
