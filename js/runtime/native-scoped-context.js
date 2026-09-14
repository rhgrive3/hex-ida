/** Read-only projection of an already opened, retained Phase 10 trace.
 * No session creation, event stream consumption, replay, or target execution.
 * Only the existing versioned scpaAsync payload supplies events. Optional
 * contracts/relations are the same typed records consumed by scoped-async;
 * their presence is a provider premise, never inferred runtime semantics. */
import { RuntimeProviderPlatform, RuntimeProviderSession, TraceProvider } from './provider-platform.js';
import { RuntimeModuleBindingTable } from './provider-identity.js';
import { CAPTURED_ASYNC_SOURCE_SCHEMA, CAPTURED_ASYNC_EVENT_SCHEMA, capturedAsyncBuildIdentity } from './captured-async.js';
import { assertScopedAnalysisWork } from '../core/budgets/scoped-work.js';
import { assertWorldScope, assertAssumptionSet } from '../core/identity/world.js';
import { deepFreeze, stableDigest, stableStringify, lossyTypeWitness } from '../core/identity/index.js';
import { snapshotContractData, recordFields, plainRecord, exactString, contractFail } from '../core/identity/structured.js';

const MAX_RETAINED = 4096, MAX_ASYNC = 128, MAX_BYTES = 1048576;
const EVENT_FIELDS = ['eventId', 'runtimeSessionId', 'providerId', 'providerVersion', 'sessionEpoch', 'streamId', 'sequence',
  'predecessorIds', 'providerEventId', 'timestamp', 'processKey', 'threadKey', 'moduleBindingKey', 'moduleGeneration',
  'kind', 'payload', 'observationMode', 'completeness', 'interventionIds'];
const typed = value => stableStringify([value, lossyTypeWitness(value)]);
const unsupported = reason => ({ status: 'unsupported', reason, exact: false });

export function createNativeScopedRuntimeContextProvider(platform, { binaryId, sliceId, isCurrent } = {}) {
  if (!(platform instanceof RuntimeProviderPlatform) || typeof isCurrent !== 'function') contractFail('native-runtime-owner-required');
  exactString(binaryId, 'native-runtime-binary'); exactString(sliceId, 'native-runtime-slice');

  function capture(runtimeSessionId, scope) {
    const { world, assumptions, snapshotId, work, signal } = scope;
    assertWorldScope(world); assertAssumptionSet(assumptions, world); assertScopedAnalysisWork(work); work.checkpoint();
    exactString(runtimeSessionId, 'native-runtime-session'); exactString(snapshotId, 'native-runtime-snapshot');
    if (signal?.aborted) contractFail('native-runtime-cancelled');
    if (isCurrent() !== true) contractFail('native-runtime-owner-stale');
    if (!world.binarySet.some(b => b.binaryId === binaryId && b.sliceId === sliceId)) contractFail('native-runtime-world-binding');
    const session = platform.getSession(runtimeSessionId);
    if (!(session instanceof RuntimeProviderSession) || platform.current !== session || session.closed || session.state !== 'ready') {
      return unsupported('native-current-runtime-session-unavailable');
    }
    const provider = session.provider, events = session.normalizedEvents, modules = session.modules;
    if (!(provider instanceof TraceProvider) || provider.activeSession !== session || platform.provider(session.providerId) !== provider
      || !Array.isArray(events) || !Object.isFrozen(events) || !(modules instanceof RuntimeModuleBindingTable)) {
      return unsupported('native-retained-trace-owner-unavailable');
    }
    if (session.target.primaryBinaryId !== binaryId || session.target.primarySliceId !== sliceId) {
      return unsupported('native-runtime-target-scope-mismatch');
    }
    if (events.length > MAX_RETAINED) return unsupported('native-retained-trace-event-bound');
    if (Object.getPrototypeOf(events) !== Array.prototype || Reflect.ownKeys(events).length !== events.length + 1) {
      contractFail('native-retained-event-array-invalid');
    }
    if (session.sourceCompleteness !== 'complete') return unsupported('native-retained-trace-incomplete');
    const epoch = session.epoch, providerId = session.providerId, providerVersion = session.providerVersion;
    const target = session.target, active = modules.active();
    if (active.length > MAX_RETAINED) contractFail('native-runtime-module-bound');
    const pinnedModules = new Map(active.map(m => [m.bindingKey, m]));
    work.charge('residentBytes', active.length * 128); work.charge('workUnits', active.length);
    const current = () => {
      work.checkpoint();
      if (signal?.aborted || isCurrent() !== true || platform.current !== session || platform.getSession(runtimeSessionId) !== session
        || session.closed || session.state !== 'ready' || session.epoch !== epoch || session.target !== target
        || session.provider !== provider || provider.activeSession !== session || platform.provider(providerId) !== provider
        || session.providerId !== providerId || session.providerVersion !== providerVersion
        || session.normalizedEvents !== events || session.sourceCompleteness !== 'complete' || session.modules !== modules) return false;
      const now = modules.active();
      if (now.length !== pinnedModules.size) return false;
      for (const module of now) { work.charge('workUnits'); if (pinnedModules.get(module.bindingKey) !== module) return false; }
      return true;
    };
    const selected = [], observations = new Map(), contracts = new Map(), relations = new Map();
    const allIds = new Set(); let bytes = 0, selectedModule = null;
    function addRecords(records, owner, limit, label) {
      if (records === undefined) return;
      if (!Array.isArray(records) || records.length > limit) contractFail(`native-async-${label}-bound`);
      for (const record of records) {
        work.charge('workUnits'); exactString(record.id, `native-async-${label}-id`, 256);
        if (owner.has(record.id) && typed(owner.get(record.id)) !== typed(record)) contractFail(`native-async-${label}-conflict`);
        owner.set(record.id, record);
        if (owner.size > limit) contractFail(`native-async-${label}-bound`);
      }
    }
    for (let index = 0; index < events.length; index++) {
      work.charge('workUnits');
      const descriptor = Object.getOwnPropertyDescriptor(events, String(index));
      if (!descriptor || !Object.hasOwn(descriptor, 'value')) contractFail('native-retained-event-array-invalid');
      const raw = descriptor.value;
      recordFields(raw, EVENT_FIELDS, 'native-retained-event-fields');
      // The canonical owner freezes complete events. A replaced/mutable record
      // is not a retained owner record and cannot become a capture premise.
      if (!Object.isFrozen(raw) || !Object.isFrozen(raw.payload)) contractFail('native-retained-event-not-immutable');
      plainRecord(raw.payload, 'native-retained-event-payload');
      exactString(raw.eventId, 'native-retained-event-id', 256);
      if (allIds.has(raw.eventId)) contractFail('native-retained-event-id-collision');
      allIds.add(raw.eventId);
      if (raw.kind === 'gap' || raw.kind === 'dropped-events') return unsupported('native-retained-trace-loss');
      if (raw.runtimeSessionId !== runtimeSessionId || raw.providerId !== providerId || raw.providerVersion !== providerVersion
        || raw.sessionEpoch !== epoch) return unsupported('native-retained-trace-event-epoch-mismatch');
      const asyncDescriptor = Object.getOwnPropertyDescriptor(raw.payload, 'scpaAsync');
      if (!asyncDescriptor) continue;
      if (!Object.hasOwn(asyncDescriptor, 'value') || !asyncDescriptor.enumerable) contractFail('native-retained-async-payload-accessor');
      if (asyncDescriptor.value === undefined) continue;
      if (!['trace-marker', 'instrumentation-observation'].includes(raw.kind) || raw.observationMode !== 'observed'
        || raw.interventionIds.length || raw.completeness !== 'complete') return unsupported('native-retained-async-event-unqualified');
      const copied = snapshotContractData(raw, { maxBytes: 65536, maxNodes: 4096 });
      const cost = stableStringify(copied).length * 2;
      bytes += cost; if (bytes > MAX_BYTES) contractFail('native-retained-async-byte-bound');
      work.charge('residentBytes', cost);
      const payload = copied.payload.scpaAsync;
      recordFields(payload, ['schema', 'event', 'contracts', 'relations'], 'native-retained-async-payload-fields');
      if (payload.schema !== CAPTURED_ASYNC_EVENT_SCHEMA) return unsupported('native-retained-async-schema-unqualified');
      if (payload.event?.id !== raw.eventId) contractFail('native-retained-async-event-binding');
      const module = pinnedModules.get(raw.moduleBindingKey);
      if (!module || module.generation !== raw.moduleGeneration || module.identityState !== 'exact' || module.buildIdentity == null
        || !module.identityEvidenceIds.length || module.binaryId !== binaryId || module.sliceId !== sliceId) {
        return unsupported('native-retained-async-module-unqualified');
      }
      if (selectedModule && selectedModule !== module) return unsupported('native-retained-async-multiple-modules');
      const buildIdentity = capturedAsyncBuildIdentity(module, world);
      if (buildIdentity.status !== 'matched') return unsupported(buildIdentity.reason);
      selectedModule = module;
      selected.push(payload.event); observations.set(raw.eventId, copied);
      if (selected.length > MAX_ASYNC) return unsupported('native-retained-async-event-bound');
      addRecords(payload.contracts, contracts, 32, 'contracts'); addRecords(payload.relations, relations, 2048, 'relations');
    }
    if (!selected.length) return unsupported('native-retained-async-markers-unavailable');
    if (!current()) contractFail('native-runtime-owner-stale');
    const source = deepFreeze({ schema: 'scpa-async-events/v1', events: selected, contracts: [...contracts.values()], relations: [...relations.values()],
      remaining: ['retained-async-contracts-are-provider-premises', ...(!contracts.size ? ['retained-async-contracts-unavailable'] : [])] });
    const runtimeBinding = deepFreeze({ worldId: world.id, assumptionsId: assumptions.id, snapshotId, runtimeSessionId,
      providerId, providerVersion, sessionEpoch: epoch });
    const ownerRevision = stableDigest({ runtimeBinding, source, typedSource: lossyTypeWitness(source),
      moduleBindingKey: selectedModule.bindingKey, moduleGeneration: selectedModule.generation });
    const context = { source, binding: deepFreeze({ worldId: world.id, assumptionsId: assumptions.id, snapshotId, runtimeSessionId,
      epoch, moduleGeneration: String(selectedModule.generation), ownerRevision }),
      runtimeCapture: deepFreeze({ schema: CAPTURED_ASYNC_SOURCE_SCHEMA, moduleBindingKey: selectedModule.bindingKey,
        moduleGeneration: selectedModule.generation, providerSchemaVersion: CAPTURED_ASYNC_EVENT_SCHEMA }), isCurrent: current };
    const runtime = { binding: runtimeBinding, modules, isCurrent: current,
      getObservation(eventId, { role } = {}) {
        if (!current()) contractFail('native-runtime-owner-stale');
        // Other observation roles require their own actual owner field map.
        return role === 'async-event' && observations.has(eventId) ? { event: observations.get(eventId), address: null } : null;
      } };
    return { context: Object.freeze(context), runtime: Object.freeze(runtime) };
  }
  return Object.freeze({
    getAsyncEventContext(runtimeSessionId, scope) {
      const result = capture(runtimeSessionId, scope); return result.context ?? result;
    },
    getRuntimeEvidenceContext(runtimeSessionId, scope) {
      const result = capture(runtimeSessionId, scope); return result.runtime ?? null;
    },
  });
}
