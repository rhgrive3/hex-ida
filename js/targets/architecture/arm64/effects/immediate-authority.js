const hasOwnValue = (descriptor) => descriptor != null
  && Object.prototype.hasOwnProperty.call(descriptor, 'value');

function immutableDataDescriptor(value, descriptor = null) {
  return {
    value,
    enumerable: descriptor?.enumerable ?? false,
    writable: false,
    configurable: false,
  };
}

function snapshotModifier(value) {
  if (value == null || typeof value !== 'object') return { ok:true, value };

  let descriptors;
  let prototype;
  try {
    descriptors = Object.getOwnPropertyDescriptors(value);
    prototype = Object.getPrototypeOf(value);
  } catch {
    return { ok:false, value:null };
  }

  const stableDescriptors = { ...descriptors };
  for (const field of ['op','amount']) {
    const descriptor = descriptors[field];
    if (descriptor && !hasOwnValue(descriptor)) return { ok:false, value:null };
    stableDescriptors[field] = immutableDataDescriptor(descriptor?.value, descriptor);
  }

  try {
    return {
      ok:true,
      value:Object.create(prototype, stableDescriptors),
    };
  } catch {
    return { ok:false, value:null };
  }
}

export function snapshotArm64ImmediateOperands(instruction, ops) {
  const stableOps = [];
  let hasImmediate = false;

  for (const op of ops) {
    if (!op || typeof op !== 'object') {
      stableOps.push(op);
      continue;
    }

    let descriptors;
    try {
      descriptors = Object.getOwnPropertyDescriptors(op);
    } catch {
      return null;
    }

    const kindDescriptor = descriptors.k;
    if (!kindDescriptor) {
      let kind;
      try { kind = op.k; } catch { return null; }
      if (kind === 'imm') return null;
      stableOps.push(op);
      continue;
    }
    if (!hasOwnValue(kindDescriptor)) return null;
    const kind = kindDescriptor.value;
    if (kind !== 'imm') {
      stableOps.push(op);
      continue;
    }

    const valueDescriptor = descriptors.value;
    if (!hasOwnValue(valueDescriptor)) return null;

    let prototype;
    try {
      prototype = Object.getPrototypeOf(op);
    } catch {
      return null;
    }

    const stableDescriptors = { ...descriptors };
    stableDescriptors.k = immutableDataDescriptor(kind, kindDescriptor);
    stableDescriptors.value = immutableDataDescriptor(valueDescriptor.value, valueDescriptor);

    for (const field of ['shift','extend']) {
      const descriptor = descriptors[field];
      if (descriptor && !hasOwnValue(descriptor)) return null;
      const modifier = snapshotModifier(descriptor?.value);
      if (!modifier.ok) return null;
      stableDescriptors[field] = immutableDataDescriptor(modifier.value, descriptor);
    }

    try {
      stableOps.push(Object.create(prototype, stableDescriptors));
    } catch {
      return null;
    }
    hasImmediate = true;
  }

  if (!hasImmediate) return Object.freeze({ instruction, ops });

  let instructionDescriptors;
  let instructionPrototype;
  try {
    instructionDescriptors = Object.getOwnPropertyDescriptors(instruction);
    instructionPrototype = Object.getPrototypeOf(instruction);
  } catch {
    return null;
  }
  const opsDescriptor = instructionDescriptors.ops;
  instructionDescriptors.ops = immutableDataDescriptor(stableOps, opsDescriptor);

  try {
    const stableInstruction = Object.create(instructionPrototype, instructionDescriptors);
    return Object.freeze({ instruction: stableInstruction, ops: stableInstruction.ops });
  } catch {
    return null;
  }
}
