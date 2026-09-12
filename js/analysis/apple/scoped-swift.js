/**
 * Scope-bound Swift candidates from the EXISTING runtime metadata owner.
 * No new Swift parser, demangler, ABI guess, function discovery or pointer
 * authentication semantics. A decoded witness slot is never an exact target.
 */
import { projectSwiftGenericEnvironment } from './scoped-swift-generic.js';
import { resolveSwiftDispatch } from '../../swift.js';
import { createEntityId, deepFreeze, stableDigest, lossyTypeWitness } from '../../core/identity/index.js';
import { assertWorldScope, assertAssumptionSet, worldContains } from '../../core/identity/world.js';
import { assertScopedAnalysisWork } from '../../core/budgets/scoped-work.js';
import { snapshotContractData, recordFields, exactString, exactInteger, exactEnum, stringSet,
  unsignedAddress, contractFail } from '../../core/identity/structured.js';

export const SCOPED_SWIFT_DISPATCH_VERSION = '1.1.0';
const MAX_TABLES = 4096, MAX_SLOTS = 4096;
const digest = (data) => stableDigest({ data, typed: lossyTypeWitness(data) });

function captureCall(value) {
  const data = snapshotContractData(value, { maxBytes: 32768 });
  recordFields(data, ['kind', 'typeAddress', 'protocolAddress', 'slot', 'genericEnvironmentId'], 'swift-scoped-call-fields');
  const kind = exactEnum(data.kind, ['vtable', 'witness', 'existential'], 'swift-scoped-call-kind');
  const typeAddress = unsignedAddress(data.typeAddress);
  const protocolAddress = kind === 'vtable' ? null : unsignedAddress(data.protocolAddress);
  if (kind === 'vtable' && data.protocolAddress != null) contractFail('swift-scoped-vtable-protocol');
  const slot = exactInteger(data.slot, 'swift-scoped-slot', { max: MAX_SLOTS - 1 });
  const genericEnvironmentId = data.genericEnvironmentId == null ? null : exactString(data.genericEnvironmentId, 'swift-scoped-generic-environment');
  return deepFreeze({ kind, typeAddress, protocolAddress, slot, genericEnvironmentId });
}

/** Bound only the collections the existing resolver might scan. Map lookup of
 * a single nominal address does not require rebuilding its whole runtime index.
 */
function boundedIndex(index, call, work) {
  if (index?.runtime !== 'swift' || !(index.typesByAddress instanceof Map)
    || !(index.protocolsByAddress instanceof Map) || !(index.vtablesByType instanceof Map)
    || !(index.witnessesByPair instanceof Map) || !(index.conformancesByType instanceof Map)) return 'swift-runtime-index-unavailable';
  const typeKey = `type@${BigInt(call.typeAddress)}`;
  const type = index.typesByAddress.get(BigInt(call.typeAddress).toString());
  if (!type || unsignedAddress(type.address) !== call.typeAddress) return 'swift-nominal-address-not-in-owner';
  if (call.kind === 'vtable') {
    const methods = index.vtablesByType.get(typeKey) ?? [];
    if (!Array.isArray(methods) || methods.length > MAX_SLOTS) return 'swift-vtable-slot-budget';
    work.charge('workUnits', methods.length + 1);
  } else {
    const tables = index.model?.witnessTables;
    const protocol = index.protocolsByAddress.get(BigInt(call.protocolAddress).toString());
    if (!protocol || unsignedAddress(protocol.address) !== call.protocolAddress) return 'swift-protocol-address-not-in-owner';
    if (!Array.isArray(tables) || tables.length > MAX_TABLES) return 'swift-witness-table-budget';
    if (!Array.isArray(protocol.requirements) || protocol.requirements.length > MAX_SLOTS) return 'swift-protocol-requirement-budget';
    const conformances = index.conformancesByType.get(typeKey) ?? [];
    if (!Array.isArray(conformances) || conformances.length > MAX_TABLES) return 'swift-conformance-budget';
    work.charge('workUnits', tables.length + protocol.requirements.length + conformances.length + 1);
    for (const table of tables) {
      work.checkpoint();
      if (!Array.isArray(table.entries) || table.entries.length > MAX_SLOTS) return 'swift-witness-slot-budget';
    }
    // The existing resolver scans just the selected table's slot list.
    work.charge('workUnits', MAX_SLOTS);
  }
  return null;
}

export function createSwiftScopedDispatchResolver({ getContext, resolveFunctionIdentity, snapshotId } = {}) {
  if (typeof getContext !== 'function' || typeof resolveFunctionIdentity !== 'function') contractFail('swift-scoped-host-capabilities');
  exactString(snapshotId, 'swift-scoped-snapshot');
  return { id: 'existing-swift-owner-scoped-candidates', version: SCOPED_SWIFT_DISPATCH_VERSION,
    families: ['swift-witness', 'swift-metadata'],
    resolve: async (query, { world, assumptions, projection, nodeReference, signal, work }) => {
      assertWorldScope(world); assertAssumptionSet(assumptions, world); assertScopedAnalysisWork(work);
      const base = { worldId: world.id, assumptionsId: assumptions.id, projectionId: projection.id,
        callSiteId: query.callSiteId, candidates: [], chains: [] };
      const context = await work.await((providerSignal) => getContext(nodeReference, {
        world, assumptions, snapshotId, projectionId: projection.id, signal: providerSignal, work,
      }));
      if (!context) return { ...base, status: 'unsupported', requirements: ['swift-call-metadata-owner-unavailable'] };
      if (typeof context.isCurrent !== 'function' || context.isCurrent() !== true) contractFail('swift-scoped-current-owner-required');
      const binding = snapshotContractData(context.binding, { maxBytes: 32768 });
      recordFields(binding, ['worldId', 'assumptionsId', 'snapshotId', 'projectionId', 'callSiteId', 'binaryId',
        'sliceId', 'artifactId', 'ownerRevision', 'byteBinding', 'evidenceIds'], 'swift-scoped-binding-fields');
      if (binding.worldId !== world.id || binding.assumptionsId !== assumptions.id || binding.snapshotId !== snapshotId
        || binding.projectionId !== projection.id || binding.callSiteId !== query.callSiteId
        || !worldContains(world, binding.binaryId, binding.sliceId)
        || binding.byteBinding !== 'host-read-current-source') contractFail('swift-scoped-source-binding');
      exactString(binding.artifactId, 'swift-scoped-artifact'); exactString(binding.ownerRevision, 'swift-scoped-owner-revision');
      const evidenceIds = stringSet(binding.evidenceIds, 'swift-scoped-source-evidence', 64);
      if (!evidenceIds.length) contractFail('swift-scoped-source-evidence-empty');
      const call = captureCall(context.call), family = call.kind === 'vtable' ? 'swift-metadata' : 'swift-witness';
      if (!query.families.includes(family)) return { ...base, status: 'unsupported', requirements: ['swift-call-family-not-requested'] };
      const reason = boundedIndex(context.index, call, work);
      if (reason) return { ...base, status: 'unsupported', requirements: [reason] };
      const requirements = ['swift-dynamic-conformance-world-open', 'swift-slot-expression-not-independently-qualified',
        'swift-metadata-is-not-machine-semantics', 'swift-authentication-and-interposition-unqualified'];
      const genericEnvironment = projectSwiftGenericEnvironment(context.genericEnvironment, { expectedId: call.genericEnvironmentId, binding, index: context.index, work });
      if (genericEnvironment) requirements.push('swift-generic-environment-substitution-not-proved', ...genericEnvironment.remaining);
      const index = context.index, typeKey = `type@${BigInt(call.typeAddress)}`;
      if (call.kind !== 'vtable') {
        const protocol = index.protocolsByAddress.get(BigInt(call.protocolAddress).toString());
        const matches = protocol.requirements.filter((entry) => entry.index === call.slot);
        if (protocol.requirementsComplete !== true || matches.length !== 1 || matches[0].witnessCallable !== true) {
          return { ...base, status: 'unsupported', requirements: [...requirements, 'swift-slot-not-proved-callable-metadata'] };
        }
        const conformances = (index.conformancesByType.get(typeKey) ?? []).filter((entry) => entry.protocol != null
          && unsignedAddress(entry.protocol) === call.protocolAddress);
        if (conformances.length !== 1 || conformances[0].conditionalRequirements !== 0
          || conformances[0].resilientWitnesses !== false) {
          return { ...base, status: 'unsupported', requirements: [...requirements,
            conformances.length > 1 ? 'swift-conformance-collision-set-unresolved' : 'swift-conditional-or-resilient-layout-unqualified'] };
        }
      }
      // Pass canonical numeric addresses, not nominal spellings or a guessed
      // compiler suffix. The existing owner's lookup is the only resolver.
      const resolved = resolveSwiftDispatch(index, { kind: call.kind, typeAddress: BigInt(call.typeAddress),
        ...(call.protocolAddress === null ? {} : { protocolAddress: BigInt(call.protocolAddress) }), slot: call.slot });
      if (context.isCurrent() !== true) contractFail('swift-scoped-metadata-changed');
      const candidates = [];
      if (resolved.complete !== true) requirements.push('swift-owner-metadata-incomplete');
      const records = resolved.candidates?.length ? resolved.candidates : resolved.resolved ? [resolved.resolved] : [];
      if (!Array.isArray(records) || records.length > Math.min(query.maxTargets, 128)) contractFail('swift-scoped-result-budget');
      for (const record of records) {
        work.checkpoint(); work.charge('workUnits');
        const rawAddress = call.kind === 'vtable' ? record.impl : record.target;
        if (rawAddress == null || call.kind !== 'vtable' && record.resolved !== true) {
          requirements.push('swift-target-pointer-unresolved'); continue;
        }
        const address = unsignedAddress(rawAddress);
        const declaration = snapshotContractData({ binding, call, ...(genericEnvironment ? { genericEnvironment } : {}), slot: exactInteger(record.index, 'swift-scoped-owner-slot', { max: MAX_SLOTS - 1 }),
          address, pointerStorage: record.address == null ? null : unsignedAddress(record.address),
          rawPointer: record.rawTarget == null ? null : unsignedAddress(record.rawTarget),
          declaredAsync: record.async === true, declaredDynamic: record.dynamic === true }, { allowBigInt: true, maxBytes: 65536 });
        if (declaration.slot !== call.slot) contractFail('swift-scoped-result-slot-mismatch');
        const declarationId = createEntityId({ binaryId: binding.binaryId, kind: 'swift-dispatch-metadata-reference',
          identity: { version: SCOPED_SWIFT_DISPATCH_VERSION, digest: digest(declaration) } });
        const target = await work.await((providerSignal) => resolveFunctionIdentity({
          binaryId: binding.binaryId, sliceId: binding.sliceId, address,
        }, { world, assumptions, snapshotId, signal: providerSignal, work }));
        if (signal?.aborted) throw signal.reason;
        if (context.isCurrent() !== true) contractFail('swift-scoped-stale-after-function-lookup');
        if (!target || target.worldId !== world.id || target.snapshotId !== snapshotId
          || target.binaryId !== binding.binaryId || target.sliceId !== binding.sliceId || unsignedAddress(target.address) !== address) {
          requirements.push('swift-canonical-function-membership-unavailable'); continue;
        }
        const entryRequirements = ['metadata-candidate-not-static-call-proof'];
        if (declaration.pointerStorage === null) entryRequirements.push('swift-pointer-storage-coordinate-not-retained-by-owner');
        if (declaration.declaredAsync) entryRequirements.push('swift-async-continuation-and-context-unqualified');
        if (declaration.declaredDynamic) entryRequirements.push('swift-dynamic-replacement-unexcluded');
        candidates.push({ targetEntityId: exactString(target.entityId, 'swift-canonical-function-id'),
          binaryId: binding.binaryId, address, family, evidenceIds: [...evidenceIds, binding.artifactId],
          provenance: { schema: 'dispatch-owner-reference/v1', id: declarationId, worldId: world.id,
            binaryId: binding.binaryId, artifactId: binding.artifactId, ownerRevision: binding.ownerRevision, declaration },
          requirements: entryRequirements, score: typeof resolved.confidence === 'number' && Number.isFinite(resolved.confidence)
            && resolved.confidence >= 0 && resolved.confidence <= 1 ? resolved.confidence : 0 });
      }
      if (!candidates.length) requirements.push('swift-no-callable-target-in-supplied-owner-view');
      if (context.isCurrent() !== true) contractFail('swift-scoped-stale-before-publication');
      return { ...base, status: 'partial', candidates, requirements: stringSet(requirements) };
    } };
}
