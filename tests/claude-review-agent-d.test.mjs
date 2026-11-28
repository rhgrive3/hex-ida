import test from 'node:test';
import assert from 'node:assert/strict';

import {
  deepFreeze,
  isLightweightIdentityActive,
  nextLightweightId,
  stableDigest,
  stableStringify,
  withLightweightIdentity,
} from '../js/core/identity/index.js';
import {
  createOriginSet,
  isCanonicalOriginSet,
  isReusableOriginSet,
  mergeOriginSets,
} from '../js/core/identity/origin.js';
import { analyzeFunction } from '../js/analyze.js';
import { buildIR, MK } from '../js/ir.js';
import {
  constantComparisons,
  dataflowEngine,
  distinctCandidateLocations,
  findValueUpdates,
  stripHeavyIrRefs,
} from '../js/dataflow.js';
import { handlePinpointWorkerMessage, WORKER_SEMANTIC_IR_MAX_INSNS } from '../js/analysis/pinpoint-worker.js';
import { InvestigationService } from '../js/analysis/investigation-service.js';
import { makePinpointAnalyzer } from '../js/ui/pinpoint-runtime.js';
import { pinpointField, pinpointFunction, pinpointLocation } from '../js/pinpoint-legacy.js';
import { fieldUse } from '../js/verify.js';
import { memoizeAnalysis } from '../js/auto.js';
import { goalFromPreset } from '../js/goals.js';

async function makeArm64Model(asmLines, base = 0x100000000n) {
  const mn = [];
  const ops = [];
  for (const line of asmLines) {
    const trimmed = line.trim();
    const sp = trimmed.indexOf(' ');
    mn.push(sp === -1 ? trimmed : trimmed.slice(0, sp));
    ops.push(sp === -1 ? '' : trimmed.slice(sp + 1).trim());
  }
  const region = { id: 'test-text', vmAddr: base, size: BigInt(asmLines.length * 4) };
  const backend = {
    async fetchChunk(_rid, c) {
      return c === 0 ? { mn, ops, bytes: null } : { mn: [], ops: [], bytes: null };
    },
  };
  const res = await analyzeFunction(backend, region, 0, asmLines.length - 1, null, null, { texts: false });
  return res.model;
}

test('withLightweightIdentity: scoped flag, nested scopes, exception recovery, and deepFreeze skip', () => {
  assert.equal(isLightweightIdentityActive(), false);

  const frozenOutside = deepFreeze({ a: { b: 1 } });
  assert.equal(Object.isFrozen(frozenOutside), true);
  assert.equal(Object.isFrozen(frozenOutside.a), true);

  let innerActive = false;
  let unfrozenInside = null;
  const ret = withLightweightIdentity(() => {
    assert.equal(isLightweightIdentityActive(), true);
    unfrozenInside = deepFreeze({ a: { b: 2 } });
    assert.equal(Object.isFrozen(unfrozenInside), false);
    assert.equal(Object.isFrozen(unfrozenInside.a), false);

    withLightweightIdentity(() => {
      innerActive = isLightweightIdentityActive();
    });
    assert.equal(isLightweightIdentityActive(), true, 'outer scope stays active after nested scope exits');
    return 42;
  });

  assert.equal(ret, 42);
  assert.equal(innerActive, true);
  assert.equal(isLightweightIdentityActive(), false);

  assert.throws(() => {
    withLightweightIdentity(() => {
      assert.equal(isLightweightIdentityActive(), true);
      throw new Error('boom');
    });
  }, /boom/);
  assert.equal(isLightweightIdentityActive(), false, 'flag must be restored in finally after throw');

  const lwOrigin = withLightweightIdentity(() => {
    const o1 = createOriginSet({
      virtualRanges: [{ start: 0x1000n, end: 0x1004n }],
      instructionIds: ['i1'],
    });
    const o2 = createOriginSet({
      virtualRanges: [{ start: 0x1004n, end: 0x1008n }],
      instructionIds: ['i2'],
    });
    const merged = mergeOriginSets(o1, o2);
    assert.equal(isReusableOriginSet(merged), true);
    assert.equal(Object.isFrozen(merged), false);
    return merged;
  });
  assert.equal(isCanonicalOriginSet(lwOrigin), false);
  assert.equal(isReusableOriginSet(lwOrigin), false);

  const canonical = createOriginSet({ virtualRanges: [{ start: 0x1000n, end: 0x1004n }] });
  assert.equal(isCanonicalOriginSet(canonical), true);
  assert.equal(Object.isFrozen(canonical), true);

  const id1 = nextLightweightId('test');
  const id2 = nextLightweightId('test');
  assert.notEqual(id1, id2);
});

test('stableDigest determinism: identical bit-for-bit output inside and outside withLightweightIdentity', () => {
  const samples = [
    { kind: 'register', registerId: 'x0' },
    { kind: 'register', registerId: 'x19' },
    { ordering: 'unknown', bytes: 4, signed: false, zero: 0, negZero: -0, smallInt: 255, big: 1024, bigInt: 0x100000000n },
    { escaped: 'hello "world" \\ \n \t 日本語', ascii: 'plain_ascii_key_123' },
    ['possibleFaults', 'alignment', 'page-fault'],
    new Map([['b', 2], ['a', 1]]),
    new Set(['z', 'a', 'm']),
    new Uint8Array([0, 1, 10, 99, 100, 255]),
  ];

  for (const sample of samples) {
    const outsideDigest = stableDigest(sample);
    const outsideStr = stableStringify(sample);
    const inside = withLightweightIdentity(() => ({
      d1: stableDigest(sample),
      d2: stableDigest(sample),
      s1: stableStringify(sample),
      s2: stableStringify(sample),
    }));
    assert.equal(inside.d1, outsideDigest, 'stableDigest must match bit-for-bit inside lightweight mode');
    assert.equal(inside.d2, outsideDigest, 'repeated stableDigest must remain deterministic');
    assert.equal(inside.s1, outsideStr, 'stableStringify must match bit-for-bit inside lightweight mode');
    assert.equal(inside.s2, outsideStr, 'repeated stableStringify must remain deterministic');
  }
});

test('stripHeavyIrRefs and pinpointLocation strip u.ir references', async () => {
  const fakeIrGraph = { giant: new Array(1000).fill('node') };
  const sample = {
    kind: 'read-modify-write',
    engine: 'ir-ssa',
    location: { base: 'x0', disp: 0x20n, size: 4, key: 'x0@32', self: true },
    store: { row: 3, address: 0x10000000cn, reg: 'w8' },
    confidence: 0.95,
    ir: { location: fakeIrGraph, load: fakeIrGraph, store: fakeIrGraph },
  };
  const stripped = stripHeavyIrRefs(sample);
  assert.equal('ir' in stripped, false);
  assert.equal(stripped.kind, 'read-modify-write');
  assert.equal(stripped.location.key, 'x0@32');
  assert.equal(stripped.confidence, 0.95);
  assert.equal(stripHeavyIrRefs(stripped), stripped, 'already-stripped object is returned as-is');

  const model = await makeArm64Model([
    'ldr w8, [x0, #0x20]',
    'add w8, w8, #1',
    'str w8, [x0, #0x20]',
    'cmp w8, #100',
    'ret',
  ]);
  const liveUpdates = findValueUpdates(model);
  assert.ok(liveUpdates.length > 0, 'model produces updates');

  const program = {
    functionRange: () => ({ start: model.startAddress, end: model.endAddress }),
    functionStartOf: () => model.startAddress,
    callersOf: () => [],
  };
  const locRes = await pinpointLocation({
    goal: goalFromPreset('money'),
    ranked: [{ addr: model.startAddress, name: 'addCoins', strings: [{ text: 'coins' }] }],
    program,
    analyze: async () => model,
  });
  assert.ok((locRes.candidates || []).length > 0, 'pinpointLocation produces candidate');
  for (const cand of locRes.candidates || []) {
    for (const u of cand.updates || []) {
      assert.equal('ir' in u && u.ir != null, false, 'pinpointLocation must strip u.ir before storing in e.updates');
    }
  }
});

test('dataflow precomputed bypass: opts-consistent filtering without main-thread IR rebuild', () => {
  const fakeModel = {
    instructions: null,
    _precomputedEngine: 'semantic-ir',
    _precomputedUpdates: [
      {
        kind: 'read-modify-write',
        engine: 'ir-ssa',
        location: { base: 'x0', disp: 0x20n, size: 4, key: 'x0@32', irKey: 'field:arg0+32', irKind: MK.FIELD, self: true },
        store: { row: 2, address: 0x1008n, reg: 'w8' },
        confidence: 0.95,
      },
      {
        kind: 'write',
        engine: 'ir-semantic',
        location: { base: 'x1', disp: 0x40n, size: 4, key: 'x1@64', irKey: 'field:arg1+64', irKind: MK.FIELD, self: false },
        store: { row: 4, address: 0x1010n, reg: 'w9' },
        confidence: 0.8,
      },
      {
        kind: 'write',
        engine: 'ir-semantic',
        location: { base: 'global', disp: 0x2000n, size: 4, key: 'global@8192', irKey: 'global:8192', irKind: MK.GLOBAL, self: false },
        store: { row: 6, address: 0x1018n, reg: 'w10' },
        confidence: 0.75,
      },
    ],
    _precomputedConstants: [
      { row: 3, address: 0x100cn, register: 'w8', value: 100n, mnemonic: 'cmp', engine: 'ir-ssa', propagated: false },
      { row: 5, address: 0x1014n, register: 'w9', value: 999n, mnemonic: 'cmp', engine: 'ir-ssa', propagated: true },
    ],
  };

  assert.equal(dataflowEngine(fakeModel), 'semantic-ir');

  const defaultUpdates = findValueUpdates(fakeModel);
  assert.equal(defaultUpdates.length, 2);
  assert.equal(defaultUpdates.some((u) => u.location.irKind === MK.GLOBAL), false);
  assert.equal(distinctCandidateLocations(defaultUpdates), 2);

  const withGlobals = findValueUpdates(fakeModel, { includeGlobals: true });
  assert.equal(withGlobals.length, 3);
  assert.equal(withGlobals.some((u) => u.location.irKind === MK.GLOBAL), true);

  const defaultCmps = constantComparisons(fakeModel);
  assert.equal(defaultCmps.length, 1);
  assert.equal(defaultCmps[0].propagated, false);

  const allCmps = constantComparisons(fakeModel, { allowUnscopedPropagated: true });
  assert.equal(allCmps.length, 2);
  assert.equal(allCmps.some((c) => c.propagated === true), true);
});

test('pinpoint-worker precomputes stripped _precomputedUpdates and _precomputedConstants', async () => {
  const model = await makeArm64Model([
    'ldr w8, [x0, #0x20]',
    'add w8, w8, #5',
    'str w8, [x0, #0x20]',
    'cmp w8, #50',
    'ret',
  ]);
  const rows = model.instructions.map((ins) => ({
    mn: ins.mnemonic,
    ops: ins.operands,
    bytes: ins.bytes || null,
  }));
  const resp = await handlePinpointWorkerMessage({
    id: 1,
    addr: model.startAddress,
    rows,
    options: {},
  });
  assert.equal(resp.ok, true);
  assert.ok(resp.result?.model);
  assert.ok(Array.isArray(resp.result.model._precomputedUpdates));
  assert.ok(Array.isArray(resp.result.model._precomputedConstants));
  assert.ok(resp.result.model._precomputedUpdates.length >= 1);
  assert.ok(resp.result.model._precomputedConstants.length >= 1);
  for (const u of resp.result.model._precomputedUpdates) {
    assert.equal('ir' in u && u.ir != null, false, 'worker precomputed updates must strip u.ir');
  }
  const cloned = structuredClone(resp.result.model);
  const updatesFromPrecomputed = findValueUpdates(cloned);
  const cmpsFromPrecomputed = constantComparisons(cloned);
  assert.equal(updatesFromPrecomputed.length, resp.result.model._precomputedUpdates.filter((u) => u.location?.irKind !== MK.GLOBAL).length);
  assert.equal(cmpsFromPrecomputed.length, resp.result.model._precomputedConstants.length);
});

test('pinpoint-runtime prioritizes Worker before canonicalPinpointModel ONLY for legacyArm64 && shouldUseWorker', async () => {
  const region = { id: 'text', vmAddr: 0x1000n, size: 0x100n };
  let canonicalCalls = 0;
  let workerCalls = 0;

  class MockWorker extends EventTarget {
    postMessage(msg) {
      workerCalls++;
      queueMicrotask(() => {
        const data = {
          id: msg.id,
          ok: true,
          result: {
            model: {
              fromWorker: true,
              semantic: [],
              _precomputedUpdates: [],
              _precomputedConstants: [],
            },
          },
        };
        this.dispatchEvent(Object.assign(new Event('message'), { data }));
      });
    }
    terminate() {}
  }

  const arm64App = {
    store: {
      get: (k) => (k === 'canDisassemble' ? true : k === 'architecture' ? 'arm64' : { architecture: 'arm64', fixedInstructionSize: 4 }),
    },
    backend: {
      async fetchChunk() { return { mn: ['ret'], ops: [''], bytes: new Uint8Array([0xc0, 0x03, 0x5f, 0xd6]) }; },
    },
    symbols: { gen: 1, functionWindowBound: () => 0x1004n },
    analysisQueries: {
      async snapshot() { canonicalCalls++; return { snapshotId: 's1' }; },
      async function() { canonicalCalls++; return { completeness: 'complete', value: { model: { fromCanonical: true } } }; },
    },
  };
  const arm64Analyzer = makePinpointAnalyzer(arm64App, region, null, undefined, { WorkerCtor: MockWorker });
  const arm64Model = await arm64Analyzer(0x1000n, 0x1004n);
  arm64Analyzer.dispose();
  assert.equal(arm64Model?.fromWorker, true);
  assert.equal(workerCalls, 1);
  assert.equal(canonicalCalls, 0, 'ARM64 Worker must execute before canonicalPinpointModel');

  const x86App = {
    ...arm64App,
    store: {
      get: (k) => (k === 'canDisassemble' ? true : k === 'architecture' ? 'x86_64' : { architecture: 'x86_64', fixedInstructionSize: null }),
    },
  };
  const x86Analyzer = makePinpointAnalyzer(x86App, region, null, undefined, { WorkerCtor: MockWorker });
  const x86Model = await x86Analyzer(0x1000n, 0x1004n);
  x86Analyzer.dispose();
  assert.equal(x86Model?.fromCanonical, true);
  assert.equal(workerCalls, 1, 'Worker must NOT be invoked for x86_64');
  assert.equal(canonicalCalls, 2);
});

test('memoizeAnalysis enforces bounded LRU cache (<= 256) and deduplicates repeated calls', async () => {
  let calls = 0;
  const memo = memoizeAnalysis(async (addr) => {
    calls++;
    return { addr };
  });

  for (let i = 0; i < 300; i++) {
    await memo(BigInt(0x1000 + i * 4), null);
  }
  assert.equal(calls, 300);

  await memo(BigInt(0x1000 + 299 * 4), null);
  assert.equal(calls, 300);

  await memo(BigInt(0x1000), null);
  assert.equal(calls, 301);
});

test('lightweight IR fast-path matches canonical dataflow results on synthetic ARM64 function', async () => {
  const asm = [
    'ldr w8, [x0, #0x20]',
    'add w8, w8, w1',
    'cmp w8, #999',
    'str w8, [x0, #0x20]',
    'ldr w9, [x0, #0x24]',
    'sub w9, w9, #1',
    'str w9, [x0, #0x24]',
    'ret',
  ];
  const m1 = await makeArm64Model(asm, 0x200000000n);
  const m2 = await makeArm64Model(asm, 0x200000000n);

  const irCanonical = buildIR(m1);
  const irLightweight = withLightweightIdentity(() => buildIR(m2));
  assert.ok(irCanonical && irLightweight);

  const u1 = findValueUpdates(m1, { ir: irCanonical }).map(stripHeavyIrRefs);
  const u2 = findValueUpdates(m2, { ir: irLightweight }).map(stripHeavyIrRefs);
  assert.equal(u2.length, u1.length);
  assert.deepEqual(
    u2.map((u) => ({ kind: u.kind, key: u.location?.key, row: u.store?.row })),
    u1.map((u) => ({ kind: u.kind, key: u.location?.key, row: u.store?.row })),
  );

  const c1 = constantComparisons(m1, { ir: irCanonical });
  const c2 = constantComparisons(m2, { ir: irLightweight });
  assert.deepEqual(c2, c1);
});

test('InvestigationService.investigate() disposes pinpoint analyzer and terminates Worker', async () => {
  let spawned = 0;
  let terminated = 0;
  const prevWorker = globalThis.Worker;

  class CountingMockWorker extends EventTarget {
    constructor() {
      super();
      spawned++;
    }
    postMessage(msg) {
      queueMicrotask(() => {
        const data = {
          id: msg.id,
          ok: true,
          result: {
            model: {
              startAddress: 0x1000n,
              endAddress: 0x1010n,
              instructions: [],
              semantic: [],
              _precomputedEngine: 'semantic-ir',
              _precomputedUpdates: [],
              _precomputedConstants: [],
            },
          },
        };
        this.dispatchEvent(Object.assign(new Event('message'), { data }));
      });
    }
    terminate() {
      terminated++;
    }
  }

  globalThis.Worker = CountingMockWorker;
  try {
    const region = { id: 'text', vmAddr: 0x1000n, size: 0x100n, executable: true };
    const program = {
      functionRange: (addr) => (addr === 0x1000n ? { start: 0x1000n, end: 0x1010n } : null),
      functionStartOf: () => 0x1000n,
      callersOf: () => [],
      functions: [{ start: 0x1000n, end: 0x1010n, name: 'addCoins' }],
      stringsInFunction: () => [{ text: 'coins', addr: 0x2000n }],
    };
    const app = {
      backend: {
        gen: 1,
        async fetchChunk() {
          return { mn: ['ret'], ops: [''], bytes: new Uint8Array([0xc0, 0x03, 0x5f, 0xd6]) };
        },
        async fieldAccessMany() { return new Map(); },
        async strings() { return [{ text: 'coins', addr: 0x2000n, xrefs: [0x1000n] }]; },
      },
      store: (() => {
        const regions = [region];
        const info = { architecture: 'arm64', fixedInstructionSize: 4 };
        return {
          get: (k) => {
            if (k === 'canDisassemble') return true;
            if (k === 'architecture') return 'arm64';
            if (k === 'regions') return regions;
            if (k === 'binaryInfo' || k === 'macho') return info;
            return null;
          },
        };
      })(),
      codeRegion: () => region,
      symbols: {
        gen: 1,
        nameAt: (a) => (a === 0x1000n ? 'addCoins' : null),
        label: (a) => (a === 0x1000n ? 'addCoins' : null),
        functionWindowBound: () => 0x1010n,
        list: () => [{ addr: 0x1000n, name: 'addCoins' }],
      },
      program,
      strings: [{ text: 'coins', addr: 0x2000n, xrefs: [0x1000n] }],
      fields: (() => {
        const playerClass = {
          name: 'Player',
          methods: [{ sel: 'addCoins:', addr: 0x1000n }],
          ivars: [{ name: '_coins', offset: 0x20, size: 4, type: 'i' }],
        };
        return {
          classCount: 1,
          classes: new Map([['Player', playerClass]]),
          allIvars: () => [{ className: 'Player', name: '_coins', offset: 0x20, size: 4, type: 'i' }],
          classInfo: (name) => (name === 'Player' ? playerClass : null),
          ownerOf: () => ({ className: 'Player', sel: 'addCoins:' }),
        };
      })(),
      cxxFields: null,
      shapes: null,
      ensureStrings: async () => [{ text: 'coins', addr: 0x2000n, xrefs: [0x1000n] }],
      ensureShapes: async () => null,
      ensureProgram: async () => program,
      ensureFields: async () => app.fields,
      analysisQueries: {
        async snapshot() { return { snapshotId: 'snap-investigate-dispose' }; },
        async binaryInfo() { return {}; },
      },
    };
    const service = new InvestigationService(app);
    await service.investigate(goalFromPreset('money'));
    assert.ok(spawned >= 1, 'investigate() should spawn a Worker via pinpoint analyzer');
    assert.equal(terminated, spawned, 'investigate() must dispose analyzer and terminate every spawned Worker');
  } finally {
    if (prevWorker === undefined) delete globalThis.Worker;
    else globalThis.Worker = prevWorker;
  }
});

test('verify.js fieldUse, pinpointField, pinpointFunction, and dataflow cache strip u.ir references', async () => {
  const model = await makeArm64Model([
    'ldr w8, [x0, #0x20]',
    'add w8, w8, #1',
    'str w8, [x0, #0x20]',
    'cmp w8, #100',
    'ret',
  ], 0x300000000n);

  const cachedUpdates = findValueUpdates(model);
  assert.ok(cachedUpdates.length > 0, 'model produces updates');
  for (const u of cachedUpdates) {
    assert.equal('ir' in u && u.ir != null, false, 'findValueUpdates default cache must not retain u.ir');
  }

  // Also test fieldUse with a fake _precomputedUpdates entry carrying a heavy u.ir reference
  const injectedModel = {
    ...model,
    _precomputedEngine: 'semantic-ir',
    _precomputedUpdates: cachedUpdates.map((u) => ({ ...u, ir: { giantGraph: true } })),
    _precomputedConstants: [],
  };
  const fu = fieldUse(injectedModel, 0x20n);
  assert.ok(fu.rmw.length > 0, 'fieldUse detects RMW');
  for (const u of fu.rmw) {
    assert.equal('ir' in u && u.ir != null, false, 'fieldUse must strip u.ir before pushing to out.rmw');
  }

  // pinpointField: verify sites[].rmw strips u.ir
  const playerClass = {
    name: 'Player',
    methods: [{ sel: 'addCoins:', addr: model.startAddress }],
    ivars: [{ name: '_coins', offset: 0x20, size: 4, type: 'i' }],
  };
  const fields = {
    classCount: 1,
    classes: new Map([['Player', playerClass]]),
    allIvars: () => [{ className: 'Player', name: '_coins', offset: 0x20, size: 4, type: 'i' }],
    classInfo: (name) => (name === 'Player' ? playerClass : null),
    ownerOf: () => ({ className: 'Player', sel: 'addCoins:' }),
  };
  const fieldRes = await pinpointField({
    goal: goalFromPreset('money'),
    fields,
    program: {
      functionRange: () => ({ start: model.startAddress, end: model.endAddress }),
      functionStartOf: () => model.startAddress,
      callersOf: () => [],
    },
    analyze: async () => injectedModel,
  });
  assert.ok((fieldRes.candidates || []).length > 0, 'pinpointField produces candidates');
  for (const cand of fieldRes.candidates || []) {
    for (const site of cand.sites || []) {
      for (const u of site.rmw || []) {
        assert.equal('ir' in u && u.ir != null, false, 'pinpointField must strip u.ir from site.rmw');
      }
    }
  }

  // pinpointFunction: verify candidate.updates strips u.ir
  const fnRes = await pinpointFunction({
    goal: goalFromPreset('money'),
    field: { className: 'Player', name: '_coins', plain: 'coins', offset: 0x20n, size: 4 },
    fields,
    ranked: [{ addr: model.startAddress, name: '-[Player addCoins:]', strings: [{ text: 'coins' }] }],
    program: {
      functionRange: () => ({ start: model.startAddress, end: model.endAddress }),
      functionStartOf: () => model.startAddress,
      callersOf: () => [],
    },
    analyze: async () => injectedModel,
  });
  assert.ok((fnRes.candidates || []).length > 0, 'pinpointFunction produces candidates');
  for (const cand of fnRes.candidates || []) {
    for (const u of cand.updates || []) {
      assert.equal('ir' in u && u.ir != null, false, 'pinpointFunction must strip u.ir from candidate.updates');
    }
  }
});

test('dataflow cache bypasses on unknown opts (opts.window, custom comparison opts) and opts.requireSemanticIr', async () => {
  // Build a simple model with a sentinel _precomputedUpdates/_precomputedConstants
  const model = await makeArm64Model([
    'ldr w8, [x0, #0x20]',
    'add w8, w8, #5',
    'str w8, [x0, #0x20]',
    'cmp w8, #50',
    'ret',
  ], 0x400000000n);
  const sentinelUpdate = {
    kind: 'write',
    engine: 'legacy-sentinel',
    location: { base: 'x0', disp: 0x999n, size: 4, key: 'x0@2457', irKind: MK.FIELD, self: true },
    store: { row: 0, address: 0x400000000n, reg: 'w0' },
    confidence: 0.5,
  };
  const sentinelCmp = {
    row: 0,
    address: 0x400000000n,
    register: 'w0',
    value: 777n,
    mnemonic: 'cmp',
    engine: 'legacy-sentinel',
    propagated: false,
  };
  model._precomputedEngine = 'legacy-fallback';
  model._precomputedUpdates = [sentinelUpdate];
  model._precomputedConstants = [sentinelCmp];

  // Default call hits precomputed cache
  const defUpdates = findValueUpdates(model);
  assert.equal(defUpdates.length, 1);
  assert.equal(defUpdates[0].engine, 'legacy-sentinel');

  // opts.window is an unknown cache option -> must bypass precomputed cache
  const windowUpdates = findValueUpdates(model, { window: 12 });
  assert.ok(windowUpdates.length > 0);
  assert.equal(windowUpdates.some((u) => u.engine === 'legacy-sentinel'), false, 'opts.window must bypass precomputed/cached updates');
  assert.ok(windowUpdates.some((u) => u.location?.disp === 0x20n), 'opts.window computes fresh updates from model');

  // opts.requireSemanticIr -> must bypass legacy-fallback precomputed cache and compute Semantic IR
  const semanticUpdates = findValueUpdates(model, { requireSemanticIr: true });
  assert.ok(semanticUpdates.length > 0);
  assert.equal(semanticUpdates.some((u) => u.engine === 'legacy-sentinel'), false, 'opts.requireSemanticIr must bypass legacy-fallback cache');
  assert.ok(semanticUpdates.some((u) => u.engine === 'ir-ssa' || u.engine === 'ir-semantic'));
  assert.equal(dataflowEngine(model), 'legacy-fallback');
  assert.equal(dataflowEngine(model, { requireSemanticIr: true }), 'semantic-ir');

  // constantComparisons: default hits precomputed, unknown option bypasses cache
  const defCmps = constantComparisons(model);
  assert.equal(defCmps.length, 1);
  assert.equal(defCmps[0].engine, 'legacy-sentinel');

  const customCmps = constantComparisons(model, { window: 12 });
  assert.equal(customCmps.some((c) => c.engine === 'legacy-sentinel'), false, 'unknown option must bypass constantComparisons cache');
  assert.ok(customCmps.some((c) => c.value === 50n), 'unknown option computes fresh comparisons from model');
});

test('pinpoint-worker threshold (160 insns) records legacy-fallback above threshold and semantic-ir within threshold', async () => {
  assert.equal(WORKER_SEMANTIC_IR_MAX_INSNS, 160);
  const largeRows = [];
  for (let i = 0; i < WORKER_SEMANTIC_IR_MAX_INSNS + 5; i++) {
    if (i === 0) largeRows.push({ mn: 'ldr', ops: 'w8, [x0, #0x20]' });
    else if (i === 1) largeRows.push({ mn: 'add', ops: 'w8, w8, #1' });
    else if (i === 2) largeRows.push({ mn: 'str', ops: 'w8, [x0, #0x20]' });
    else largeRows.push({ mn: 'nop', ops: '' });
  }
  largeRows.push({ mn: 'ret', ops: '' });

  const resp = await handlePinpointWorkerMessage({
    id: 2,
    addr: 0x500000000n,
    rows: largeRows,
    options: {},
  });
  assert.equal(resp.ok, true);
  assert.equal(resp.result.model._precomputedEngine, 'legacy-fallback');
  assert.ok(Array.isArray(resp.result.model._precomputedUpdates));
  for (const u of resp.result.model._precomputedUpdates) {
    assert.equal('ir' in u && u.ir != null, false);
  }
  const semanticOverride = findValueUpdates(resp.result.model, { requireSemanticIr: true });
  assert.ok(semanticOverride.some((u) => u.engine === 'ir-ssa' || u.engine === 'ir-semantic'));
});
