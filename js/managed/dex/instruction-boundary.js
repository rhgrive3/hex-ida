const ONE_UNIT = new Set([
  0x00,0x01,0x04,0x07,
  ...Array.from({length:9},(_,i)=>0x0a+i), // 0a..12
  0x1d,0x1e,0x21,0x27,0x28,
  ...Array.from({length:6},(_,i)=>0x3e+i), // 3e..43
  0x73,
  ...Array.from({length:0x8f-0x79+1},(_,i)=>0x79+i),
  ...Array.from({length:0xcf-0xb0+1},(_,i)=>0xb0+i),
  ...Array.from({length:0xf9-0xe3+1},(_,i)=>0xe3+i),
]);
const TWO_UNIT = new Set([
  0x02,0x05,0x08,0x13,0x15,0x16,0x19,0x1a,0x1c,0x1f,0x20,0x22,0x23,0x29,
  ...Array.from({length:0x3d-0x2d+1},(_,i)=>0x2d+i),
  ...Array.from({length:0x6d-0x44+1},(_,i)=>0x44+i),
  ...Array.from({length:0xaf-0x90+1},(_,i)=>0x90+i),
  ...Array.from({length:0xe2-0xd0+1},(_,i)=>0xd0+i),
  0xfe,0xff,
]);
const THREE_UNIT = new Set([
  0x03,0x06,0x09,0x14,0x17,0x1b,0x24,0x25,0x26,0x2a,0x2b,0x2c,
  ...Array.from({length:5},(_,i)=>0x6e+i),
  ...Array.from({length:5},(_,i)=>0x74+i),
  0xfc,0xfd,
]);

export function dexOpcodeCodeUnits(opcode) {
  if (opcode === 0x18) return 5;
  if (opcode === 0xfa || opcode === 0xfb) return 4;
  if (THREE_UNIT.has(opcode)) return 3;
  if (TWO_UNIT.has(opcode)) return 2;
  if (ONE_UNIT.has(opcode)) return 1;
  throw new TypeError('dex-instruction-width-unmapped');
}

export function decodeDexInstructionBoundary(view, insnsStart, pc, insnsSize) {
  const remaining = insnsSize - pc;
  if (!Number.isInteger(pc) || pc < 0 || remaining <= 0) throw new TypeError('dex-invalid-instruction-offset');
  const insn = view.getUint16(insnsStart + pc * 2, true);
  const opcode = insn & 0xff;
  const signature = (insn >>> 8) & 0xff;

  let length;
  let kind = 'instruction';
  let mnemonic = null;
  if (opcode === 0x00 && signature !== 0x00) {
    kind = 'payload';
    if (signature === 0x01 || signature === 0x02) {
      if (remaining < 2) return { opcode, signature, kind:'unknown', length:remaining, stop:true, reason:'dex-truncated-payload-header' };
      const size = view.getUint16(insnsStart + (pc + 1) * 2, true);
      length = signature === 0x01 ? 4 + size * 2 : 2 + size * 4;
      mnemonic = signature === 0x01 ? 'packed-switch-payload' : 'sparse-switch-payload';
    } else if (signature === 0x03) {
      if (remaining < 4) return { opcode, signature, kind:'unknown', length:remaining, stop:true, reason:'dex-truncated-payload-header' };
      const elementWidth = view.getUint16(insnsStart + (pc + 1) * 2, true);
      const size = view.getUint32(insnsStart + (pc + 2) * 2, true);
      const dataBytes = elementWidth * size;
      length = 4 + Math.ceil(dataBytes / 2);
      mnemonic = 'fill-array-data-payload';
    } else {
      return { opcode, signature, kind:'unknown', length:remaining, stop:true, reason:'dex-unknown-payload-signature' };
    }
  } else {
    length = dexOpcodeCodeUnits(opcode);
  }

  if (length > remaining) {
    return { opcode, signature, kind:'unknown', length:remaining, stop:true, reason:'dex-truncated-instruction' };
  }
  return { opcode, signature, kind, mnemonic, length, stop:false, reason:null };
}

// Resolve packed/sparse-switch payload tables into switch-relative case
// target byte offsets (#5300). The switch opcode's i32 operand is the
// displacement to the payload pseudo-unit; each payload target is itself
// relative to the switch opcode. Fail-closed: ident/parity/bounds checks
// emit typed errors instead of fabricating case edges.
function fail(code) { throw new TypeError(code); }

export function decodeDexSwitchTargets(view, insnsStart, insnsSize, switchPc, payloadPc, packed) {
  const codeEnd = insnsSize * 2;
  const payloadByte = payloadPc * 2;
  if (!Number.isSafeInteger(payloadByte) || payloadPc < 0 || payloadByte + 6 > codeEnd) {
    fail('dex-switch-payload-out-of-range');
  }
  const ident = view.getUint16(insnsStart + payloadByte, true);
  const expected = packed ? 0x0100 : 0x0200;
  if (ident !== expected) fail('dex-switch-payload-ident-mismatch');
  const targets = [];
  if (packed) {
    const size = view.getUint16(insnsStart + payloadByte + 2, true);
    if (payloadByte + 8 + size * 4 > codeEnd) fail('dex-switch-payload-truncated');
    for (let i = 0; i < size; i++) {
      targets.push(view.getInt32(insnsStart + payloadByte + 8 + i * 4, true));
    }
  } else {
    const size = view.getUint32(insnsStart + payloadByte + 2, true);
    if (payloadByte + 6 + size * 8 > codeEnd) fail('dex-switch-payload-truncated');
    const targetsBase = payloadByte + 6 + size * 4;
    for (let i = 0; i < size; i++) {
      targets.push(view.getInt32(insnsStart + targetsBase + i * 4, true));
    }
  }
  const switchByte = switchPc * 2;
  const resolved = [];
  for (const displacement of targets) {
    const target = switchByte + displacement * 2;
    if (target < 0 || target >= codeEnd || target % 2 !== 0) fail('dex-switch-target-out-of-range');
    resolved.push(target);
  }
  return resolved;
}
