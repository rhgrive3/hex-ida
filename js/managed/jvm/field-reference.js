function cpEntry(jvmClass, index) {
  const pool = jvmClass?.constantPool;
  if (!Array.isArray(pool) || !Number.isInteger(index) || index <= 0 || index >= pool.length) return null;
  return pool[index] ?? null;
}

function utf8Value(jvmClass, index) {
  const entry = cpEntry(jvmClass, index);
  return entry?.tag === 1 && typeof entry.value === 'string' ? entry.value : null;
}

function validUnqualifiedName(name) {
  return typeof name === 'string'
    && name.length > 0
    && !name.includes('.')
    && !name.includes(';')
    && !name.includes('[')
    && !name.includes('/');
}

function validInternalClassName(name) {
  if (typeof name !== 'string' || name.length === 0) return false;
  return name.split('/').every(validUnqualifiedName);
}

export function classifyJvmFieldDescriptor(descriptor) {
  if (typeof descriptor !== 'string' || descriptor.length === 0) return null;

  const primitive = {
    B: { bits: 32, category: 1, valueKind: 'int' },
    C: { bits: 32, category: 1, valueKind: 'int' },
    F: { bits: 32, category: 1, valueKind: 'float' },
    I: { bits: 32, category: 1, valueKind: 'int' },
    J: { bits: 64, category: 2, valueKind: 'long' },
    S: { bits: 32, category: 1, valueKind: 'int' },
    Z: { bits: 32, category: 1, valueKind: 'int' },
    D: { bits: 64, category: 2, valueKind: 'double' },
  }[descriptor];
  if (primitive) return Object.freeze({ descriptor, slots: primitive.category, ...primitive });

  if (descriptor[0] === 'L') {
    if (descriptor.at(-1) !== ';') return null;
    const name = descriptor.slice(1, -1);
    if (!validInternalClassName(name)) return null;
    return Object.freeze({ descriptor, bits: 64, category: 1, slots: 1, valueKind: 'reference' });
  }

  if (descriptor[0] === '[') {
    let dimensions = 0;
    while (descriptor[dimensions] === '[') dimensions++;
    if (dimensions === 0 || dimensions > 255) return null;
    const component = descriptor.slice(dimensions);
    if (!component || component === 'V' || component[0] === '[') return null;
    if (component[0] === 'L') {
      if (component.at(-1) !== ';' || !validInternalClassName(component.slice(1, -1))) return null;
    } else if (!['B', 'C', 'D', 'F', 'I', 'J', 'S', 'Z'].includes(component)) {
      return null;
    }
    return Object.freeze({ descriptor, bits: 64, category: 1, slots: 1, valueKind: 'reference' });
  }

  return null;
}

export function resolveJvmFieldRef(jvmClass, cpIndex) {
  const fieldRef = cpEntry(jvmClass, cpIndex);
  if (fieldRef?.tag !== 9) return null;

  const ownerClass = cpEntry(jvmClass, fieldRef.classIndex);
  const nameAndType = cpEntry(jvmClass, fieldRef.nameAndTypeIndex);
  if (ownerClass?.tag !== 7 || nameAndType?.tag !== 12) return null;

  const owner = utf8Value(jvmClass, ownerClass.nameIndex);
  const name = utf8Value(jvmClass, nameAndType.nameIndex);
  const descriptor = utf8Value(jvmClass, nameAndType.descriptorIndex);
  const value = classifyJvmFieldDescriptor(descriptor);
  if (!validInternalClassName(owner) || !validUnqualifiedName(name) || !value) return null;

  return Object.freeze({
    cpIndex,
    owner,
    name,
    descriptor,
    bits: value.bits,
    category: value.category,
    slots: value.slots,
    valueKind: value.valueKind,
  });
}
