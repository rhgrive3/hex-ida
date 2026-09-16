const JVM_PRIMITIVE_VALUE_TYPES = Object.freeze(Object.assign(Object.create(null), {
  B: Object.freeze({ kind: 'bitvector', widthBits: 32 }),
  C: Object.freeze({ kind: 'bitvector', widthBits: 32 }),
  D: Object.freeze({ kind: 'float', widthBits: 64, format: 'binary64' }),
  F: Object.freeze({ kind: 'float', widthBits: 32, format: 'binary32' }),
  I: Object.freeze({ kind: 'bitvector', widthBits: 32 }),
  J: Object.freeze({ kind: 'bitvector', widthBits: 64 }),
  S: Object.freeze({ kind: 'bitvector', widthBits: 32 }),
  Z: Object.freeze({ kind: 'bitvector', widthBits: 32 }),
}));

// Canonical primitive JVM descriptor -> Semantic IR machine type authority.
// Reference descriptors deliberately return null: managed-reference typing is
// owned by #8836 and must not be inferred as part of the #8955 repair.
export function jvmCanonicalValueTypeForDescriptor(descriptor) {
  if (typeof descriptor !== 'string') return null;
  return JVM_PRIMITIVE_VALUE_TYPES[descriptor] ?? null;
}
