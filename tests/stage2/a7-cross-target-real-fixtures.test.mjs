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
  assert.match(proof.binding.runtimeInstanceIdentity, /^qemu-user-process:\d+$/);
  assert.match(proof.binding.targetIdentity, /^qemu-user-target:.*:\d+:sha256:[0-9a-f]{64}$/);
  assert.equal(proof.observation.payload.processIdentity, proof.activeOperations.attach.processId);
  assert.equal(proof.activeOperations.attach.transport, 'gdb-remote');
  assert.equal(proof.activeOperations.pause.processId, proof.activeOperations.attach.processId);
  assert.equal(proof.activeOperations.pause.runningObserved, true);
  assert.equal(proof.activeOperations.pause.stoppedObserved, true);
  assert.equal(proof.activeOperations.pause.executionAdvanced, true);
  assert.equal(proof.activeOperations.cancel.processId, proof.activeOperations.attach.processId);
  assert.equal(proof.activeOperations.cancel.inFlightObserved, true);
  assert.equal(proof.activeOperations.cancel.interruptAccepted, true);
  assert.equal(proof.activeOperations.cancel.commandSettled, true);
  assert.equal(proof.activeOperations.cancel.settlement, 'cancelled');
  assert.equal(proof.activeOperations.cancel.lateResultRejected, true);
  assert.equal(proof.activeOperations.cancel.lateStateStable, true);
  assert.match(proof.fixture.sourceSha256, /^[0-9a-f]{64}$/);
  assert.match(proof.fixture.binarySha256, /^[0-9a-f]{64}$/);
  assert.match(proof.independentOracle.outputSha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(proof.fixture.semantics, [...A7_PROFILE_BINDINGS[proof.targetProfileId].semanticMarkers]);
  assert.match(proof.independentOracle.executableIdentities.readobj.path, /(?:^|\/)(?:llvm-readobj-18|llvm-readobj)$/);
  assert.match(proof.independentOracle.executableIdentities.objdump.path, /(?:^|\/)(?:llvm-objdump-18|llvm-objdump)$/);

  for (const [field, value, reason] of [
    ['sessionIdentity', `${proof.binding.sessionIdentity}:stale`, 'runtime-observation-sessionIdentity-mismatch'],
    ['providerIdentity', `${proof.binding.providerIdentity}:substituted`, 'runtime-observation-providerIdentity-mismatch'],
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
  const value = {
    kind:'active-provider-operations',
    attach:{ observed:true, transport:'gdb-remote', processId:1, targetTriple:'aarch64-unknown-linux-gnu', modulePath:'/tmp/fixture', threadId:2, registers:{ pc:'0x1000', sp:'0x2000', x0:'0x1' }, memoryProbe:'0x1020304050607080', state:'stopped' },
    pause:{ observed:true, runningObserved:true, stoppedObserved:true, executionAdvanced:true, processId:1, threadId:2, registers:{ pc:'0x1004', sp:'0x2000', x0:'0x10' }, state:'stopped' },
    cancel:{ observed:true, inFlightObserved:true, interruptAccepted:true, commandSettled:true, processId:1, threadId:2, settlement:'cancelled', providerDisposition:'interrupted-command', lateResultRejected:true, lateStateStable:true, registers:{ pc:'0x1008', x0:'0x20' }, state:'stopped' },
    operationResults:{ attach:true, pause:true, cancel:true },
    ...overrides,
  };
  return `A7_CROSS_ACTIVE_OPS=${JSON.stringify(value)}`;
}

assert.doesNotThrow(() => parseCrossTargetActiveOpsOutput(activeMarker(), target, { binaryPath:'/tmp/fixture', probeWord:0x2000n }));
assert.throws(() => parseCrossTargetActiveOpsOutput(activeMarker({
  attach:{ observed:true, transport:'gdb-remote', processId:1, targetTriple:'x86_64-linux-gnu', modulePath:'/tmp/fixture', threadId:2, registers:{ pc:'0x1', sp:'0x2', x0:'0x3' }, memoryProbe:'0x1020304050607080' },
}), target, { binaryPath:'/tmp/fixture', probeWord:0x2000n }), /attach-target-identity-mismatch/);
assert.throws(() => parseCrossTargetActiveOpsOutput(activeMarker({
  attach:{ observed:true, transport:'gdb-remote', processId:1, targetTriple:'aarch64-linux-gnu', modulePath:'/tmp/wrong', threadId:2, registers:{ pc:'0x1', sp:'0x2', x0:'0x3' }, memoryProbe:'0x1020304050607080' },
}), target, { binaryPath:'/tmp/fixture', probeWord:0x2000n }), /attach-module-identity-mismatch/);
assert.throws(() => parseCrossTargetActiveOpsOutput(activeMarker({ advertisedCapabilities:{ cancel:true }, cancel:{ observed:false } }), target, { binaryPath:'/tmp/fixture', probeWord:0x2000n }), /cancel-not-observed/, 'capability advertisement without active cancellation is not proof');
assert.throws(() => parseCrossTargetActiveOpsOutput(activeMarker({ cancel:{ observed:true, inFlightObserved:true, interruptAccepted:true, commandSettled:true, processId:999, threadId:2, settlement:'cancelled', providerDisposition:'interrupted-command', lateResultRejected:true, lateStateStable:true, registers:{ pc:'0x1', x0:'0x2' } } }), target, { binaryPath:'/tmp/fixture', probeWord:0x2000n }), /cancel-session-identity-mismatch/);

console.log(`A7_CROSS_TARGET_PROVIDER_PROOF=${JSON.stringify(run)}`);
console.log('[stage2] active AArch64/PAC/RV64 LLDB remote provider proofs passed');
