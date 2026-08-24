import assert from 'node:assert/strict';

import {
  A7_CROSS_TARGET_PROOF_SCHEMA,
  A7_CROSS_TARGET_PROVIDER_PROFILE,
  A7_CROSS_TARGETS,
  A7_REQUIRED_CAPABILITIES,
  A7_UNSUPPORTED_PROVIDER_CAPABILITIES,
  collectA7CrossTargetProofs,
  parseCrossTargetLldbOutput,
} from '../../tools/validation/stage2/a7-cross-target-real-fixtures.mjs';
import { A7_PROFILE_BINDINGS } from '../../tools/validation/stage2/a7-profile-contract.mjs';

const run = await collectA7CrossTargetProofs();
assert.equal(run.schemaVersion, A7_CROSS_TARGET_PROOF_SCHEMA);
assert.match(run.candidateCommitSha, /^[0-9a-f]{40}$/);
assert.match(run.candidateTreeSha, /^[0-9a-f]{40}$/);
assert.equal(run.providerProfileId, A7_CROSS_TARGET_PROVIDER_PROFILE);
assert.deepEqual(run.proofs.map((proof) => proof.targetProfileId), A7_CROSS_TARGETS.map((target) => target.targetProfileId));
for (const proof of run.proofs) {
  assert.equal(proof.status, 'exact-active-provider-observed');
  assert.equal(proof.candidateCommitSha, run.candidateCommitSha);
  assert.equal(proof.candidateTreeSha, run.candidateTreeSha);
  assert.deepEqual(proof.closedCapabilities, A7_REQUIRED_CAPABILITIES);
  assert.deepEqual(proof.unsupportedCapabilities, A7_UNSUPPORTED_PROVIDER_CAPABILITIES);
  assert.equal(proof.binding.targetProfileId, proof.targetProfileId);
  assert.equal(proof.binding.providerProfileId, A7_CROSS_TARGET_PROVIDER_PROFILE);
  assert.match(proof.fixture.sourceSha256, /^[0-9a-f]{64}$/);
  assert.match(proof.fixture.binarySha256, /^[0-9a-f]{64}$/);
  assert.match(proof.independentOracle.outputSha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(proof.fixture.semantics, [...A7_PROFILE_BINDINGS[proof.targetProfileId].semanticMarkers]);
  assert.match(proof.independentOracle.executableIdentities.readobj.path, /(?:^|\/)(?:llvm-readobj-18|llvm-readobj)$/);
  assert.match(proof.independentOracle.executableIdentities.objdump.path, /(?:^|\/)(?:llvm-objdump-18|llvm-objdump)$/);
}

const target = A7_CROSS_TARGETS[0];
assert.throws(() => parseCrossTargetLldbOutput("Current executable set to '/tmp/fixture' (x86_64).", target, { binaryPath:'/tmp/fixture', entry:0x1000n, probeWord:0x2000n }), /a7-cross-lldb-target-profile-mismatch/);
assert.throws(() => parseCrossTargetLldbOutput("Current executable set to '/tmp/fixture' (aarch64).", target, { binaryPath:'/tmp/fixture', entry:0x1000n, probeWord:0x2000n }), /a7-cross-lldb-active-process-missing/);
assert.throws(() => parseCrossTargetLldbOutput(`Current executable set to '/tmp/fixture' (aarch64).\nProcess 1 stopped\nstop reason = signal SIGTRAP\n/tmp/fixture [0]\n* thread #1: tid = 2\npc = 0x1001, sp = 0x2000\nx0 = 0x42\n0x2000: 0x1020304050607080\n0x2000: 0x8877665544332211\nBreakpoint 1: 0x1004\nstop reason = breakpoint 1.1\nstop reason = instruction step into\n1 breakpoints deleted; 0 breakpoint locations disabled.\nProcess 1 exited`, target, { binaryPath:'/tmp/fixture', entry:0x1000n, probeWord:0x2000n }), /a7-cross-lldb-register-read-missing/);

console.log(`A7_CROSS_TARGET_PROVIDER_PROOF=${JSON.stringify(run)}`);
console.log('[stage2] active AArch64/PAC/RV64 LLDB remote provider proofs passed');
