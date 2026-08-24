import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  A7_CROSS_ACTIVE_OPERATION_CAPABILITIES,
  A7_CROSS_TARGET_PROOF_SCHEMA,
  A7_CROSS_TARGET_PROVIDER_PROFILE,
  A7_CROSS_TARGETS,
  A7_REQUIRED_CAPABILITIES,
  A7_UNSUPPORTED_PROVIDER_CAPABILITIES,
  collectA7CrossTargetProofs,
  parseCrossTargetActiveOpsOutput,
  parseCrossTargetLldbOutput,
} from '../../tools/validation/stage2/a7-cross-target-real-fixtures.mjs';
import { A7_PROFILE_BINDINGS } from '../../tools/validation/stage2/a7-profile-contract.mjs';
import { RuntimeAuthorityTracker, validateRuntimeObservation } from '../../js/runtime/authority.js';

const A7_RUNTIME_FIXTURE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/a7-runtime');
const previousPythonPath = process.env.PYTHONPATH;
let run;
try {
  process.env.PYTHONPATH = [A7_RUNTIME_FIXTURE_DIR, previousPythonPath].filter(Boolean).join(path.delimiter);
  run = await collectA7CrossTargetProofs();
} finally {
  if (previousPythonPath == null) delete process.env.PYTHONPATH;
  else process.env.PYTHONPATH = previousPythonPath;
}

assert.equal(run.schemaVersion, A7_CROSS_TARGET_PROOF_SCHEMA);
assert.match(run.candidateCommitSha, /^[0-9a-f]{40}$/);
assert.match(run.candidateTreeSha, /^[0-9a-f]{40}$/);
assert.equal(run.providerProfileId, A7_CROSS_TARGET_PROVIDER_PROFILE);
assert.deepEqual(A7_CROSS_ACTIVE_OPERATION_CAPABILITIES, ['attach', 'cancel', 'pause']);
assert.deepEqual(run.proofs.map((proof) => proof.targetProfileId), A7_CROSS_TARGETS.map((target) => target.targetProfileId));

for (const proof of run.proofs) {
  assert.equal(proof.status, 'exact-active-provider-observed');
  assert.equal(proof.candidateCommitSha, run.candidateCommitSha);
  assert.equal(proof.candidateTreeSha, run.candidateTreeSha);
  assert.deepEqual(proof.closedCapabilities, [...A7_REQUIRED_CAPABILITIES].sort());
  assert.deepEqual(proof.unsupportedCapabilities, A7_UNSUPPORTED_PROVIDER_CAPABILITIES);
  assert.equal(proof.binding.targetProfileId, proof.targetProfileId);
  assert.equal(proof.binding.providerProfileId, A7_CROSS_TARGET_PROVIDER_PROFILE);
  assert.match(proof.binding.runtimeInstanceIdentity, /^qemu-user-process:\d+:start:\d+$/);
  assert.match(proof.binding.targetIdentity, /^qemu-user-target:.*:\d+:sha256:[0-9a-f]{64}$/);

  const identityParts = proof.binding.runtimeInstanceIdentity.split(':');
  const qemuPid = Number(identityParts[1]);
  const qemuStartTimeTicks = Number(identityParts[3]);
  assert.ok(Number.isSafeInteger(qemuPid) && qemuPid > 0);
  assert.ok(Number.isSafeInteger(qemuStartTimeTicks) && qemuStartTimeTicks > 0);

  assert.equal(proof.observation.payload.processIdentity, proof.activeOperations.attach.processId);
  assert.equal(proof.observation.payload.qemuHostPid, qemuPid);
  assert.equal(proof.observation.payload.qemuStartTimeTicks, qemuStartTimeTicks);

  assert.equal(proof.activeOperations.attach.transport, 'gdb-remote');
  assert.equal(proof.activeOperations.attach.registerTransport, 'SBFrame');
  assert.equal(proof.activeOperations.attach.qemuHostPid, qemuPid);
  assert.equal(proof.activeOperations.attach.qemuStartTimeTicks, qemuStartTimeTicks);

  assert.equal(proof.activeOperations.pause.processId, proof.activeOperations.attach.processId);
  assert.equal(proof.activeOperations.pause.qemuHostPid, qemuPid);
  assert.equal(proof.activeOperations.pause.qemuStartTimeTicks, qemuStartTimeTicks);
  assert.equal(proof.activeOperations.pause.continueAccepted, true);
  assert.equal(proof.activeOperations.pause.interruptIssued, true);
  assert.equal(proof.activeOperations.pause.runningObserved, true);
  assert.equal(proof.activeOperations.pause.runningEvidence, 'provider-running-state-event+exact-qemu-cpu-progress+lldb-stop-id');
  assert.equal(proof.activeOperations.pause.executionEvidence, 'exact-qemu-process-cpu-ticks-during-provider-running-window');
  assert.equal(proof.activeOperations.pause.executionWindow, 'after-running-event-before-interrupt');
  assert.equal(proof.activeOperations.pause.progressTransport, 'linux-proc-stat+lldb-process-events');
  assert.equal(proof.activeOperations.pause.providerDisposition, 'qemu-user-sigint-observed-by-lldb');
  assert.equal(proof.activeOperations.pause.stoppedObserved, true);
  assert.equal(proof.activeOperations.pause.executionAdvanced, true);
  assert.ok(proof.activeOperations.pause.qemuCpuTicksAfter > proof.activeOperations.pause.qemuCpuTicksBefore);
  assert.equal(proof.activeOperations.pause.stopIdAdvanced, true);
  assert.ok(proof.activeOperations.pause.stopIdAfter > proof.activeOperations.pause.stopIdBefore);
  assert.equal(proof.activeOperations.pause.modulePath, proof.activeOperations.attach.modulePath);
  assert.equal(Object.prototype.hasOwnProperty.call(proof.activeOperations.pause, 'memoryProbe'), false, 'pause proof must not pretend QEMU supports post-SIGINT memory reads');

  assert.equal(proof.activeOperations.cancel.processId, proof.activeOperations.attach.processId);
  assert.equal(proof.activeOperations.cancel.qemuHostPid, qemuPid);
  assert.equal(proof.activeOperations.cancel.qemuStartTimeTicks, qemuStartTimeTicks);
  assert.equal(proof.activeOperations.cancel.inFlightObserved, true);
  assert.equal(proof.activeOperations.cancel.inFlightEvidence, 'provider-running-state-event+exact-qemu-cpu-progress-before-cancel');
  assert.equal(proof.activeOperations.cancel.continueAccepted, true);
  assert.equal(proof.activeOperations.cancel.runningObserved, true);
  assert.equal(proof.activeOperations.cancel.executionAdvanced, true);
  assert.equal(proof.activeOperations.cancel.executionEvidence, 'exact-qemu-process-cpu-ticks-during-provider-running-window');
  assert.equal(proof.activeOperations.cancel.executionWindow, 'after-running-event-before-cancel-interrupt');
  assert.ok(proof.activeOperations.cancel.qemuCpuTicksAfter > proof.activeOperations.cancel.qemuCpuTicksBefore);
  assert.equal(proof.activeOperations.cancel.interruptIssued, true);
  assert.equal(proof.activeOperations.cancel.operationSettled, true);
  assert.equal(proof.activeOperations.cancel.executionSettled, true);
  assert.equal(proof.activeOperations.cancel.stopIdAdvanced, true);
  assert.ok(proof.activeOperations.cancel.stopIdAfter > proof.activeOperations.cancel.stopIdBefore);
  assert.equal(proof.activeOperations.cancel.settlement, 'cancelled');
  assert.equal(proof.activeOperations.cancel.providerDisposition, 'qemu-user-sigint-observed-by-lldb');
  assert.equal(proof.activeOperations.cancel.progressTransport, 'linux-proc-stat+lldb-running-and-stop-events');
  assert.equal(proof.activeOperations.cancel.modulePath, proof.activeOperations.attach.modulePath);
  assert.equal(Object.prototype.hasOwnProperty.call(proof.activeOperations.cancel, 'memoryProbe'), false, 'cancel proof must not pretend QEMU supports post-SIGINT memory reads');
  assert.equal(proof.activeOperations.cancel.lateSuccessRejected, true);
  assert.equal(proof.activeOperations.cancel.lateStateStable, true);
  assert.equal(proof.activeOperations.cancel.lateStopIdStable, true);
  assert.equal(proof.activeOperations.cancel.lateQemuInstanceStable, true);

  assert.match(proof.fixture.sourceSha256, /^[0-9a-f]{64}$/);
  assert.match(proof.fixture.binarySha256, /^[0-9a-f]{64}$/);
  assert.match(proof.independentOracle.outputSha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(proof.fixture.semantics, [...A7_PROFILE_BINDINGS[proof.targetProfileId].semanticMarkers]);
  assert.match(proof.independentOracle.executableIdentities.readobj.path, /(?:^|\/)(?:llvm-readobj-18|llvm-readobj)$/);
  assert.match(proof.independentOracle.executableIdentities.objdump.path, /(?:^|\/)(?:llvm-objdump-18|llvm-objdump)$/);

  for (const [field, value, reason] of [
    ['sessionIdentity', `${proof.binding.sessionIdentity}:stale`, 'runtime-observation-sessionIdentity-mismatch'],
    ['providerIdentity', `${proof.binding.providerIdentity}:substituted`, 'runtime-observation-providerIdentity-mismatch'],
    ['runtimeInstanceIdentity', `${proof.binding.runtimeInstanceIdentity}:reused`, 'runtime-observation-runtimeInstanceIdentity-mismatch'],
    ['binaryIdentity', 'sha256:' + 'f'.repeat(64), 'runtime-observation-binaryIdentity-mismatch'],
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
  const replacement = tracker.nextEpoch({ sessionIdentity:`${proof.binding.sessionIdentity}:replacement` });
  assert.equal(validateRuntimeObservation(replacement, proof.observation).ok, false);
}

const target = A7_CROSS_TARGETS[0];
assert.throws(() => parseCrossTargetLldbOutput("Current executable set to '/tmp/fixture' (x86_64).", target, { binaryPath:'/tmp/fixture', entry:0x1000n, probeWord:0x2000n }), /a7-cross-lldb-target-profile-mismatch/);
assert.throws(() => parseCrossTargetLldbOutput("Current executable set to '/tmp/fixture' (aarch64).", target, { binaryPath:'/tmp/fixture', entry:0x1000n, probeWord:0x2000n }), /a7-cross-lldb-active-process-missing/);
assert.throws(() => parseCrossTargetLldbOutput(`Current executable set to '/tmp/fixture' (aarch64).\nProcess 1 stopped\nstop reason = signal SIGTRAP\n/tmp/fixture [0]\n* thread #1: tid = 2\npc = 0x1001, sp = 0x2000\nx0 = 0x42\n0x2000: 0x1020304050607080\n0x2000: 0x8877665544332211\nBreakpoint 1: 0x1004\nstop reason = breakpoint 1.1\nstop reason = instruction step into\n1 breakpoints deleted; 0 breakpoint locations disabled.\nProcess 1 exited`, target, { binaryPath:'/tmp/fixture', entry:0x1000n, probeWord:0x2000n }), /a7-cross-lldb-register-read-missing/);

function activeMarker(overrides = {}) {
  const attach = {
    observed:true,
    transport:'gdb-remote',
    registerTransport:'SBFrame',
    processId:1,
    qemuHostPid:10,
    qemuStartTimeTicks:1000,
    qemuCpuTicks:1,
    targetTriple:'aarch64-unknown-linux-gnu',
    modulePath:'/tmp/fixture',
    threadId:2,
    registers:{ pc:'0x1000', sp:'0x2000', x0:'0x1' },
    memoryProbe:'0x1020304050607080',
    state:'stopped',
    ...(overrides.attach || {}),
  };

  const pause = {
    observed:true,
    continueAccepted:true,
    interruptIssued:true,
    runningObserved:true,
    runningEvidence:'provider-running-state-event+exact-qemu-cpu-progress+lldb-stop-id',
    executionAdvanced:true,
    executionEvidence:'exact-qemu-process-cpu-ticks-during-provider-running-window',
    executionWindow:'after-running-event-before-interrupt',
    progressTransport:'linux-proc-stat+lldb-process-events',
    providerDisposition:'qemu-user-sigint-observed-by-lldb',
    stoppedObserved:true,
    stopIdAdvanced:true,
    stopIdBefore:1,
    stopIdAfter:2,
    processId:1,
    qemuHostPid:10,
    qemuStartTimeTicks:1000,
    qemuCpuTicksBefore:1,
    qemuCpuTicksAfter:3,
    modulePath:'/tmp/fixture',
    state:'stopped',
    ...(overrides.pause || {}),
  };

  const cancel = {
    observed:true,
    inFlightObserved:true,
    inFlightEvidence:'provider-running-state-event+exact-qemu-cpu-progress-before-cancel',
    continueAccepted:true,
    runningObserved:true,
    executionAdvanced:true,
    executionEvidence:'exact-qemu-process-cpu-ticks-during-provider-running-window',
    executionWindow:'after-running-event-before-cancel-interrupt',
    interruptIssued:true,
    operationSettled:true,
    executionSettled:true,
    stopIdAdvanced:true,
    stopIdBefore:2,
    stopIdAfter:3,
    processId:1,
    qemuHostPid:10,
    qemuStartTimeTicks:1000,
    qemuCpuTicksBefore:3,
    qemuCpuTicksAfter:5,
    settlement:'cancelled',
    providerDisposition:'qemu-user-sigint-observed-by-lldb',
    progressTransport:'linux-proc-stat+lldb-running-and-stop-events',
    modulePath:'/tmp/fixture',
    lateSuccessRejected:true,
    lateStateStable:true,
    lateStopIdStable:true,
    lateQemuInstanceStable:true,
    state:'stopped',
    ...(overrides.cancel || {}),
  };

  const value = {
    kind:'active-provider-operations',
    attach,
    pause,
    cancel,
    operationResults:{ attach:true, pause:true, cancel:true },
  };
  for (const [key, item] of Object.entries(overrides)) {
    if (key !== 'attach' && key !== 'pause' && key !== 'cancel') value[key] = item;
  }
  return `A7_CROSS_ACTIVE_OPS=${JSON.stringify(value)}`;
}

const activeOptions = { binaryPath:'/tmp/fixture', probeWord:0x2000n, qemuPid:10 };
assert.doesNotThrow(() => parseCrossTargetActiveOpsOutput(activeMarker(), target, activeOptions));
assert.throws(() => parseCrossTargetActiveOpsOutput(activeMarker({ attach:{ targetTriple:'x86_64-linux-gnu' } }), target, activeOptions), /attach-target-identity-mismatch/);
assert.throws(() => parseCrossTargetActiveOpsOutput(activeMarker({ attach:{ modulePath:'/tmp/wrong' } }), target, activeOptions), /attach-module-identity-mismatch/);
assert.throws(() => parseCrossTargetActiveOpsOutput(activeMarker({ attach:{ qemuHostPid:11 } }), target, activeOptions), /attach-qemu-identity-mismatch/);
assert.throws(() => parseCrossTargetActiveOpsOutput(activeMarker({ attach:{ qemuStartTimeTicks:0 } }), target, activeOptions), /attach-qemu-instance-identity-missing/);
assert.throws(() => parseCrossTargetActiveOpsOutput(activeMarker({ advertisedCapabilities:{ cancel:true }, cancel:{ observed:false } }), target, activeOptions), /cancel-not-observed/, 'capability advertisement without active cancellation is not proof');
assert.throws(() => parseCrossTargetActiveOpsOutput(activeMarker({ cancel:{ processId:999 } }), target, activeOptions), /cancel-session-identity-mismatch/);
assert.throws(() => parseCrossTargetActiveOpsOutput(activeMarker({ pause:{ runningEvidence:'static-capability-flag' } }), target, activeOptions), /pause-running-evidence-missing/);
assert.throws(() => parseCrossTargetActiveOpsOutput(activeMarker({ pause:{ qemuHostPid:11 } }), target, activeOptions), /pause-qemu-identity-mismatch/);
assert.throws(() => parseCrossTargetActiveOpsOutput(activeMarker({ pause:{ qemuStartTimeTicks:1001 } }), target, activeOptions), /pause-qemu-instance-identity-mismatch/);
assert.throws(() => parseCrossTargetActiveOpsOutput(activeMarker({ pause:{ qemuCpuTicksAfter:1 } }), target, activeOptions), /pause-execution-progress-missing/, 'running state without measured QEMU execution progress cannot prove pause');
assert.throws(() => parseCrossTargetActiveOpsOutput(activeMarker({ pause:{ executionWindow:'after-interrupt' } }), target, activeOptions), /pause-running-evidence-missing/, 'post-interrupt CPU work cannot stand in for provider-running execution');
assert.throws(() => parseCrossTargetActiveOpsOutput(activeMarker({ cancel:{ runningObserved:false } }), target, activeOptions), /cancel-not-observed/, 'cancel requires a real provider-running interval');
assert.throws(() => parseCrossTargetActiveOpsOutput(activeMarker({ cancel:{ operationSettled:false } }), target, activeOptions), /cancel-settlement-missing/, 'unsettled qemu-backed execution cannot prove cancel');
assert.throws(() => parseCrossTargetActiveOpsOutput(activeMarker({ cancel:{ executionSettled:false } }), target, activeOptions), /cancel-settlement-missing/, 'cancel must settle the active execution');
assert.throws(() => parseCrossTargetActiveOpsOutput(activeMarker({ cancel:{ inFlightEvidence:'static-capability-flag' } }), target, activeOptions), /cancel-inflight-evidence-missing/, 'capability advertisement cannot substitute for an in-flight provider operation');
assert.throws(() => parseCrossTargetActiveOpsOutput(activeMarker({ cancel:{ qemuHostPid:11 } }), target, activeOptions), /cancel-qemu-identity-mismatch/);
assert.throws(() => parseCrossTargetActiveOpsOutput(activeMarker({ cancel:{ qemuStartTimeTicks:1001 } }), target, activeOptions), /cancel-qemu-instance-identity-mismatch/);
assert.throws(() => parseCrossTargetActiveOpsOutput(activeMarker({ cancel:{ qemuCpuTicksAfter:3 } }), target, activeOptions), /cancel-execution-progress-missing/, 'settlement without measured QEMU execution progress cannot prove cancel');
assert.throws(() => parseCrossTargetActiveOpsOutput(activeMarker({ cancel:{ executionWindow:'after-interrupt' } }), target, activeOptions), /cancel-settlement-missing/, 'post-interrupt CPU work cannot stand in for an in-flight cancellation');
assert.throws(() => parseCrossTargetActiveOpsOutput(activeMarker({ cancel:{ lateSuccessRejected:false } }), target, activeOptions), /cancel-settlement-missing/, 'late success invalidates cancellation settlement');
assert.throws(() => parseCrossTargetActiveOpsOutput(activeMarker({ cancel:{ lateStopIdStable:false } }), target, activeOptions), /cancel-settlement-missing/, 'late stop-ID movement invalidates cancellation settlement');
assert.throws(() => parseCrossTargetActiveOpsOutput(activeMarker({ cancel:{ lateQemuInstanceStable:false } }), target, activeOptions), /cancel-settlement-missing/, 'QEMU instance replacement invalidates cancellation settlement');

console.log(`A7_CROSS_TARGET_PROVIDER_PROOF=${JSON.stringify(run)}`);
console.log('[stage2] active AArch64/PAC/RV64 LLDB remote provider proofs passed');
