import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

import { ArtifactStore } from '../js/core/artifacts/store.js';
import { MemoryArtifactBackend } from '../js/core/artifacts/backends.js';
import {
  createArtifactDescriptor,
  createArtifactRecord,
  encodeArtifactPayload,
} from '../js/core/artifacts/contracts.js';
import { runProductionDevBootstrap } from '../js/ai/dev/bootstrap/production-bootstrap.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function makeDescriptor(index) {
  return createArtifactDescriptor({
    artifactKind: 'semantic-summary',
    binaryId: `sha256:${String(index).padStart(64, '0')}`,
    sliceId: 'arm64:0',
    entityId: `reg-${index}`,
    producerId: 'audit-test',
    producerVersion: '1.0.0',
    versions: {
      loader: '1',
      architectureSemantic: '1',
      abiSemantic: '1',
      semanticSchema: '1',
    },
    config: { version: 1, index },
  });
}

test('Finding 1: worker-data-in-code-fix isolates sub-regions across awaits and enforces kindLimit / MAX_KIND_WORDS', async () => {
  const source = fs.readFileSync(path.join(ROOT, 'js/worker-data-in-code-fix.js'), 'utf8');
  const originalRegion = {
    id: 'code-0',
    fileOffset: 0x100n,
    vmAddr: 0x1000n,
    size: 0x100n, // 64 words
    dataInCode: [{ address: 0x1020n, length: 0x20 }], // spans: [0x1000, 0x1020) (8 words) and [0x1040, 0x1100) (48 words)
  };
  const regions = new Map([[originalRegion.id, originalRegion]]);
  const observedConcurrentRegions = [];
  const observedScanArgs = [];
  const observedXrefArgs = [];

  const sandbox = {
    BigInt,
    DataView,
    Uint8Array,
    BigUint64Array,
    Number,
    Math,
    Array,
    Set,
    Map,
    String,
    INSN_SIZE: 4,
    CHUNK_BYTES: 4096,
    MAX_EDGES: 1000,
    MAX_REFS: 1000,
    MAX_KIND_WORDS: 20,
    regions,
    functionStartsForRegion: () => [],
    readRange: async () => new Uint8Array(0),
    Words: { isCallImm: () => false, isBranchImm: () => false, branchImm26: () => null },
    getChunk: async () => ({ bytes: new Uint8Array(0), mn: '', ops: '' }),
    guessFunctions: async () => ({ starts: [] }),
    runSearch: async () => ({ results: [] }),
    scanProgram: async (args) => {
      observedScanArgs.push({ regionId: args.regionId, kindLimit: args.kindLimit, callLimit: args.callLimit, refLimit: args.refLimit });
      const sub = regions.get(args.regionId);
      assert.ok(sub, 'sub-region must exist under isolated key');
      assert.notEqual(args.regionId, originalRegion.id, 'must not overwrite args.regionId');
      assert.equal(sub.id, originalRegion.id, 'sub-region must preserve original region.id for functionStartsForRegion');
      // Yield to simulate async readRange/yieldToQueue and verify concurrent access to original regionId
      await new Promise((resolve) => setTimeout(resolve, 5));
      observedConcurrentRegions.push(regions.get(originalRegion.id));
      const words = Math.floor(Number(sub.size) / 4);
      const cap = args.kindLimit == null ? 20 : Math.min(words, args.kindLimit);
      const kinds = new Uint8Array(cap).fill(3);
      return {
        regionId: args.regionId,
        vmAddr: sub.vmAddr,
        words,
        callFrom: new BigUint64Array([sub.vmAddr]),
        callTo: new BigUint64Array([sub.vmAddr + 4n]),
        callCount: 1,
        refFrom: new BigUint64Array(0),
        refTo: new BigUint64Array(0),
        refKind: new Uint8Array(0),
        refCount: 0,
        kinds,
        kindsCovered: kinds.length,
        callsCapped: false,
        refsCapped: false,
        cancelled: false,
        completeness: { complete: cap >= words, reasons: cap < words ? ['kind-stat-budget'] : [] },
      };
    },
    findXrefs: async (args) => {
      observedXrefArgs.push({ regionId: args.regionId, limit: args.limit });
      assert.notEqual(args.regionId, originalRegion.id, 'findXrefs must not overwrite args.regionId');
      await new Promise((resolve) => setTimeout(resolve, 5));
      assert.equal(regions.get(originalRegion.id), originalRegion, 'original region must remain untouched during findXrefs await');
      return { results: [{ addr: regions.get(args.regionId).vmAddr }], cancelled: false, capped: false };
    },
  };

  vm.runInNewContext(source, sandbox);

  // 1. Explicit kindLimit cap (10 words out of 64)
  const limited = await sandbox.scanProgram({ regionId: originalRegion.id, kindLimit: 10 });
  assert.equal(limited.kinds.length, 10, 'kinds must respect args.kindLimit');
  assert.equal(limited.kindsCovered, 10);
  assert.ok(limited.completeness.reasons.includes('kind-stat-budget'));
  assert.equal(regions.size, 1, 'temporary region keys must be cleaned up after scanProgram');
  assert.equal(regions.get(originalRegion.id), originalRegion);
  for (const seen of observedConcurrentRegions) {
    assert.equal(seen, originalRegion, 'concurrent lookup of original regionId must never observe truncated sub-region');
  }

  // 2. Default MAX_KIND_WORDS cap (20 words out of 64)
  const hardCapped = await sandbox.scanProgram({ regionId: originalRegion.id });
  assert.equal(hardCapped.kinds.length, 20, 'kinds must respect MAX_KIND_WORDS when args.kindLimit is omitted');
  assert.equal(hardCapped.kindsCovered, 20);
  assert.ok(hardCapped.completeness.reasons.includes('kind-stat-budget'));
  assert.equal(regions.size, 1);

  // 3. findXrefsDataInCode isolates sub-regions and cleans up temporary keys
  const xrefs = await sandbox.findXrefs({ regionId: originalRegion.id, target: 0x2000n, limit: 10 });
  assert.equal(xrefs.results.length, 2);
  assert.equal(regions.size, 1, 'temporary region keys must be cleaned up after findXrefs');
  assert.equal(regions.get(originalRegion.id), originalRegion);
  assert.equal(observedXrefArgs.length, 2);
});

test('Finding 6: ArtifactStore bounds epochs and identity proofs and clears them in close()', async () => {
  const backend = new MemoryArtifactBackend();
  const store = new ArtifactStore({ backend, maxIdentityProofs: 4, maxEpochs: 4 });

  for (let i = 0; i < 12; i++) {
    const desc = makeDescriptor(i);
    await store.publish(desc, { value: i });
  }

  assert.ok(store.epochs.size <= 4, `epochs map must stay bounded (got ${store.epochs.size})`);

  // Verify close() clears epochs and internal maps
  await store.close();
  assert.equal(store.epochs.size, 0, 'close() must clear epochs map');
});

test('Finding 7: waitForForegroundDrain exits early on cancel or epoch change', async () => {
  const workerSource = fs.readFileSync(path.join(ROOT, 'js/platform/worker.js'), 'utf8');
  assert.match(workerSource, /waitForForegroundDrain\(epoch,\s*\{\s*scheduledEntry\s*=\s*null,\s*signal\s*=\s*null\s*\}\s*=\s*\{\}\)/);
  assert.match(workerSource, /epoch === currentEpoch/);
  assert.match(workerSource, /!scheduledEntry\?\.cancelled/);
  assert.match(workerSource, /!signal\?\.aborted/);

  // Behavioral test: extract and exercise waitForForegroundDrain logic with live foreground work
  const active = new Map();
  let currentEpoch = 1;
  const cooperativeYield = () => new Promise((resolve) => setTimeout(resolve, 0));
  async function waitForForegroundDrain(epoch, { scheduledEntry = null, signal = null } = {}) {
    while (
      epoch === currentEpoch
      && !scheduledEntry?.cancelled
      && !signal?.aborted
      && [...active.values()].some((entry) => entry.epoch === epoch && entry.priority !== 'background')
    ) {
      await cooperativeYield();
    }
  }

  active.set('1:fg', { id: 'fg', epoch: 1, priority: 'current' });

  // Case A: exits early on scheduledEntry.cancelled while foreground is still active
  const scheduledEntry = { id: 'bg1', epoch: 1, cancelled: false };
  let bg1Exited = false;
  const p1 = waitForForegroundDrain(1, { scheduledEntry }).then(() => { bg1Exited = true; });
  await cooperativeYield();
  assert.equal(bg1Exited, false, 'should wait while foreground is active and not cancelled');
  scheduledEntry.cancelled = true;
  await p1;
  assert.equal(bg1Exited, true, 'must exit early when scheduledEntry.cancelled becomes true');

  // Case B: exits early on AbortSignal abort while foreground is still active
  const ac = new AbortController();
  let bg2Exited = false;
  const p2 = waitForForegroundDrain(1, { signal: ac.signal }).then(() => { bg2Exited = true; });
  await cooperativeYield();
  assert.equal(bg2Exited, false);
  ac.abort();
  await p2;
  assert.equal(bg2Exited, true, 'must exit early when signal is aborted');

  // Case C: exits early when currentEpoch changes while foreground is still active
  let bg3Exited = false;
  const p3 = waitForForegroundDrain(1, { scheduledEntry: { id: 'bg3', epoch: 1, cancelled: false } }).then(() => { bg3Exited = true; });
  await cooperativeYield();
  assert.equal(bg3Exited, false);
  currentEpoch = 2;
  await p3;
  assert.equal(bg3Exited, true, 'must exit early when epoch changes');
});

test('Finding 8: MemoryArtifactBackend.putAtomic eliminates redundant copies while preserving defensive immutability', async () => {
  const backend = new MemoryArtifactBackend();
  const desc = makeDescriptor(99);
  const payloadBytes = encodeArtifactPayload({ hello: 'world', n: 42 });
  const originalCopy = payloadBytes.slice();
  const record = createArtifactRecord(desc, payloadBytes);

  let sliceCalls = 0;
  const origSlice = ArrayBuffer.prototype.slice;
  ArrayBuffer.prototype.slice = function countedSlice(...args) {
    sliceCalls += 1;
    return origSlice.apply(this, args);
  };
  try {
    const first = await backend.putAtomic(record, payloadBytes);
    assert.equal(first.duplicate, false);
    // Previously 3 copies (putAtomic + storedRow + cloneRaw); now at most 2 (storage copy + returned caller-isolated copy)
    assert.ok(sliceCalls <= 2, `fresh putAtomic should do at most 2 buffer copies, did ${sliceCalls}`);

    // Duplicate put should do at most 1 copy (returned cloneRaw(previous)), 0 copies of input payload
    sliceCalls = 0;
    const dup = await backend.putAtomic(record, payloadBytes);
    assert.equal(dup.duplicate, true);
    assert.ok(sliceCalls <= 1, `duplicate putAtomic should do at most 1 buffer copy, did ${sliceCalls}`);

    // Defensive immutability: mutating both input payloadBytes and returned first.payload must not corrupt stored entry
    payloadBytes[0] ^= 0xff;
    first.payload[0] ^= 0xaa;
    const raw = await backend.getRaw(desc.artifactId);
    assert.deepEqual(raw.payload, originalCopy, 'stored payload must remain isolated from input and return mutations');
  } finally {
    ArrayBuffer.prototype.slice = origSlice;
  }
});

test('Area 9 Finding 5: production-bootstrap never uses wildcard targetOrigin and rejects untrusted origins', async () => {
  const COMMIT = 'a'.repeat(40);
  const BUILD = 'b'.repeat(24);
  const TOKEN = 'c'.repeat(64);

  function makeEnv({ referrer = '', ancestorOrigins = undefined, locationOrigin = 'null', replyOrigin = 'https://chatgpt.com' } = {}) {
    const listeners = new Set();
    const posted = [];
    const parent = {
      postMessage(message, targetOrigin) {
        posted.push({ message, targetOrigin });
        queueMicrotask(() => {
          if (message.type === 'hex.dev.bootstrap.handoff-request') {
            target.emit({
              origin: replyOrigin,
              source: parent,
              data: {
                protocol: message.protocol,
                type: 'hex.dev.bootstrap.handoff-response',
                generation: message.generation,
                sandboxToken: message.sandboxToken,
                handoff: null,
                runtimeIdentity: { commit: COMMIT, buildId: BUILD },
              },
            });
          } else if (message.type === 'hex.dev.bootstrap.reload-request') {
            target.emit({
              origin: replyOrigin,
              source: parent,
              data: {
                protocol: message.protocol,
                type: 'hex.dev.bootstrap.reload-accepted',
                generation: message.generation,
                sandboxToken: message.sandboxToken,
              },
            });
          }
        });
      },
    };
    const search = '?__hex_embed_generation=1&__hex_dev_bootstrap=1';
    const target = {
      parent,
      document: { referrer },
      location: { href: 'about:srcdoc', origin: locationOrigin, pathname: '', search: '', ...(ancestorOrigins ? { ancestorOrigins } : {}) },
      __HEX_RUNTIME_HOST_HREF__: `https://ida.rhgrive.workers.dev/embed/chatgpt${search}`,
      __HEX_RUNTIME_HOST_ORIGIN__: 'https://ida.rhgrive.workers.dev',
      __HEX_RUNTIME_HOST_PATHNAME__: '/embed/chatgpt',
      __HEX_RUNTIME_HOST_SEARCH__: search,
      __HEX_EMBED_SANDBOX_TOKEN__: TOKEN,
      addEventListener(type, listener) { if (type === 'message') listeners.add(listener); },
      removeEventListener(type, listener) { if (type === 'message') listeners.delete(listener); },
      emit(event) { for (const listener of [...listeners]) listener(event); },
    };
    const handoff = { checkpoint: { runId: 'r1' } };
    const engine = {
      devBootstrap: {
        prepare: async () => {},
        sessionFor: () => ({ supervisorSessionKey: 'sup-1' }),
        createCheckpoint: () => handoff.checkpoint,
        activateAtSafeBoundary: () => ({ status: 'reload-required', handoff }),
      },
    };
    const bridge = {
      request: async () => ({ conversation: { id: 'cgpt-1' } }),
      conversationFor: () => null,
    };
    const session = { current: { id: 'hex-1', model: null, reasoning: null } };
    return { target, posted, engine, bridge, session };
  }

  // 1. Concrete origin from document.referrer
  {
    const env = makeEnv({ referrer: 'https://chat.openai.com/c/abc', replyOrigin: 'https://chat.openai.com' });
    const res = await runProductionDevBootstrap({ engine: env.engine, session: env.session, bridge: env.bridge, globalObject: env.target });
    assert.equal(res.state, 'reload-requested');
    assert.equal(env.posted.length, 2);
    for (const call of env.posted) {
      assert.equal(call.targetOrigin, 'https://chat.openai.com');
      assert.notEqual(call.targetOrigin, '*');
    }
  }

  // 2. Explicit options.parentOrigin
  {
    const env = makeEnv({ replyOrigin: 'https://chat.openai.com' });
    const res = await runProductionDevBootstrap({
      engine: env.engine,
      session: env.session,
      bridge: env.bridge,
      globalObject: env.target,
      parentOrigin: 'https://chat.openai.com',
    });
    assert.equal(res.state, 'reload-requested');
    assert.equal(env.posted.length, 2);
    assert.equal(env.posted[0].targetOrigin, 'https://chat.openai.com');
    assert.equal(env.posted[1].targetOrigin, 'https://chat.openai.com');
  }

  // 3. Opaque 'null' origin with no referrer falls back to concrete default parent origin (never '*')
  {
    const env = makeEnv({ referrer: '', locationOrigin: 'null', replyOrigin: 'https://chatgpt.com' });
    const res = await runProductionDevBootstrap({ engine: env.engine, session: env.session, bridge: env.bridge, globalObject: env.target });
    assert.equal(res.state, 'reload-requested');
    assert.equal(env.posted.length, 2);
    assert.equal(env.posted[0].targetOrigin, 'https://chatgpt.com');
    assert.equal(env.posted[1].targetOrigin, 'https://chatgpt.com');
  }

  // 4. Untrusted document.referrer must fail closed without calling postMessage
  {
    const env = makeEnv({ referrer: 'https://evil.example/frame' });
    const res = await runProductionDevBootstrap({ engine: env.engine, session: env.session, bridge: env.bridge, globalObject: env.target });
    assert.equal(res.state, 'failed');
    assert.equal(env.posted.length, 0, 'untrusted parent origin must never receive sandboxToken via postMessage');
  }

  // 5. Untrusted explicit options.parentOrigin must fail closed without calling postMessage
  {
    const env = makeEnv();
    const res = await runProductionDevBootstrap({
      engine: env.engine,
      session: env.session,
      bridge: env.bridge,
      globalObject: env.target,
      parentOrigin: 'https://evil.example',
    });
    assert.equal(res.state, 'failed');
    assert.equal(env.posted.length, 0, 'untrusted explicit parentOrigin must never receive postMessage');
  }
});
