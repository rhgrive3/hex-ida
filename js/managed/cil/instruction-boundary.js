function invalidBoundary(bytecode, start, reason = 'cil-instruction-boundary-unresolved') {
  return Object.freeze({ start, end: bytecode.length, complete: false, reason });
}

function inRange(value, start, end) {
  return value >= start && value <= end;
}

function normalImmediateBytes(opcode) {
  // ShortInlineI / ShortInlineVar / ShortInlineBrTarget.
  if (inRange(opcode, 0x0e, 0x13) || opcode === 0x1f || inRange(opcode, 0x2b, 0x37) || opcode === 0xde) return 1;
  // InlineI / InlineMethod / InlineField / InlineType / InlineString /
  // InlineTok / InlineSig / InlineBrTarget.
  if (opcode === 0x20 || inRange(opcode, 0x27, 0x29) || inRange(opcode, 0x38, 0x44)
    || inRange(opcode, 0x6f, 0x75) || opcode === 0x79 || inRange(opcode, 0x7b, 0x81)
    || opcode === 0x8c || opcode === 0x8d || opcode === 0x8f || inRange(opcode, 0xa3, 0xa5)
    || opcode === 0xc2 || opcode === 0xc6 || opcode === 0xd0 || opcode === 0xdd) return 4;
  // InlineI8 / ShortInlineR(4 bytes is handled above for 0x22) / InlineR.
  if (opcode === 0x21 || opcode === 0x23) return 8;
  if (opcode === 0x22) return 4;
  return null;
}

function validNormalNoOperand(opcode) {
  return inRange(opcode, 0x00, 0x0d)
    || inRange(opcode, 0x14, 0x1e)
    || opcode === 0x25 || opcode === 0x26 || opcode === 0x2a
    || inRange(opcode, 0x46, 0x6e)
    || opcode === 0x76 || opcode === 0x7a
    || inRange(opcode, 0x82, 0x8b) || opcode === 0x8e
    || inRange(opcode, 0x90, 0xa2)
    || inRange(opcode, 0xb3, 0xba)
    || opcode === 0xc3
    || inRange(opcode, 0xd1, 0xdc) || opcode === 0xdf || opcode === 0xe0;
}

function feImmediateBytes(subOpcode) {
  if (subOpcode === 0x12 || subOpcode === 0x19) return 1;
  if (inRange(subOpcode, 0x09, 0x0e)) return 2;
  if (subOpcode === 0x06 || subOpcode === 0x07 || subOpcode === 0x15 || subOpcode === 0x16 || subOpcode === 0x1c) return 4;
  return null;
}

function validFeNoOperand(subOpcode) {
  return inRange(subOpcode, 0x00, 0x05)
    || subOpcode === 0x0f || subOpcode === 0x11 || subOpcode === 0x13 || subOpcode === 0x14
    || subOpcode === 0x17 || subOpcode === 0x18 || subOpcode === 0x1a
    || subOpcode === 0x1d || subOpcode === 0x1e;
}

function fixedBoundary(bytecode, start, headerBytes, immediateBytes) {
  const end = start + headerBytes + immediateBytes;
  if (end > bytecode.length) return invalidBoundary(bytecode, start, 'cil-truncated-instruction');
  return Object.freeze({ start, end, complete: true, reason: null });
}

function switchBoundary(bytecode, start) {
  const countOffset = start + 1;
  if (countOffset + 4 > bytecode.length) return invalidBoundary(bytecode, start, 'cil-truncated-switch');
  const view = new DataView(bytecode.buffer, bytecode.byteOffset, bytecode.byteLength);
  const count = view.getUint32(countOffset, true);
  const remaining = bytecode.length - (countOffset + 4);
  // Validate before multiplication so hostile counts cannot overflow the
  // instruction span or turn the target table into following opcodes.
  if (count > Math.floor(remaining / 4)) return invalidBoundary(bytecode, start, 'cil-truncated-switch');
  return Object.freeze({ start, end: countOffset + 4 + count * 4, complete: true, reason: null });
}

export function decodeCilInstructionBoundary(bytecode, start) {
  if (!(bytecode instanceof Uint8Array) || !Number.isSafeInteger(start) || start < 0 || start >= bytecode.length) {
    throw new TypeError('cil-invalid-instruction-boundary-input');
  }

  const opcode = bytecode[start];
  if (opcode === 0x45) return switchBoundary(bytecode, start);
  if (opcode === 0xfe) {
    if (start + 2 > bytecode.length) return invalidBoundary(bytecode, start, 'cil-truncated-prefixed-opcode');
    const subOpcode = bytecode[start + 1];
    const immediateBytes = feImmediateBytes(subOpcode);
    if (immediateBytes != null) return fixedBoundary(bytecode, start, 2, immediateBytes);
    if (validFeNoOperand(subOpcode)) return fixedBoundary(bytecode, start, 2, 0);
    return invalidBoundary(bytecode, start);
  }

  const immediateBytes = normalImmediateBytes(opcode);
  if (immediateBytes != null) return fixedBoundary(bytecode, start, 1, immediateBytes);
  if (validNormalNoOperand(opcode)) return fixedBoundary(bytecode, start, 1, 0);
  return invalidBoundary(bytecode, start);
}
