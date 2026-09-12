/** Opt-in ARM64 projection route using existing decoder, lifter and scheduler.
 * This adds NO ISA semantics and does not change default viewer analysis.
 */
import { makeInstruction } from '../blocks.js';
import { arm64EncodingWord } from '../targets/architecture/arm64/encoding-word.js';
import { ARM64_MACHINE_EFFECTS_SEMANTIC_VERSION } from '../targets/architecture/arm64/effects/index.js';
import { resolveABIPlugin } from '../targets/abi/index.js';
import { createScopedWorkerAnalysisArtifactDescriptor, awaitCancellableProducer } from '../cache/artifact-orchestration.js';
import { stableDigest, lossyTypeWitness } from '../core/identity/index.js';
import { exactString, exactInteger, unsignedAddress, contractFail, snapshotContractData, recordFields, exactEnum, stringSet } from '../core/identity/structured.js';
import { assertScopedAnalysisWork } from '../core/budgets/scoped-work.js';
import { remainingScopedWorkerLimits, chargeScopedWorkerCost, throwIfScopedWorkerStopped } from '../core/budgets/scoped-worker.js';
import { normalizeDependencyScope } from '../core/artifacts/dependencies.js';
import { assertWorldScope, worldContains } from '../core/identity/world.js';

export const SCOPED_ARM64_PRODUCER_VERSION = '1.8.0';
export const SCOPED_ARM64_MAX_BYTES = 16384;
const CHUNK_INSTRUCTIONS = 1024;

export async function produceScopedArm64Pipeline(backend, { region, address, length, sliceIndex, snapshotId,
  binaryId, architecture, abiId, platform, dataEndianness, world, work, isCurrent, localProjection = null, dependencyScope = null } = {}) {
  assertScopedAnalysisWork(work); assertWorldScope(world);
  exactString(snapshotId, 'scoped-arm64-snapshot'); exactString(binaryId, 'scoped-arm64-binary');
  if (!worldContains(world, binaryId)) contractFail('scoped-arm64-world-mismatch');
  // ARM64e's distinct architecture/ABI pairing is not silently coerced to A64.
  // The current main's shared route rejects that pairing; keep it unsupported.
  if (architecture !== 'arm64') return { status: 'unsupported', reason: 'scoped-arm64-architecture-abi-pair-unavailable' };
  if (typeof backend?.fetchChunk !== 'function' || typeof backend?.readAt !== 'function'
    || typeof backend?._artifactRuntime !== 'function' || typeof isCurrent !== 'function') {
    return { status: 'unsupported', reason: 'scoped-arm64-canonical-backend-unavailable' };
  }
  const start = BigInt(unsignedAddress(address, { bits: 64 }));
  exactInteger(length, 'scoped-arm64-length', { min: 4, max: SCOPED_ARM64_MAX_BYTES });
  exactInteger(sliceIndex, 'scoped-arm64-slice');
  const regionStart = BigInt(unsignedAddress(region?.vmAddr, { bits: 64 }));
  const regionSize = BigInt(unsignedAddress(region?.size, { bits: 64 }));
  if (region.exec !== true || !region.id || start % 4n || length % 4 || start < regionStart
    || start + BigInt(length) > regionStart + regionSize || (start - regionStart) % 4n) contractFail('scoped-arm64-region-geometry');
  if (!['little', 'big'].includes(dataEndianness)) return { status: 'unsupported', reason: 'scoped-arm64-endianness-unbound' };
  const abi = resolveABIPlugin({ architecture, platform, abiId });
  if (!abi?.supported || abi.architectureId !== architecture) return { status: 'unsupported', reason: 'scoped-arm64-abi-unbound' };
  let scopedLocalProjection = null;
  if (localProjection !== null) {
    const local = snapshotContractData(localProjection, { maxBytes: 2 * 1024 * 1024 });
    recordFields(local, ['kind', 'valueId', 'entityIds', 'request', 'world', 'assumptions', 'offset', 'limit', 'ownerIdentity', 'precision', 'context'], 'scoped-local-request-fields');
    exactEnum(local.kind, ['summary', 'points-to', 'types', 'ranges', 'range-values', 'flow-inputs', 'demand', 'transforms'], 'scoped-local-request-kind');
    const isRange = ['ranges', 'range-values'].includes(local.kind);
    const isFlow = ['flow-inputs', 'demand', 'transforms'].includes(local.kind);
    if (!isRange && ['request', 'offset', 'limit', 'ownerIdentity'].some((key) => local[key] !== undefined)) contractFail('scoped-local-unexpected-range-fields');
    if (!isRange && !isFlow && ['world', 'assumptions'].some((key) => local[key] !== undefined)) contractFail('scoped-local-unexpected-world-fields');
    if ((isRange || isFlow) && local.world?.id !== world.id) contractFail('scoped-local-range-world');
    if (local.kind === 'points-to') exactString(local.valueId, 'scoped-local-request-value');
    else if (local.valueId !== undefined) contractFail('scoped-local-summary-value');
    if (local.kind === 'types') {
      if (!stringSet(local.entityIds, 'scoped-local-types-entities', 64).length) contractFail('scoped-local-types-empty');
    } else if (local.entityIds !== undefined) contractFail('scoped-local-unexpected-entities');
    if (local.kind !== 'demand' && (local.precision !== undefined || local.context !== undefined)) contractFail('scoped-local-unexpected-precision');
    scopedLocalProjection = { ...local, ...(local.kind === 'types' ? { entityIds: stringSet(local.entityIds, 'scoped-local-types-entities', 64) } : {}), snapshotId, worldId: world.id };
  }
  const scopeToken = dependencyScope === null ? null : normalizeDependencyScope(dependencyScope);
  if (scopeToken && scopeToken.worldId !== world.id) contractFail('scoped-arm64-dependency-world-mismatch');
  const uiEpoch = backend.gen, transportEpoch = backend.transportEpoch, file = backend.file;
  const check = () => {
    work.checkpoint();
    if (isCurrent() !== true || uiEpoch !== backend.gen || transportEpoch !== backend.transportEpoch || file !== backend.file) contractFail('scoped-arm64-stale');
  };
  check();
  // A byte-addressed read supplies the loader's actual file mapping. Region
  // display offsets never become physical byte provenance by assumption.
  work.charge('bytesRead', length);
  const read = await work.await((signal) => awaitCancellableProducer(backend.readAt(start, length, false), signal));
  check();
  if (!read?.found || !(read.bytes instanceof Uint8Array) || read.bytes.byteLength !== length || read.fileOffset == null) {
    return { status: 'unsupported', reason: 'scoped-arm64-byte-source-incomplete' };
  }
  const byteStart = BigInt(unsignedAddress(read.fileOffset, { bits: 64 }));
  const bytes = read.bytes.slice(); work.charge('residentBytes', length);
  const relative = start - regionStart;
  if (relative / 4n > BigInt(Number.MAX_SAFE_INTEGER)) return { status: 'unsupported', reason: 'scoped-arm64-viewer-row-range' };
  const startRow = Number(relative / 4n), count = length / 4;
  // A partial low-budget result must not mask later higher-budget precision.
  // Timeouts do not publish; resource ceilings, not wall time, enter the key.
  const scopedOwnerBudget = ['ranges', 'range-values', 'flow-inputs', 'demand', 'transforms'].includes(scopedLocalProjection?.kind)
    ? Object.fromEntries(Object.entries(remainingScopedWorkerLimits(work)).filter(([key]) => key !== 'deadlineMs')) : null;
  const descriptor = createScopedWorkerAnalysisArtifactDescriptor({ binaryId, sliceIndex, architecture,
    artifactKind: 'scpa-arm64-canonical-function', dependencyScope: scopeToken, producerVersion: SCOPED_ARM64_PRODUCER_VERSION,
    loaderVersion: 'source-backed-arm64-chunk-byte-reconciliation/v1',
    architectureSemanticVersion: ARM64_MACHINE_EFFECTS_SEMANTIC_VERSION, abiSemanticVersion: abi.semanticIdentity,
    semanticSchemaVersion: 'semantic-function/v1', config: { address: start.toString(), length, abiId: abi.id, platform,
      dataEndianness, instructionEndianness: 'little', worldId: world.id, snapshotId, scopedLocalProjection, scopedOwnerBudget,
      // The existing ArtifactStore remains the cache owner. Bind exact bounded
      // input bytes in addition to the loader/session identity.
      content: stableDigest({ bytes: [...bytes], typed: lossyTypeWitness([...bytes]) }) },
    keyExtras: { canonicalProjection: 'without-decompiler/v1', semanticRoute: 'existing-decoder>MachineEffects>SemanticIR>SSA>MemorySSA', decoderContract: 'legacy-model-decoder-v1' },
    originRefs: [binaryId, `file-offset:${byteStart}`, `virtual-address:${start}`] }, world);
  const result = await work.await((signal) => backend._artifactRuntime().request({ descriptor, signal, priority: 'current',
    completeness: 'partial', creation: { producer: 'scpa-arm64-source-reconciled', snapshotId },
    validate: (payload) => {
      const pipeline = payload?.pipeline, local = payload?.scopedLocal;
      if (pipeline?.instrumentation?.v2Executed !== true || payload?.projection !== 'canonical-only' || payload?.abiId !== abi.id
        || pipeline.binaryId !== binaryId || pipeline.sliceId !== descriptor.sliceId) return false;
      if (!scopedLocalProjection) return local == null;
      return local?.schema === 'scoped-local-owner-projection/v1' && local.version === (['demand', 'transforms'].includes(scopedLocalProjection.kind) ? '1.0.0' : ['ranges', 'range-values'].includes(scopedLocalProjection.kind) ? '1.2.0' : '1.1.0')
        && local.kind === scopedLocalProjection.kind && local.worldId === world.id
        && local.snapshotId === snapshotId && local.binaryId === binaryId
        && local.functionId === pipeline.functionId
        && (local.kind !== 'points-to' || local.valueId === scopedLocalProjection.valueId)
        && (local.kind !== 'types' || Array.isArray(local.types?.requested) && stableDigest(local.types.requested) === stableDigest(scopedLocalProjection.entityIds));
    },
    produce: async ({ signal: producerSignal }) => {
      const instructions = [];
      let loadedChunk = -1, entry = null;
      for (let index = 0; index < count; index++) {
        check(); work.charge('workUnits'); work.charge('nodes');
        const row = startRow + index, chunk = Math.floor(row / CHUNK_INSTRUCTIONS), chunkRow = row % CHUNK_INSTRUCTIONS;
        if (chunk !== loadedChunk) {
          work.charge('bytesRead', CHUNK_INSTRUCTIONS * 4); work.charge('pagesFetched');
          entry = await work.await((childSignal) => awaitCancellableProducer(backend.fetchChunk(region.id, chunk, true), childSignal));
          loadedChunk = chunk; check();
        }
        if (producerSignal.aborted) throw producerSignal.reason;
        const word = arm64EncodingWord(entry?.bytes, chunkRow);
        const sourceWord = arm64EncodingWord(bytes, index);
        if (word === null || sourceWord === null || word !== sourceWord) contractFail('scoped-arm64-decode-byte-mismatch');
        const mn = entry?.mn?.[chunkRow], ops = entry?.ops?.[chunkRow];
        if (typeof mn !== 'string' || !mn || typeof ops !== 'string') contractFail('scoped-arm64-decode-row-missing');
        const instructionAddress = start + BigInt(index * 4);
        const decoded = makeInstruction({ row: index, address: instructionAddress, mn, ops, word });
        // Decoded data/parse failures must not create a successful CFG seam.
        // Do not silently drop their bytes or claim a complete function.
        if (decoded.parseError || decoded.data) return Promise.reject(new TypeError('scoped-arm64-decode-row-unsupported'));
        instructions.push({ ...decoded, size: 4, opStr: ops, origin: {
          byteRanges: [{ binaryId, start: byteStart + BigInt(index * 4), length: 4 }],
          virtualRanges: [{ sliceId: descriptor.sliceId, start: instructionAddress, length: 4 }],
        } });
        await work.yieldIfNeeded();
      }
      check();
      const payload = await work.await((childSignal) => awaitCancellableProducer(backend._callTo('platform', 'semanticFunction', {
        scopedCanonicalProjection: true, scopedLocalProjection: ['demand', 'transforms'].includes(scopedLocalProjection?.kind)
          ? { ...scopedLocalProjection, producerArtifactId: descriptor.artifactId } : scopedLocalProjection,
        ...(scopedOwnerBudget ? { scopedWorkLimits: remainingScopedWorkerLimits(work) } : {}),
        input: { binaryId, sliceId: descriptor.sliceId, snapshotId, architecture, platform, abiId: abi.id,
          decoderSemanticVersion: 'legacy-model-decoder-v1', analysisVersion: SCOPED_ARM64_PRODUCER_VERSION,
          instructions, dataEndianness, instructionEndianness: 'little', machineEffectsContext: { dataEndianness, instructionEndianness: 'little' } },
      }), childSignal));
      // Parent debit precedes ArtifactStore publication. No fresh successful
      // artifact may survive a failed resource-accounting fence.
      check();
      if (scopedOwnerBudget) {
        throwIfScopedWorkerStopped(work, payload?.scopedStop, { kind: scopedLocalProjection.kind,
          worldId: world.id, snapshotId, binaryId });
        chargeScopedWorkerCost(work, payload?.scopedLocal?.workerCost);
      }
      return payload;
    },
  }));
  check();
  return { status: 'completed', pipeline: result.payload.pipeline, artifactId: descriptor.artifactId,
    nativeSource: { binaryId, offset: byteStart.toString(), virtualStart: start.toString(), length },
    localProjection: result.payload.scopedLocal ?? null, reused: result.reused === true, completeness: 'partial', scope: { start, end: start + BigInt(length), snapshotId },
    remaining: ['bounded-function-extent', 'current-isa-coverage', 'ambient-state', 'interprocedural-world-closure'] };
}
