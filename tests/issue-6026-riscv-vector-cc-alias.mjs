// Issue #6026 regression: the RISC-V ABI registry must claim the same
// calling-convention aliases its classifier accepts. 'riscv_vector_cc' is the
// legacy spelling handled by vectorVariantRequested(); rejecting it in
// resolveABIPlugin degraded an explicitly-named ABI profile to 'unknown'.
import assert from 'node:assert/strict';
import { resolveABIPlugin } from '../js/targets/abi/index.js';
import { RISCV_VECTOR_CALLING_CONVENTION_ALIASES } from '../js/targets/abi/riscv-lp64.js';

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

// The registry, argument classifier, call-return classifier, and function
// return classifier must share the same vocabulary.  Exercise an actual
// vector-shaped prototype at both the legacy and canonical spellings so a
// registry-only alias cannot drift from either classification boundary.
{
  for (const abiId of ['lp64', 'lp64f', 'lp64d']) {
    const abi = resolveABIPlugin({ abiId, callingConvention: 'riscv_vector_cc', architecture: 'riscv64' });
    assert.equal(abi.architectureId, 'riscv64');
    for (const alias of RISCV_VECTOR_CALLING_CONVENTION_ALIASES) {
      assert.ok(abi.callingConventions().includes(alias), `${abiId} must claim ${alias}`);
      const vectorPrototype = {
        callingConvention: alias,
        args: [{ type: 'vector', vector: true, lmul: 1, tupleCount: 1 }],
      };
      const classified = abi.classifyArguments({
        callTarget: 0x1000n,
        callingConvention: alias,
        callPrototype: vectorPrototype,
      }, { architecture: 'riscv64' });
      assert.equal(classified.arguments[0].reg, 'v8', `${abiId}/${alias} vector argument must use v8`);
      assert.equal(classified.arguments[0].abiClass, 'vector-data');
      assert.equal(classified.callingConvention, 'riscv-vector-variant');

      const callReturn = abi.classifyCallReturn({
        callingConvention: alias,
        callPrototype: {
          returnType: 'vector',
          returnsValue: true,
          returnVector: { vector: true, lmul: 1, tupleCount: 1 },
        },
      });
      assert.deepEqual(callReturn.regs, ['v8'], `${abiId}/${alias} call return must use v8`);
      assert.equal(callReturn.callingConvention, 'riscv-vector-variant');

      const functionReturn = abi.classifyFunctionReturn({
        functionPrototype: {
          callingConvention: alias,
          returnType: 'vector',
          returnsValue: true,
          returnVector: { vector: true, lmul: 1, tupleCount: 1 },
        },
      });
      assert.deepEqual(functionReturn.regs, ['v8'], `${abiId}/${alias} function return must use v8`);
      assert.equal(functionReturn.callingConvention, 'riscv-vector-variant');
    }
  }
}

console.log('issue #6026 riscv_vector_cc registry alias regressions: PASS');
