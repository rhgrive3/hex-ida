import { captured, scope } from './native-owner-fixture.mjs';
import { workFor } from './helpers.mjs';
import { buildCanonicalQueryProjection } from '../../js/analysis/query/semantic/projection.js';
import { projectScopedDemandOwners } from '../../js/analysis/scoped-demand-projection.js';
import { DispatchResolverRegistry, resolveUnifiedDispatch } from '../../js/analysis/dispatch/unified.js';
import { createNativeDemandDispatchResolver } from '../../js/analysis/dispatch/native-demand.js';
import { createNativeDispatchMemoryReader } from '../../js/analysis/dispatch/native-source.js';
import { SymbolIndex } from '../../js/symbols.js';

export async function dispatchOwnerFixture(t, rowsByAddress, { imports = [], contents = [], read = null } = {}) {
  const f = scope(), members = [], data = new Uint8Array(0x4000), view = new DataView(data.buffer);
  for (const [address, value, width = 8] of contents) {
    if (width === 8) view.setBigUint64(address - 0x1000, BigInt(value), true);
    else view.setUint32(address - 0x1000, Number(value), true);
  }
  for (const [address, rows] of rowsByAddress) {
    const native = captured(BigInt(address), rows), artifactId = `artifact-dispatch-${address}`;
    const demand = await projectScopedDemandOwners(native.owner, native.result,
      { kind: 'demand', ...f, worldId: f.world.id, snapshotId: 'snap', producerArtifactId: artifactId, precision: { maximumValues: 64 } }, { limits: { deadlineMs: 10000 } });
    const projection = await buildCanonicalQueryProjection(native.result.pipeline, { ...f, work: workFor(t), snapshotId: 'snap',
      producerArtifactId: artifactId, sourceLocation: { start: BigInt(address), end: BigInt(address + rows.length * 4), snapshotId: 'snap' } });
    t.after(() => projection.release());
    members.push({ projection, demand, inputIdentity: projection.inputIdentity, functionId: projection.functionId });
    rows.forEach((row, i) => view.setUint32(address - 0x1000 + i * 4, row[2], true));
  }
  const symbols = new SymbolIndex({ addrs: new BigUint64Array(imports.map(row => BigInt(row.address))),
    names: imports.map(row => row.name), kinds: new Uint8Array(imports.map(row => row.kind)) });
  let current = true; const counters = { reads: 0 };
  const backend = { readAt: async (address, length) => {
    counters.reads++;
    if (read) return read(address, length, { data, retire: () => { current = false; } });
    const offset = Number(address - 0x1000n);
    return { found: offset >= 0 && offset + length <= data.length, fileOffset: BigInt(Math.max(0, offset)), bytes: data.slice(offset, offset + length) };
  } };
  const readMemory = createNativeDispatchMemoryReader({ backend, symbols, regions: [{ id: 'owned-memory', vmAddr: 0x1000n, size: BigInt(data.length), fileOffset: 0n, exec: true }],
    binaryId: 'binary-scpa-test', sliceId: 'slice-arm64', snapshotId: 'snap', isCurrent: () => current });
  const registry = new DispatchResolverRegistry(); registry.register(createNativeDemandDispatchResolver({ readMemory }));
  const member = members[0], projection = member.projection;
  return { ...f, members, data, readMemory, counters, registry, retire: () => { current = false; },
    resolve: async (node, request = {}) => resolveUnifiedDispatch(projection, {
      functionId: projection.functionId, callSiteId: node.id, maxTargets: 16, maxHops: 8, ...request },
    { ...f, projection, registry, nativeContext: { member, members }, work: workFor(t) }),
    nodes: () => Array.from({ length: projection.size }, (_, i) => projection.recordAt(i))
      .filter(row => row.owner === 'semantic-ir').map(row => projection.source(row.id)),
  };
}
