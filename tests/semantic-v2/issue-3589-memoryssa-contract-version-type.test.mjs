import assert from 'node:assert/strict';
import {
  MEMORY_SSA_CONTRACT_VERSION,
  createMemorySsaContract,
} from '../../js/semantics/memoryssa/contract.js';

function contract(contractVersion, includeVersion = true) {
  const input = {
    functionId: 'function_fixture',
    regions: [],
    definitions: [],
    uses: [],
  };
  if (includeVersion) input.contractVersion = contractVersion;
  return createMemorySsaContract(input);
}

assert.equal(
  contract(MEMORY_SSA_CONTRACT_VERSION).contractVersion,
  MEMORY_SSA_CONTRACT_VERSION,
);
assert.equal(
  contract(undefined, false).contractVersion,
  MEMORY_SSA_CONTRACT_VERSION,
);
assert.equal(contract(null).contractVersion, MEMORY_SSA_CONTRACT_VERSION);
assert.equal(contract(undefined).contractVersion, MEMORY_SSA_CONTRACT_VERSION);

for (const value of [
  [MEMORY_SSA_CONTRACT_VERSION],
  new String(MEMORY_SSA_CONTRACT_VERSION),
  { version: MEMORY_SSA_CONTRACT_VERSION },
  2,
  true,
  false,
  '',
  '1.0.0',
]) {
  assert.throws(
    () => contract(value),
    /memory-ssa-contract-version-mismatch/,
  );
}

let coercions = 0;
const coercible = {
  toString() {
    coercions += 1;
    return MEMORY_SSA_CONTRACT_VERSION;
  },
  valueOf() {
    coercions += 1;
    return MEMORY_SSA_CONTRACT_VERSION;
  },
};
assert.throws(
  () => contract(coercible),
  /memory-ssa-contract-version-mismatch/,
);
assert.equal(coercions, 0);
