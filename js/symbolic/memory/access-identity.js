/** Shared admission facts for an ordinary memory access. */
const ADDRESS_SPACE_MISMATCH = 'address-space-mismatch';
const UNRESOLVED_MEMORY_ADDRESS = 'unresolved-memory-address';

/**
 * Classify only address authority that is explicit on the actual access.
 * Execution, qualifier and width semantics remain owned by translate/memory.js.
 */
export function memoryAccessExclusionReason(instruction, expectedAddressSpace, memoryDescriptor = instruction?.extra?.memoryAccess) {
  const descriptor = memoryDescriptor;
  for (const addressSpace of [instruction?.loc?.addressSpace, instruction?.addr?.addressSpace, descriptor?.addressSpace]) {
    if (addressSpace != null && addressSpace !== expectedAddressSpace) return ADDRESS_SPACE_MISMATCH;
  }
  const canonicalAddressId = descriptor?.addressExpr?.valueId;
  if (!canonicalAddressId && (instruction?.addr?.precise === false || instruction?.extra?.addressPrecise === false)) {
    return UNRESOLVED_MEMORY_ADDRESS;
  }
  return null;
}

export function isMemoryAccessExclusionReason(reason) {
  return reason === ADDRESS_SPACE_MISMATCH || reason === UNRESOLVED_MEMORY_ADDRESS;
}
