import assert from 'node:assert/strict';
import { collectA7X86LldbProof, parseLldbOutput } from '../../tools/validation/stage2/a7-lldb-real-fixture.mjs';
import { runtimeProfileSupport } from '../../js/runtime/authority.js';

const proof = collectA7X86LldbProof();
assert.equal(proof.status, 'bounded-x86-provider-observed');
assert.equal(proof.promotion, 'blocked-four-profile-denominator-incomplete');
assert.equal(proof.targetProfileId, 'x86_64:long-64');
assert.deepEqual(proof.uncoveredTargetProfiles, ['arm64:a64', 'arm64e:a64+pac', 'riscv64:rv64imc']);
assert.equal(proof.binding.binaryIdentity, `sha256:${proof.fixture.sha256}`);
assert.equal(proof.binding.targetProfileId, proof.targetProfileId);
assert.equal(proof.binding.providerProfileId, proof.providerProfileId);
assert.match(proof.binding.moduleIdentity, /^lldb-module:sha256:[0-9a-f]{64}:[0-9a-f]{64}$/);
assert.match(proof.binding.loadMappingIdentity, /^lldb-load:sha256:[0-9a-f]{64}:[0-9a-f]{64}$/);
assert.equal(proof.binding.commitSha, proof.candidateCommitSha);
assert.equal(proof.binding.treeSha, proof.candidateTreeSha);
assert.equal(proof.observation.bindingId, proof.binding.bindingId);
assert.ok(proof.closedChecks.includes('lldb-registers-observed'));
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
}).status, 'partial', 'one x86 provider run cannot promote the four-profile A7 denominator');

assert.throws(() => parseLldbOutput('Current executable set to \'fixture\' (arm64).'), /a7-lldb-target-profile-mismatch/);
assert.throws(() => parseLldbOutput("Current executable set to 'tests/phase5/corpus/fixtures/vertical-sysv-amd64.elf' (x86_64).\nProcess 1 launched: 'fixture' (x86-64)"), /a7-lldb-stop-observation-missing/);
console.log('[stage2] bounded x86 LLDB A7 provider proof passed; four-profile promotion remains blocked');
