import { parseJvm as parseJvmCore, probeJvm } from './parser-core.js';
import { parseJvmFieldDescriptor, parseJvmMethodDescriptor } from './descriptors.js';

export { probeJvm };

const LOADABLE_BOOTSTRAP_CONSTANT_TAGS = new Set([3, 4, 5, 6, 7, 8, 15, 16, 17]);
function fail(code) { throw new TypeError(code); }
function cpEntry(pool, index) {
  if (!Number.isInteger(index) || index <= 0 || index >= pool.length) return null;
  return pool[index] ?? null;
}
function utf8(pool, index) {
  const entry = cpEntry(pool, index);
  return entry?.tag === 1 && typeof entry.value === 'string' ? entry.value : null;
}
function validStandaloneNameAndTypeDescriptor(descriptor) {
  try { parseJvmFieldDescriptor(descriptor); return true; } catch {}
  try { parseJvmMethodDescriptor(descriptor); return true; } catch {}
  return false;
}

function validateConstantPoolClosure(pool) {
  for (let i = 1; i < pool.length; i++) {
    const entry = pool[i];
    if (!entry) continue;
    if (entry.tag === 12) {
      const descriptor = utf8(pool, entry.descriptorIndex);
      if (!validStandaloneNameAndTypeDescriptor(descriptor)) {
        fail('jvm-invalid-cp-nameandtype-descriptor');
      }
    }
    if (entry.tag === 15 && entry.referenceKind === 8) {
      const target = cpEntry(pool, entry.referenceIndex);
      const nameAndType = cpEntry(pool, target?.nameAndTypeIndex);
      const descriptor = utf8(pool, nameAndType?.descriptorIndex);
      let parsed;
      try { parsed = parseJvmMethodDescriptor(descriptor); }
      catch { fail('jvm-invalid-cp-methodhandle-constructor-descriptor'); }
      if (parsed.returnType !== null) fail('jvm-invalid-cp-methodhandle-constructor-descriptor');
    }
  }
}

function skipConstantPool(view, bytes) {
  const count = view.getUint16(8, false);
  let pos = 10;
  for (let i = 1; i < count; i++) {
    const tag = bytes[pos++];
    switch (tag) {
      case 1: { const length = view.getUint16(pos, false); pos += 2 + length; break; }
      case 3: case 4: pos += 4; break;
      case 5: case 6: pos += 8; i++; break;
      case 7: case 8: case 16: case 19: case 20: pos += 2; break;
      case 9: case 10: case 11: case 12: case 17: case 18: pos += 4; break;
      case 15: pos += 3; break;
      default: fail('jvm-invalid-cp-tag');
    }
  }
  return pos;
}
function skipMembers(view, pos) {
  const count = view.getUint16(pos, false); pos += 2;
  for (let i = 0; i < count; i++) {
    const attributes = view.getUint16(pos + 6, false); pos += 8;
    for (let a = 0; a < attributes; a++) {
      const length = view.getUint32(pos + 2, false);
      pos += 6 + length;
    }
  }
  return pos;
}
function validateBootstrapMethods(image) {
  const bytes = image.rawBytes;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let pos = skipConstantPool(view, bytes);
  pos += 6;
  const interfaces = view.getUint16(pos, false); pos += 2 + interfaces * 2;
  pos = skipMembers(view, pos);
  pos = skipMembers(view, pos);
  const attributes = view.getUint16(pos, false); pos += 2;
  for (let a = 0; a < attributes; a++) {
    const nameIndex = view.getUint16(pos, false);
    const length = view.getUint32(pos + 2, false);
    const start = pos + 6;
    const end = start + length;
    if (utf8(image.constantPool, nameIndex) === 'BootstrapMethods') {
      let cursor = start;
      const count = view.getUint16(cursor, false); cursor += 2;
      for (let i = 0; i < count; i++) {
        const methodRef = view.getUint16(cursor, false);
        const argumentCount = view.getUint16(cursor + 2, false); cursor += 4;
        if (cpEntry(image.constantPool, methodRef)?.tag !== 15) {
          fail('jvm-invalid-bootstrap-method-ref');
        }
        for (let j = 0; j < argumentCount; j++) {
          const argumentIndex = view.getUint16(cursor, false); cursor += 2;
          const argument = cpEntry(image.constantPool, argumentIndex);
          if (!argument || !LOADABLE_BOOTSTRAP_CONSTANT_TAGS.has(argument.tag)) {
            fail('jvm-invalid-bootstrap-argument');
          }
        }
      }
      if (cursor !== end) fail('jvm-invalid-bootstrap-methods-attribute-length');
    }
    pos = end;
  }
}

export function parseJvm(bytes, options = {}) {
  const image = parseJvmCore(bytes, options);
  validateConstantPoolClosure(image.constantPool);
  validateBootstrapMethods(image);
  return image;
}
