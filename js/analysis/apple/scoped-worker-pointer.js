/** Current loader + eight source bytes. No parser or PAC evaluator is added. */
import { queryMachOPointerView } from './scoped-metadata.js';
import { machOPointerMetadataRevision } from '../../binary/macho-dyld.js';
import { createWorldScope, createAssumptionSet, worldContains } from '../../core/identity/world.js';
import { createEntityId, deepFreeze } from '../../core/identity/index.js';
import { snapshotContractData, recordFields, exactString, unsignedAddress, contractFail } from '../../core/identity/structured.js';
import { ScopedAnalysisWork } from '../../core/budgets/scoped-work.js';

export async function projectScopedWorkerPointer(request, { image, source, isCurrent, signal = null, limits = {} } = {}) {
  const input = snapshotContractData(request, { maxBytes: 2 * 1024 * 1024, maxNodes: 32768 });
  recordFields(input, ['storageAddress', 'world', 'assumptions', 'snapshotId', 'binaryId', 'sliceId'], 'scoped-worker-pointer-fields');
  const world = createWorldScope(input.world), assumptions = createAssumptionSet(input.assumptions, world);
  exactString(input.snapshotId, 'scoped-worker-pointer-snapshot');
  if (!worldContains(world, input.binaryId, input.sliceId)) contractFail('scoped-worker-pointer-world');
  const address = BigInt(unsignedAddress(input.storageAddress, { bits: 64 }));
  if (address > 0xfffffffffffffff8n) contractFail('scoped-worker-pointer-address-overflow');
  const work = new ScopedAnalysisWork({ limits, signal, name: 'scoped-pointer-worker' });
  try {
    const check = () => { work.checkpoint(); if (typeof isCurrent !== 'function' || !isCurrent()) contractFail('scoped-worker-pointer-stale'); };
    check();
    const finish = (value) => { check(); return deepFreeze({ ...value, workerCost: work.cost() }); };
    if (!image || image.format !== 'macho' || image.bits !== 64 || !['arm64', 'arm64e'].includes(image.arch)
      || typeof source?.readExactly !== 'function' || typeof image.addressToOffset !== 'function') {
      return finish({ status: 'unsupported', reason: 'current-macho-slice-owner-unavailable', exact: false });
    }
    if (image.endian !== (world.profile.endianness === 'le' ? 'little' : 'big')) contractFail('scoped-worker-pointer-endianness');
    const revision = machOPointerMetadataRevision(image), relative = image.addressToOffset(address);
    if (relative === null) return finish({ status: 'unsupported', reason: 'pointer-storage-not-file-backed', exact: false });
    for (let index = 0; index < 8; index++) {
      work.charge('workUnits');
      if (image.addressToOffset(address + BigInt(index)) !== relative + BigInt(index)) {
        return finish({ status: 'unsupported', reason: 'pointer-storage-crosses-file-mapping', exact: false });
      }
    }
    const offset = image.fileOffset + relative;
    if (relative < 0n || relative + 8n > image.fileSize || offset < 0n || offset + 8n > source.size) {
      return finish({ status: 'unsupported', reason: 'pointer-storage-outside-source', exact: false });
    }
    work.charge('bytesRead', 8); work.charge('pagesFetched');
    const bytes = await work.await((childSignal) => source.readExactly(offset, 8, { signal: childSignal }));
    check();
    if (!(bytes instanceof Uint8Array) || bytes.byteLength !== 8 || machOPointerMetadataRevision(image) !== revision) contractFail('scoped-worker-pointer-source-changed');
    const raw = new DataView(bytes.buffer, bytes.byteOffset, 8).getBigUint64(0, image.endian === 'little');
    const sourceRange = { worldId: world.id, snapshotId: input.snapshotId, binaryId: input.binaryId,
      sliceId: input.sliceId, offset: offset.toString(), length: 8, bytes: [...bytes], loaderRevision: revision };
    // These IDs bind content, not independent EvidenceGraph proof nodes.
    const rangeId = createEntityId({ binaryId: input.binaryId, kind: 'scoped-source-byte-range', identity: sourceRange });
    const artifactId = createEntityId({ binaryId: input.binaryId, kind: 'scoped-loader-site-reference', identity: {
      worldId: world.id, snapshotId: input.snapshotId, sliceId: input.sliceId, rangeId, revision } });
    const value = await queryMachOPointerView({ storageAddress: input.storageAddress }, { world, assumptions,
      snapshotId: input.snapshotId, work, getContext: async () => ({ image,
        worldId: world.id, snapshotId: input.snapshotId, binaryId: input.binaryId, sliceId: input.sliceId,
        storageAddress: input.storageAddress, rawValue: raw.toString(), artifactId, loaderRevision: revision,
        byteBinding: 'host-read-current-source', evidenceIds: [rangeId],
        isCurrent: () => isCurrent() && machOPointerMetadataRevision(image) === revision,
      }) });
    return finish({ ...value, byteSource: { ...sourceRange, id: rangeId,
      authority: 'current-source-byte-reference; not-an-independent-semantic-proof' } });
  } finally { work.dispose(); }
}
