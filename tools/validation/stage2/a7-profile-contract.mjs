/*
 * Immutable A7 target/provider contract.
 *
 * The real-provider runners are evidence producers.  Their target labels,
 * fixture paths, provider commands, and fixture bytes must therefore be
 * checked against one canonical table instead of being inferred from the
 * runner's mutable target list or from generated evidence.
 */

export const A7_PROFILE_BINDINGS = Object.freeze({
  'arm64:a64': Object.freeze({
    sourcePath: 'tests/stage2/fixtures/a7-runtime/aarch64-a64.S',
    sourceSha256: 'e9a8f237e5b10347ff3b720852e31fa29c192a140fa5aee65d27fd15186bf580',
    targetTriple: 'aarch64-linux-gnu',
    providerProfileId: 'native:remote-debug-v1:qemu-lldb',
    providerProofCommandId: 'a7-cross-target-real-fixtures',
    semanticMarkers: Object.freeze(['add x0, x0, #1', '0x1020304050607080']),
  }),
  'arm64e:a64+pac': Object.freeze({
    sourcePath: 'tests/stage2/fixtures/a7-runtime/aarch64-pac.S',
    sourceSha256: 'fccaf4081afdae0c0bf37352b4f32f7684bf77562aee64b438b78e76baee9ae1',
    targetTriple: 'aarch64-linux-gnu',
    providerProfileId: 'native:remote-debug-v1:qemu-lldb',
    providerProofCommandId: 'a7-cross-target-real-fixtures',
    semanticMarkers: Object.freeze(['paciasp', 'autiasp', 'add x0, x0, #1', '0x1020304050607080']),
  }),
  'x86_64:long-64': Object.freeze({
    sourcePath: 'tests/stage2/fixtures/a7-runtime/x86_64-long64.S',
    sourceSha256: 'b041ca268e351174c497c42647afbb600c39bc8b043b00c08e83163367671b30',
    targetTriple: 'x86_64-linux-gnu',
    providerProfileId: 'native:lldb-compatible-v1:host',
    providerProofCommandId: 'a7-lldb-real-fixture',
    semanticMarkers: Object.freeze(['inc %rax', '0x1020304050607080']),
  }),
  'riscv64:rv64imc': Object.freeze({
    sourcePath: 'tests/stage2/fixtures/a7-runtime/riscv64-rv64imc.S',
    sourceSha256: '034dbfa4e6526308435e912c8e97a8885fa3f422bd98cc04a87445de7ff5c028',
    targetTriple: 'riscv64-linux-gnu',
    providerProfileId: 'native:remote-debug-v1:qemu-lldb',
    providerProofCommandId: 'a7-cross-target-real-fixtures',
    semanticMarkers: Object.freeze(['addi a0, a0, 1', '0x1020304050607080']),
  }),
});

export const A7_PROFILE_IDS = Object.freeze(Object.keys(A7_PROFILE_BINDINGS));
export const A7_PROVIDER_PROFILE_IDS = Object.freeze([
  'native:lldb-compatible-v1:host',
  'native:remote-debug-v1:qemu-lldb',
]);

// These capabilities are not actually exercised by the current bounded
// runners.  Keeping the denominator blocked is safer than asserting them
// from a status-only observation.
export const A7_UNSUPPORTED_CAPABILITIES = Object.freeze(['attach', 'cancel', 'pause']);
export const A7_OBSERVED_CAPABILITIES = Object.freeze([
  'breakpointAddress', 'connect', 'disconnect', 'modules', 'readMemory', 'readRegisters',
  'removeBreakpoint', 'resume', 'stepInto', 'threads', 'writeMemory',
]);

export function a7ProfileBinding(profileId) {
  return A7_PROFILE_BINDINGS[String(profileId)] || null;
}

export function a7ProfileFixtureIdentity(profileId) {
  const binding = a7ProfileBinding(profileId);
  return binding ? `artifact:${binding.sourcePath}@sha256:${binding.sourceSha256}` : null;
}

export function validateA7FixtureSource(profileId, sourcePath, sourceSha256, sourceText) {
  const binding = a7ProfileBinding(profileId);
  if (!binding || sourcePath !== binding.sourcePath || sourceSha256 !== binding.sourceSha256) return false;
  const text = String(sourceText || '');
  return binding.semanticMarkers.every((marker) => text.includes(marker));
}
