import test from 'node:test';
import assert from 'node:assert/strict';

import { ArchitecturePluginV2 } from '../js/targets/architecture/registry.js';
import { architectureCapability } from '../js/architecture/index.js';
import { aiBudget, AI_BUDGETS } from '../js/ai/schema.js';
import { normalizeIntegerValue, rangeWithDomain } from '../js/range-domain.js';
import { LRU } from '../js/lru.js';
import { RemoteDebugAdapter } from '../js/adapters/index.js';
import { buildAppMap } from '../js/appmap.js';
import { createOriginSet } from '../js/core/identity/origin.js';
import { ArtifactHotCache } from '../js/core/artifacts/hot-cache.js';
import { createArtifactDescriptor, encodeArtifactPayload } from '../js/core/artifacts/contracts.js';
import { ArtifactStore } from '../js/core/artifacts/store.js';
import { AnalysisScheduler } from '../js/core/scheduler/analysis-scheduler.js';
import { EvidenceStore } from '../js/ai/evidence.js';
import { canonicalBindingId, createTurnSnapshot } from '../js/ai/control/snapshot.js';
import { sessionMatchesSnapshot } from '../js/ai/control/runtime-support.js';
import { executeTurn } from '../js/ai/control/turn-executor.js';
import { normalizeAITurnRequest } from '../js/ai/provider/worker-protocol.js';
import { handleAITurn } from '../js/ai/provider/worker-turn.js';
import { handleGemini } from '../js/ai/provider/worker-legacy.js';

await import('../js/worker-budget.js');

function expectCode(code) {
  return (error) => error?.code === code;
}

class MemoryArtifactBackend {
  constructor() { this.map = new Map(); }
  capabilities() { return { persistent: false, atomicPublish: true }; }
  stats() { return { entries: this.map.size }; }
  async getRaw(id) { return this.map.get(id) || null; }
  async putAtomic(record, payload) {
    const current = this.map.get(record.artifactId);
    if (current) return { ...current, duplicate: true };
    const stored = { record, payload };
    this.map.set(record.artifactId, stored);
    return { ...stored, duplicate: false };
  }
  async delete(id) { return this.map.delete(id); }
  async deleteIfMatches(id, record) {
    const current = this.map.get(id);
    if (!current || current.record?.payloadChecksum !== record?.payloadChecksum) return false;
    this.map.delete(id);
    return true;
  }
  async close() {}
}

function artifactDescriptor(kind, upstreamArtifactIds = [], extra = {}) {
  return createArtifactDescriptor({
    binaryId: 'bin:test',
    artifactKind: kind,
    producerId: `test:${kind}`,
    producerVersion: '1',
    relevance: {
      loader: false,
      architectureSemantic: false,
      abiSemantic: false,
      semanticSchema: false,
    },
    upstreamArtifactIds,
    ...extra,
  });
}

function quotaEnvironment() {
  let releases = 0;
  const stub = {
    async acquire() { return { allowed: true, token: 'lease' }; },
    async release() { releases++; },
  };
  return {
    env: {
      GEMINI_API_KEY: 'test-key',
      AI_QUOTA: { getByName() { return stub; } },
    },
    releases: () => releases,
  };
}

function abortedJsonRequest(body) {
  const controller = new AbortController();
  controller.abort('pre-aborted-test');
  return new Request('https://hex.invalid/ai', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: controller.signal,
  });
}

test('architecture positive-integer metadata rejects Number coercion (#3273, #3287)', () => {
  for (const bad of ['4', true, [4], { valueOf: () => 4 }, 1.5, Infinity]) {
    assert.throws(() => new ArchitecturePluginV2({ id: 'strict-test', instructionAlignment: bad }), TypeError);
    assert.throws(() => new ArchitecturePluginV2({ id: 'strict-test', fixedInstructionSize: bad }), TypeError);
  }
  assert.equal(new ArchitecturePluginV2({ id: 'strict-test', instructionAlignment: 4 }).instructionAlignment, 4);
});

test('aiBudget ignores non-number overrides instead of coercing them (#3277)', () => {
  for (const bad of ['1', true, [1], { valueOf: () => 1 }]) {
    assert.equal(aiBudget('chat', { maxToolCalls: bad }).maxToolCalls, AI_BUDGETS.chat.maxToolCalls);
  }
  assert.equal(aiBudget('chat', { maxToolCalls: 1 }).maxToolCalls, 1);
});

test('architecture capability ignores inherited backend flags (#3289)', () => {
  const engine = Object.create({ arm64: true });
  engine.emulation = Object.create({ arm64: true });
  const capability = architectureCapability({ arch: 'arm64', format: 'macho', bits: 64, endian: 'little' }, engine);
  assert.equal(capability.canDisassemble, false);
  assert.equal(capability.canEmulate, false);
});

test('worker supplemental budgets accept primitive finite numbers only (#3291)', () => {
  const budget = globalThis.HexWorkerBudget.createSupplementalBudget();
  assert.equal(budget.takeRead('1'), false);
  assert.equal(budget.takeResident(10), true);
  budget.releaseResident('10');
  assert.equal(budget.snapshot().resident, 10);
  budget.releaseResident(10);
  assert.equal(budget.snapshot().resident, 0);
  assert.equal(globalThis.HexWorkerBudget.withinProgramBudget('0', 1), false);
});

test('range bit widths keep fallback semantics without coercion (#3293)', () => {
  assert.equal(normalizeIntegerValue(0x1ffn, '8', false), 0x1ffn);
  assert.equal(rangeWithDomain(0n, 1n, true, false).bits, 64);
  assert.equal(rangeWithDomain(0n, 1n, [32], false).bits, 64);
  assert.equal(rangeWithDomain(0n, 1n, 32, false).bits, 32);
});

test('LRU limit is an exact non-negative safe integer (#3295)', () => {
  for (const bad of ['1', true, [1], 1.5, -1, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => new LRU(bad), RangeError);
  }
  assert.equal(new LRU(0).limit, 0);
});

test('RemoteDebugAdapter epoch cannot be laundered through Number coercion (#3298)', () => {
  let calls = 0;
  const fake = { epoch: 7, protocol: { setEpoch() { calls++; } } };
  for (const bad of ['8', true, [8], { valueOf: () => 8 }, -1, 1.5]) {
    assert.equal(RemoteDebugAdapter.prototype.setEpoch.call(fake, bad), 7);
  }
  assert.equal(calls, 0);
  assert.equal(RemoteDebugAdapter.prototype.setEpoch.call(fake, 8), 8);
  assert.equal(calls, 1);
});

test('app-map address joins reject structured/stringifying addresses (#3302)', () => {
  const cls = { name: 'NeutralThing', superName: null, methods: [{ addr: 1n, sel: 'm' }], classMethods: [], ivars: [], instanceSize: 0 };
  const fields = { classCount: 1, classes: new Map([['NeutralThing', cls]]) };
  const program = {
    functionRange() { return { start: 1n, end: 2n }; },
    refsFrom() { return [{ target: 16n }]; },
    calleesOf() { return []; },
    callCountOf() { return 0; },
  };
  const invalid = buildAppMap({ fields, program, strings: [{ addr: [16], text: '/login/account' }] });
  const valid = buildAppMap({ fields, program, strings: [{ addr: 16n, text: '/login/account' }] });
  assert.equal(invalid.classes[0].category, 'unknown');
  assert.equal(valid.classes[0].category, 'login');
});

test('OriginSet entity ids are canonical nonblank strings (#3320)', () => {
  const origin = createOriginSet({ instructionIds: [' inst:1 '], operationIds: [' op:1 '], parentEntityIds: [' parent:1 '] });
  assert.deepEqual(origin.instructionIds, ['inst:1']);
  assert.deepEqual(origin.operationIds, ['op:1']);
  assert.deepEqual(origin.parentEntityIds, ['parent:1']);
  assert.throws(() => createOriginSet({ parentEntityIds: ['   '] }), /origin-invalid-parent-ids/);
});

test('ArtifactHotCache rejects blank and non-string artifact ids (#3322)', () => {
  const cache = new ArtifactHotCache();
  assert.throws(() => cache.put('   ', {}, 0), TypeError);
  assert.throws(() => cache.get(['artifact']), TypeError);
  assert.equal(cache.put('artifact', {}, 0), true);
});

test('ArtifactStore rejects unsafe graph budgets instead of turning them into false stale dependencies (#3329)', async () => {
  const backend = new MemoryArtifactBackend();
  const store = new ArtifactStore({ backend, hotCache: new ArtifactHotCache() });
  const parent = artifactDescriptor('parent');
  const child = artifactDescriptor('child', [parent.artifactId]);
  await store.publish(parent, { value: 1 });
  await store.publish(child, { value: 2 });
  store.evictHot();
  const hit = await store.get(child, { maxNodes: -1 });
  assert.equal(hit.status, 'hit');
  await store.close();
});

test('ArtifactStore hot-cache accounting includes record metadata (#3330)', async () => {
  const backend = new MemoryArtifactBackend();
  const hotCache = new ArtifactHotCache();
  const store = new ArtifactStore({ backend, hotCache });
  const descriptor = artifactDescriptor('metadata-size');
  const payload = { value: 'x' };
  await store.publish(descriptor, payload);
  assert.ok(hotCache.stats().bytes > encodeArtifactPayload(payload).byteLength);
  await store.close();
});

test('artifact descriptor optional ids reject whitespace and canonicalize valid strings (#3332)', () => {
  assert.throws(() => artifactDescriptor('blank-slice', [], { sliceId: '   ' }), expectCode('artifact-optional-id-invalid'));
  assert.throws(() => artifactDescriptor('blank-entity', [], { entityId: '   ' }), expectCode('artifact-optional-id-invalid'));
  const descriptor = artifactDescriptor('trimmed', [], { sliceId: ' slice:1 ', entityId: ' entity:1 ' });
  assert.equal(descriptor.sliceId, 'slice:1');
  assert.equal(descriptor.entityId, 'entity:1');
});

test('scheduler lookup/cancel APIs do not stringify structured ids (#3336)', () => {
  const scheduler = new AnalysisScheduler({ store: {} });
  assert.throws(() => scheduler.state(['task']), TypeError);
  assert.throws(() => scheduler.dependencyIds({ toString: () => 'task' }), TypeError);
  assert.throws(() => scheduler.cancel(['task']), TypeError);
  assert.equal(scheduler.state('task'), 'unknown');
});

test('EvidenceStore lookup ids remain string-only (#3351)', () => {
  const store = new EvidenceStore();
  store.add({ id: 'evidence:1', kind: 'fact', status: 'supported', title: 'fact', sourceTool: 'test' });
  assert.equal(store.has(['evidence:1']), false);
  assert.equal(store.get({ toString: () => 'evidence:1' }), null);
  assert.equal(store.has('evidence:1'), true);
});

test('AI snapshot/session authority ids remain primitive strings (#3354)', () => {
  assert.equal(canonicalBindingId({ toString: () => 'bin:1' }), null);
  const snapshot = createTurnSnapshot({ binaryId: ['bin:1'], runtimeSessionId: { toString: () => 'run:1' } }, { projectId: ['project:1'] });
  assert.equal(snapshot.projectIdentity, null);
  assert.equal(snapshot.runtimeSessionIdentity, null);
  assert.equal(sessionMatchesSnapshot({ binaryId: ['bin:1'] }, { binaryId: 'bin:1', binaryIdentity: { id: 'bin:1' }, projectIdentity: null, runtimeSessionState: 'unknown' }), false);
});

test('turn executor rejects malformed external signal objects (#3356)', async () => {
  await assert.rejects(
    () => executeTurn.call({}, { goal: 'test', mode: 'chat', style: 'analyst', scope: 'auto' }, {
      signal: { aborted: false, addEventListener() {}, removeEventListener: 'not-a-function' },
    }),
    (error) => error?.type === 'invalid_model_output',
  );
});

test('worker turn enum fields reject structured/coercible values (#3357)', () => {
  const base = { context: { request: { goal: 'test' } } };
  assert.throws(() => normalizeAITurnRequest({ ...base, mode: ['chat'] }), (error) => error?.code === 'invalid_mode');
  assert.throws(() => normalizeAITurnRequest({ ...base, style: { toString: () => 'analyst' } }), (error) => error?.code === 'invalid_style');
  assert.throws(() => normalizeAITurnRequest({ ...base, scope: ['auto'] }), (error) => error?.code === 'invalid_scope');
});

test('pre-aborted worker requests stop before provider fetch and release quota (#3363)', async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = async () => { fetchCalls++; throw new Error('provider fetch must not run'); };
  try {
    const turnQuota = quotaEnvironment();
    const turnResponse = await handleAITurn(abortedJsonRequest({
      mode: 'chat',
      context: { request: { goal: 'test' } },
    }), turnQuota.env);
    assert.equal(turnResponse.status, 499);
    assert.equal(turnQuota.releases(), 1);

    const legacyQuota = quotaEnvironment();
    const legacyResponse = await handleGemini(abortedJsonRequest({
      question: 'test',
      currentFunction: { address: '0x1000', assembly: 'ret' },
    }), legacyQuota.env);
    assert.equal(legacyResponse.status, 499);
    assert.equal(legacyQuota.releases(), 1);
    assert.equal(fetchCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
