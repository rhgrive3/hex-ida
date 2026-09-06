function malformedBoundary(bytecode, start) {
  return Object.freeze({ end: bytecode.length, complete: false, start });
}

function fixedLength(opcode) {
  if (opcode === 0xc5) return 4;
  if (opcode === 0xb9 || opcode === 0xba || opcode === 0xc8 || opcode === 0xc9) return 5;

  if (
    opcode === 0x11 || opcode === 0x13 || opcode === 0x14 || opcode === 0x84 ||
    (opcode >= 0x99 && opcode <= 0xa8) ||
    (opcode >= 0xb2 && opcode <= 0xb8) ||
    opcode === 0xbb || opcode === 0xbd || opcode === 0xc0 || opcode === 0xc1 ||
    opcode === 0xc6 || opcode === 0xc7
  ) return 3;

  if (
    opcode === 0x10 || opcode === 0x12 ||
    (opcode >= 0x15 && opcode <= 0x19) ||
    (opcode >= 0x36 && opcode <= 0x3a) ||
    opcode === 0xa9 || opcode === 0xbc
  ) return 2;

  if (opcode <= 0xca || opcode === 0xfe || opcode === 0xff) return 1;
  return null;
}

function readI32(view, offset) {
  return view.getInt32(offset, false);
}

function decodeTableSwitch(bytecode, view, start) {
  let pos = start + 1;
  pos += (4 - (pos & 3)) & 3;
  if (pos + 12 > bytecode.length) return malformedBoundary(bytecode, start);
  const low = readI32(view, pos + 4);
  const high = readI32(view, pos + 8);
  if (high < low) return malformedBoundary(bytecode, start);
  const count = high - low + 1;
  const remaining = bytecode.length - (pos + 12);
  if (!Number.isSafeInteger(count) || count < 0 || count > Math.floor(remaining / 4)) {
    return malformedBoundary(bytecode, start);
  }
  return Object.freeze({ end: pos + 12 + count * 4, complete: true, start });
}

function decodeLookupSwitch(bytecode, view, start) {
  let pos = start + 1;
  pos += (4 - (pos & 3)) & 3;
  if (pos + 8 > bytecode.length) return malformedBoundary(bytecode, start);
  const pairs = readI32(view, pos + 4);
  const remaining = bytecode.length - (pos + 8);
  if (pairs < 0 || pairs > Math.floor(remaining / 8)) return malformedBoundary(bytecode, start);
  return Object.freeze({ end: pos + 8 + pairs * 8, complete: true, start });
}

function decodeWide(bytecode, start) {
  if (start + 2 > bytecode.length) return malformedBoundary(bytecode, start);
  const modified = bytecode[start + 1];
  let length = null;
  if ((modified >= 0x15 && modified <= 0x19) || (modified >= 0x36 && modified <= 0x3a) || modified === 0xa9) {
    length = 4;
  } else if (modified === 0x84) {
    length = 6;
  }
  if (length === null || start + length > bytecode.length) return malformedBoundary(bytecode, start);
  return Object.freeze({ end: start + length, complete: true, start });
}

export function decodeJvmInstructionBoundary(bytecode, start) {
  if (!(bytecode instanceof Uint8Array) || !Number.isSafeInteger(start) || start < 0 || start >= bytecode.length) {
    throw new TypeError('jvm-invalid-instruction-boundary-input');
  }
  const opcode = bytecode[start];
  const view = new DataView(bytecode.buffer, bytecode.byteOffset, bytecode.byteLength);
  if (opcode === 0xaa) return decodeTableSwitch(bytecode, view, start);
  if (opcode === 0xab) return decodeLookupSwitch(bytecode, view, start);
  if (opcode === 0xc4) return decodeWide(bytecode, start);

  const length = fixedLength(opcode);
  if (length === null || start + length > bytecode.length) return malformedBoundary(bytecode, start);
  return Object.freeze({ end: start + length, complete: true, start });
}
