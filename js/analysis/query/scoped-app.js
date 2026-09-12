/** Lazy app integration: no new analysis work until explicitly enabled. */
import { scopedAnalysisHost, scopedImmutableSourceIdentity } from './scoped-host.js';
import { ScopedAnalysisService } from './scoped-service.js';
import { produceScopedArm64Pipeline, SCOPED_ARM64_MAX_BYTES } from '../scoped-arm64-producer.js';
import { resolveABIPlugin } from '../../targets/abi/index.js';
import { ARM64_MACHINE_EFFECTS_SEMANTIC_VERSION } from '../../targets/architecture/arm64/effects/index.js';
import { stableDigest, createSliceId } from '../../core/identity/index.js';
import { recordFields, exactInteger, unsignedAddress, contractFail } from '../../core/identity/structured.js';
import { awaitCancellableProducer } from '../../cache/artifact-orchestration.js';
import { remainingScopedWorkerLimits, chargeScopedWorkerCost } from '../../core/budgets/scoped-worker.js';
const unsupported = (reason) => ({ value: { status: 'unsupported', reason, exact: false }, status: { completeness: 'unsupported', reason } });

export async function dispatchScopedAppQuery(app, snapshot, method, request, options, bindings) {
  const entry = scopedAnalysisHost(app);
  if (!entry?.configuration.enabled) return unsupported('scoped-analysis-disabled');
  const backend = app.backend, file = backend?.file ?? bindings.file();
  const sourceId = scopedImmutableSourceIdentity(app, file);
  if (!sourceId) return unsupported('scoped-immutable-source-unavailable');
  const describe = () => ({ snapshotId: snapshot.snapshotId, hostRevision: entry.revision,
    sourceId, architecture: bindings.architecture(), format: bindings.format(), sliceIndex: bindings.sliceIndex(),
    artifactVersions: bindings.artifactVersions(), projectRevision: bindings.projectRevision(), analysisEpoch: backend?.gen ?? 0,
    transportEpoch: backend?.transportEpoch ?? 0, binaryId: typeof backend?.binaryId === 'string' && /^bin_sha256_[0-9a-f]{64}$/.test(backend.binaryId) ? backend.binaryId : snapshot.binaryId,
    symbolsRevision: app.symbols?.revision ?? app.symbols?.generation ?? app.symbols?.gen ?? null,
    functionCount: app.symbols?.functionCount ?? null, knowledgeRevision: app.knowledge?.revision ?? null });
  const initial = describe(), identity = stableDigest(initial), selectedSymbols = app.symbols;
  const knowledgeOwner = app.knowledge;
  const objcIndex = app.objcRuntime, swiftIndex = app.swiftRuntime, metadataSource = bindings.metadata();
  const current = () => scopedAnalysisHost(app) === entry && entry.configuration.enabled
    && backend === app.backend && file === (app.backend?.file ?? bindings.file()) && selectedSymbols === app.symbols
    && knowledgeOwner === app.knowledge && objcIndex === app.objcRuntime && swiftIndex === app.swiftRuntime && metadataSource === bindings.metadata()
    && identity === stableDigest(describe());
  if (initial.analysisEpoch !== snapshot.analysisEpoch || initial.projectRevision !== snapshot.projectRevision
    || initial.binaryId !== snapshot.binaryId) return unsupported('scoped-snapshot-stale');
  if (!Number.isSafeInteger(initial.sliceIndex) || initial.sliceIndex < 0) return unsupported('scoped-slice-unbound');
  if (!['arm64', 'arm64e'].includes(initial.architecture)) return unsupported('scoped-native-arm64-only');
  const metadata = bindings.metadata(), capability = bindings.capability();
  const endian = metadata?.endian ?? capability?.endianness ?? null;
  if (!['little', 'big', 'le', 'be'].includes(endian)) return unsupported('scoped-data-endianness-unbound');
  const dataEndianness = ['little', 'le'].includes(endian) ? 'little' : 'big';
  // PE/arm64e do not borrow a neighboring ABI just to advertise availability.
  const platform = initial.format === 'macho' ? 'darwin' : initial.format === 'elf' ? 'unknown' : null;
  const abiId = initial.format === 'macho' ? 'darwin-arm64' : initial.format === 'elf' ? 'aapcs64' : null;
  if (!platform || !abiId) return unsupported('scoped-arm64-format-abi-unavailable');
  const abi = resolveABIPlugin({ architecture: 'arm64', platform, abiId });
  if (!abi?.supported) return unsupported('scoped-arm64-abi-unavailable');
  if (entry.binding !== identity || !entry.service || entry.service.closed) {
    entry.service?.close('app-binding-changed');
    const worldInput = { binarySet: [{ binaryId: snapshot.binaryId, sliceId: createSliceId({ binaryId: snapshot.binaryId, index: initial.sliceIndex, architecture: initial.architecture }),
      sourceIdentity: { kind: 'local-immutable', sourceInstance: sourceId, generation: identity },
      loadMapHash: `snapshot-scoped:${identity}`, relocationViewHash: `unqualified:${identity}` }],
      profile: { isaRevision: `${initial.architecture}:effects@${ARM64_MACHINE_EFFECTS_SEMANTIC_VERSION}`, features: [],
        abi: abi.id, abiRevision: abi.semanticVersion, osModel: platform, endianness: dataEndianness === 'little' ? 'le' : 'be',
        addressBits: 64, exceptionModel: 'ambient-state-unqualified', memoryModel: 'current-owner-with-open-concurrency' },
      environment: { dynamicLoading: 'open', concurrency: 'unknown', interposition: 'possible', ambientState: 'unqualified' },
      coverage: 'explicit-bounded-function-scopes; no-negative-world-closure', generation: identity };
    const host = { configuration: entry.configuration, isCurrent: current, canonicalArchitecture: initial.architecture,
      knowledgeOwner,
      artifactStore: typeof backend?._artifactRuntime === 'function' ? backend._artifactRuntime().store : null,
      loadPipeline: entry.configuration.loadPipeline ?? (async (locator, ctx) => {
        const range = bindings.rangeFor(locator);
        if (!range.ok) return { reason: range.reason ?? 'function-range-unavailable' };
        const span = range.end - range.start;
        const length = Number(span > BigInt(SCOPED_ARM64_MAX_BYTES) ? BigInt(SCOPED_ARM64_MAX_BYTES) : span);
        if (length < 4 || length % 4) return { reason: 'function-extent-not-a64-aligned' };
        return produceScopedArm64Pipeline(backend, { region: range.region, address: range.start, length,
          sliceIndex: initial.sliceIndex, snapshotId: snapshot.snapshotId, binaryId: snapshot.binaryId,
          architecture: initial.architecture, abiId, platform, dataEndianness, world: ctx.world, work: ctx.work, isCurrent: current, localProjection: ctx.localProjection ?? null, dependencyScope: ctx.dependencyScope });
      }),
      getNativeInvestigationContext: async (jobId, context) => {
        const aiEngine = app.aiRuntime;
        if (typeof aiEngine?.getScopedInvestigationContext !== 'function') return null;
        if (!current() || app.aiRuntime !== aiEngine) contractFail('scoped-investigation-host-stale');
        const borrowed = await context.work.await((signal) => aiEngine.getScopedInvestigationContext(jobId, { ...context, signal }));
        if (!current() || app.aiRuntime !== aiEngine) contractFail('scoped-investigation-host-stale');
        if (!borrowed) return null;
        return Object.freeze({ ...borrowed, isCurrent: () => current() && app.aiRuntime === aiEngine && borrowed.isCurrent() === true });
      },
      queryNativeApplePointer: initial.format !== 'macho' || typeof backend?._callTo !== 'function' ? null : async (request, ctx) => {
        recordFields(request, ['storageAddress'], 'apple-pointer-query-fields');
        const storageAddress = unsignedAddress(request.storageAddress, { bits: 64 });
        if (!current()) contractFail('scoped-pointer-host-stale');
        const sliceId = createSliceId({ binaryId: snapshot.binaryId, index: initial.sliceIndex, architecture: initial.architecture });
        const result = await ctx.work.await((signal) => awaitCancellableProducer(backend._callTo('platform', 'scopedApplePointer', {
          sliceIndex: initial.sliceIndex, scopedWorkLimits: remainingScopedWorkerLimits(ctx.work),
          request: { storageAddress, world: ctx.world, assumptions: ctx.assumptions,
            snapshotId: snapshot.snapshotId, binaryId: snapshot.binaryId, sliceId },
        }), signal));
        if (!current()) contractFail('scoped-pointer-host-stale');
        chargeScopedWorkerCost(ctx.work, result.workerCost);
        if (result.status === 'completed' && (result.worldId !== ctx.world.id || result.assumptionsId !== ctx.assumptions.id
          || result.snapshotId !== snapshot.snapshotId || result.source?.binaryId !== snapshot.binaryId
          || result.source?.sliceId !== sliceId || unsignedAddress(result.pointer?.storageAddress, { bits: 64 }) !== storageAddress)) {
          contractFail('scoped-pointer-result-binding');
        }
        return result;
      },
      readRange: async (request, { signal } = {}) => {
        if (!current()) contractFail('scoped-byte-reader-stale');
        if (signal?.aborted) throw signal.reason;
        if (request.binaryId !== snapshot.binaryId || request.worldId !== entry.service?.worldId) contractFail('scoped-byte-reader-world-mismatch');
        const offset = BigInt(unsignedAddress(request.offset, { bits: 64 }));
        exactInteger(request.length, 'scoped-byte-reader-length', { min: 1, max: 65536 });
        if (offset > BigInt(Number.MAX_SAFE_INTEGER) || offset + BigInt(request.length) > BigInt(file.size)) contractFail('scoped-byte-reader-range');
        const bytes = new Uint8Array(await file.slice(Number(offset), Number(offset) + request.length).arrayBuffer());
        if (signal?.aborted) throw signal.reason;
        if (!current()) contractFail('scoped-byte-reader-stale');
        return { worldId: request.worldId, binaryId: snapshot.binaryId, offset: request.offset, bytes };
      },
    };
    entry.service = new ScopedAnalysisService({ host, snapshot, worldInput }); entry.binding = identity;
  }
  return entry.service.invoke(method, request, options);
}

/** Opt-in model-free competition adapter over the SAME already-bound service.
 * Caller first obtains a scoped snapshot and capabilities through QueryAPI.
 * No secondary analysis service, app initialization or benchmark oracle.
 */
export async function createScopedNativeBenchmarkAdapter(app, binding) {
  const entry = scopedAnalysisHost(app);
  if (!entry?.configuration.enabled || !entry.service || entry.service.closed) contractFail('native-best-scoped-service-not-ready');
  const { ScopedNativeBestAdapter } = await import('../benchmark/scoped-native-adapter.js');
  if (scopedAnalysisHost(app) !== entry || entry.service.closed) contractFail('native-best-host-changed');
  return new ScopedNativeBestAdapter(entry.service, binding);
}
