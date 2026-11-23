import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { describe, it, beforeEach, afterEach } from 'node:test';
import { fileURLToPath } from 'node:url';

import { Backend } from '../js/backend.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const origDocumentDesc = Object.getOwnPropertyDescriptor(globalThis, 'document');
const origNavigatorDesc = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
const origWorkerDesc = Object.getOwnPropertyDescriptor(globalThis, 'Worker');

function setGlobal(name, value) {
  Object.defineProperty(globalThis, name, {
    value,
    configurable: true,
    writable: true,
    enumerable: true,
  });
}

function restoreGlobal(name, desc) {
  if (desc) Object.defineProperty(globalThis, name, desc);
  else delete globalThis[name];
}

class MockWorker {
  constructor(onPost = null) {
    this.sent = [];
    this.terminated = false;
    this.onmessage = null;
    this.onerror = null;
    this.onmessageerror = null;
    this._onPost = onPost;
  }
  postMessage(msg, transfer) {
    if (this.terminated) throw new Error('Worker terminated');
    this.sent.push({ msg, transfer });
    if (typeof this._onPost === 'function') this._onPost(this, msg, transfer);
  }
  emitMessage(data) {
    if (!this.terminated && this.onmessage) this.onmessage({ data });
  }
  terminate() {
    this.terminated = true;
  }
}

function makeFakeFile(sizeBytes) {
  const buf = new ArrayBuffer(sizeBytes);
  return {
    name: 'wave1.bin',
    size: sizeBytes,
    slice(start = 0, end = sizeBytes) {
      const s = Math.max(0, Math.min(sizeBytes, Number(start)));
      const e = Math.max(s, Math.min(sizeBytes, Number(end)));
      return { async arrayBuffer() { return buf.slice(s, e); } };
    },
  };
}

describe('Wave 1 Track 1 — Issue 1: Backend.cleanupMemory() worker spawn & lastRequestId preservation', () => {
  let spawnedWorkers;

  beforeEach(() => {
    spawnedWorkers = [];
    setGlobal('document', {
      hidden: false,
      addEventListener() {},
      removeEventListener() {},
    });
    setGlobal('navigator', {
      userAgent: 'Mozilla/5.0 (X11; Linux x86_64)',
      platform: 'Linux x86_64',
      maxTouchPoints: 0,
      hardwareConcurrency: 4,
    });
    setGlobal('Worker', class extends MockWorker {
      constructor() {
        super();
        spawnedWorkers.push(this);
      }
    });
  });

  afterEach(() => {
    restoreGlobal('document', origDocumentDesc);
    restoreGlobal('navigator', origNavigatorDesc);
    restoreGlobal('Worker', origWorkerDesc);
  });

  it('does NOT spawn platformWorker when uninitialized and preserves lastRequestId', async () => {
    const b = new Backend();
    b.legacyWorker = new MockWorker();
    b.lastRequestId = 42;

    const res = await b.cleanupMemory();
    assert.equal(res, null);
    assert.equal(b._platformWorker, null, 'cleanupMemory must not spawn platformWorker');
    assert.equal(spawnedWorkers.length, 0, 'no Worker constructor calls allowed');
    assert.equal(b.lastRequestId, 42, 'cleanupMemory must not overwrite lastRequestId');
    assert.equal(b.legacyWorker.sent.length, 0, 'legacyWorker must not receive unsupported cleanupMemory');
    b.dispose();
  });

  it('calls platformWorker cleanupMemory with trackLastRequest:false when initialized and preserves lastRequestId', async () => {
    const b = new Backend();
    const platformWorker = new MockWorker((worker, msg) => {
      if (msg.t === 'cleanupMemory') {
        worker.emitMessage({ t: 'ok', id: msg.id, epoch: msg.epoch, result: { bytesCached: 0 } });
      }
    });
    const legacyWorker = new MockWorker();
    b.platformWorker = platformWorker;
    b.legacyWorker = legacyWorker;
    b.lastRequestId = 77;

    const res = await b.cleanupMemory();
    assert.deepEqual(res, { bytesCached: 0 });
    assert.equal(platformWorker.sent.length, 1);
    assert.equal(platformWorker.sent[0].msg.t, 'cleanupMemory');
    assert.equal(legacyWorker.sent.length, 0);
    assert.equal(b.lastRequestId, 77, 'cleanupMemory must preserve lastRequestId');
    b.dispose();
  });

  it('rejects with BACKEND_DISPOSED when called after dispose()', async () => {
    const b = new Backend();
    b.dispose();
    await assert.rejects(b.cleanupMemory(), (err) => err?.code === 'BACKEND_DISPOSED');
  });
});

describe('Wave 1 Track 1 — Issue 2: Non-ARM64 Mach-O scanProgram & valueShapes routing to platformWorker', () => {
  beforeEach(() => {
    setGlobal('document', {
      hidden: false,
      addEventListener() {},
      removeEventListener() {},
    });
    setGlobal('navigator', {
      userAgent: 'Mozilla/5.0 (X11; Linux x86_64)',
      platform: 'Linux x86_64',
      maxTouchPoints: 0,
      hardwareConcurrency: 4,
    });
    setGlobal('Worker', MockWorker);
  });

  afterEach(() => {
    restoreGlobal('document', origDocumentDesc);
    restoreGlobal('navigator', origNavigatorDesc);
    restoreGlobal('Worker', origWorkerDesc);
  });

  it('routes non-ARM64 Mach-O scanProgram (with limits.architecture omitted) and valueShapes to platformWorker', async () => {
    const scanPoolSpawns = [];
    const b = new Backend({
      parallelScanThresholdBytes: 64,
      scanWorkerFactory: () => {
        const w = new MockWorker();
        scanPoolSpawns.push(w);
        return w;
      },
    });
    b.formatId = 'macho';
    b._activeMachArchitecture = 'x86_64';
    b.file = makeFakeFile(4096);

    const platformWorker = new MockWorker((worker, msg) => {
      if (msg.t === 'scanProgram' || msg.t === 'valueShapes') {
        worker.emitMessage({ t: 'ok', id: msg.id, epoch: msg.epoch, result: { worker: 'platform', op: msg.t, regionId: msg.regionId } });
      }
    });
    const legacyWorker = new MockWorker((worker, msg) => {
      worker.emitMessage({ t: 'ok', id: msg.id, epoch: msg.epoch, result: { worker: 'legacy', op: msg.t } });
    });
    b.platformWorker = platformWorker;
    b.legacyWorker = legacyWorker;

    const scanRes = await b.scanProgram('__text');
    assert.deepEqual(scanRes, { worker: 'platform', op: 'scanProgram', regionId: '__text' });

    const shapeRes = await b.valueShapes('__text');
    assert.deepEqual(shapeRes, { worker: 'platform', op: 'valueShapes', regionId: '__text' });

    assert.equal(legacyWorker.sent.length, 0, 'legacy ARM64 worker must NOT be called for x86_64 Mach-O');
    assert.equal(scanPoolSpawns.length, 0, 'parallel ARM64 scan pool must NOT be spawned for x86_64 Mach-O');
    assert.equal(b._scanPool, null);
    b.dispose();
  });

  it('routes Mach-O slice whose capability architecture is x86_64 (even before analyze sets _activeMachArchitecture) to platformWorker', async () => {
    const b = new Backend();
    b.formatId = 'macho';
    b._activeMachArchitecture = null;
    b.legacyInfo = { slices: [{ capability: { architecture: 'x86_64' } }] };
    b.file = makeFakeFile(4096);

    const platformWorker = new MockWorker((worker, msg) => {
      worker.emitMessage({ t: 'ok', id: msg.id, epoch: msg.epoch, result: { worker: 'platform', op: msg.t } });
    });
    const legacyWorker = new MockWorker();
    b.platformWorker = platformWorker;
    b.legacyWorker = legacyWorker;

    const scanRes = await b.scanProgram('__text');
    assert.equal(scanRes.worker, 'platform');
    const shapeRes = await b.valueShapes('__text');
    assert.equal(shapeRes.worker, 'platform');
    assert.equal(legacyWorker.sent.length, 0);
    b.dispose();
  });

  it('keeps ARM64 Mach-O on legacy/parallel path unless limits.architecture overrides to non-legacy', async () => {
    const b = new Backend({ parallelScanThresholdBytes: 1024 * 1024 });
    b.formatId = 'macho';
    b._activeMachArchitecture = 'arm64';
    b.file = null; // forces single-worker legacy path

    const platformWorker = new MockWorker((worker, msg) => {
      worker.emitMessage({ t: 'ok', id: msg.id, epoch: msg.epoch, result: { worker: 'platform', op: msg.t } });
    });
    const legacyWorker = new MockWorker((worker, msg) => {
      worker.emitMessage({ t: 'ok', id: msg.id, epoch: msg.epoch, result: { worker: 'legacy', op: msg.t } });
    });
    b.platformWorker = platformWorker;
    b.legacyWorker = legacyWorker;

    const armScan = await b.scanProgram('__text');
    assert.equal(armScan.worker, 'legacy');
    const armShapes = await b.valueShapes('__text');
    assert.equal(armShapes.worker, 'legacy');
    assert.equal(platformWorker.sent.length, 0);

    const overrideScan = await b.scanProgram('__text', null, { architecture: 'x86_64' });
    assert.equal(overrideScan.worker, 'platform');
    b.dispose();
  });
});

describe('Wave 1 Track 1 — Issue 3: worker-data-in-code-fix.js cumulative budget & 4-byte span alignment', () => {
  function loadDicSandbox({ region, budgetBytes, onScan }) {
    const source = fs.readFileSync(path.join(ROOT, 'js/worker-data-in-code-fix.js'), 'utf8');
    const regions = new Map([[region.id, region]]);
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
      MAX_EDGES: 100000,
      MAX_REFS: 100000,
      MAX_KIND_WORDS: 100000,
      PROGRAM_INDEX_BUDGET_BYTES: budgetBytes,
      regions,
      functionStartsForRegion: () => [],
      readRange: async () => new Uint8Array(0),
      Words: { isCallImm: () => false, isBranchImm: () => false, branchImm26: () => null },
      getChunk: async () => ({ bytes: new Uint8Array(0), mn: '', ops: '' }),
      guessFunctions: async () => ({ starts: [] }),
      runSearch: async () => ({ results: [] }),
      findXrefs: async () => ({ results: [] }),
      scanProgram: async (args) => onScan(args, regions.get(args.regionId)),
    };
    vm.runInNewContext(source, sandbox);
    return sandbox;
  }

  it('(a) enforces strict cumulative PROGRAM_INDEX_BUDGET_BYTES across spans without boxed JS arrays', async () => {
    // Region has 64 bytes = 16 words -> kinds takes 16 bytes.
    // Two spans separated by dataInCode: [0x1000, 0x1018) and [0x1020, 0x1040)
    const region = {
      id: 'text',
      fileOffset: 0n,
      vmAddr: 0x1000n,
      size: 0x40n,
      dataInCode: [{ address: 0x1018n, length: 8 }],
    };
    // Total budget: 16 (kinds) + 16*4 (4 calls = 64) + 17*2 (2 refs = 34) + 8 (subKindsBytes headroom) = 122 bytes
    const budgetBytes = 128;
    const observedLimits = [];

    const sandbox = loadDicSandbox({
      region,
      budgetBytes,
      onScan(args, sub) {
        observedLimits.push({ callLimit: args.callLimit, refLimit: args.refLimit, vmAddr: sub.vmAddr, size: sub.size });
        const words = Math.floor(Number(sub.size) / 4);
        const kinds = new Uint8Array(words).fill(1);
        // Each span tries to return 4 calls (64 bytes) and 2 refs (34 bytes) = 98 bytes, capped by passed limits
        const wantCalls = Math.min(4, args.callLimit);
        const wantRefs = Math.min(2, args.refLimit);
        const callFrom = new BigUint64Array(wantCalls);
        const callTo = new BigUint64Array(wantCalls);
        for (let i = 0; i < wantCalls; i++) {
          callFrom[i] = sub.vmAddr + BigInt(i * 4);
          callTo[i] = 0x2000n + BigInt(i * 4);
        }
        const refFrom = new BigUint64Array(wantRefs);
        const refTo = new BigUint64Array(wantRefs);
        const refKind = new Uint8Array(wantRefs);
        for (let i = 0; i < wantRefs; i++) {
          refFrom[i] = sub.vmAddr + BigInt(i * 4);
          refTo[i] = 0x3000n + BigInt(i * 4);
          refKind[i] = 1;
        }
        return {
          regionId: args.regionId,
          vmAddr: sub.vmAddr,
          words,
          callFrom, callTo, callCount: wantCalls,
          refFrom, refTo, refKind, refCount: wantRefs,
          kinds, kindsCovered: words,
          callsCapped: wantCalls < 4,
          refsCapped: wantRefs < 2,
          cancelled: false,
          completeness: {
            complete: wantCalls === 4 && wantRefs === 2,
            reasons: [
              ...(wantCalls < 4 ? ['call-edge-memory-budget'] : []),
              ...(wantRefs < 2 ? ['reference-memory-budget'] : []),
            ],
          },
        };
      },
    });

    const out = await sandbox.scanProgram({ regionId: 'text' });
    assert.equal(observedLimits.length, 2, 'must scan both code spans');
    assert.ok(observedLimits[1].callLimit < observedLimits[0].callLimit, 'second span callLimit must reflect cumulative bytes already consumed');
    assert.ok(observedLimits[1].refLimit < observedLimits[0].refLimit, 'second span refLimit must reflect cumulative bytes already consumed');

    const totalBytes = out.kinds.byteLength + out.callCount * 16 + out.refCount * 17;
    assert.ok(totalBytes <= budgetBytes, `total allocated bytes (${totalBytes}) must not exceed budget (${budgetBytes})`);
    assert.equal(out.completeness.memoryBudgetBytes, budgetBytes);
    assert.equal(out.completeness.allocatedBytes, totalBytes);
    assert.ok(out.callsCapped || out.refsCapped, 'budget exhaustion must set capped flags');
    assert.ok(out.callFrom instanceof sandbox.BigUint64Array || out.callFrom instanceof BigUint64Array);
    assert.ok(out.refKind instanceof sandbox.Uint8Array || out.refKind instanceof Uint8Array);
    assert.equal(out.__transfer.length, 6);
  });

  it('(b) rounds unaligned dataInCode end address up to 4-byte boundary so prior word kinds are never overwritten', async () => {
    // Region: [0x1000, 0x1020) = 8 words (indices 0..7)
    // dataInCode: [0x1004, 0x1006) (ends at non-4-byte-aligned 0x1006!)
    // Expected spans:
    //   span 0: [0x1000, 0x1004) -> word 0 (kind = 7)
    //   word 1 [0x1004, 0x1008) overlaps dataInCode -> MUST stay 0 (OTHER)
    //   span 1: [0x1008, 0x1020) -> words 2..7 (kind = 9)
    const region = {
      id: 'text',
      fileOffset: 0x200n,
      vmAddr: 0x1000n,
      size: 0x20n,
      dataInCode: [{ address: 0x1004n, length: 2 }],
    };
    const seenSpans = [];
    const sandbox = loadDicSandbox({
      region,
      budgetBytes: 1024 * 1024,
      onScan(args, sub) {
        seenSpans.push({ vmAddr: sub.vmAddr, fileOffset: sub.fileOffset, size: sub.size });
        const words = Math.floor(Number(sub.size) / 4);
        const fillVal = sub.vmAddr === 0x1000n ? 7 : 9;
        const kinds = new Uint8Array(words).fill(fillVal);
        return {
          regionId: args.regionId,
          vmAddr: sub.vmAddr,
          words,
          callFrom: new BigUint64Array(0), callTo: new BigUint64Array(0), callCount: 0,
          refFrom: new BigUint64Array(0), refTo: new BigUint64Array(0), refKind: new Uint8Array(0), refCount: 0,
          kinds, kindsCovered: words,
          callsCapped: false, refsCapped: false, cancelled: false,
          completeness: { complete: true, reasons: [] },
        };
      },
    });

    const out = await sandbox.scanProgram({ regionId: 'text' });
    assert.deepEqual(seenSpans, [
      { vmAddr: 0x1000n, fileOffset: 0x200n, size: 4n },
      { vmAddr: 0x1008n, fileOffset: 0x208n, size: 0x18n },
    ]);
    assert.equal(out.kinds[0], 7, 'word 0 before dataInCode must be preserved');
    assert.equal(out.kinds[1], 0, 'word 1 overlapping unaligned dataInCode must stay 0 (OTHER)');
    for (let i = 2; i < 8; i++) {
      assert.equal(out.kinds[i], 9, `word ${i} after aligned resume must have kind 9`);
    }
    assert.ok(out.completeness.reasons.includes('aarch64-code-span-not-word-aligned'));
  });

  it('(b-2) handles dataInCode starting and ending mid-word ([0x1005, 0x1006)) without corrupting word 0 or word 1', async () => {
    const region = {
      id: 'text',
      fileOffset: 0n,
      vmAddr: 0x1000n,
      size: 0x10n, // 4 words: 0x1000, 0x1004, 0x1008, 0x100c
      dataInCode: [{ address: 0x1005n, length: 1 }],
    };
    const seenSpans = [];
    const sandbox = loadDicSandbox({
      region,
      budgetBytes: 1024 * 1024,
      onScan(args, sub) {
        seenSpans.push({ vmAddr: sub.vmAddr, size: sub.size });
        const words = Math.floor(Number(sub.size) / 4);
        const fillVal = sub.vmAddr === 0x1000n ? 3 : 5;
        return {
          regionId: args.regionId,
          vmAddr: sub.vmAddr,
          words,
          callFrom: new BigUint64Array(0), callTo: new BigUint64Array(0), callCount: 0,
          refFrom: new BigUint64Array(0), refTo: new BigUint64Array(0), refKind: new Uint8Array(0), refCount: 0,
          kinds: new Uint8Array(words).fill(fillVal), kindsCovered: words,
          callsCapped: false, refsCapped: false, cancelled: false,
          completeness: { complete: true, reasons: [] },
        };
      },
    });

    const out = await sandbox.scanProgram({ regionId: 'text' });
    assert.deepEqual(seenSpans, [
      { vmAddr: 0x1000n, size: 4n },
      { vmAddr: 0x1008n, size: 8n },
    ]);
    assert.deepEqual(Array.from(out.kinds), [3, 0, 5, 5]);
    assert.ok(out.completeness.reasons.includes('aarch64-code-span-not-word-aligned'));
  });
});

describe('Wave 1 Track 1 — Issue 4: platform/worker.js readAtAddress fileSize clamp & <= 0n guard', () => {
  function createPlatformWorkerHarness(fileBytes, { region, addressToOffset = () => null }) {
    const workerPath = path.join(ROOT, 'js/platform/worker.js');
    const workerSource = fs.readFileSync(workerPath, 'utf8').replace(/^import .*;\n/gm, '');
    const posts = [];
    const readCalls = [];

    class FakeCachedByteSource {
      constructor(base) {
        this.size = base.size;
        this.maxReadLength = base.maxReadLength ?? 8 * 1024 * 1024;
      }
      async readExactly(offset, length) {
        readCalls.push({ offset, length });
        const start = Number(offset);
        if (length < 0 || start < 0 || start + length > fileBytes.length) {
          throw new RangeError(`Out of bounds readExactly(${offset}, ${length}) for fileSize=${fileBytes.length}`);
        }
        return fileBytes.slice(start, start + length);
      }
      clear() {}
      memoryStats() { return { bytesCached: 0 }; }
    }

    const self = { postMessage(msg) { posts.push(msg); } };
    const ctx = vm.createContext({
      self,
      TextDecoder,
      TextEncoder,
      AbortController,
      Uint8Array,
      BigUint64Array,
      BigInt,
      Number,
      Math,
      Promise,
      Map,
      Set,
      Array,
      Object,
      Error,
      RangeError,
      URL,
      setTimeout,
      clearTimeout,
      console,
      asByteSource: () => ({ size: BigInt(fileBytes.length) }),
      CachedByteSource: FakeCachedByteSource,
      detectBinary: async () => ({ formatId: 'elf' }),
      async openBinarySource() {
        return {
          arch: 'x86_64',
          format: 'elf',
          fileSize: BigInt(fileBytes.length),
          metadata: {},
          libraries: [],
          imports: [],
          symbols: [],
          functions: [],
          sections: [],
          addressToOffset,
        };
      },
      describeBinaryImage: () => ({
        platform: {},
        slices: [{ regions: region ? [region] : [] }],
        raw: { id: 'raw' },
        capability: null,
      }),
      parseMachOSource: async () => null,
      fingerprintVendors: () => [],
      analysisFromBinaryImage: () => ({}),
      emptyAnalysis: () => ({}),
      analyzeDecodedSemanticFunction: async () => ({}),
      releaseDecoderRevalidationWorker: () => {},
      analyzeSemanticFunction: async () => ({}),
      hashByteSource: async () => '00',
      sha256BlobHex: async () => ({ hex: '00' }),
      resolveMachOPointer: () => null,
      resolveScopedApplePointer: () => null,
      runSemanticFunctionRequest: async () => ({}),
    });
    vm.runInContext(workerSource, ctx, { filename: workerPath });

    async function send(msg) {
      const prevLen = posts.length;
      self.onmessage({ data: msg });
      for (let i = 0; i < 50; i++) {
        await new Promise((r) => setTimeout(r, 1));
        const found = posts.slice(prevLen).find((p) => p.id === msg.id);
        if (found) return found;
      }
      throw new Error(`Timed out waiting for response to ${msg.t}`);
    }

    return { send, readCalls };
  }

  it('clamps region available length to image.fileSize - hit.offset when region extends past EOF', async () => {
    const fileBytes = new Uint8Array(32);
    for (let i = 0; i < 32; i++) fileBytes[i] = i + 1;
    // Region claims size=100 at fileOffset=16, extending past fileSize=32
    const region = { id: 'seg0', name: '.data', vmAddr: 0x1000n, fileOffset: 16n, size: 100n };
    const harness = createPlatformWorkerHarness(fileBytes, { region });

    const openRes = await harness.send({ t: 'open', id: 1, epoch: 1, file: { size: fileBytes.length } });
    assert.equal(openRes.t, 'ok', `open failed: ${openRes.error}`);
    assert.equal(openRes.t, 'ok', `open failed: ${openRes.error}`);

    // Read at 0x1008 -> hit.offset = 24n; regionAvailable = 92n, fileAvailable = 32n - 24n = 8n
    const res = await harness.send({ t: 'readAt', id: 2, epoch: 1, addr: 0x1008n, len: 64 });
    assert.equal(res.t, 'ok', `expected ok, got err: ${res.error}`);
    assert.equal(res.result.found, true);
    assert.equal(res.result.bytes.length, 8, 'must clamp to remaining fileSize (8 bytes)');
    assert.deepEqual(Array.from(res.result.bytes), [25, 26, 27, 28, 29, 30, 31, 32]);
    assert.deepEqual(harness.readCalls, [{ offset: 24n, length: 8 }]);
  });

  it('returns { found: false } without reading when hit.offset >= image.fileSize (available <= 0n)', async () => {
    const fileBytes = new Uint8Array(32);
    const region = { id: 'seg0', name: '.bss_like', vmAddr: 0x1000n, fileOffset: 16n, size: 100n };
    const harness = createPlatformWorkerHarness(fileBytes, { region });

    const openRes = await harness.send({ t: 'open', id: 1, epoch: 1, file: { size: fileBytes.length } });
    assert.equal(openRes.t, 'ok', `open failed: ${openRes.error}`);

    // hit.offset = 32n === fileSize -> available === 0n
    const atEof = await harness.send({ t: 'readAt', id: 2, epoch: 1, addr: 0x1010n, len: 16 });
    assert.equal(atEof.t, 'ok');
    assert.equal(atEof.result.found, false);

    // hit.offset = 48n > fileSize -> available === -16n < 0n
    const pastEof = await harness.send({ t: 'readAt', id: 3, epoch: 1, addr: 0x1020n, len: 16 });
    assert.equal(pastEof.t, 'ok');
    assert.equal(pastEof.result.found, false);

    assert.equal(harness.readCalls.length, 0, 'readFileRange must not be called when available <= 0n');
  });

  it('returns { found: false } when addressToOffset without region resolves to offset >= fileSize', async () => {
    const fileBytes = new Uint8Array(16);
    const harness = createPlatformWorkerHarness(fileBytes, {
      region: null,
      addressToOffset: () => 20n,
    });

    const openRes = await harness.send({ t: 'open', id: 1, epoch: 1, file: { size: fileBytes.length } });
    assert.equal(openRes.t, 'ok', `open failed: ${openRes.error}`);

    const res = await harness.send({ t: 'readAt', id: 2, epoch: 1, addr: 0x2000n, len: 16 });
    assert.equal(res.t, 'ok', `expected ok, got err: ${res.error}`);
    assert.equal(res.result.found, false);
    assert.equal(harness.readCalls.length, 0);
  });
});
