import assert from 'node:assert/strict';
import test from 'node:test';

import {
  RUNTIME_AUTHORITY_SCHEMA,
  RUNTIME_OBSERVATION_SCHEMA,
  RuntimeAuthorityTracker,
  createRuntimeAuthorityBinding,
  createRuntimeObservation,
  isValidatedRuntimeProfileSupport,
  runtimeProfileSupport,
  validateRuntimeObservation,
} from '../../js/runtime/authority.js';
import {
  RUNTIME_RESOLUTION_STATES,
  RuntimeModuleBindingTable,
  createRuntimeProviderSessionId,
} from '../../js/runtime/provider-identity.js';
import { TraceProvider } from '../../js/runtime/trace-provider.js';
import { validatedCapabilityProofFixture } from './helpers/profile-proof-fixture.mjs';

// HEX-S2-01 acceptance denominator.  Runtime observation is only evidence when
// it is bound to the exact provider/session/target/module/build generation being
// analyzed, and the retained trace is bounded.  Every category below is fixed
// here so a later provider cannot quietly drop one identity class.
const BINDING_IDENTITY_FIELDS = Object.freeze([
  'bindingId', 'providerIdentity', 'providerProfileId', 'providerVersion',
  'runtimeInstanceIdentity', 'targetIdentity', 'targetProfileId',
  'architectureProfileId', 'binaryIdentity', 'buildIdentity',
  'runtimeBuildIdentity', 'moduleIdentity', 'loadMappingIdentity',
  'sessionIdentity', 'capabilityVersion', 'commitSha', 'treeSha', 'epoch',
]);

const OBSERVATION_LIFECYCLE_FIELDS = Object.freeze(['sequence', 'observedAt', 'kind', 'observationId']);

const MODULE_GENERATION_LIFECYCLE = Object.freeze(['loaded', 'unloaded', 'reloaded']);

const REQUIRED_PROOF_FLAGS = Object.freeze([
  'exactHead', 'identityNegativeTests', 'staleEventTests', 'lifecycleTests',
  'capabilityTests', 'moduleMappingTests', 'mutationAuthorityTests',
]);

const REQUIRED_BINDING_INPUTS = Object.freeze([
  ['providerIdentity', 'runtime-provider-identity-required'],
  ['runtimeInstanceIdentity', 'runtime-instance-identity-required'],
  ['targetIdentity', 'runtime-target-identity-required'],
  ['binaryIdentity', 'runtime-binary-identity-required'],
  ['moduleIdentity', 'runtime-module-identity-required'],
  ['loadMappingIdentity', 'runtime-load-mapping-identity-required'],
  ['sessionIdentity', 'runtime-session-identity-required'],
  ['capabilityVersion', 'runtime-capability-version-required'],
]);

// Identity alias pairs: both spellings must denote the same identity.  A pair
// that can be supplied twice is a conflict and is rejected instead of silently
// picking one side.
const ALIAS_CONFLICT_PAIRS = Object.freeze([
  ['targetProfileId', 'architectureProfileId'],
  ['buildIdentity', 'runtimeBuildIdentity'],
]);

const ALIAS_FALLBACK_PAIRS = Object.freeze([
  ['binaryIdentity', 'binaryHash'],
  ['sessionIdentity', 'sessionId'],
  ['targetIdentity', 'processIdentity'],
]);

const REQUIRED_CAPABILITIES = Object.freeze([
  'connect', 'disconnect', 'attach', 'pause', 'resume', 'stepInto',
  'breakpointAddress', 'removeBreakpoint', 'readRegisters', 'readMemory', 'writeMemory',
  'threads', 'modules', 'cancel',
]);

const COMMIT_SHA = 'a'.repeat(40);
const TREE_SHA = 'b'.repeat(40);

function bindingInput(overrides = {}) {
  return {
    providerIdentity: 'provider:lldb:s2',
    providerProfileId: 'native:remote-debug-v1:qemu-lldb',
    providerVersion: 'lldb:s2',
    runtimeInstanceIdentity: 'runtime:s2',
    targetIdentity: 'process:s2',
    targetProfileId: 'arm64:a64',
    binaryIdentity: 'binary:s2',
    buildIdentity: 'build:s2',
    moduleIdentity: 'module:s2',
    loadMappingIdentity: 'mapping:s2',
    sessionIdentity: 'session:s2',
    capabilityVersion: 'debug/v1',
    commitSha: COMMIT_SHA,
    treeSha: TREE_SHA,
    epoch: 3,
    ...overrides,
  };
}

function fixtureBinding(overrides = {}) {
  return createRuntimeAuthorityBinding(bindingInput(overrides));
}

function moduleInput(overrides = {}) {
  return {
    bindingKey: 'main',
    runtimeBase: 0x1000n,
    runtimeSize: 0x100n,
    staticBase: 0x4000n,
    binaryId: 'binary:s2',
    identityState: 'exact',
    loadedSequence: 1,
    ...overrides,
  };
}

// `TypeError` constructors in the runtime authority surface throw the reason
// text itself, while `DebugAdapterError` carries the machine reason in `.code`.
// Acceptance assertions bind whichever of the two is the contract.
function errorMessage(code) {
  return (error) => {
    assert.match(String(error?.message), new RegExp(code));
    return true;
  };
}

function errorCode(code) {
  return (error) => {
    assert.equal(error?.code, code);
    return true;
  };
}

let traceSequence = 0;

async function openTraceSession(recording, options = {}) {
  const provider = new TraceProvider({
    recordingId: `recording:s2-${++traceSequence}`,
    sourceProvider: 'fixture-tracer',
    sourceProviderVersion: '1',
    binaryId: 'binary:s2',
    completeness: 'bounded',
    events: [],
    ...recording,
  }, { id: `trace-provider-s2-${traceSequence}`, ...options });
  return provider.openSession({ sessionNonce: `s2-${traceSequence}` });
}

test('S2-01 identity denominator is frozen and present on canonical records', () => {
  assert.deepEqual(BINDING_IDENTITY_FIELDS, [
    'bindingId', 'providerIdentity', 'providerProfileId', 'providerVersion',
    'runtimeInstanceIdentity', 'targetIdentity', 'targetProfileId',
    'architectureProfileId', 'binaryIdentity', 'buildIdentity',
    'runtimeBuildIdentity', 'moduleIdentity', 'loadMappingIdentity',
    'sessionIdentity', 'capabilityVersion', 'commitSha', 'treeSha', 'epoch',
  ]);
  assert.deepEqual(MODULE_GENERATION_LIFECYCLE, ['loaded', 'unloaded', 'reloaded']);
  assert.deepEqual(RUNTIME_RESOLUTION_STATES, ['exact', 'resolved', 'ambiguous', 'unresolved', 'mismatch']);

  const binding = fixtureBinding();
  assert.equal(binding.schemaVersion, RUNTIME_AUTHORITY_SCHEMA);
  const observation = createRuntimeObservation({ binding, sequence: 1, observedAt: '2026-09-16T00:00:01Z', kind: 'stop', payload: { pc: '0x1010' } });
  assert.equal(observation.schemaVersion, RUNTIME_OBSERVATION_SCHEMA);
  assert.equal(observation.authority, 'runtime-evidence');
  for (const field of BINDING_IDENTITY_FIELDS) {
    assert.ok(Object.prototype.hasOwnProperty.call(binding, field), `binding must carry identity field ${field}`);
    assert.ok(Object.prototype.hasOwnProperty.call(observation, field), `observation must carry identity field ${field}`);
  }
  for (const field of OBSERVATION_LIFECYCLE_FIELDS) {
    assert.ok(Object.prototype.hasOwnProperty.call(observation, field), `observation must carry lifecycle field ${field}`);
  }
});

test('S2-01 missing or malformed identity inputs fail closed with their exact reason', () => {
  for (const [field, code] of REQUIRED_BINDING_INPUTS) {
    const input = bindingInput();
    delete input[field];
    assert.throws(() => createRuntimeAuthorityBinding(input), new RegExp(code), `missing ${field} must be rejected`);
  }
  assert.throws(() => createRuntimeAuthorityBinding({ ...bindingInput(), epoch: '3' }), /runtime-epoch-invalid/);
  assert.throws(() => createRuntimeAuthorityBinding({ ...bindingInput(), epoch: -1 }), /runtime-epoch-invalid/);
  assert.throws(() => createRuntimeAuthorityBinding({ ...bindingInput(), commitSha: 'not-a-sha' }), /runtime-commit-identity-invalid/);
  assert.throws(() => createRuntimeAuthorityBinding({ ...bindingInput(), treeSha: 'not-a-sha' }), /runtime-tree-identity-invalid/);
  assert.throws(() => createRuntimeAuthorityBinding({ ...bindingInput(), providerIdentity: '   ' }), /runtime-provider-identity-required/);
  assert.throws(() => createRuntimeAuthorityBinding(), errorMessage('runtime-provider-identity-required'));
  assert.throws(() => createRuntimeAuthorityBinding(null), errorMessage('runtime-provider-identity-required'));

  for (const [primary, alias] of ALIAS_CONFLICT_PAIRS) {
    const conflicting = { ...bindingInput(), [primary]: `${primary}:a`, [alias]: `${alias}:b` };
    assert.throws(() => createRuntimeAuthorityBinding(conflicting), errorMessage('runtime-identity-alias-mismatch'), `${primary}/${alias} conflict must be rejected`);
  }
  for (const [primary, alias] of ALIAS_FALLBACK_PAIRS) {
    const viaAlias = bindingInput();
    const value = viaAlias[primary];
    delete viaAlias[primary];
    viaAlias[alias] = value;
    assert.equal(
      createRuntimeAuthorityBinding(viaAlias).bindingId,
      fixtureBinding().bindingId,
      `${primary} and ${alias} must denote one identity`,
    );
  }

  const binding = fixtureBinding();
  const observation = createRuntimeObservation({ binding, sequence: 1, observedAt: '2026-09-16T00:00:01Z', kind: 'stop' });
  assert.equal(validateRuntimeObservation({ ...binding, providerIdentity: 'provider:evil' }, observation).reason, 'runtime-binding-identity-invalid', 'a mutated authority tuple without a recomputed digest is not identity');
  assert.equal(validateRuntimeObservation({ ...bindingInput(), schemaVersion: 'hex-runtime-authority/v0' }, observation).reason, 'runtime-binding-identity-invalid', 'an unknown authority schema cannot be validated');
});

test('S2-01 every identity field mismatch is rejected as a field-scoped reason', () => {
  const binding = fixtureBinding();
  const valid = createRuntimeObservation({
    binding, sequence: 7, observedAt: '2026-09-16T00:00:07Z', kind: 'stop', payload: { pc: '0x1010' },
  });
  const replacements = {
    bindingId: 'runtime-binding:0000000000000000000000000000000000000000',
    providerIdentity: 'provider:other',
    providerProfileId: 'native:replay-v1:other',
    providerVersion: 'lldb:other',
    runtimeInstanceIdentity: 'runtime:other',
    targetIdentity: 'process:other',
    targetProfileId: 'arm64e:a64+pac',
    architectureProfileId: 'arm64e:a64+pac',
    binaryIdentity: 'binary:other',
    buildIdentity: 'build:other',
    runtimeBuildIdentity: 'build:other',
    moduleIdentity: 'module:other',
    loadMappingIdentity: 'mapping:other',
    sessionIdentity: 'session:other',
    capabilityVersion: 'debug/v2',
    commitSha: 'c'.repeat(40),
    treeSha: 'd'.repeat(40),
    epoch: binding.epoch + 1,
  };
  for (const field of BINDING_IDENTITY_FIELDS) {
    const result = validateRuntimeObservation(binding, { ...valid, [field]: replacements[field] });
    assert.equal(result.ok, false, `${field} mismatch must not validate`);
    assert.equal(result.reason, `runtime-observation-${field}-mismatch`, `${field} must report its own mismatch reason`);
  }
  const tampered = { ...valid, payload: { pc: '0xdead' } };
  assert.equal(validateRuntimeObservation(binding, tampered).reason, 'runtime-observation-identity-invalid');
  assert.equal(validateRuntimeObservation(binding, { ...valid, authority: 'static-fact' }).reason, 'runtime-observation-authority-invalid');
  assert.equal(validateRuntimeObservation(binding, { ...valid, schemaVersion: 'hex-runtime-observation/v0' }).reason, 'runtime-observation-schema-invalid');
  assert.equal(validateRuntimeObservation(binding, createRuntimeObservation({
    binding, sequence: 7, observedAt: '2026-09-16T00:00:07Z', kind: 'stop',
  }), { minimumSequence: 8 }).reason, 'runtime-observation-stale-sequence');
});

test('S2-01 observation identity is sensitive to payload type and bytes, not only values', () => {
  const binding = fixtureBinding();
  const observation = (payload) => createRuntimeObservation({
    binding, sequence: 1, observedAt: '2026-09-16T00:00:01Z', kind: 'memory-read', payload,
  });
  const bytesA = observation({ bytes: Uint8Array.from([1, 2, 3, 4]) });
  const bytesB = observation({ bytes: Uint8Array.from([1, 2, 3, 5]) });
  const sameBytesOtherType = observation({ bytes: Uint16Array.from([513, 1027]) });
  const sameBytesArray = observation({ bytes: [1, 2, 3, 4] });
  assert.notEqual(bytesA.observationId, bytesB.observationId, 'byte content is identity material');
  assert.notEqual(bytesA.observationId, sameBytesOtherType.observationId, 'binary view type is identity material');
  assert.notEqual(bytesA.observationId, sameBytesArray.observationId, 'binary and array payloads are different evidence');
  assert.equal(bytesA.observationId, observation({ bytes: Uint8Array.from([1, 2, 3, 4]) }).observationId, 'identical payloads stay identical');
  const cyclic = {};
  cyclic.self = cyclic;
  assert.throws(() => observation({ cyclic }), /runtime-observation-cyclic-payload/);
});

test('S2-01 bounded observation storage counts and bytes, and stale sequences are refused', () => {
  const binding = fixtureBinding();
  assert.throws(() => new RuntimeAuthorityTracker(binding, { maxObservations: Number.NaN }), /runtime-max-observations-invalid/);
  assert.throws(() => new RuntimeAuthorityTracker(binding, { maxObservations: 5000 }), /runtime-max-observations-invalid/);
  assert.throws(() => new RuntimeAuthorityTracker(binding, { maxRetainedPayloadBytes: 0 }), /runtime-max-retained-payload-bytes-invalid/);

  const tracker = new RuntimeAuthorityTracker(binding, { maxObservations: 2 });
  for (let sequence = 1; sequence <= 3; sequence++) {
    const observation = createRuntimeObservation({
      binding, sequence, observedAt: `2026-09-16T00:00:0${sequence}Z`, kind: 'stop', payload: { pc: `0x100${sequence}` },
    });
    assert.equal(tracker.accept(observation).status, 'accepted');
  }
  assert.equal(tracker.snapshot().observations.length, 2, 'observation history must stay count-bounded');
  assert.equal(tracker.snapshot().lastSequence, 3);
  assert.equal(tracker.accept(createRuntimeObservation({
    binding, sequence: 3, observedAt: '2026-09-16T00:00:04Z', kind: 'stop',
  })).reason, 'runtime-observation-stale-sequence');
  assert.equal(tracker.accept(createRuntimeObservation({
    binding, sequence: 2, observedAt: '2026-09-16T00:00:04Z', kind: 'stop',
  })).reason, 'runtime-observation-stale-sequence', 'an out-of-order sequence below the accepted high-water mark is stale');

  const byteTracker = new RuntimeAuthorityTracker(binding, { maxRetainedPayloadBytes: 8 });
  assert.equal(byteTracker.accept(createRuntimeObservation({
    binding, sequence: 1, observedAt: '2026-09-16T00:00:01Z', kind: 'memory-read', payload: { bytes: Uint8Array.from([1, 2, 3, 4]) },
  })).status, 'accepted');
  assert.equal(byteTracker.accept(createRuntimeObservation({
    binding, sequence: 2, observedAt: '2026-09-16T00:00:02Z', kind: 'memory-read', payload: { bytes: Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]) },
  })).reason, 'runtime-tracker-retained-payload-bytes-exceeded', 'retained payload bytes must bound memory, not just row count');

  const epochTracker = new RuntimeAuthorityTracker(binding, { maxObservations: 1 });
  epochTracker.accept(createRuntimeObservation({ binding, sequence: 1, observedAt: '2026-09-16T00:00:01Z', kind: 'stop' }));
  const nextBinding = epochTracker.nextEpoch({ sessionIdentity: 'session:s2-next' });
  assert.equal(nextBinding.epoch, binding.epoch + 1);
  assert.notEqual(nextBinding.bindingId, binding.bindingId);
  assert.equal(epochTracker.closed, true);
  assert.equal(epochTracker.accept(createRuntimeObservation({ binding, sequence: 2, observedAt: '2026-09-16T00:00:02Z', kind: 'stop' })).reason, 'runtime-tracker-closed');
  const nextObservation = createRuntimeObservation({ binding: nextBinding, sequence: 1, observedAt: '2026-09-16T00:00:03Z', kind: 'stop' });
  assert.equal(validateRuntimeObservation(nextBinding, nextObservation).ok, true);
  assert.equal(validateRuntimeObservation(nextBinding, createRuntimeObservation({
    binding, sequence: 1, observedAt: '2026-09-16T00:00:03Z', kind: 'stop',
  })).reason, 'runtime-observation-bindingId-mismatch', 'an old-generation observation cannot cross into the new epoch');
});

test('S2-01 runtime mutation authority requires the exact binding plus explicit approval', () => {
  const binding = fixtureBinding();
  const tracker = new RuntimeAuthorityTracker(binding);
  assert.equal(tracker.authorizeMutation({ bindingId: binding.bindingId, actorIdentity: 'local:user', operation: 'write-memory', issuedAt: '2026-09-16T00:00:06Z' }).reason, 'runtime-mutation-explicit-approval-required');
  assert.equal(tracker.authorizeMutation({ bindingId: 'runtime-binding:other', actorIdentity: 'local:user', operation: 'write-memory', issuedAt: '2026-09-16T00:00:06Z', explicitApproval: true }).reason, 'runtime-mutation-binding-mismatch');
  const authorized = tracker.authorizeMutation({ bindingId: binding.bindingId, actorIdentity: 'local:user', operation: 'write-memory', issuedAt: '2026-09-16T00:00:06Z', explicitApproval: true });
  assert.equal(authorized.status, 'authorized');
  assert.equal(authorized.token.authority, 'explicit-local-runtime-mutation');
  assert.match(authorized.token.tokenId, /^runtime-mutation:/);
});

test('S2-01 provider session identity is bound to the verified binary identity', () => {
  assert.throws(() => createRuntimeProviderSessionId({ providerId: 'p', sessionNonce: 'n' }), errorCode('runtime-binary-identity-required'));
  const first = createRuntimeProviderSessionId({ binaryId: 'binary:s2', providerId: 'p', sessionNonce: 'n' });
  const second = createRuntimeProviderSessionId({ binaryId: 'binary:s2-other', providerId: 'p', sessionNonce: 'n' });
  assert.notEqual(first, second, 'a different binary identity must not reuse the session identity');
  assert.equal(first, createRuntimeProviderSessionId({ binaryId: 'binary:s2', providerId: 'p', sessionNonce: 'n' }));
});

test('S2-01 module reload at the same VA advances the generation and retires the old binding', () => {
  const table = new RuntimeModuleBindingTable('session:s2-modules');
  const first = table.load(moduleInput({ runtimeBase: 0x1000n, runtimeSize: 0x100n, buildIdentity: 'build:1', loadedSequence: 1, pathHint: 'libA' }));
  assert.equal(first.generation, 1);
  assert.equal(table.resolve(0x1010n).state, 'exact');
  assert.equal(table.resolve(0x1010n).moduleGeneration, 1);
  assert.equal(table.resolve(0x1010n).staticAddress, 0x4010n);
  assert.throws(() => table.load(moduleInput()), errorCode('module-binding-already-loaded'));
  assert.throws(() => table.load(moduleInput({ bindingKey: 'other', unloadedSequence: 2 })), errorCode('invalid-module-sequence'));
  assert.throws(() => table.unload('main', 0), errorCode('invalid-module-sequence'), 'an unload sequence before the load sequence is rejected');

  const retired = table.unload('main', 5);
  assert.equal(retired.generation, 1);
  assert.equal(retired.unloadedSequence, 5);
  assert.equal(table.resolve(0x1010n).state, 'unresolved', 'an unloaded module generation is not addressable');

  // Same runtime VA, new bytes/build: this is a new generation, never a relabel.
  const second = table.load(moduleInput({ runtimeBase: 0x1000n, runtimeSize: 0x100n, buildIdentity: 'build:2', loadedSequence: 6, pathHint: 'libA' }));
  assert.equal(second.generation, 2);
  assert.equal(second.runtimeBase, first.runtimeBase);
  assert.notEqual(second.buildIdentity, first.buildIdentity);
  const resolved = table.resolve(0x1010n);
  assert.equal(resolved.state, 'exact');
  assert.equal(resolved.moduleGeneration, 2, 'resolution must publish the current generation, not the retired one');
  assert.deepEqual(table.active().map((entry) => entry.generation), [2]);
  assert.deepEqual(table.history().map((entry) => entry.generation), [1, 1, 2]);
  assert.equal(table.get('main').generation, 2);
});

test('S2-01 unresolved, ambiguous and mismatched module identity states stay explicit', () => {
  const unresolvedTable = new RuntimeModuleBindingTable('session:s2-unresolved');
  unresolvedTable.load(moduleInput({ bindingKey: 'anon', binaryId: null, staticBase: null, identityState: undefined }));
  const unresolved = unresolvedTable.resolve(0x1010n);
  assert.equal(unresolved.state, 'unresolved');
  assert.equal(unresolved.method, 'static-identity-unresolved');
  assert.equal(unresolved.staticAddress, null);

  const ambiguousTable = new RuntimeModuleBindingTable('session:s2-ambiguous');
  ambiguousTable.load(moduleInput({ bindingKey: 'a', runtimeBase: 0x1000n, runtimeSize: 0x200n }));
  ambiguousTable.load(moduleInput({ bindingKey: 'b', runtimeBase: 0x1100n, runtimeSize: 0x200n }));
  const ambiguous = ambiguousTable.resolve(0x1150n);
  assert.equal(ambiguous.state, 'ambiguous');
  assert.equal(ambiguous.method, 'overlapping-active-modules');

  const mismatchTable = new RuntimeModuleBindingTable('session:s2-mismatch');
  mismatchTable.load(moduleInput());
  const mismatch = mismatchTable.resolve(0x1010n, { binaryId: 'binary:other' });
  assert.equal(mismatch.state, 'mismatch');
  assert.equal(mismatch.method, 'binary-id-mismatch');
  assert.equal(mismatch.staticAddress, null, 'a different binary identity cannot be silently mapped through this module');

  // Recognition candidates are not authority to re-bind a different binary.
  const weak = mismatchTable.resolve(0x1010n, {
    binaryId: 'binary:other',
    crossVersionMatch: { accepted: true, ambiguous: false, targetBinaryId: 'binary:other', confidence: 0.8, margin: 0.2, staticAddress: 0x5000n },
  });
  assert.equal(weak.state, 'mismatch', 'a sub-threshold candidate cannot redeem a binary identity mismatch');
  const ambiguousCandidate = mismatchTable.resolve(0x1010n, {
    binaryId: 'binary:other',
    crossVersionMatch: { accepted: true, ambiguous: true, targetBinaryId: 'binary:other', confidence: 0.99, margin: 0.9, staticAddress: 0x5000n },
  });
  assert.equal(ambiguousCandidate.state, 'mismatch', 'an explicitly ambiguous match cannot redeem a binary identity mismatch');

  const strong = mismatchTable.resolve(0x1010n, {
    binaryId: 'binary:other',
    crossVersionMatch: {
      accepted: true, ambiguous: false, targetBinaryId: 'binary:other', confidence: 0.95, margin: 0.4,
      staticAddress: 0x5000n, targetEntityIds: ['fn:1'], evidenceIds: ['evidence:match'],
    },
  });
  assert.equal(strong.state, 'resolved');
  assert.equal(strong.method, 'cross-version-match');
  assert.equal(strong.binaryId, 'binary:other');
  assert.deepEqual(strong.targetEntityIds, ['fn:1']);

  const sliceTable = new RuntimeModuleBindingTable('session:s2-slice');
  sliceTable.load(moduleInput({ bindingKey: 'slice', sliceId: null, binaryId: 'binary:s2' }));
  const slice = sliceTable.resolve(0x1010n, { binaryId: 'binary:s2', sliceId: 'slice:2' });
  assert.equal(slice.state, 'unresolved');
  assert.equal(slice.method, 'slice-identity-unresolved');
});

test('S2-01 dropped events are flagged and degrade trace completeness', async () => {
  const session = await openTraceSession({
    dropped: 2,
    events: [{ kind: 'trace-marker', payload: { marker: 1 } }],
  });
  const replay = await session.facets.trace.replay();
  assert.equal(replay.dropped, 2);
  assert.equal(replay.completeness, 'truncated');
  const dropped = replay.events.find((event) => event.kind === 'dropped-events');
  assert.ok(dropped, 'a dropped-events record must be published for an implicit loss');
  assert.equal(dropped.payload.dropped, 2);
  assert.equal(dropped.completeness, 'truncated');
  await session.close();

  const conflicting = new TraceProvider({
    recordingId: 'recording:s2-dropped-conflict',
    sourceProvider: 'fixture-tracer',
    sourceProviderVersion: '1',
    binaryId: 'binary:s2',
    dropped: 2,
    events: [{ kind: 'dropped-events', payload: { dropped: 3 } }],
  });
  await assert.rejects(() => conflicting.openSession({ sessionNonce: 's2-conflict' }), errorCode('trace-invalid-dropped-count'));

  assert.throws(() => new TraceProvider({
    recordingId: 'recording:s2-unbounded',
    sourceProvider: 'fixture-tracer',
    sourceProviderVersion: '1',
    binaryId: 'binary:s2',
    events: [{ kind: 'trace-marker' }, { kind: 'trace-marker' }],
  }, { maxEvents: 1 }), errorCode('resource-limit'));
});

test('S2-01 external trace module identity needs an out-of-band verifier to become exact', async () => {
  const modules = [{
    name: 'libX',
    runtimeBase: 0x1000n,
    runtimeSize: 0x100n,
    staticBase: 0x4000n,
    binaryId: 'binary:x',
    identityState: 'exact',
  }];
  const unverified = await openTraceSession({ modules });
  assert.equal(unverified.modules.get('libX').identityState, 'unresolved', 'a recording-declared exact identity is not authority');
  assert.equal(unverified.modules.resolve(0x1010n, { binaryId: 'binary:x' }).state, 'unresolved');
  await unverified.close();

  const truthyVerifier = await openTraceSession({ modules }, { verifyModuleIdentity: () => 1 });
  assert.equal(truthyVerifier.modules.get('libX').identityState, 'unresolved', 'only strict boolean true authenticates a module mapping');
  await truthyVerifier.close();

  const verified = await openTraceSession({ modules }, { verifyModuleIdentity: () => true });
  assert.equal(verified.modules.get('libX').identityState, 'exact');
  assert.equal(verified.modules.resolve(0x1010n, { binaryId: 'binary:x' }).state, 'exact');
  await verified.close();
});

test('S2-01 runtime profile promotion needs current exact proof and cannot be copied', () => {
  const binding = fixtureBinding();
  const tracker = new RuntimeAuthorityTracker(binding);
  const accepted = tracker.accept(createRuntimeObservation({
    binding, sequence: 1, observedAt: '2026-09-15T00:00:01Z', kind: 'stop', payload: { pc: '0x1000' },
  }));
  const mutation = tracker.authorizeMutation({
    actorIdentity: 'local:user', operation: 'write-memory', issuedAt: '2026-09-15T00:00:02Z', explicitApproval: true,
  });
  const runtimeReceipt = tracker.mintProfileSupportReceipt({
    observationIdentities: [accepted.observationId],
    mutationAuthorityIdentities: [mutation.token.tokenId],
    testItemIdentities: ['lifecycle', 'capability', 'module-mapping', 'stale-event', 'mutation-authority'],
  });
  const { proofs } = validatedCapabilityProofFixture();
  const providerProfileId = 'native:remote-debug-v1:qemu-lldb';
  const targetProfileId = 'arm64:a64';
  const providerCapabilities = Object.fromEntries(REQUIRED_CAPABILITIES.map((name) => [name, true]));
  const proof = {
    exactHead: true,
    headSha: binding.commitSha,
    treeSha: binding.treeSha,
    identityNegativeTests: true,
    staleEventTests: true,
    lifecycleTests: true,
    capabilityTests: true,
    moduleMappingTests: true,
    mutationAuthorityTests: true,
  };
  const support = runtimeProfileSupport({
    binding, providerProfileId, targetProfileId, providerCapabilities,
    requiredCapabilities: REQUIRED_CAPABILITIES, proof, profileProof: proofs['S2-A7-NATIVE'],
    runtimeReceipt,
  });
  assert.equal(support.status, 'supported-for-exact-provider-profile');
  assert.equal(isValidatedRuntimeProfileSupport(support), true);
  assert.equal(isValidatedRuntimeProfileSupport({ ...support }), false, 'a copied support record must lose promotion authority');
  assert.equal(runtimeProfileSupport({
    binding, providerProfileId, targetProfileId, providerCapabilities, requiredCapabilities: REQUIRED_CAPABILITIES,
    proof, profileProof: { ...proofs['S2-A7-NATIVE'] },
    runtimeReceipt,
  }).status, 'partial', 'a copied profile proof must lose promotion authority');

  for (const flag of REQUIRED_PROOF_FLAGS) {
    const supportWithMissingFlag = runtimeProfileSupport({
      binding, providerProfileId, targetProfileId, providerCapabilities,
      requiredCapabilities: REQUIRED_CAPABILITIES, proof: { ...proof, [flag]: false }, profileProof: proofs['S2-A7-NATIVE'],
      runtimeReceipt,
    });
    assert.equal(supportWithMissingFlag.status, 'partial', `missing proof flag ${flag} must not promote`);
  }
  assert.equal(runtimeProfileSupport({
    binding, providerProfileId, targetProfileId, providerCapabilities,
    requiredCapabilities: REQUIRED_CAPABILITIES, proof: { ...proof, headSha: 'e'.repeat(40) }, profileProof: proofs['S2-A7-NATIVE'],
    runtimeReceipt,
  }).reason, 'runtime-proof-stale-head');
  assert.equal(runtimeProfileSupport({
    binding, providerProfileId, targetProfileId, providerCapabilities,
    requiredCapabilities: REQUIRED_CAPABILITIES, proof: { ...proof, headSha: null }, profileProof: proofs['S2-A7-NATIVE'],
    runtimeReceipt,
  }).reason, 'runtime-proof-exact-identity-required');
  assert.equal(runtimeProfileSupport({
    binding, providerProfileId, targetProfileId,
    providerCapabilities: { ...providerCapabilities, stepInto: false },
    requiredCapabilities: REQUIRED_CAPABILITIES, proof, profileProof: proofs['S2-A7-NATIVE'],
    runtimeReceipt,
  }).status, 'partial');
  const withoutTargetProfile = fixtureBinding({ targetProfileId: undefined, architectureProfileId: undefined });
  assert.equal(withoutTargetProfile.targetProfileId, null);
  assert.equal(runtimeProfileSupport({
    binding: withoutTargetProfile, providerProfileId, targetProfileId: null, providerCapabilities,
    requiredCapabilities: REQUIRED_CAPABILITIES, proof, profileProof: proofs['S2-A7-NATIVE'],
    runtimeReceipt,
  }).reason, 'runtime-profile-identity-required', 'a binding without a locked target profile cannot promote');
  const withoutBuildIdentity = fixtureBinding({ buildIdentity: undefined, runtimeBuildIdentity: undefined });
  assert.equal(withoutBuildIdentity.buildIdentity, null);
  assert.equal(runtimeProfileSupport({
    binding: withoutBuildIdentity, providerProfileId, targetProfileId, providerCapabilities,
    requiredCapabilities: REQUIRED_CAPABILITIES, proof, profileProof: proofs['S2-A7-NATIVE'],
    runtimeReceipt,
  }).status, 'partial', 'a binding without a build identity cannot promote');
  assert.equal(runtimeProfileSupport({
    binding, providerProfileId: 'native:replay-v1:other', targetProfileId, providerCapabilities,
    requiredCapabilities: REQUIRED_CAPABILITIES, proof, profileProof: proofs['S2-A7-NATIVE'],
    runtimeReceipt,
  }).reason, 'runtime-provider-target-profile-mismatch');
  assert.throws(() => runtimeProfileSupport({
    binding, providerProfileId, targetProfileId, providerCapabilities,
    requiredCapabilities: [...REQUIRED_CAPABILITIES, 'inventedCapability'],
  }), /runtime-capability-unknown/);
});
