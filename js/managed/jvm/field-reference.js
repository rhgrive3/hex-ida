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

// Storage width is a separate axis from operand-stack value width. JVMS §4.3.1
// plus §2.11.1/§6.5 keep `B`/`Z` in one byte and `C`/`S` in two while every
// stack value they take part in is a 32-bit `int`, and `J`/`D` occupy eight
// bytes as one category-2 stack pair. Publishing only the value width let the
// shared bridge default every field access to four bytes (#8799).
const PRIMITIVE_FIELD_DESCRIPTORS = Object.freeze(Object.assign(Object.create(null), {
  B: { bits: 32, storageBits: 8, category: 1, valueKind: 'int' },
  C: { bits: 32, storageBits: 16, category: 1, valueKind: 'int' },
  F: { bits: 32, storageBits: 32, category: 1, valueKind: 'float' },
  I: { bits: 32, storageBits: 32, category: 1, valueKind: 'int' },
  J: { bits: 64, storageBits: 64, category: 2, valueKind: 'long' },
  S: { bits: 32, storageBits: 16, category: 1, valueKind: 'int' },
  Z: { bits: 32, storageBits: 8, category: 1, valueKind: 'int' },
  D: { bits: 64, storageBits: 64, category: 2, valueKind: 'double' },
}));

// The project's JVM reference value model is 64-bit (`bits` below, and the
// shared bridge's canonical field-address entry carries the same width), so a
// reference field stores exactly that width; no separate HotSpot-style
// compressed-oop authority is invented here (#8799).
const JVM_REFERENCE_STORAGE_BITS = 64;

export function classifyJvmFieldDescriptor(descriptor) {
  if (typeof descriptor !== 'string' || descriptor.length === 0) return null;

  const primitive = PRIMITIVE_FIELD_DESCRIPTORS[descriptor];
  if (primitive) {
    return Object.freeze({
      descriptor, slots: primitive.category, ...primitive,
      storageByteWidth: primitive.storageBits / 8,
    });
  }

  if (descriptor[0] === 'L') {
    if (descriptor.at(-1) !== ';') return null;
    const name = descriptor.slice(1, -1);
    if (!validInternalClassName(name)) return null;
    return Object.freeze({
      descriptor, bits: 64, storageBits: JVM_REFERENCE_STORAGE_BITS, category: 1, slots: 1,
      valueKind: 'reference', storageByteWidth: JVM_REFERENCE_STORAGE_BITS / 8,
    });
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
    return Object.freeze({
      descriptor, bits: 64, storageBits: JVM_REFERENCE_STORAGE_BITS, category: 1, slots: 1,
      valueKind: 'reference', storageByteWidth: JVM_REFERENCE_STORAGE_BITS / 8,
    });
  }

  return null;
}

// A jvmClass's declared-field set is immutable during decoding, so the
// same-owner ACC_VOLATILE authority (#7861) is a stable fact. Rescanning
// `jvmClass.fields` for every field opcode hid O(class fields) work behind one
// admitted semantic operation (#8829). Cache the resolved flags per class keyed
// by the exact (owner, name, descriptor) triple so ambiguity/external-owner
// fail-closed results are preserved.
const declaredFlagsCache = new WeakMap();

function resolveDeclaredAccessFlags(jvmClass, owner, name, descriptor) {
  let byClass = declaredFlagsCache.get(jvmClass);
  if (!byClass) { byClass = new Map(); declaredFlagsCache.set(jvmClass, byClass); }
  const key = `${owner}\u0000${name}\u0000${descriptor}`;
  if (byClass.has(key)) return byClass.get(key);
  const declared = Array.isArray(jvmClass?.fields)
    ? jvmClass.fields.filter((field) => field?.name === name && field?.descriptor === descriptor)
    : [];
  const flags = owner === jvmClass?.thisClassName && declared.length === 1 ? declared[0].accessFlags : null;
  byClass.set(key, flags);
  return flags;
}

export function resolveJvmFieldRef(jvmClass, cpIndex, { resolveDeclaredFlags = false } = {}) {
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

  // JLS §17.4.5 / JVMS §4.5: ACC_VOLATILE on the declared field is the
  // happens-before authority for field access semantics (#7861). It is only
  // resolvable when the field's owner IS the current class — a same-owner
  // same-name same-descriptor declared field may still be ambiguous, so the
  // declared flags bind only when exactly one declared field matches.
  let declaredAccessFlags;
  if (resolveDeclaredFlags) {
    declaredAccessFlags = resolveDeclaredAccessFlags(jvmClass, owner, name, descriptor);
  }

  return Object.freeze({
    cpIndex,
    owner,
    name,
    descriptor,
    bits: value.bits,
    storageBits: value.storageBits,
    storageByteWidth: value.storageByteWidth,
    category: value.category,
    slots: value.slots,
    valueKind: value.valueKind,
    ...(resolveDeclaredFlags
      ? {
          // null = volatility unresolvable (external owner or ambiguous match);
          // the caller must not fabricate a plain access from it.
          declaredAccessFlags,
          isVolatile: declaredAccessFlags != null && (declaredAccessFlags & 0x0040) !== 0,
        }
      : {}),
  });
}
