// Test adapter invokes the actual platform message handler and structured clone.
// It does not replace worker dispatch, ABI classification, Semantic IR or SCCP.
import { fixture } from './helpers.mjs';
import { createSliceId } from '../../js/core/identity/index.js';
import { ArtifactStore } from '../../js/core/artifacts/store.js';
import { MemoryArtifactBackend } from '../../js/core/artifacts/backends.js';
import { ArtifactAnalysisOrchestrator } from '../../js/cache/artifact-orchestration.js';
import { produceScopedArm64Pipeline } from '../../js/analysis/scoped-arm64-producer.js';
import { ScopedAnalysisService } from '../../js/analysis/query/scoped-service.js';
let loaded, serial = 0;
const pending = new Map();
async function platform() {
  if (!loaded) {
    globalThis.self = { postMessage(message) { pending.get(message.id)?.(structuredClone(message)); } };
    loaded = import('../../js/platform/worker.js');
  }
  await loaded;
  return async function call(method, data) {
    const id = ++serial;
    let timer;
    try {
      return await new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new Error('test-platform-request-timeout')), 10000);
        pending.set(id, message => { if (message.t === 'err') reject(new Error(message.error));
          else if (message.t === 'ok') resolve(message.result); });
        self.onmessage({ data: structuredClone({ ...data, t: method, id, epoch: 0 }) }).catch(reject);
      });
    } finally { clearTimeout(timer); pending.delete(id); }
  };
}
export const NATIVE_ROWS = Object.freeze({
  '0x1000': [['mov', 'x0, #1', 0xd2800020], ['bl', '#0x2000', 0x940003ff], ['ret', '', 0xd65f03c0]],
  '0x2000': [['str', 'x0, [sp]', 0xf90003e0], ['ret', '', 0xd65f03c0]],
});
export async function nativeWorkerFixture(t, { rowsByLocator = NATIVE_ROWS, knowledgeOwner = null, queryNativeApplePointer = null } = {}) {
  const call = await platform(), binaryId = 'bin_sha256_' + 'ab'.repeat(32);
  const sliceId = createSliceId({ binaryId, index: 0, architecture: 'arm64' });
  const f = fixture(d => { d.binarySet[0].binaryId = binaryId; d.binarySet[0].sliceId = sliceId; d.profile.abiRevision = '2'; });
  const size = Math.max(0x1100, ...Object.entries(rowsByLocator).map(([locator, rows]) => Number(BigInt(locator) - 0x1000n) + 64 + rows.length * 4));
  const data = new Uint8Array(size), view = new DataView(data.buffer), ranges = new Map();
  for (const [locator, rows] of Object.entries(rowsByLocator)) {
    const address = BigInt(locator), offset = Number(address - 0x1000n) + 64;
    rows.forEach((row, i) => view.setUint32(offset + i * 4, row[2], true));
    ranges.set(locator, { address, offset, rows, bytes: data.slice(offset, offset + rows.length * 4),
      region: { id: locator, exec: true, vmAddr: address, size: rows.length * 4 } });
  }
  const store = new ArtifactStore({ backend: new MemoryArtifactBackend() }), runtime = new ArtifactAnalysisOrchestrator({ store });
  const counters = { workers: 0, reads: 0, decodes: 0 };
  const backend = { gen: 1, transportEpoch: 0, file: new Blob([data]), _artifactRuntime: () => runtime,
    readAt: async address => { counters.reads++; const r = ranges.get('0x' + address.toString(16));
      return r ? { found: true, bytes: r.bytes.slice(), fileOffset: BigInt(r.offset) } : { found: false }; },
    fetchChunk: async regionId => { counters.decodes++; const r = ranges.get(regionId);
      return { bytes: r.bytes.slice(), mn: r.rows.map(r => r[0]), ops: r.rows.map(r => r[1]) }; },
    _callTo: async (_route, method, message) => { counters.workers++; return call(method, message); } };
  let current = true;
  const host = { configuration: { maximumSessions: 4, sessionTtlMs: 120000 }, isCurrent: () => current,
    canonicalArchitecture: 'arm64', artifactStore: store, knowledgeOwner, queryNativeApplePointer,
    loadPipeline: async (locator, ctx) => {
      const r = ranges.get(locator); if (!r) return { reason: 'fixture-function-not-selected' };
      return produceScopedArm64Pipeline(backend, { ...ctx, binaryId, sliceIndex: 0, snapshotId: 'snap', architecture: 'arm64',
        abiId: 'aapcs64', platform: 'linux', dataEndianness: 'little', region: r.region,
        address: r.address, length: r.bytes.length, isCurrent: () => current });
    },
    readRange: async request => ({ worldId: request.worldId, binaryId, offset: request.offset,
      bytes: data.slice(Number(BigInt(request.offset)), Number(BigInt(request.offset)) + request.length) }),
  };
  const service = new ScopedAnalysisService({ host, snapshot: { snapshotId: 'snap', binaryId }, worldInput: f.world });
  t.after(() => { service.close(); return runtime.close(); });
  return { ...f, service, backend, data, ranges, counters, call, retire: () => { current = false; },
    invoke: async (method, request = {}, limits = {}) => (await service.invoke(method, request, { limits: { deadlineMs: 10000, ...limits } })).value };
}
