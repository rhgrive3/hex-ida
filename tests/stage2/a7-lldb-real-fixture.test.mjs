import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  A7_X86_ACTIVE_OPERATION_CAPABILITIES,
  A7_X86_REQUIRED_CAPABILITIES,
  A7_X86_UNSUPPORTED_CAPABILITIES,
  collectA7X86LldbProof,
  parseLldbActiveOpsOutput,
  parseLldbOutput,
} from '../../tools/validation/stage2/a7-lldb-real-fixture.mjs';
import { A7_PROFILE_BINDINGS } from '../../tools/validation/stage2/a7-profile-contract.mjs';
import { RuntimeAuthorityTracker, runtimeProfileSupport, validateRuntimeObservation } from '../../js/runtime/authority.js';
import { RUNTIME_PROVIDER_PROTOCOL, RUNTIME_PROVIDER_PROTOCOL_VERSION, RuntimeProviderProtocolClient } from '../../js/runtime/provider-protocol.js';

const A7_RUNTIME_FIXTURE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/a7-runtime');
const previousPythonPath = process.env.PYTHONPATH;
let proof;
try {
  process.env.PYTHONPATH = [A7_RUNTIME_FIXTURE_DIR, previousPythonPath].filter(Boolean).join(path.delimiter);
  proof = collectA7X86LldbProof();
} finally {
  if (previousPythonPath == null) delete process.env.PYTHONPATH;
  else process.env.PYTHONPATH = previousPythonPath;
}

assert.equal(proof.status, 'exact-active-provider-observed');
assert.equal(proof.promotion, 'requires-canonical-four-profile-evidence-assembly');
assert.equal(proof.targetProfileId, 'x86_64:long-64');
assert.deepEqual(proof.closedCapabilities, [...A7_X86_REQUIRED_CAPABILITIES].sort());
assert.deepEqual(proof.unsupportedCapabilities, A7_X86_UNSUPPORTED_CAPABILITIES);
assert.deepEqual(A7_X86_ACTIVE_OPERATION_CAPABILITIES, ['attach', 'cancel', 'pause']);
assert.deepEqual(proof.fixture.semantics, [...A7_PROFILE_BINDINGS['x86_64:long-64'].semanticMarkers]);
assert.equal(proof.binding.binaryIdentity, `sha256:${proof.fixture.sha256}`);
assert.equal(proof.binding.targetProfileId, proof.targetProfileId);
assert.equal(proof.binding.providerProfileId, proof.providerProfileId);
assert.match(proof.binding.runtimeInstanceIdentity, /^a7-provider-operation-set:[0-9a-f]{64}$/);
assert.match(proof.binding.targetIdentity, /^a7-target-operation-set:x86_64:long-64:sha256:[0-9a-f]{64}$/);
assert.match(proof.binding.moduleIdentity, /^lldb-module-set:sha256:[0-9a-f]{64}:[0-9a-f]{64}$/);
assert.match(proof.binding.loadMappingIdentity, /^lldb-load-set:sha256:[0-9a-f]{64}:entry-0x[0-9a-f]+:probe-0x[0-9a-f]+$/);
assert.equal(proof.binding.commitSha, proof.candidateCommitSha);
assert.equal(proof.binding.treeSha, proof.candidateTreeSha);
assert.equal(proof.observation.bindingId, proof.binding.bindingId);
assert.equal(proof.observation.payload.operationBindingIds.pause, proof.operationBindings.pause.bindingId);
assert.equal(proof.observation.payload.operationBindingIds.cancel, proof.operationBindings.cancel.bindingId);
assert.notEqual(proof.operationBindings.pause.bindingId, proof.operationBindings.cancel.bindingId);
assert.equal(validateRuntimeObservation(proof.operationBindings.pause, proof.operationObservations.pause).ok, true);
assert.equal(validateRuntimeObservation(proof.operationBindings.cancel, proof.operationObservations.cancel).ok, true);

const pauseAttach = proof.activeOperations.attach;
const cancelAttach = proof.activeOperations.cancelAttach;
assert.equal(pauseAttach.requestedPid, pauseAttach.attachedPid);
assert.equal(cancelAttach.requestedPid, cancelAttach.attachedPid);
assert.notDeepEqual(
  [pauseAttach.attachedPid, pauseAttach.processStartTimeTicks],
  [cancelAttach.attachedPid, cancelAttach.processStartTimeTicks],
  'pause and cancel must be proven on independent real process instances',
);
assert.equal(path.resolve(cancelAttach.modulePath), path.resolve(pauseAttach.modulePath));
assert.equal(cancelAttach.targetTriple, pauseAttach.targetTriple);
assert.equal(proof.activeOperations.pause.processId, pauseAttach.attachedPid);
assert.equal(proof.activeOperations.pause.processStartTimeTicks, pauseAttach.processStartTimeTicks);
assert.equal(proof.activeOperations.pause.continueAccepted, true);
assert.equal(proof.activeOperations.pause.stopAccepted, true);
assert.equal(proof.activeOperations.pause.runningObserved, true);
assert.equal(proof.activeOperations.pause.runningEvidence, 'exact-host-process-cpu-progress+lldb-stop-id');
assert.equal(proof.activeOperations.pause.executionEvidence, 'exact-host-process-cpu-ticks-during-provider-running-window');
assert.equal(proof.activeOperations.pause.stoppedObserved, true);
assert.equal(proof.activeOperations.pause.executionAdvanced, true);
assert.equal(proof.activeOperations.pause.stopIdAdvanced, true);
assert.ok(proof.activeOperations.pause.cpuTicksAfter > proof.activeOperations.pause.cpuTicksBefore);
assert.ok(proof.activeOperations.pause.stopIdAfter > proof.activeOperations.pause.stopIdBefore);
assert.equal(proof.activeOperations.cancel.processId, cancelAttach.attachedPid);
assert.equal(proof.activeOperations.cancel.processStartTimeTicks, cancelAttach.processStartTimeTicks);
assert.equal(proof.activeOperations.cancel.continueAccepted, true);
assert.equal(proof.activeOperations.cancel.inFlightObserved, true);
assert.equal(proof.activeOperations.cancel.inFlightEvidence, 'async-continue+exact-host-process-cpu-progress-before-cancel');
assert.equal(proof.activeOperations.cancel.executionEvidence, 'exact-host-process-cpu-ticks-during-provider-running-window');
assert.equal(proof.activeOperations.cancel.executionAdvanced, true);
assert.equal(proof.activeOperations.cancel.interruptAccepted, true);
assert.equal(proof.activeOperations.cancel.operationSettled, true);
assert.equal(proof.activeOperations.cancel.stopIdAdvanced, true);
assert.ok(proof.activeOperations.cancel.cpuTicksAfter > proof.activeOperations.cancel.cpuTicksBefore);
assert.ok(proof.activeOperations.cancel.stopIdAfter > proof.activeOperations.cancel.stopIdBefore);
assert.equal(proof.activeOperations.cancel.settlement, 'cancelled');
assert.equal(proof.activeOperations.cancel.providerDisposition, 'lldb-async-interrupt-observed');
assert.equal(proof.activeOperations.cancel.lateResultRejected, true);
assert.equal(proof.activeOperations.cancel.lateStateStable, true);
assert.equal(proof.activeOperations.cancel.lateStopIdStable, true);
assert.equal(proof.activeOperations.cancel.lateProcessInstanceStable, true);
assert.ok(proof.closedChecks.includes('lldb-real-process-attach-observed'));
assert.ok(proof.closedChecks.includes('lldb-running-target-pause-observed'));
assert.ok(proof.closedChecks.includes('lldb-independent-cancel-session-observed'));
assert.ok(proof.closedChecks.includes('lldb-active-process-cancel-observed'));
assert.ok(proof.closedChecks.includes('lldb-cancel-operation-settled'));
assert.match(proof.fixture.sourceSha256, /^[0-9a-f]{64}$/);
assert.match(proof.independentOracle.outputSha256, /^[0-9a-f]{64}$/);
assert.match(proof.independentOracle.executableIdentity.path, /(?:^|\/)(?:llvm-readobj-18|llvm-readobj)$/);
assert.match(proof.independentOracle.executableIdentity.sha256, /^[0-9a-f]{64}$/);
assert.equal(runtimeProfileSupport({
  binding:proof.binding,
  providerProfileId:proof.providerProfileId,
  targetProfileId:proof.targetProfileId,
  providerCapabilities:proof.observation.payload.observedCapabilities,
  requiredCapabilities:A7_X86_REQUIRED_CAPABILITIES,
  proof:{ exactHead:true, headSha:proof.candidateCommitSha, treeSha:proof.candidateTreeSha, identityNegativeTests:true, staleEventTests:true, lifecycleTests:true, capabilityTests:true, moduleMappingTests:true, mutationAuthorityTests:true },
}).status, 'partial', 'an active provider run still requires the canonical four-profile evidence object');

assert.throws(() => parseLldbOutput("Current executable set to 'fixture' (arm64)."), /a7-lldb-target-profile-mismatch/);
assert.throws(() => parseLldbOutput("Current executable set to '/tmp/fixture' (x86_64).\nProcess 1 launched: 'fixture' (x86-64)", { fixturePath:'/tmp/fixture' }), /a7-lldb-stop-observation-missing/);
assert.throws(() => parseLldbOutput(`Current executable set to '/tmp/fixture' (x86_64).\nProcess 1 launched: '/tmp/fixture' (x86-64)\nProcess 1 stopped\n/tmp/fixture [0]\n* thread #1: tid = 2\nrip = 0x1001, rsp = 0x2000\nrax = 0x42\n0x2000: 0x1020304050607080\n0x2000: 0x8877665544332211\nBreakpoint 1: 0x1001\nstop reason = breakpoint 1.1\nstop reason = instruction step into\n1 breakpoints deleted; 0 breakpoint locations disabled.\nProcess 1 exited with status = 9 (killed)`, { fixturePath:'/tmp/fixture', entry:0x1000n, probeWord:0x2000n }), /a7-lldb-entry-register-mismatch/);

function attach(pid, start = 4242, modulePath = '/tmp/fixture') {
  return { observed:true, requestedPid:pid, attachedPid:pid, processStartTimeTicks:start, targetTriple:'x86_64-unknown-linux-gnu', modulePath, threadId:7, registers:{ rip:'0x1000', rsp:'0x2000', rax:'0x1' }, memoryProbe:'0x1020304050607080', state:'stopped' };
}
function activeMarker(overrides = {}) {
  const value = {
    kind:'active-provider-operation-set',
    attach:attach(101, 4242),
    pause:{ observed:true, continueAccepted:true, stopAccepted:true, runningObserved:true, runningEvidence:'exact-host-process-cpu-progress+lldb-stop-id', executionEvidence:'exact-host-process-cpu-ticks-during-provider-running-window', executionWindow:'after-continue-before-interrupt', progressTransport:'linux-proc-stat+lldb-stop-id', stoppedObserved:true, executionAdvanced:true, interruptIssued:true, processId:101, cpuTicksBefore:1, cpuTicksAfter:2, processStartTimeTicks:4242, stopIdBefore:1, stopIdAfter:2, stopIdAdvanced:true, state:'stopped' },
    cancelAttach:attach(202, 5252),
    cancel:{ observed:true, inFlightObserved:true, continueAccepted:true, inFlightEvidence:'async-continue+exact-host-process-cpu-progress-before-cancel', executionEvidence:'exact-host-process-cpu-ticks-during-provider-running-window', executionWindow:'after-continue-before-cancel-interrupt', progressTransport:'linux-proc-stat+lldb-stop-id', executionAdvanced:true, interruptAccepted:true, operationSettled:true, processId:202, cpuTicksBefore:2, cpuTicksAfter:3, processStartTimeTicks:5252, stopIdBefore:1, stopIdAfter:2, stopIdAdvanced:true, settlement:'cancelled', providerDisposition:'lldb-async-interrupt-observed', lateResultRejected:true, lateStateStable:true, lateStopIdStable:true, lateProcessInstanceStable:true, state:'stopped' },
    operationResults:{ attach:true, pause:true, cancel:true },
    ...overrides,
  };
  return `A7_LLDB_ACTIVE_OPS=${JSON.stringify(value)}`;
}

assert.doesNotThrow(() => parseLldbActiveOpsOutput(activeMarker(), { fixturePath:'/tmp/fixture', probeWord:0x2000n }));
assert.throws(() => parseLldbActiveOpsOutput(activeMarker({ attach:{ ...attach(101), attachedPid:202 } }), { fixturePath:'/tmp/fixture', probeWord:0x2000n }), /pause-attach-process-identity-mismatch/);
assert.throws(() => parseLldbActiveOpsOutput(activeMarker({ attach:attach(101, 4242, '/tmp/wrong') }), { fixturePath:'/tmp/fixture', probeWord:0x2000n }), /pause-attach-module-identity-mismatch/);
assert.throws(() => parseLldbActiveOpsOutput(activeMarker({ pause:{ observed:false } }), { fixturePath:'/tmp/fixture', probeWord:0x2000n }), /pause-not-observed/, 'advertising pause without a real observation must not close the denominator');
assert.throws(() => parseLldbActiveOpsOutput(activeMarker({ cancel:{ ...JSON.parse(activeMarker().slice('A7_LLDB_ACTIVE_OPS='.length)).cancel, operationSettled:false } }), { fixturePath:'/tmp/fixture', probeWord:0x2000n }), /cancel-settlement-missing/);
assert.throws(() => parseLldbActiveOpsOutput(activeMarker({ pause:{ ...JSON.parse(activeMarker().slice('A7_LLDB_ACTIVE_OPS='.length)).pause, runningEvidence:'static-capability-flag' } }), { fixturePath:'/tmp/fixture', probeWord:0x2000n }), /pause-running-evidence-missing/);
assert.throws(() => parseLldbActiveOpsOutput(activeMarker({ pause:{ ...JSON.parse(activeMarker().slice('A7_LLDB_ACTIVE_OPS='.length)).pause, cpuTicksAfter:1 } }), { fixturePath:'/tmp/fixture', probeWord:0x2000n }), /pause-process-progress-evidence-missing/);
assert.throws(() => parseLldbActiveOpsOutput(activeMarker({ cancel:{ ...JSON.parse(activeMarker().slice('A7_LLDB_ACTIVE_OPS='.length)).cancel, stopIdAfter:1 } }), { fixturePath:'/tmp/fixture', probeWord:0x2000n }), /cancel-stop-id-evidence-missing/);
assert.throws(() => parseLldbActiveOpsOutput(activeMarker({ cancelAttach:attach(101, 4242), cancel:{ ...JSON.parse(activeMarker().slice('A7_LLDB_ACTIVE_OPS='.length)).cancel, processId:101, processStartTimeTicks:4242 } }), { fixturePath:'/tmp/fixture', probeWord:0x2000n }), /operation-set-runtime-not-independent/);

for (const [field, value, reason] of [
  ['sessionIdentity', `${proof.binding.sessionIdentity}:stale`, 'runtime-observation-sessionIdentity-mismatch'],
  ['providerIdentity', `${proof.binding.providerIdentity}:substituted`, 'runtime-observation-providerIdentity-mismatch'],
  ['binaryIdentity', 'sha256:' + '0'.repeat(64), 'runtime-observation-binaryIdentity-mismatch'],
  ['moduleIdentity', `${proof.binding.moduleIdentity}:wrong`, 'runtime-observation-moduleIdentity-mismatch'],
  ['epoch', proof.binding.epoch + 1, 'runtime-observation-epoch-mismatch'],
]) {
  const checked = validateRuntimeObservation(proof.binding, { ...proof.observation, [field]:value });
  assert.equal(checked.ok, false);
  assert.equal(checked.reason, reason);
}
const tracker = new RuntimeAuthorityTracker(proof.binding);
assert.equal(tracker.accept(proof.observation).status, 'accepted');
assert.equal(tracker.accept(proof.observation).reason, 'runtime-observation-stale-sequence');
const nextBinding = tracker.nextEpoch({ sessionIdentity:`${proof.binding.sessionIdentity}:next-launch` });
assert.notEqual(nextBinding.bindingId, proof.binding.bindingId);
assert.equal(validateRuntimeObservation(nextBinding, proof.observation).ok, false, 'operation-set observations from the old proof epoch cannot cross a launch epoch');

class MemoryTransport {
  constructor() { this.sent = []; this.listener = null; this.closed = false; }
  async send(packet) { this.sent.push(packet); }
  onMessage(listener) { this.listener = listener; return () => { this.listener = null; }; }
  close() { this.closed = true; }
}

{
  const transport = new MemoryTransport();
  const client = new RuntimeProviderProtocolClient(transport, { timeoutMs:1000 });
  const pending = client.request('debugger.pause', {}, { facet:'debugger' });
  await Promise.resolve();
  const request = transport.sent.find((packet) => packet.type === 'request');
  client.close('fixture-disconnect');
  await assert.rejects(pending, (error) => error?.code === 'disconnected');
  assert.equal(client.pending.size, 0, 'disconnect must settle pending operation ownership');
  assert.equal(client.receive({ protocol:RUNTIME_PROVIDER_PROTOCOL, version:RUNTIME_PROVIDER_PROTOCOL_VERSION, type:'response', id:request.id, epoch:1, result:{ late:true } }), false);
}
{
  const transport = new MemoryTransport();
  const client = new RuntimeProviderProtocolClient(transport, { timeoutMs:1000 });
  const controller = new AbortController();
  const pending = client.request('debugger.resume', {}, { facet:'debugger', signal:controller.signal });
  await Promise.resolve();
  const request = transport.sent.find((packet) => packet.type === 'request');
  controller.abort('fixture-cancel');
  await assert.rejects(pending, (error) => error?.code === 'cancelled');
  assert.equal(client.pending.size, 0, 'cancel must settle pending operation ownership');
  assert.equal(transport.sent.some((packet) => packet.type === 'cancel' && packet.id === request.id), true);
  assert.equal(client.receive({ protocol:RUNTIME_PROVIDER_PROTOCOL, version:RUNTIME_PROVIDER_PROTOCOL_VERSION, type:'response', id:request.id, epoch:1, result:{ late:true } }), false);
}
{
  const transport = new MemoryTransport();
  const client = new RuntimeProviderProtocolClient(transport, { timeoutMs:1000 });
  const pending = client.request('debugger.readRegisters', {}, { facet:'debugger' });
  await Promise.resolve();
  const request = transport.sent.find((packet) => packet.type === 'request');
  client.setEpoch(2);
  await assert.rejects(pending, (error) => error?.code === 'cancelled');
  assert.equal(client.pending.size, 0, 'epoch rotation must settle old operation ownership');
  assert.equal(client.receive({ protocol:RUNTIME_PROVIDER_PROTOCOL, version:RUNTIME_PROVIDER_PROTOCOL_VERSION, type:'response', id:request.id, epoch:1, result:{ stale:true } }), false);
  client.close();
}

console.log(`A7_X86_LLDB_PROVIDER_PROOF=${JSON.stringify(proof)}`);
console.log('[stage2] independent active x86 LLDB A7 pause/cancel proofs passed; canonical evidence assembly remains required');
