/** Bounded reads of the application's existing Apple metadata owners. Request
 * fields select records; they cannot declare receiver types or generic values.
 */
import { selectorFromSymbol } from '../../apple/selector-stubs.js';
import { assertWorldScope, assertAssumptionSet, worldContains } from '../../core/identity/world.js';
import { assertScopedAnalysisWork } from '../../core/budgets/scoped-work.js';
import { createEntityId, deepFreeze, stableDigest, lossyTypeWitness } from '../../core/identity/index.js';
import { snapshotContractData, recordFields, exactString, exactInteger, exactEnum, unsignedAddress, contractFail } from '../../core/identity/structured.js';
import { indexScopedFunctionEntries, scopedCallTargetRows, assertNativeTargetDemand } from '../query/semantic/call-targets.js';
import { nativeLoadCut } from '../dispatch/native-demand.js';

export const NATIVE_APPLE_METADATA_VERSION = '1.0.0';
const KINDS = ['objc-selector', 'objc-class', 'objc-imp', 'swift-type', 'swift-protocol', 'swift-vtable', 'swift-witness', 'swift-generic', 'swift-capture'];
const address = value => value == null ? null : unsignedAddress(value);
const sameAddress = (left, right) => left != null && right != null && address(left) === address(right);
const digest = value => stableDigest({ value, types: lossyTypeWitness(value) });
const capture = value => snapshotContractData(value, { allowBigInt: true, maxBytes: 131072 });
function array(value, work) {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > 4096) contractFail('native-apple-owner-record-budget');
  work.charge('workUnits', value.length + 1);
  return value;
}
function map(value) {
  if (!(value instanceof Map) || value.size > 4096) contractFail('native-apple-owner-index-budget');
  return value;
}
function selectedFields(row, keys) {
  const result = {};
  for (const key of keys) result[key] = row[key] ?? null;
  return result;
}
function methodRecord(method) {
  return { kind: 'objc-method', ...selectedFields(method, ['selector', 'className', 'classMethod', 'source', 'types']), address: address(method.imp) };
}
function inputQuery(request) {
  const input = snapshotContractData(request);
  recordFields(input, ['kind', 'selector', 'className', 'address', 'protocolAddress', 'slot', 'offset', 'limit'], 'native-apple-query-fields');
  const kind = exactEnum(input.kind, KINDS, 'native-apple-query-kind');
  const allowed = { 'objc-selector': ['selector'], 'objc-class': ['className'], 'objc-imp': ['address'],
    'swift-type': ['address'], 'swift-protocol': ['address'], 'swift-vtable': ['address', 'slot'],
    'swift-witness': ['address', 'protocolAddress', 'slot'], 'swift-generic': ['address'], 'swift-capture': ['address'] }[kind];
  for (const key of Object.keys(input)) if (!['kind', 'offset', 'limit', ...allowed].includes(key)) contractFail('native-apple-query-kind-fields');
  const result = { kind, offset: exactInteger(input.offset ?? 0, 'native-apple-query-offset', { max: 4096 }),
    limit: exactInteger(input.limit ?? 16, 'native-apple-query-limit', { min: 1, max: 64 }) };
  for (const key of allowed) if (key in input) result[key] = key === 'slot'
    ? exactInteger(input[key], 'native-apple-query-slot', { max: 4095 })
    : ['address', 'protocolAddress'].includes(key) ? address(input[key]) : exactString(input[key], 'native-apple-query-name', 2048);
  return result;
}
function sourceBinding(context, world) {
  if (typeof context?.isCurrent !== 'function' || context.isCurrent() !== true) contractFail('native-apple-owner-stale');
  const source = snapshotContractData(context.sourceIdentity);
  recordFields(source, ['binaryId', 'sliceId', 'sourceId', 'generation'], 'native-apple-source-fields');
  for (const key of ['binaryId', 'sliceId', 'sourceId', 'generation']) exactString(source[key], 'native-apple-source-' + key);
  if (!worldContains(world, source.binaryId, source.sliceId) || source.generation !== world.generation) contractFail('native-apple-source-binding');
  const worldSource = world.binarySet.find(row => row.binaryId === source.binaryId && row.sliceId === source.sliceId).sourceIdentity;
  if (worldSource.kind !== 'complete-content' && (worldSource.sourceInstance !== source.sourceId || worldSource.generation !== source.generation)) contractFail('native-apple-source-instance');
  return source;
}

/** Read every bounded matching owner record before pagination; retain duplicate
 * addresses/slots as distinct declarations instead of Map last-write wins. */
function recordsFor(context, query, work) {
  const records = [];
  const emit = row => {
    if (records.length >= 4096) contractFail('native-apple-result-budget');
    const copy = capture(row), text = JSON.stringify(copy, (_key, value) => typeof value === 'bigint' ? value.toString() : value);
    work.charge('residentBytes', text.length * 4 + 256); records.push(copy);
  };
  if (query.kind.startsWith('objc-')) {
    const index = context.objcIndex;
    if (index?.runtime !== 'objc') return { available: false, records };
    if (query.kind === 'objc-class') {
      const classes = map(index.classes); work.charge('workUnits', classes.size);
      for (const [name, cls] of classes) if (query.className == null || query.className === name) {
        emit({ kind: 'objc-class', name, ...selectedFields(cls, ['address', 'superName', 'protocols']),
          methodCount: array(cls.methods, work).length, classMethodCount: array(cls.classMethods, work).length });
      }
    } else {
      const methods = query.kind === 'objc-imp' ? map(index.methodsByIMP) : map(index.methodsBySelector);
      work.charge('workUnits', methods.size);
      for (const [key, values] of methods) {
        if (query.kind === 'objc-imp' && query.address != null && !sameAddress(key, query.address)) continue;
        for (const method of array(values, work)) if (query.selector == null || query.selector === method.selector) emit(methodRecord(method));
      }
    }
    return { available: true, records };
  }
  const index = context.swiftIndex;
  if (index?.runtime !== 'swift' || !index.model) return { available: false, records };
  const model = index.model;
  if (query.kind === 'swift-type' || query.kind === 'swift-protocol') {
    const source = query.kind === 'swift-type' ? model.types : model.protocols;
    for (const row of array(source, work)) if (query.address == null || sameAddress(row.address, query.address)) {
      emit({ kind: query.kind, ...selectedFields(row, ['address', 'name', 'flags', 'parent', 'generic', 'metadataAccessor', 'requirementsComplete']) });
    }
  } else if (query.kind === 'swift-generic' || query.kind === 'swift-capture') {
    const source = query.kind === 'swift-generic' ? model.genericContexts : model.captureDescriptors;
    if (!Array.isArray(source)) return { available: false, records };
    for (const row of array(source, work)) if (query.address == null || sameAddress(query.kind === 'swift-generic' ? row.typeAddress : row.address, query.address)) emit({ kind: query.kind, ...row });
  } else {
    const witnesses = query.kind === 'swift-witness';
    for (const table of array(witnesses ? model.witnessTables : model.vtables, work)) {
      if (query.address != null && !sameAddress(table.typeAddress, query.address)) continue;
      if (query.protocolAddress != null && !sameAddress(table.protocolAddress, query.protocolAddress)) continue;
      for (const entry of array(witnesses ? table.entries : table.methods, work)) {
        if (query.slot != null && entry.index !== query.slot) continue;
        emit({ kind: query.kind, tableAddress: address(table.address), entriesAddress: address(table.entriesAddress),
          typeAddress: address(table.typeAddress), protocolAddress: address(table.protocolAddress), source: table.source ?? null,
          slot: entry.index, address: address(witnesses ? entry.target : entry.impl),
          pointerResolved: witnesses ? entry.resolved === true : entry.impl != null,
          rawTarget: witnesses ? address(entry.rawTarget) : null,
          dynamic: entry.dynamic ?? null, async: entry.async ?? null });
      }
    }
  }
  return { available: true, records };
}
function current(context, source, world, read, before) {
  if (digest(sourceBinding(context, world)) !== digest(source) || digest(read()) !== before) contractFail('native-apple-owner-changed');
}

export async function queryNativeAppleMetadata(request, { world, assumptions, snapshotId, work, getContext } = {}) {
  assertWorldScope(world); assertAssumptionSet(assumptions, world); assertScopedAnalysisWork(work);
  exactString(snapshotId, 'native-apple-snapshot');
  const query = inputQuery(request);
  if (typeof getContext !== 'function') return { status: 'unsupported', reason: 'native-apple-owner-unavailable', exact: false };
  const context = await work.await(signal => getContext({ world, assumptions, snapshotId, signal, work }));
  if (!context) return { status: 'unsupported', reason: 'native-apple-owner-unavailable', exact: false };
  const source = sourceBinding(context, world), read = () => recordsFor(context, query, work);
  const selected = read(), before = digest(selected);
  const end = Math.min(selected.records.length, query.offset + query.limit);
  const records = selected.records.slice(query.offset, end);
  work.charge('residentBytes', records.length * 2048 + 1024);
  await work.yieldIfNeeded(); current(context, source, world, read, before);
  const body = { schema: 'scoped-native-apple-metadata/v1', status: selected.available ? 'completed' : 'unsupported',
    reason: selected.available ? null : 'native-apple-metadata-kind-unavailable', worldId: world.id,
    assumptionsId: assumptions.id, snapshotId, source, query, records,
    total: selected.records.length, nextOffset: end < selected.records.length ? end : null,
    authority: 'existing-metadata-owner-records', bytesRevalidated: false, exact: false,
    remaining: ['runtime-image-set-open', 'metadata-is-not-instantiated-runtime-type', 'capture-object-layout-and-lifetime-unproven'],
    ownerVersion: NATIVE_APPLE_METADATA_VERSION };
  return deepFreeze({ ...body, id: createEntityId({ binaryId: source.binaryId, kind: body.schema, identity: body }), cost: work.cost() });
}

/** Automatic address/selector joins from canonical call targets. Function
 * boundaries still come exclusively from selected projections or the host's
 * canonical identity owner. A metadata entry alone cannot create a function. */
export function createNativeAppleDispatchResolver({ snapshotId, getContext, resolveFunctionIdentity = null } = {}) {
  exactString(snapshotId, 'native-apple-snapshot');
  if (typeof getContext !== 'function' || (resolveFunctionIdentity !== null && typeof resolveFunctionIdentity !== 'function')) contractFail('native-apple-dispatch-owner');
  return { id: 'native-apple-metadata-dispatch', version: NATIVE_APPLE_METADATA_VERSION,
    families: ['objc-msgsend', 'swift-witness', 'swift-metadata'],
    async resolve(query, { world, assumptions, projection, nativeContext, work }) {
      assertScopedAnalysisWork(work);
      const result = { worldId: world.id, assumptionsId: assumptions.id, projectionId: projection.id,
        callSiteId: query.callSiteId, candidates: [], chains: [], status: 'partial',
        requirements: ['apple-runtime-world-open', 'metadata-candidate-not-call-proof', 'receiver-generic-substitution-unproven'] };
      const context = await work.await(signal => getContext({ world, assumptions, snapshotId, signal, work }));
      if (!context) return { ...result, status: 'unsupported', requirements: ['native-apple-owner-unavailable'] };
      const source = sourceBinding(context, world), location = projection.inputIdentity.sourceLocation;
      if (projection.inputIdentity.snapshotId !== snapshotId || projection.inputIdentity.binaryId !== source.binaryId
        || location?.sliceId !== source.sliceId) contractFail('native-apple-call-source-binding');
      const reference = projection.entityReference('semantic-ir', query.callSiteId), node = reference && projection.source(reference);
      if (!node?.call) return { ...result, status: 'unsupported', requirements: ['native-apple-call-unavailable'] };
      const members = nativeContext?.members ?? [];
      if (!Array.isArray(members) || members.length > 16) contractFail('native-apple-selected-scope-budget');
      if (nativeContext?.member && nativeContext.member.projection !== projection) contractFail('native-apple-native-context-binding');
      const demand = nativeContext?.member ? assertNativeTargetDemand(nativeContext.member.demand, projection) : null;
      const entries = indexScopedFunctionEntries(members.map(row => row.projection));
      work.charge('workUnits', Math.min(64, node.call.targetValueIds?.length ?? 0) * 512 + 1);
      const targets = [...scopedCallTargetRows(projection, node, entries, demand)].filter(row => row.address != null);
      const read = () => ['objc-imp', 'swift-witness', 'swift-vtable'].flatMap(kind => recordsFor(context, { kind }, work).records);
      const metadata = read(), before = digest(metadata), alternatives = [];
      for (const target of targets) {
        work.charge('workUnits', metadata.length + 1);
        for (const record of metadata) if (record.address != null && sameAddress(record.address, target.address)) alternatives.push({ record, target, selector: null });
        if (typeof context.symbolFor === 'function') {
          const symbol = await work.await(signal => context.symbolFor(BigInt(target.address), { signal }));
          const selector = typeof symbol === 'string' ? selectorFromSymbol(symbol) : null;
          if (selector) for (const record of recordsFor(context, { kind: 'objc-selector', selector }, work).records) alternatives.push({ record, target, selector });
        }
      }
      if (demand) {
        const cut = await nativeLoadCut(projection, node, work, query.maxHops);
        if (cut.cut) result.requirements.push('native-apple-load-dependency-cut');
        for (const access of array(demand.memoryObjects?.accesses, work)) {
          if (!cut.loads.has(access.nodeId) || access.widthBits !== 64) continue;
          const pointsTo = array(demand.objects, work).find(row => row.valueId === access.addressValueId)?.pointsTo;
          if (!pointsTo || pointsTo.top) continue;
          for (const object of array(pointsTo.targets, work)) {
            if (object.rootKind !== 'absolute' || object.address == null || object.offsetRange?.min == null
              || object.offsetRange.min !== object.offsetRange.max) continue;
            const storage = BigInt(object.address) + BigInt(object.offsetRange.min);
            if (storage < 0n || storage >= 1n << 64n) continue;
            work.charge('workUnits', metadata.length);
            for (const record of metadata) {
              // entriesAddress is retained by the canonical parser's upstream
              // #8086 ABI correction. Explicit unqualified table seeds do not
              // acquire a synthetic header or slot coordinate here.
              if (record.kind !== 'swift-witness' || record.source !== 'conformance' || record.entriesAddress == null
                || !Number.isSafeInteger(record.slot) || record.slot < 0 || record.slot > 4095
                || BigInt(record.entriesAddress) + BigInt(record.slot * 8) !== storage) continue;
              alternatives.push({ record, selector: null, target: { source: 'existing-memoryssa-and-points-to',
                loadNodeId: access.nodeId, memoryEntityId: access.memoryEntityId, storageAddress: address(storage),
                exact: false, dependency: 'possible', contentStability: 'unknown' } });
            }
          }
        }
        if (alternatives.some(row => row.target.source === 'existing-memoryssa-and-points-to')) result.requirements.push('witness-pointer-content-stability-and-authentication-unproven');
      }
      for (const alternative of alternatives) {
        const { record } = alternative;
        const family = record.kind === 'objc-method' ? 'objc-msgsend' : record.kind === 'swift-witness' ? 'swift-witness' : 'swift-metadata';
        if (query.families && !query.families.includes(family)) continue;
        if (result.candidates.length >= Math.min(query.maxTargets, 128)) { result.requirements.push('native-apple-target-budget'); break; }
        if (record.address == null || record.pointerResolved === false) continue;
        const selected = members.filter(row => row.projection.inputIdentity.binaryId === source.binaryId
          && row.projection.inputIdentity.sourceLocation?.sliceId === source.sliceId
          && sameAddress(row.projection.inputIdentity.sourceLocation?.start, record.address));
        const identities = selected.map(row => ({ entityId: row.projection.functionId, worldId: world.id,
          snapshotId, binaryId: source.binaryId, sliceId: source.sliceId, address: record.address }));
        if (!identities.length && resolveFunctionIdentity) {
          const identity = await work.await(signal => resolveFunctionIdentity({ binaryId: source.binaryId, sliceId: source.sliceId, address: record.address },
            { world, assumptions, snapshotId, signal, work }));
          if (identity) identities.push(identity);
        }
        if (!identities.length) result.requirements.push('native-apple-canonical-function-unavailable');
        for (const identity of identities) {
          if (result.candidates.length >= Math.min(query.maxTargets, 128)) { result.requirements.push('native-apple-target-budget'); break; }
          if (identity.worldId !== world.id || identity.snapshotId !== snapshotId || identity.binaryId !== source.binaryId
            || identity.sliceId !== source.sliceId || !sameAddress(identity.address, record.address)) contractFail('native-apple-function-binding');
          const declaration = capture({ source, record, targetReference: alternative.target,
            selectorFromOwnerSymbol: alternative.selector, callSiteId: query.callSiteId, projectionId: projection.id });
          const id = createEntityId({ binaryId: source.binaryId, kind: 'native-apple-dispatch-reference', identity: declaration });
          result.candidates.push({ targetEntityId: exactString(identity.entityId, 'native-apple-function-identity'), binaryId: source.binaryId,
            address: record.address, family,
            evidenceIds: [query.callSiteId, id], requirements: ['runtime-overrides-and-interposition-unexcluded'],
            provenance: { schema: 'dispatch-owner-reference/v1', id, worldId: world.id, binaryId: source.binaryId,
              artifactId: id, ownerRevision: NATIVE_APPLE_METADATA_VERSION, declaration } });
        }
        current(context, source, world, read, before);
      }
      current(context, source, world, read, before);
      return result;
    } };
}
