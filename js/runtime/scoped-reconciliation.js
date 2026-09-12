/**
 * Read-only reconciliation of ALREADY CAPTURED runtime events. No provider is
 * opened, no process is run, no breakpoint/intervention is requested, and no
 * observation overwrites a static artifact. Events remain existential samples.
 */
import { RuntimeModuleBindingTable } from './provider-identity.js';
import { createRuntimeEvent } from './events.js';
import { assertSetEnvelope } from '../core/evidence/set-envelope.js';
import { assertQualifiedJudgment } from '../core/evidence/scoped.js';
import { assertWorldScope, assertAssumptionSet } from '../core/identity/world.js';
import { assertScopedAnalysisWork } from '../core/budgets/scoped-work.js';
import { createEntityId, deepFreeze, stableDigest, stableStringify, lossyTypeWitness } from '../core/identity/index.js';
import { snapshotContractData, recordFields, exactString, exactInteger, exactEnum, stringSet, unsignedAddress, contractFail } from '../core/identity/structured.js';

export const RUNTIME_RECONCILIATION_SCHEMA = 'scoped-runtime-reconciliation/v1';
export const RUNTIME_RECONCILIATION_VERSION = '1.0.0';
export const RUNTIME_ADDRESS_SET_DOMAIN = 'arm64-static-code-addresses/v1';
const sameData = (a, b) => stableStringify(a) === stableStringify(b)
  && stableStringify(lossyTypeWitness(a)) === stableStringify(lossyTypeWitness(b));

export function scopedStaticAddress(value, world) {
  assertWorldScope(world);
  recordFields(value, ['binaryId', 'sliceId', 'address'], 'runtime-static-address-fields');
  if (!world.binarySet.some((member) => member.binaryId === value.binaryId && member.sliceId === value.sliceId)) contractFail('runtime-address-outside-world');
  const address = unsignedAddress(value.address, { bits: world.profile.addressBits });
  return deepFreeze({ binaryId: value.binaryId, sliceId: value.sliceId, address });
}
export function scopedStaticAddressMemberId(value, world) {
  const canonical = scopedStaticAddress(value, world);
  return createEntityId({ binaryId: canonical.binaryId, kind: RUNTIME_ADDRESS_SET_DOMAIN, identity: canonical });
}
/** A target set is about one callsite, not every address in a world. */
export function normalizeRuntimeCallSubject(value, world) {
  recordFields(value, ['binaryId', 'sliceId', 'functionId', 'callSiteId'], 'runtime-call-subject-fields');
  if (!world.binarySet.some((member) => member.binaryId === value.binaryId && member.sliceId === value.sliceId)) contractFail('runtime-call-subject-outside-world');
  return deepFreeze({ binaryId: value.binaryId, sliceId: value.sliceId,
    functionId: exactString(value.functionId, 'runtime-call-subject-function'),
    callSiteId: exactString(value.callSiteId, 'runtime-call-subject-callsite') });
}
export function scopedCallTargetDomain(value, world) {
  const subject = normalizeRuntimeCallSubject(value, world);
  return `${RUNTIME_ADDRESS_SET_DOMAIN}:${createEntityId({ binaryId: subject.binaryId,
    kind: 'scoped-call-target-domain', identity: { worldId: world.id, subject } })}`;
}
function selectPayloadAddress(payload, path) {
  if (!Array.isArray(path) || !path.length || path.length > 8) contractFail('runtime-address-field-path');
  let cursor = payload;
  for (const key of path) {
    exactString(key, 'runtime-address-field-path-token', 256);
    if (!cursor || typeof cursor !== 'object' || !Object.hasOwn(cursor, key)) contractFail('runtime-address-payload-field-missing');
    cursor = cursor[key];
  }
  return unsignedAddress(cursor, { bits: 64 });
}
function admittedObservation(judgment, observationId, proposition, world, assumptions) {
  if (judgment === null) return false;
  assertQualifiedJudgment(judgment);
  return judgment.world === world.id && judgment.assumptions === assumptions.id && judgment.subject === observationId
    && judgment.quantifier === 'some-witnessed-execution' && ['exact', 'sound-underapprox'].includes(judgment.precision)
    && judgment.executionStatus === 'completed' && judgment.obligations.length === 0 && sameData(judgment.value, proposition);
}

export async function queryRuntimeReconciliation(request, { world, assumptions, snapshotId, work,
  getContext = null, getTargetEnvelope = null, qualifyObservation = null } = {}) {
  assertWorldScope(world); assertAssumptionSet(assumptions, world); assertScopedAnalysisWork(work);
  recordFields(request, ['runtimeSessionId', 'eventIds', 'role', 'targetEnvelopeId'], 'runtime-reconciliation-query-fields');
  const runtimeSessionId = exactString(request.runtimeSessionId, 'runtime-reconciliation-session');
  const eventIds = stringSet(request.eventIds, 'runtime-reconciliation-events', 128);
  if (!eventIds.length) contractFail('runtime-reconciliation-empty-query');
  const role = exactEnum(request.role, ['instruction', 'call-target', 'memory-address'], 'runtime-reconciliation-address-role');
  const targetEnvelopeId = request.targetEnvelopeId == null ? null : exactString(request.targetEnvelopeId, 'runtime-target-envelope');
  if (targetEnvelopeId !== null && role !== 'call-target') contractFail('runtime-target-comparison-requires-call-target');
  if (!getContext) return { status: 'unsupported', reason: 'captured-runtime-evidence-owner-unbound', exact: false };
  const context = await work.await((signal) => getContext(runtimeSessionId, { world, assumptions, snapshotId, signal, work }));
  if (!context) return { status: 'unsupported', reason: 'captured-runtime-session-unavailable', exact: false };
  if (!(context.modules instanceof RuntimeModuleBindingTable) || context.modules.runtimeSessionId !== runtimeSessionId
    || typeof context.isCurrent !== 'function' || typeof context.getObservation !== 'function' || context.isCurrent() !== true) contractFail('runtime-reconciliation-owner-contract');
  const binding = snapshotContractData(context.binding, { maxBytes: 32768 });
  recordFields(binding, ['worldId', 'assumptionsId', 'snapshotId', 'runtimeSessionId', 'providerId', 'providerVersion', 'sessionEpoch'], 'runtime-reconciliation-binding-fields');
  if (binding.worldId !== world.id || binding.assumptionsId !== assumptions.id || binding.snapshotId !== snapshotId
    || binding.runtimeSessionId !== runtimeSessionId) contractFail('runtime-reconciliation-world-mismatch');
  exactString(binding.providerId, 'runtime-reconciliation-provider'); exactString(binding.providerVersion, 'runtime-reconciliation-provider-version');
  exactInteger(binding.sessionEpoch, 'runtime-reconciliation-epoch', { min: 1 });
  const active = context.modules.active();
  if (active.length > 4096) contractFail('runtime-reconciliation-module-budget');
  const capturedModules = new Map();
  for (const module of active) { work.charge('workUnits'); capturedModules.set(module.bindingKey, module); }
  const assertCurrent = () => {
    work.checkpoint();
    if (context.isCurrent() !== true) contractFail('runtime-reconciliation-session-stale');
    const current = context.modules.active();
    if (current.length !== capturedModules.size) contractFail('runtime-reconciliation-module-membership-changed');
    for (const module of current) {
      work.charge('workUnits');
      if (capturedModules.get(module.bindingKey) !== module) contractFail('runtime-reconciliation-module-generation-changed');
    }
  };
  let targetContext = null, envelope = null, targetSubject = null, upperIds = null;
  if (targetEnvelopeId !== null && getTargetEnvelope) {
    targetContext = await work.await((signal) => getTargetEnvelope(targetEnvelopeId, { world, assumptions, snapshotId, signal, work }));
    assertCurrent();
    if (targetContext) {
      if (typeof targetContext.isCurrent !== 'function' || targetContext.isCurrent() !== true) contractFail('runtime-static-envelope-owner-required');
      envelope = assertSetEnvelope(targetContext.envelope, world);
      targetSubject = normalizeRuntimeCallSubject(snapshotContractData(targetContext.subject), world);
      if (envelope.id !== targetEnvelopeId || envelope.domain !== scopedCallTargetDomain(targetSubject, world)) contractFail('runtime-static-envelope-domain-or-identity');
      if (envelope.admission?.assumptions !== assumptions.id || envelope.admission?.upperAdmitted !== true) envelope = null;
      else if (envelope.upper.kind === 'finite') {
        if (envelope.upper.members.length > 8192) contractFail('runtime-static-envelope-member-budget');
        upperIds = new Set();
        for (const member of envelope.upper.members) {
          work.charge('workUnits');
          const id = scopedStaticAddressMemberId(member.value, world);
          if (id !== member.id) contractFail('runtime-static-envelope-address-identity'); upperIds.add(id);
        }
      }
    }
  }
  const observations = [], unknown = [], disagreements = [];
  for (const eventId of eventIds) {
    assertCurrent();
    const raw = await work.await((signal) => context.getObservation(eventId, { role, signal, work }));
    assertCurrent();
    if (!raw) { unknown.push({ eventId, reason: 'captured-event-unavailable' }); continue; }
    const supplied = snapshotContractData(raw, { allowBigInt: true, maxNodes: 8192, maxBytes: 262144 });
    recordFields(supplied, ['event', 'address'], 'runtime-observation-envelope-fields');
    // Reuse the event owner, then require that normalization changed no field.
    const event = createRuntimeEvent(supplied.event);
    if (!sameData(event, supplied.event) || event.eventId !== eventId || event.runtimeSessionId !== runtimeSessionId
      || event.providerId !== binding.providerId || event.providerVersion !== binding.providerVersion
      || event.sessionEpoch !== binding.sessionEpoch) contractFail('runtime-observation-event-binding');
    const address = supplied.address;
    recordFields(address, ['eventId', 'role', 'fieldPath', 'moduleBindingKey', 'moduleGeneration', 'providerSchemaVersion', 'evidenceIds', 'subject'], 'runtime-observation-address-fields');
    if (address.eventId !== eventId || address.role !== role) contractFail('runtime-observation-address-role-binding');
    exactString(address.providerSchemaVersion, 'runtime-observation-schema-version');
    const moduleKey = exactString(address.moduleBindingKey, 'runtime-observation-module-key');
    const moduleGeneration = exactInteger(address.moduleGeneration, 'runtime-observation-module-generation', { min: 1 });
    const subject = address.subject == null ? null : normalizeRuntimeCallSubject(address.subject, world);
    if (subject !== null && role !== 'call-target') contractFail('runtime-observation-unexpected-call-subject');
    const evidenceIds = stringSet(address.evidenceIds, 'runtime-observation-address-evidence', 64);
    if (!evidenceIds.length) contractFail('runtime-observation-role-evidence-required');
    if (role === 'instruction' && (event.moduleBindingKey !== moduleKey || event.moduleGeneration !== moduleGeneration)) {
      unknown.push({ eventId, reason: 'instruction-event-module-binding-mismatch' }); continue;
    }
    // No implicit PAC/TBI masking. The selected address must already be a
    // canonical event-schema value; tagged/authenticated representations keep
    // their ambiguity unless the runtime owner provides a distinct proof.
    const runtimeAddress = selectPayloadAddress(event.payload, address.fieldPath);
    const module = capturedModules.get(moduleKey);
    if (!module || module.generation !== moduleGeneration) {
      unknown.push({ eventId, reason: 'historical-or-unloaded-module-generation' }); continue;
    }
    const resolution = context.modules.resolve(BigInt(runtimeAddress));
    if (resolution.moduleBindingKey !== moduleKey || resolution.moduleGeneration !== moduleGeneration
      || !['exact', 'resolved'].includes(resolution.state) || resolution.staticAddress === null) {
      unknown.push({ eventId, reason: resolution.method ?? 'runtime-address-unresolved', resolutionState: resolution.state }); continue;
    }
    if (!world.binarySet.some((member) => member.binaryId === resolution.binaryId && member.sliceId === resolution.sliceId)) {
      unknown.push({ eventId, reason: 'runtime-image-not-exactly-in-static-world' }); continue;
    }
    if (!module.identityEvidenceIds.length || module.buildIdentity === null) {
      unknown.push({ eventId, reason: 'runtime-module-build-identity-evidence-incomplete' }); continue;
    }
    const staticAddress = scopedStaticAddress({ binaryId: resolution.binaryId, sliceId: resolution.sliceId,
      address: resolution.staticAddress }, world);
    const eventDigest = stableDigest({ event, typed: lossyTypeWitness(event) });
    const proposition = deepFreeze({ kind: 'observed-static-address', eventId, eventDigest, runtimeSessionId,
      sessionEpoch: binding.sessionEpoch, role, subject, providerSchemaVersion: address.providerSchemaVersion,
      fieldPath: address.fieldPath, moduleBindingKey: moduleKey, moduleGeneration,
      buildIdentity: snapshotContractData(module.buildIdentity, { maxBytes: 16384 }), staticAddress });
    const observationId = createEntityId({ binaryId: staticAddress.binaryId, kind: 'scoped-runtime-observation',
      identity: { version: RUNTIME_RECONCILIATION_VERSION, worldId: world.id, assumptionsId: assumptions.id, snapshotId, proposition } });
    const eligibleMode = event.observationMode === 'observed' && event.interventionIds.length === 0;
    let judgment = null, admitted = false;
    if (eligibleMode && qualifyObservation) {
      judgment = await work.await((signal) => qualifyObservation({ observationId, proposition, event, resolution, module },
        { world, assumptions, snapshotId, signal, work }));
      assertCurrent();
      admitted = admittedObservation(judgment, observationId, proposition, world, assumptions);
    }
    const memberId = scopedStaticAddressMemberId(staticAddress, world);
    const subjectMatches = targetSubject !== null && subject !== null && sameData(targetSubject, subject);
    const comparison = targetEnvelopeId === null ? 'not-requested' : !subjectMatches ? 'callsite-subject-not-bound-to-static-envelope'
      : upperIds === null ? 'static-upper-bound-unqualified-or-top'
      : upperIds.has(memberId) ? 'not-refuted-by-this-observation'
        : admitted ? 'admitted-observation-outside-qualified-upper-bound' : 'potential-disagreement-observation-unqualified';
    if (subjectMatches && upperIds !== null && !upperIds.has(memberId)) disagreements.push({ observationId, eventId,
      targetEnvelopeId, memberId, status: admitted ? 'scoped-contradiction' : 'requires-observation-admission' });
    const row = { observationId, eventId, runtimeSessionId, providerId: binding.providerId, sessionEpoch: binding.sessionEpoch,
      role, subject, observationMode: event.observationMode, interventionIds: event.interventionIds,
      moduleBindingKey: moduleKey, moduleGeneration, runtimeAddress, staticAddress, memberId,
      provenance: { eventDigest, providerSchemaVersion: address.providerSchemaVersion, fieldPath: address.fieldPath,
        moduleEvidenceIds: module.identityEvidenceIds, addressEvidenceIds: evidenceIds, resolutionMethod: resolution.method,
        buildIdentity: proposition.buildIdentity },
      quantifier: admitted ? 'some-witnessed-execution' : 'unqualified-runtime-observation',
      admissionJudgmentId: judgment?.id ?? null, admitted, comparison, staticExact: false,
      remaining: [...(admitted ? [] : ['runtime-image-role-and-execution-scope-admission']),
        ...(eligibleMode ? [] : ['intervened-or-synthetic-not-natural-execution']),
        'unobserved-executions-not-excluded', 'cross-thread-order-not-inferred'] };
    work.charge('results'); work.charge('residentBytes', stableStringify(row).length * 2); observations.push(row);
    await work.yieldIfNeeded();
  }
  assertCurrent();
  if (targetContext && targetContext.isCurrent() !== true) contractFail('runtime-static-envelope-stale-before-publication');
  const body = snapshotContractData({ schema: RUNTIME_RECONCILIATION_SCHEMA, version: RUNTIME_RECONCILIATION_VERSION,
    status: 'completed', worldId: world.id, assumptionsId: assumptions.id, snapshotId, binding,
    requested: eventIds.length, observations, unknown, disagreements, targetEnvelopeId,
    exact: false, negativeConclusion: 'not-supported-by-observation', staticTruthChanged: false,
    runtimeSideEffects: false, eventPayloadProjection: 'selected-address-only; other captured data not returned' },
  { allowBigInt: true, maxNodes: 131072, maxBytes: 4 * 1024 * 1024 });
  return deepFreeze({ ...body, id: createEntityId({ binaryId: world.binarySet[0].binaryId, kind: RUNTIME_RECONCILIATION_SCHEMA,
    identity: { digest: stableDigest({ body, typed: lossyTypeWitness(body) }) } }), cost: work.cost() });
}
