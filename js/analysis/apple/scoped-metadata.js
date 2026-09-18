/** Apple owner projections. No new dyld parser, ObjC dispatch solver, or PAC
 * implementation. Imported metadata/observations never become exact targets.
 */
import { describeMachOPointerSite, machOPointerMetadataRevision, MACHO_POINTER_SITE_VIEW_VERSION } from '../../binary/macho-dyld.js';
import { resolveObjcDispatch, cleanClassName } from '../../apple/objc-runtime.js';
import { assertWorldScope, assertAssumptionSet, worldContains } from '../../core/identity/world.js';
import { assertScopedAnalysisWork } from '../../core/budgets/scoped-work.js';
import { createEntityId, deepFreeze, stableDigest, lossyTypeWitness } from '../../core/identity/index.js';
import { snapshotContractData, recordFields, exactString, unsignedAddress, stringSet, contractFail } from '../../core/identity/structured.js';

export const APPLE_SCOPED_METADATA_VERSION = '1.2.0';

/** Host context binds the loader instance and bytes BEFORE entering this view.
 * Request contains an address, never a raw pointer, assumed target or image.
 */
export async function queryMachOPointerView(request, { world, assumptions, snapshotId, work, getContext } = {}) {
  assertWorldScope(world); assertAssumptionSet(assumptions, world); assertScopedAnalysisWork(work);
  const input = snapshotContractData(request); recordFields(input, ['storageAddress'], 'apple-pointer-query-fields');
  const storageAddress = unsignedAddress(input.storageAddress);
  if (typeof getContext !== 'function') return { status: 'unsupported', reason: 'canonical-macho-pointer-owner-not-bound', exact: false };
  const context = await work.await((signal) => getContext({ storageAddress }, { world, assumptions, snapshotId, signal }));
  if (!context) return { status: 'unsupported', reason: 'canonical-macho-pointer-site-unavailable', exact: false };
  if (typeof context.isCurrent !== 'function' || context.isCurrent() !== true) contractFail('apple-pointer-current-owner-required');
  if (context.worldId !== world.id || context.snapshotId !== snapshotId
    || !worldContains(world, context.binaryId, context.sliceId)
    || unsignedAddress(context.storageAddress) !== storageAddress) contractFail('apple-pointer-context-binding');
  exactString(context.artifactId, 'apple-pointer-loader-artifact');
  if (context.byteBinding !== 'host-read-current-source' || !Array.isArray(context.evidenceIds)) contractFail('apple-pointer-source-evidence-required');
  const raw = unsignedAddress(context.rawValue), revision = machOPointerMetadataRevision(context.image);
  if (context.loaderRevision !== revision) contractFail('apple-pointer-loader-revision');
  const evidenceIds = stringSet(context.evidenceIds, 'apple-pointer-source-evidence-ids', 64);
  if (!evidenceIds.length) contractFail('apple-pointer-source-evidence-empty');
  work.charge('workUnits'); work.charge('residentBytes', 4096);
  const view = describeMachOPointerSite(context.image, raw, storageAddress);
  if (!view || view.revision !== revision || machOPointerMetadataRevision(context.image) !== revision || context.isCurrent() !== true) contractFail('apple-pointer-loader-stale');
  const remaining = ['load-occurrence-not-proven', 'normal-target-vs-trap-domain-unqualified', 'interposition-and-image-closure-open'];
  if (view.status !== 'recorded-site') remaining.push(view.status);
  if (view.decoded?.authenticated === true) {
    remaining.push('authentication-success-unproven', 'runtime-PAC-key-and-discriminator-blend-unverified');
    if (view.decoded.authenticationKey === null || view.decoded.discriminator === null || view.decoded.addressDiversity === null) {
      remaining.push('authentication-context-not-retained-by-owner');
    }
  }
  if (view.decoded?.bind) remaining.push('dyld-bind-target-not-linked');
  const body = { schema: 'scoped-apple-pointer-view/v1', worldId: world.id, assumptionsId: assumptions.id, snapshotId,
    source: { binaryId: context.binaryId, sliceId: context.sliceId, artifactId: context.artifactId,
      ownerVersion: MACHO_POINTER_SITE_VIEW_VERSION, loaderRevision: revision, evidenceIds },
    pointer: snapshotContractData(view, { allowBigInt: true }), remaining, exact: false,
    authority: 'metadata-declaration-only', status: 'completed' };
  return deepFreeze({ ...body, id: createEntityId({ binaryId: context.binaryId, kind: body.schema, identity: body }), cost: work.cost() });
}

/** A provider for the unified dispatch registry. A bound semantic owner must
 * supply the selector/receiver context; AI strings cannot manufacture it.
 * resolveFunctionIdentity must resolve an already-existing canonical identity,
 * not assign a function boundary from a metadata address.
 */
/** Preflight ONLY the hierarchy/protocol closure the existing resolver reads.
 * This is budget validation, not a second method-resolution implementation. */
async function boundObjcOwnerTraversal(index, receiverType, protocols, work) {
  const pending = [...(protocols ?? [])], seenProtocols = new Set(), seenClasses = new Set();
  const enqueue = (values) => {
    if (values == null) return;
    if (!Array.isArray(values) || values.length > 256) contractFail('objc-scoped-protocol-list-budget');
    work.charge('workUnits', values.length);
    for (const value of values) {
      const raw = typeof value === 'string' ? value : value?.name;
      if (raw != null) exactString(raw, 'objc-scoped-protocol-owner-name', 2048);
      const name = cleanClassName(raw);
      if (name) pending.push(name);
    }
    if (pending.length > 8192) contractFail('objc-scoped-protocol-queue-budget');
  };
  let name = cleanClassName(receiverType);
  while (name && !seenClasses.has(name) && seenClasses.size < 64) {
    seenClasses.add(name); work.charge('workUnits');
    const entry = index.classes.get(name);
    enqueue(entry?.protocols);
    if (entry?.superName != null) exactString(entry.superName, 'objc-scoped-superclass', 2048);
    name = cleanClassName(entry?.superName);
    await work.yieldIfNeeded();
  }
  while (pending.length) {
    const name = pending.pop(); work.charge('workUnits');
    if (seenProtocols.has(name)) continue;
    if (seenProtocols.size >= 4096) contractFail('objc-scoped-protocol-closure-budget');
    seenProtocols.add(name); enqueue(index.protocols.get(name)?.protocols);
    await work.yieldIfNeeded();
  }
}

export function createObjcScopedDispatchResolver({ getContext, resolveFunctionIdentity, snapshotId } = {}) {
  if (typeof getContext !== 'function' || typeof resolveFunctionIdentity !== 'function') contractFail('objc-scoped-owner-capabilities');
  exactString(snapshotId, 'objc-scoped-snapshot');
  return { id: 'existing-objc-owner-scoped-candidates', version: APPLE_SCOPED_METADATA_VERSION, families: ['objc-msgsend'],
    resolve: async (query, { world, assumptions, projection, nodeReference, signal, work }) => {
      assertScopedAnalysisWork(work);
      const base = { worldId: world.id, assumptionsId: assumptions.id, projectionId: projection.id,
        callSiteId: query.callSiteId, candidates: [], chains: [] };
      const context = await work.await((providerSignal) => getContext(nodeReference, { world, assumptions, snapshotId, signal: providerSignal, work }));
      if (!context) return { ...base, status: 'unsupported', requirements: ['objc-selector-owner-binding-unavailable'] };
      if (typeof context.isCurrent !== 'function' || context.isCurrent() !== true) contractFail('objc-scoped-current-owner-required');
      if (context.worldId !== world.id || context.snapshotId !== snapshotId || context.callSiteId !== query.callSiteId
        || !worldContains(world, context.binaryId, context.sliceId)) contractFail('objc-scoped-context-binding');
      exactString(context.artifactId, 'objc-scoped-metadata-artifact');
      exactString(context.ownerRevision, 'objc-scoped-metadata-revision');
      const selector = exactString(context.selector, 'objc-scoped-selector', 2048);
      const receiverType = context.receiverType == null ? null : exactString(context.receiverType, 'objc-scoped-receiver', 2048);
      const protocols = context.protocols == null ? null : stringSet(context.protocols, 'objc-scoped-protocols', 128);
      if (typeof context.classMethod !== 'boolean') contractFail('objc-scoped-method-kind');
      const evidenceIds = stringSet(context.evidenceIds, 'objc-scoped-evidence', 64);
      if (!evidenceIds.length) contractFail('objc-scoped-source-evidence-empty');
      const index = context.index;
      // Borrow immutable indexed metadata; never clone a complete framework.
      if (index?.runtime !== 'objc' || !Number.isSafeInteger(index.methodCount) || index.methodCount < 0 || index.methodCount > 4096
        || !Number.isSafeInteger(index.protocolRequirementCount) || index.protocolRequirementCount < 0 || index.protocolRequirementCount > 4096
        || !(index.classes instanceof Map) || index.classes.size > 4096 || !(index.protocols instanceof Map) || index.protocols.size > 4096) {
        return { ...base, status: 'unsupported', requirements: ['objc-runtime-index-query-budget'] };
      }
      await boundObjcOwnerTraversal(index, receiverType, protocols, work);
      if (context.isCurrent() !== true) contractFail('objc-scoped-owner-stale-after-preflight');
      work.charge('workUnits', index.methodCount + index.protocolRequirementCount + 1);
      const ownerResult = resolveObjcDispatch(index, { receiverType, selector, classMethod: context.classMethod, protocols });
      const candidates = [], requirements = ['objc-dynamic-image-set-open', 'objc-method-swizzling-unexcluded',
        'objc-forwarding-unexcluded', 'objc-receiver-selector-proposition-not-independently-verified'];
      const limit = Math.min(query.maxTargets, 128);
      for (const method of ownerResult.candidates) {
        work.checkpoint(); work.charge('workUnits');
        if (candidates.length >= limit) { requirements.push('objc-target-budget'); break; }
        if (method.imp == null) { requirements.push('objc-implementation-address-unknown'); continue; }
        const address = unsignedAddress(method.imp);
        const target = await work.await((providerSignal) => resolveFunctionIdentity({ binaryId: context.binaryId, sliceId: context.sliceId, address },
          { world, assumptions, snapshotId, signal: providerSignal, work }));
        if (signal?.aborted) throw signal.reason;
        if (context.isCurrent() !== true) contractFail('objc-scoped-owner-stale-after-function-lookup');
        if (!target || target.worldId !== world.id || target.snapshotId !== snapshotId
          || target.binaryId !== context.binaryId || target.sliceId !== context.sliceId || unsignedAddress(target.address) !== address) {
          requirements.push('objc-canonical-function-membership-unavailable'); continue;
        }
        const declaration = snapshotContractData({ selector, receiverType, protocols, classMethod: context.classMethod,
          method: { className: method.className ?? null, source: method.source ?? null, address },
          snapshotId, callSiteId: query.callSiteId, projectionId: projection.id }, { maxBytes: 65536 });
        const id = createEntityId({ binaryId: context.binaryId, kind: 'objc-dispatch-owner-reference', identity: {
          worldId: world.id, artifactId: context.artifactId, ownerRevision: context.ownerRevision,
          version: APPLE_SCOPED_METADATA_VERSION, digest: stableDigest({ declaration, typed: lossyTypeWitness(declaration) }) } });
        candidates.push({ targetEntityId: exactString(target.entityId, 'objc-target-function-entity'), binaryId: target.binaryId,
          address, family: 'objc-msgsend', evidenceIds: [...evidenceIds, context.artifactId],
          provenance: { schema: 'dispatch-owner-reference/v1', id, worldId: world.id, binaryId: context.binaryId,
            artifactId: context.artifactId, ownerRevision: context.ownerRevision, declaration },
          requirements: ['metadata-candidate-not-static-call-proof'], score: method.score });
      }
      if (ownerResult.partial) requirements.push('objc-owner-metadata-partial');
      if (ownerResult.requirements?.length) requirements.push('objc-protocol-requirements-not-implementations');
      if (context.isCurrent() !== true) contractFail('objc-scoped-owner-stale-before-publication');
      return { ...base, status: 'partial', candidates, requirements: stringSet(requirements) };
    } };
}
