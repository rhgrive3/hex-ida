import { decodeUleb128 } from './parser-core.js';

const I32 = 0x7f;
const I64 = 0x7e;

const MEMORY_INSTRUCTIONS = Object.freeze({
  0x28: Object.freeze({ naturalAlign: 2, addressType: I32 }), // i32.load
  0x29: Object.freeze({ naturalAlign: 3, addressType: I32 }), // i64.load
  0x2a: Object.freeze({ naturalAlign: 2, addressType: I32 }), // f32.load
  0x2b: Object.freeze({ naturalAlign: 3, addressType: I32 }), // f64.load
  0x2c: Object.freeze({ naturalAlign: 0, addressType: I32 }), // i32.load8_s
  0x2d: Object.freeze({ naturalAlign: 0, addressType: I32 }), // i32.load8_u
  0x2e: Object.freeze({ naturalAlign: 1, addressType: I32 }), // i32.load16_s
  0x2f: Object.freeze({ naturalAlign: 1, addressType: I32 }), // i32.load16_u
  0x36: Object.freeze({ naturalAlign: 2, addressType: I32 }), // i32.store
  0x37: Object.freeze({ naturalAlign: 3, addressType: I32 }), // i64.store
  0x38: Object.freeze({ naturalAlign: 2, addressType: I32 }), // f32.store
  0x39: Object.freeze({ naturalAlign: 3, addressType: I32 }), // f64.store
  0x3a: Object.freeze({ naturalAlign: 0, addressType: I32 }), // i32.store8
  0x3b: Object.freeze({ naturalAlign: 1, addressType: I32 }), // i32.store16
});

function fail(code) { throw new TypeError(code); }

function memoryAddressType(memory) {
  const normalizeDeclared = (value) => {
    if (value == null) return null;
    if (value === I32 || value === 'i32') return I32;
    if (value === I64 || value === 'i64') return I64;
    fail('wasm-invalid-memory-address-type');
  };
  const addressType = normalizeDeclared(memory?.addressType);
  const indexType = normalizeDeclared(memory?.indexType);
  if (addressType != null && indexType != null && addressType !== indexType) {
    fail('wasm-conflicting-memory-address-type');
  }
  const declared = addressType ?? indexType;
  const flags = memory?.flags;

  if (declared === I64) fail('wasm-unsupported-memory-address-type');
  if (declared === I32) {
    if (flags != null && (!Number.isSafeInteger(flags) || flags < 0 || (flags & ~0x03) !== 0)) {
      fail('wasm-conflicting-memory-address-type');
    }
    return I32;
  }

  if (Number.isSafeInteger(flags) && flags >= 0 && (flags & ~0x03) === 0) return I32;
  fail('wasm-memory-address-type-unresolved');
}

export function createWasmMemoryValidationContext(wasmModule) {
  const imported = (wasmModule?.imports || [])
    .filter((entry) => entry?.desc?.kind === 2)
    .map((entry) => entry.desc);
  const defined = Array.isArray(wasmModule?.memories) ? wasmModule.memories : [];
  return Object.freeze({ memories: Object.freeze([...imported, ...defined]) });
}

export function decodeWasmMemarg(bytecode, offset) {
  const flags = decodeUleb128(bytecode, offset);
  if (flags.value >= 0x80) fail('wasm-invalid-memarg-flags');

  let align = flags.value;
  let memoryIndex = 0;
  let pos = flags.nextOffset;
  if ((flags.value & 0x40) !== 0) {
    align = flags.value & 0x3f;
    const memory = decodeUleb128(bytecode, pos);
    memoryIndex = memory.value;
    pos = memory.nextOffset;
  }

  // This frontend currently supports memory32 only. Its existing offset
  // authority is a canonical u32 ULEB; memory64 remains explicitly unsupported
  // in memoryAddressType() rather than silently widening this field.
  const displacement = decodeUleb128(bytecode, pos);
  return Object.freeze({
    align,
    memoryIndex,
    offset: displacement.value,
    nextOffset: displacement.nextOffset,
  });
}

export function resolveWasmMemory(context, memoryIndex = 0) {
  if (!Number.isSafeInteger(memoryIndex) || memoryIndex < 0) fail('wasm-invalid-memory-index');
  const memory = context?.memories?.[memoryIndex];
  if (!memory) fail('wasm-invalid-memory-index');
  return Object.freeze({ memoryIndex, addressType: memoryAddressType(memory) });
}

export function validateWasmMemoryInstruction(context, opcode, align, memoryIndex = 0) {
  const info = MEMORY_INSTRUCTIONS[opcode];
  if (!info) fail('wasm-unsupported-memory-opcode');
  const resolved = resolveWasmMemory(context, memoryIndex);
  if (!Number.isSafeInteger(align) || align < 0 || align > info.naturalAlign) {
    fail('wasm-invalid-memory-alignment');
  }
  if (resolved.addressType !== info.addressType) fail('wasm-invalid-memory-address-type');
  return Object.freeze({
    memoryIndex: resolved.memoryIndex,
    addressType: resolved.addressType,
    naturalAlign: info.naturalAlign,
  });
}
