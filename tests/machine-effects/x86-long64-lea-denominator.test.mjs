import assert from 'node:assert/strict';

import { createX86DecodedInstruction } from '../../js/targets/architecture/x86_64/decoded-instruction.js';
import { materializeX86Address } from '../../js/targets/architecture/x86_64/effects/addressing.js';
import { liftX86MachineEffects } from '../../js/targets/architecture/x86_64/effects/index.js';
import { evaluateMaterializedAddress } from '../phase5/effects/memory/helpers.mjs';
import { createCapstoneX86Session } from '../phase5/helpers/capstone-session.mjs';
import {
  x86Long64LeaDenominatorIdentity,
  x86Long64LeaEncodingCases,
} from '../../tools/validation/machine-effects/x86-long64-lea-denominator.mjs';

const identity = x86Long64LeaDenominatorIdentity();
assert.equal(identity.encodingCaseCount, 302976);

const REGISTER_NAMES_64 = Object.freeze(['rax','rcx','rdx','rbx','rsp','rbp','rsi','rdi','r8','r9','r10','r11','r12','r13','r14','r15']);
const REGISTER_NAMES_32 = Object.freeze(['eax','ecx','edx','ebx','esp','ebp','esi','edi','r8d','r9d','r10d','r11d','r12d','r13d','r14d','r15d']);
const REGISTER_VALUES = Object.freeze(Object.fromEntries([
  ...REGISTER_NAMES_64.map((name, index) => [name, 0x1020304050607080n + BigInt(index) * 0x0101010101010101n]),
  ...REGISTER_NAMES_32.map((name, index) => [name, 0x80706050n + BigInt(index) * 0x01010101n]),
]));

function signedLittleEndian(bytes) {
  let value = 0n;
  for (let index = 0; index < bytes.length; index++) value |= BigInt(bytes[index]) << BigInt(index * 8);
  const width = BigInt(bytes.length * 8);
  return width > 0n && (value & (1n << (width - 1n))) !== 0n ? value - (1n << width) : value;
}

// This byte-level oracle intentionally does not consume Capstone operands or
// the production address expression. It independently decodes the finite LEA
// discriminator case and calculates its effective address.
function independentLeaAddress(bytes, instructionAddress) {
  let cursor = 0;
  let addressSizeBits = 64;
  while (bytes[cursor] === 0x66 || bytes[cursor] === 0x67) {
    if (bytes[cursor] === 0x67) addressSizeBits = 32;
    cursor++;
  }
  const rex = bytes[cursor++];
  assert.ok(rex >= 0x40 && rex <= 0x4f, 'independent LEA oracle requires REX');
  assert.equal(bytes[cursor++], 0x8d, 'independent LEA oracle opcode');
  const modrm = bytes[cursor++];
  const mod = modrm >>> 6;
  const rm = modrm & 7;
  assert.ok(mod < 3, 'independent LEA oracle rejects register source');
  const rexX = (rex >>> 1) & 1;
  const rexB = rex & 1;
  const names = addressSizeBits === 32 ? REGISTER_NAMES_32 : REGISTER_NAMES_64;
  let base = null;
  let index = null;
  let scale = 1;
  let displacementSize = mod === 1 ? 1 : mod === 2 ? 4 : 0;
  if (rm === 4) {
    const sib = bytes[cursor++];
    scale = 1 << (sib >>> 6);
    const rawIndex = (sib >>> 3) & 7;
    const rawBase = sib & 7;
    if (!(rawIndex === 4 && rexX === 0)) index = names[rawIndex | (rexX << 3)];
    if (mod === 0 && rawBase === 5) displacementSize = 4;
    else base = names[rawBase | (rexB << 3)];
  } else if (mod === 0 && rm === 5) {
    base = addressSizeBits === 32 ? 'eip' : 'rip';
    displacementSize = 4;
  } else {
    base = names[rm | (rexB << 3)];
  }
  const displacement = signedLittleEndian(bytes.subarray(cursor, cursor + displacementSize));
  assert.equal(cursor + displacementSize, bytes.length, 'independent LEA oracle consumed encoding');
  const mask = (1n << BigInt(addressSizeBits)) - 1n;
  let value = 0n;
  if (base === 'rip' || base === 'eip') value = (BigInt(instructionAddress) + BigInt(bytes.length)) & mask;
  else if (base != null) value = REGISTER_VALUES[base] & mask;
  if (index != null) value = (value + (REGISTER_VALUES[index] & mask) * BigInt(scale)) & mask;
  value = (value + displacement) & mask;
  return Object.freeze({ addressSizeBits, base, index, scale, displacement, value });
}

const session = await createCapstoneX86Session();
let count = 0;
try {
  function verifyBatch(batch) {
    const byteLength = batch.reduce((sum, item) => sum + item.bytes.length, 0);
    const bytes = new Uint8Array(byteLength);
    let offset = 0;
    for (const item of batch) { bytes.set(item.bytes, offset); offset += item.bytes.length; }
    const decoded = session.decode(bytes, 0x100000n + BigInt(count));
    assert.equal(decoded.length, batch.length, `LEA batch decode count drift at ${batch[0].id}`);
    for (let index = 0; index < batch.length; index++) {
      const item = batch[index];
      const decodedItem = decoded[index];
      assert.equal(decodedItem.length, item.bytes.length, `LEA did not consume its encoding: ${item.id}`);
      assert.equal(decodedItem.instructionFamily, 'lea', `wrong family: ${item.id}`);
      const instruction = createX86DecodedInstruction({ ...decodedItem, instructionId:`x86-lea:${item.id}` });
      const effects = liftX86MachineEffects(instruction);
      assert.ok(effects, `LEA escaped effect ownership: ${item.id}`);
      assert.equal(effects.completeness, 'exact', `LEA became partial: ${item.id}:${effects.partialReason}`);
      assert.equal(effects.metadata.operation, 'lea');
      assert.equal(effects.metadata.semanticMemoryAccess, false);
      const source = instruction.detail.operands.find((operand) => operand.type === 'memory');
      const expected = independentLeaAddress(item.bytes, decodedItem.address);
      assert.ok(source, `LEA memory source missing: ${item.id}`);
      assert.deepEqual(
        { base:source.memory.base?.id ?? null, index:source.memory.index?.id ?? null, scale:source.memory.scale, displacement:source.memory.displacement, addressSizeBits:instruction.detail.addressSizeBits },
        { base:expected.base, index:expected.index, scale:expected.scale, displacement:expected.displacement, addressSizeBits:expected.addressSizeBits },
        `LEA structured address drift: ${item.id}`,
      );
      assert.equal(
        evaluateMaterializedAddress(materializeX86Address, instruction, source, REGISTER_VALUES),
        expected.value,
        `LEA effective address drift: ${item.id}`,
      );
      count++;
    }
  }

  let batch = [];
  for (const item of x86Long64LeaEncodingCases()) {
    batch.push(item);
    if (batch.length === 1024) { verifyBatch(batch); batch = []; }
  }
  if (batch.length) verifyBatch(batch);

  // Prefixes are orthogonal to the ModRM/SIB discriminator sweep. Every legal
  // segment override remains address-calculation-only for LEA; REP/REPNE are
  // accepted hints with no state effect, while LOCK and register-source forms
  // are invalid and must not enter the effect registry.
  for (const prefix of [0x26,0x2e,0x36,0x3e,0x64,0x65,0xf2,0xf3]) {
    const [decoded] = session.decode(Uint8Array.of(prefix,0x48,0x8d,0x43,0x10), 0x2000n);
    assert.equal(decoded?.instructionFamily, 'lea', `legal LEA prefix rejected: ${prefix.toString(16)}`);
    const instruction = createX86DecodedInstruction({ ...decoded, instructionId:`x86-lea:prefix:${prefix}` });
    assert.equal(liftX86MachineEffects(instruction)?.completeness, 'exact');
  }
  assert.equal(session.decode(Uint8Array.of(0xf0,0x48,0x8d,0x43,0x10), 0x3000n).length, 0, 'LOCK LEA must be rejected');
  assert.equal(session.decode(Uint8Array.of(0x48,0x8d,0xc0), 0x3000n).length, 0, 'ModRM register source must be rejected');
} finally {
  session.close();
}

assert.equal(count, identity.encodingCaseCount);
console.log(`x86 long-64 LEA denominator (${count} encoding discriminators): PASS`);
