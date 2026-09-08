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
function bigint(value, code) {
  try { return BigInt(value); } catch { throw new TypeError(code); }
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

function isUint8ArrayView(value) {
  if (value instanceof Uint8Array) return true;
  if (!ArrayBuffer.isView(value)) return false;
  let tag = null;
  try { tag = TYPED_ARRAY_TAG_GETTER?.call(value) ?? null; } catch { tag = null; }
  return tag === 'Uint8Array';
}

function rawBytesOf(input, expectedLength) {
  if (isUint8ArrayView(input)) {
    if (input.byteLength !== expectedLength) throw new TypeError('riscv64-decoded-instruction-byte-length-mismatch');
    return Uint8Array.from(input);
  }
  if (!Array.isArray(input)) throw new TypeError('riscv64-decoded-instruction-invalid-raw-bytes');
  if (input.length !== expectedLength) throw new TypeError('riscv64-decoded-instruction-byte-length-mismatch');
  const bytes = new Uint8Array(expectedLength);
  for (let index = 0; index < expectedLength; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
    /* A getter is not a stable byte authority: reading it can observe or
     * mutate state, so reject accessor-backed array entries before invoking
     * user code. */
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
  const address = bigint(input.address, 'riscv64-decoded-instruction-invalid-address');
  const size = Number(input.size ?? input.length);
  if (size !== 2 && size !== 4) throw new TypeError('riscv64-decoded-instruction-invalid-length');
  const rawBytes = rawBytesOf(input.rawBytes ?? [], size);
  if (rawBytes.length !== size) throw new TypeError('riscv64-decoded-instruction-byte-length-mismatch');
  const encodedLength = riscvInstructionLength(rawBytes[0] | (rawBytes[1] << 8));
  if (encodedLength !== size) throw new TypeError('riscv64-decoded-instruction-length-disagrees-with-encoding');

  const fields = decodeRiscv64InstructionWord(rawBytes);
  const mode = strictToken(input.mode === undefined ? 'rv64imc' : input.mode, 'riscv64-decoded-instruction-mode-required');
  if (!RISCV64_DECODE_MODES.includes(mode)) throw new TypeError('riscv64-decoded-instruction-unsupported-mode');
  if (mode === 'rv64im' && size === 2) throw new TypeError('riscv64-decoded-instruction-compressed-disabled');
  const instructionAlignment = Number(input.instructionAlignment ?? (mode === 'rv64im' ? 4 : 2));
  if (!Number.isSafeInteger(instructionAlignment) || ![2,4].includes(instructionAlignment)) {
    throw new TypeError('riscv64-decoded-instruction-invalid-instruction-alignment');
  }
  if (mode === 'rv64im' && instructionAlignment !== 4) throw new TypeError('riscv64-decoded-instruction-mode-alignment-mismatch');
  if (mode === 'rv64imc' && instructionAlignment !== 2) throw new TypeError('riscv64-decoded-instruction-mode-alignment-mismatch');

  // ISA profile metadata must agree with the C-extension capability the
  // record itself asserts (#5999). A non-boolean value is schema-invalid, and
  // either boolean that disagrees with the decode mode is contradictory
  // evidence; neither may be laundered into a canonical profile flag.
  let compressedInstructions = null;
  if (input.compressedInstructions != null) {
    if (typeof input.compressedInstructions !== 'boolean') {
      throw new TypeError('riscv64-decoded-instruction-invalid-compressed-instructions');
    }
    if (input.compressedInstructions !== (mode === 'rv64imc')) {
      throw new TypeError('riscv64-decoded-instruction-compressed-profile-contradiction');
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
    ...(input.isaIdentity == null ? {} : {
      isaIdentity:strictToken(input.isaIdentity, 'riscv64-decoded-instruction-invalid-isa-identity'),
    }),
    ...(input.isaEvidence == null ? {} : {
      isaEvidence:strictToken(input.isaEvidence, 'riscv64-decoded-instruction-invalid-isa-evidence'),
    }),
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
    ...(input.instructionId == null ? {} : {
      instructionId:strictToken(input.instructionId, 'riscv64-decoded-instruction-invalid-instruction-id'),
    }),
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
