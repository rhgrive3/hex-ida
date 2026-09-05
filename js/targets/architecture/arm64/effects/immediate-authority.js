export function snapshotArm64ImmediateOperands(instruction, ops) {
  const stableOps = [];
  let hasImmediate = false;

  for (const op of ops) {
    if (!op || typeof op !== 'object' || op.k !== 'imm') {
      stableOps.push(op);
      continue;
    }

    let descriptor;
    try {
      descriptor = Object.getOwnPropertyDescriptor(op, 'value');
    } catch {
      return null;
    }
    if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) return null;

    const stableOp = Object.create(op);
    Object.defineProperty(stableOp, 'value', {
      value: descriptor.value,
      enumerable: descriptor.enumerable !== false,
      writable: false,
      configurable: false,
    });
    stableOps.push(stableOp);
    hasImmediate = true;
  }

  if (!hasImmediate) return Object.freeze({ instruction, ops });

  const stableInstruction = Object.create(instruction);
  Object.defineProperty(stableInstruction, 'ops', {
    value: stableOps,
    enumerable: true,
    writable: false,
    configurable: false,
  });
  return Object.freeze({ instruction: stableInstruction, ops: stableOps });
}
