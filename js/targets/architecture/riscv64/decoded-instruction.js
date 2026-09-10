import { decodeRiscv64InstructionWord, riscvInstructionLength } from './instruction-word.js';
import { riscv64RegisterDescriptor } from './registers.js';

export const RISCV64_DECODED_INSTRUCTION_CONTRACT_VERSION = 'riscv64-decoded-instruction/v1';
export const RISCV64_DECODER_SEMANTIC_VERSION = 'capstone-5-riscv64-word-exact-v1';
export const RISCV64_DECODE_MODES = Object.freeze(['rv64im', 'rv64imc']);

function text(value, code) {
  const out = String(value ?? '').trim();
  if (!out) throw new TypeError(code);
  return out;
}
// Semantic metadata must be a primitive token already: structured values
// must never coerce into canonical mode/version authority.
function strictToken(value, code) {
  if (typeof value !== 'string') throw new TypeError(code);
  const out = value.trim();
  if (!out) throw new TypeError(code);
  return out;
}
function addressValue(value, code) {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isSafeInteger(value)) return BigInt(value);
  if (typeof value === 'string') {
    const normalized = value.trim();
    if (/^(?:[+-]?\d+|0[xX][0-9a-fA-F]+|0[oO][0-7]+|0[bB][01]+)$/.test(normalized)) {
      try { return BigInt(normalized); } catch { /* fall through to the contract error */ }
    }
  }
  throw new TypeError(code);
}

function exactInteger(value, code) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw new TypeError(code);
  return value;
}

// `rawBytes` are the architectural authority for every decoded field, so each
// element must be a genuine byte. Typed conversion coercion (`Uint8Array.from`)
// must never remap out-of-domain values (275 -> 19) or non-numeric entries into
// a different canonical instruction. Decoder bridges run in separate realms, so
// cross-realm Uint8Array views are recognized via their toStringTag, matching
// the canonical boundary pattern used by the x86-64 decoded instruction.
const TYPED_ARRAY_TAG_GETTER = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(Uint8Array.prototype),
  Symbol.toStringTag,
)?.get;

const UINT8_ARRAY_CONSTRUCTOR = Uint8Array;
const UINT8_ARRAY_SET = UINT8_ARRAY_CONSTRUCTOR.prototype.set;
const UINT8_ARRAY_BYTE_LENGTH_GETTER = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(UINT8_ARRAY_CONSTRUCTOR.prototype),
  'byteLength',
)?.get;

function isUint8ArrayView(value) {
  if (value instanceof Uint8Array) return true;
  if (!ArrayBuffer.isView(value)) return false;
  let tag = null;
  try { tag = TYPED_ARRAY_TAG_GETTER?.call(value) ?? null; } catch { tag = null; }
  return tag === 'Uint8Array';
}

function rawBytesOf(input, expectedLength) {
  if (isUint8ArrayView(input)) {
    let length;
    try {
      length = UINT8_ARRAY_BYTE_LENGTH_GETTER.call(input);
    } catch {
      throw new TypeError('riscv64-decoded-instruction-invalid-raw-bytes');
    }
    if (length !== expectedLength) {
      throw new TypeError('riscv64-decoded-instruction-byte-length-mismatch');
    }
    try {
      const snapshot = new UINT8_ARRAY_CONSTRUCTOR(length);
      UINT8_ARRAY_SET.call(snapshot, input);
      return snapshot;
    } catch {
      throw new TypeError('riscv64-decoded-instruction-invalid-raw-bytes');
    }
  }
  if (!Array.isArray(input)) throw new TypeError('riscv64-decoded-instruction-invalid-raw-bytes');
  const length = input.length;
  if (length !== expectedLength) throw new TypeError('riscv64-decoded-instruction-byte-length-mismatch');
  const bytes = new UINT8_ARRAY_CONSTRUCTOR(length);
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) {
      throw new TypeError('riscv64-decoded-instruction-invalid-raw-bytes');
    }
    const byte = descriptor.value;
    if (typeof byte !== 'number' || !Number.isInteger(byte) || byte < 0 || byte > 0xff) {
      throw new TypeError('riscv64-decoded-instruction-invalid-raw-bytes');
    }
    bytes[index] = byte;
  }
  return bytes;
}

/**
 * Normalize one decoder row into the canonical RISC-V decoded instruction.
 *
 * `rawBytes` is authoritative: architectural fields come from
 * `decodeRiscv64InstructionWord`, not from `mnemonic`/`opStr`. The display
 * strings are carried through for the viewer and for decoder differential
 * tests, and no semantic consumer is permitted to read them.
 */
export function createRiscv64DecodedInstruction(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('riscv64-decoded-instruction-invalid');
  const address = addressValue(input.address, 'riscv64-decoded-instruction-invalid-address');
  const size = exactInteger(input.size ?? input.length, 'riscv64-decoded-instruction-invalid-length');
  if (size !== 2 && size !== 4) throw new TypeError('riscv64-decoded-instruction-invalid-length');
  const rawBytes = rawBytesOf(input.rawBytes ?? [], size);
  if (rawBytes.length !== size) throw new TypeError('riscv64-decoded-instruction-byte-length-mismatch');
  const encodedLength = riscvInstructionLength(rawBytes[0] | (rawBytes[1] << 8));
  if (encodedLength !== size) throw new TypeError('riscv64-decoded-instruction-length-disagrees-with-encoding');

  const fields = decodeRiscv64InstructionWord(rawBytes);
  const mode = strictToken(input.mode === undefined ? 'rv64imc' : input.mode, 'riscv64-decoded-instruction-mode-required');
  if (!RISCV64_DECODE_MODES.includes(mode)) throw new TypeError('riscv64-decoded-instruction-unsupported-mode');
  if (mode === 'rv64im' && size === 2) throw new TypeError('riscv64-decoded-instruction-compressed-disabled');
  const instructionAlignment = exactInteger(
    input.instructionAlignment ?? (mode === 'rv64im' ? 4 : 2),
    'riscv64-decoded-instruction-invalid-instruction-alignment',
  );
  if (![2,4].includes(instructionAlignment)) {
    throw new TypeError('riscv64-decoded-instruction-invalid-instruction-alignment');
  }
  if (mode === 'rv64im' && instructionAlignment !== 4) throw new TypeError('riscv64-decoded-instruction-mode-alignment-mismatch');
  if (mode === 'rv64imc' && instructionAlignment !== 2) throw new TypeError('riscv64-decoded-instruction-mode-alignment-mismatch');
  // ISA/profile evidence must agree: `rv64im` is the no-C profile and `rv64imc`
  // carries compressed capability, so an explicit `compressedInstructions` flag
  // that contradicts the mode publishes contradictory ISA facts (#5999).
  let compressedInstructions = null;
  if (input.compressedInstructions != null) {
    if (typeof input.compressedInstructions !== 'boolean') {
      throw new TypeError('riscv64-decoded-instruction-invalid-compressed-instructions');
    }
    if (input.compressedInstructions !== (mode === 'rv64imc')) {
      // Keep #7010's published diagnostic for an explicit denial of C while
      // retaining #7262's validation of the reverse capability contradiction.
      throw new TypeError(mode === 'rv64imc'
        ? 'riscv64-decoded-instruction-compressed-profile-contradiction'
        : 'riscv64-decoded-instruction-compressed-capability-conflict');
    }
    compressedInstructions = input.compressedInstructions;
  }

  // `rawBytes` is authoritative for `fields`, so the canonical bytes must
  // never share mutable storage with any caller. `Object.freeze` cannot seal
  // typed-array elements, so every read publishes a fresh defensive copy and
  // caller mutation can never desynchronize the encoding from `fields`.
  return Object.freeze({
    architecture: 'riscv64',
    mode,
    instructionAlignment,
    // Identity/provenance fields are typed strings, not display text: a
    // structured value must not launder into a canonical-looking id through
    // String() coercion (#5990).
    ...(input.isaIdentity == null ? {} : { isaIdentity: strictToken(input.isaIdentity, 'riscv64-decoded-instruction-invalid-isa-identity') }),
    ...(input.isaEvidence == null ? {} : { isaEvidence: strictToken(input.isaEvidence, 'riscv64-decoded-instruction-invalid-isa-evidence') }),
    ...(compressedInstructions == null ? {} : { compressedInstructions }),
    address,
    size,
    length: size,
    get rawBytes() { return rawBytes.slice(); },
    // Display-only. Never read by the lifter or by any generic consumer.
    mnemonic: String(input.mnemonic ?? ''),
    opStr: String(input.opStr ?? ''),
    contractVersion: RISCV64_DECODED_INSTRUCTION_CONTRACT_VERSION,
    decoderContractVersion: RISCV64_DECODED_INSTRUCTION_CONTRACT_VERSION,
    decoderSemanticVersion: strictToken(
      input.decoderSemanticVersion === undefined
        ? RISCV64_DECODER_SEMANTIC_VERSION : input.decoderSemanticVersion,
      'riscv64-decoded-instruction-invalid-decoder-semantic-version',
    ),
    // Structured architectural truth.
    fields,
    // `instructionFamily` is the canonical architectural operation recovered
    // from the encoding (`addi`, `beq`, `jal`, ...), not the printer's alias.
    instructionFamily: fields.supported ? fields.op : 'unsupported',
    compressed: fields.supported ? fields.compressed === true : null,
    detailAvailable: fields.supported === true,
    detailStatus: fields.supported ? 'complete' : 'unsupported-encoding',
    ...(input.instructionId == null ? {} : { instructionId: strictToken(input.instructionId, 'riscv64-decoded-instruction-invalid-instruction-id') }),
    ...(input.origin == null ? {} : { origin: input.origin }),
  });
}

/** True when every register field of a decoded instruction resolves physically. */
export function riscv64DecodedRegistersResolve(decoded) {
  const fields = decoded?.fields;
  if (!fields?.supported) return false;
  return [fields.rd, fields.rs1, fields.rs2]
    .filter((value) => value != null)
    .every((value) => riscv64RegisterDescriptor(value) != null);
}
