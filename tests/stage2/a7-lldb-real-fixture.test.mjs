import assert from 'node:assert/strict';
import { A7_X86_REQUIRED_CAPABILITIES, A7_X86_UNSUPPORTED_CAPABILITIES, collectA7X86LldbProof, parseLldbOutput } from '../../tools/validation/stage2/a7-lldb-real-fixture.mjs';
import { A7_PROFILE_BINDINGS } from '../../tools/validation/stage2/a7-profile-contract.mjs';
import { runtimeProfileSupport } from '../../js/runtime/authority.js';

const proof = collectA7X86LldbProof();
assert.equal(proof.status, 'exact-active-provider-observed');
assert.equal(proof.promotion, 'requires-canonical-four-profile-evidence-assembly');
assert.equal(proof.targetProfileId, 'x86_64:long-64');
assert.deepEqual(proof.closedCapabilities, A7_X86_REQUIRED_CAPABILITIES);
assert.deepEqual(proof.unsupportedCapabilities, A7_X86_UNSUPPORTED_CAPABILITIES);
assert.deepEqual(proof.fixture.semantics, [...A7_PROFILE_BINDINGS['x86_64:long-64'].semanticMarkers]);
assert.equal(proof.binding.binaryIdentity, `sha256:${proof.fixture.sha256}`);
assert.equal(proof.binding.targetProfileId, proof.targetProfileId);
assert.equal(proof.binding.providerProfileId, proof.providerProfileId);
assert.match(proof.binding.moduleIdentity, /^lldb-module:sha256:[0-9a-f]{64}:[0-9a-f]{64}$/);
assert.match(proof.binding.loadMappingIdentity, /^lldb-load:sha256:[0-9a-f]{64}:[0-9a-f]{64}$/);
assert.equal(proof.binding.commitSha, proof.candidateCommitSha);
assert.equal(proof.binding.treeSha, proof.candidateTreeSha);
assert.equal(proof.observation.bindingId, proof.binding.bindingId);
assert.ok(proof.closedChecks.includes('lldb-registers-observed'));
assert.ok(proof.closedChecks.includes('lldb-memory-read-write-observed'));
assert.match(proof.fixture.sourceSha256, /^[0-9a-f]{64}$/);
assert.match(proof.independentOracle.outputSha256, /^[0-9a-f]{64}$/);
assert.match(proof.independentOracle.executableIdentity.path, /(?:^|\/)llvm-readobj-18$/);
assert.match(proof.independentOracle.executableIdentity.sha256, /^[0-9a-f]{64}$/);
assert.equal(runtimeProfileSupport({
  binding: proof.binding,
  providerProfileId: proof.providerProfileId,
  targetProfileId: proof.targetProfileId,
  providerCapabilities: { connect: true },
  requiredCapabilities: ['connect'],
  proof: {
    exactHead: true,
    headSha: proof.candidateCommitSha,
    treeSha: proof.candidateTreeSha,
    identityNegativeTests: true,
    staleEventTests: true,
    lifecycleTests: true,
    capabilityTests: true,
    moduleMappingTests: true,
    mutationAuthorityTests: true,
  },
}).status, 'partial', 'an active provider run still requires the canonical four-profile evidence object');

assert.throws(() => parseLldbOutput('Current executable set to \'fixture\' (arm64).'), /a7-lldb-target-profile-mismatch/);
assert.throws(() => parseLldbOutput("Current executable set to '/tmp/fixture' (x86_64).\nProcess 1 launched: 'fixture' (x86-64)", { fixturePath:'/tmp/fixture' }), /a7-lldb-stop-observation-missing/);
assert.throws(() => parseLldbOutput(`Current executable set to '/tmp/fixture' (x86_64).\nProcess 1 launched: '/tmp/fixture' (x86-64)\nProcess 1 stopped\n/tmp/fixture [0]\n* thread #1: tid = 2\nrip = 0x1001, rsp = 0x2000\nrax = 0x42\n0x2000: 0x1020304050607080\n0x2000: 0x8877665544332211\nBreakpoint 1: 0x1001\nstop reason = breakpoint 1.1\nstop reason = instruction step into\n1 breakpoints deleted; 0 breakpoint locations disabled.\nProcess 1 exited with status = 9 (killed)`, { fixturePath:'/tmp/fixture', entry:0x1000n, probeWord:0x2000n }), /a7-lldb-entry-register-mismatch/);
console.log(`A7_X86_LLDB_PROVIDER_PROOF=${JSON.stringify(proof)}`);
console.log('[stage2] active x86 LLDB A7 provider proof passed; canonical evidence assembly remains required');
