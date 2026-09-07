// Issue #6026 regression: the RISC-V ABI registry must claim the same
// calling-convention aliases its classifier accepts. 'riscv_vector_cc' is the
// legacy spelling handled by vectorVariantRequested(); rejecting it in
// resolveABIPlugin degraded an explicitly-named ABI profile to 'unknown'.
import assert from 'node:assert/strict';
import { resolveABIPlugin } from '../js/targets/abi/index.js';

for (const abiId of ['lp64', 'lp64f', 'lp64d']) {
  const withArch = resolveABIPlugin({ abiId, callingConvention: 'riscv_vector_cc', architecture: 'riscv64' });
  assert.equal(withArch.id, abiId, `abiId=${abiId} + riscv_vector_cc must resolve to the ${abiId} plugin, got ${withArch.id}`);
  const noArch = resolveABIPlugin({ abiId, callingConvention: 'riscv_vector_cc' });
  assert.equal(noArch.id, abiId, `abiId=${abiId} + riscv_vector_cc without architecture must still resolve`);
}

// The canonical alias keeps working.
{
  const control = resolveABIPlugin({ abiId: 'lp64d', callingConvention: 'riscv-vector-variant', architecture: 'riscv64' });
  assert.equal(control.id, 'lp64d');
}

// An unregistered convention still fails closed for an explicit id.
{
  const unknown = resolveABIPlugin({ abiId: 'lp64d', callingConvention: 'riscv_nonexistent_cc', architecture: 'riscv64' });
  assert.equal(unknown.id, 'unknown');
}

// The claimed alias reaches the vector-variant classifier path: the resolved
// plugin recognizes the legacy spelling as a vector-variant request.
{
  const abi = resolveABIPlugin({ abiId: 'lp64d', callingConvention: 'riscv_vector_cc', architecture: 'riscv64' });
  const classified = abi.classifyArguments({
    callTarget: 0x1000n,
    callingConvention: 'riscv_vector_cc',
    callPrototype: { args: [{ type: 'int32' }, { type: 'float' }] },
  }, { architecture: 'riscv64' });
  assert.ok(classified, 'the resolved plugin must classify arguments');
  assert.equal(abi.architectureId, 'riscv64');
}

console.log('issue #6026 riscv_vector_cc registry alias regressions: PASS');
