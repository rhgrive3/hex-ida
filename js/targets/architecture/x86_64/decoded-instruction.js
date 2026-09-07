import { x86RegisterDescriptor } from './registers.js';

export const X86_DECODED_INSTRUCTION_CONTRACT_VERSION = 'x86-64-decoded-instruction/v1';
export const X86_DECODER_SEMANTIC_VERSION = 'capstone-5-x86-structured-v2';
export const X86_DECODE_MODES = Object.freeze(['long-64']);

const OPERAND_TYPES = new Set(['register','immediate','memory','invalid']);
const ACCESS = new Set(['read','write','read-write','unknown']);
const DETAIL_STATUSES = new Set(['complete','unavailable','partial','malformed','skipdata']);
const SEGMENT_REGISTERS = new Set(['cs','ds','es','fs','gs','ss']);
// Per-decode-mode legal effective address sizes. 64-bit mode supports 64-bit
// and 0x67-prefixed 32-bit addressing only; 16-bit addresses are unsupported.
const ADDRESS_SIZE_BITS_BY_MODE = Object.freeze({ 'long-64': Object.freeze([32, 64]) });

function integer(value, code, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new TypeError(code);
  }
  return value;
}

function bigint(value, code) {
  if (typeof value !== 'bigint') throw new TypeError(code);
  return value;
}

function text(value, code, { empty = false } = {}) {
  if (typeof value !== 'string') throw new TypeError(code);
  const out = value.trim();
  if (!empty && !out) throw new TypeError(code);
  return out;
}

// Semantic allow-list tokens at the decoder trust boundary must be primitive
// strings: `String()` coercion would let arbitrary objects/arrays mint
// canonical `register`/`write`/`long-64` authority from `toString()`.
function token(value, code) {
  if (typeof value !== 'string') throw new TypeError(code);
  return value;
}

function instructionIdOf(value) {
  if (value == null) return value;
  if (typeof value !== 'string') throw new TypeError('x86-decoded-instruction-invalid-instruction-id');
  const instructionId = value.trim();
  if (!instructionId) throw new TypeError('x86-decoded-instruction-invalid-instruction-id');
  return instructionId;
}

function detailStatusOf(value, detailAvailable) {
  if (value == null) return detailAvailable === true ? 'complete' : 'unavailable';
  const status = value;
  if (typeof status !== 'string' || !DETAIL_STATUSES.has(status)) {
    throw new TypeError('x86-decoded-instruction-invalid-detail-status');
  }
  // detailStatus is the single authority, but an explicitly passed boolean
  // detailAvailable that contradicts it is malformed evidence, not a default
  // to override: complete/true and unavailable/false are the only coherent
  // pairs (non-complete statuses imply unavailable detail).
  if (typeof detailAvailable === 'boolean' && (detailAvailable === true) !== (status === 'complete')) {
    throw new TypeError('x86-decoded-instruction-detail-availability-contradiction');
  }
  return status;
}

function conditionCodeOf(value) {
  if (value == null) return null;
  if (typeof value !== 'string') throw new TypeError('x86-decoded-instruction-invalid-condition-code');
  return value.toLowerCase();
}

function addressSizeBitsOf(value, mode) {
  const allowed = ADDRESS_SIZE_BITS_BY_MODE[mode];
  const size = integer(value, 'x86-decoded-instruction-invalid-address-size', { min:1, max:64 });
  if (!allowed || !allowed.includes(size)) throw new TypeError('x86-decoded-instruction-invalid-address-size');
  return size;
}

function bytesOf(input, length) {
  const bytes = input instanceof Uint8Array ? input.slice() : Uint8Array.from(input || []);
  if (bytes.length !== length) throw new TypeError('x86-decoded-instruction-byte-length-mismatch');
  return bytes;
}

function accessOf(value) {
  const access = token(value ?? 'unknown', 'x86-decoded-instruction-invalid-access');
  if (!ACCESS.has(access)) throw new TypeError('x86-decoded-instruction-invalid-access');
  return access;
}

function segmentOf(value) {
  if (value == null) return null;
  if (typeof value !== 'string') throw new TypeError('x86-decoded-instruction-invalid-memory-segment');
  const segment = value.toLowerCase();
  if (!SEGMENT_REGISTERS.has(segment)) throw new TypeError('x86-decoded-instruction-invalid-memory-segment');
  return segment;
}

function supplementaryRegisterShape(value, hintedWidthBits) {
  const name = String(typeof value === 'object' ? (value?.id ?? value?.name ?? value?.registerId ?? '') : value ?? '').trim().toLowerCase();
  const hinted = Number(hintedWidthBits);
  const width = Number.isSafeInteger(hinted) && hinted > 0 ? hinted : null;
  const fixed = [
    [/^st\([0-7]\)$/,80,'x87'], [/^mm[0-7]$/,64,'mmx'], [/^k[0-7]$/,width || 64,'mask'],
    [/^xmm(?:1[6-9]|2[0-9]|3[01])$/,128,'vector'], [/^ymm(?:1[6-9]|2[0-9]|3[01])$/,256,'vector'],
    [/^zmm(?:[0-9]|[12][0-9]|3[01])$/,512,'vector'], [/^bnd[0-3]$/,128,'bounds'],
    [/^cr(?:[0-9]|1[0-5])$/,64,'control-register'], [/^dr(?:[0-9]|1[0-5])$/,64,'debug-register'],
    [/^(?:cs|ds|es|fs|gs|ss)$/,16,'segment'], [/^fpsw$/,16,'x87-status'], [/^fpcw$/,16,'x87-control'],
  ];
  for (const [pattern,bits,kind] of fixed) if (pattern.test(name)) return { name, bits:Number(bits), kind };
  return null;
}

function registerOf(value, code, { decoderRegisterCode = null, widthBits = null } = {}) {
  const descriptor = x86RegisterDescriptor(value);
  if (descriptor) return descriptor;
  const decoderCode = Number(decoderRegisterCode);
  const shape = Number.isSafeInteger(decoderCode) && decoderCode > 0 ? supplementaryRegisterShape(value, widthBits) : null;
  if (!shape) throw new TypeError(code);
  return Object.freeze({
    id:shape.name,
    physicalId:shape.name,
    physicalBits:shape.bits,
    viewBits:shape.bits,
    lsb:0,
    writePolicy:'replace',
    kind:'decoder-supplementary',
    architecturalKind:shape.kind,
    modeled:false,
    decoderSupplementary:true,
    decoderRegisterCode:decoderCode,
  });
}

function normalizeOperand(input, index, mode) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('x86-decoded-instruction-invalid-operand');
  const type = token(input.type ?? input.kind ?? 'invalid', 'x86-decoded-instruction-invalid-operand-type').toLowerCase();
  if (!OPERAND_TYPES.has(type)) throw new TypeError('x86-decoded-instruction-invalid-operand-type');
  const widthBits = input.widthBits == null ? null : integer(input.widthBits, 'x86-decoded-instruction-invalid-operand-width', { min:1, max:4096 });
  const common = { index, type, access:accessOf(input.access), ...(widthBits == null ? {} : { widthBits }) };
  if (type === 'register') {
    let register = registerOf(input.register ?? input.registerId ?? input.name, 'x86-decoded-instruction-unknown-register', { decoderRegisterCode:input.registerCode ?? input.register?.decoderRegisterCode, widthBits });
    if (widthBits != null && widthBits !== register.viewBits) {
      if (register.kind === 'opmask' && register.physicalBits === 64 && widthBits <= 64) {
        register = Object.freeze({ ...register, viewBits:widthBits, writePolicy:'decoder-dependent-opmask-width', decoderNarrowView:true });
      } else throw new TypeError('x86-decoded-instruction-register-width-mismatch');
    }
    return Object.freeze({ ...common, widthBits:register.viewBits, register });
  }
  if (type === 'immediate') {
    return Object.freeze({
      ...common,
      value:bigint(input.value, 'x86-decoded-instruction-invalid-immediate'),
      ...(input.encodedWidthBits == null ? {} : { encodedWidthBits:integer(input.encodedWidthBits, 'x86-decoded-instruction-invalid-immediate-width', { min:1, max:64 }) }),
    });
  }
  if (type === 'memory') {
    const raw = input.memory && typeof input.memory === 'object' ? input.memory : input;
    const base = raw.base == null ? null : registerOf(raw.base, 'x86-decoded-instruction-unknown-memory-base', { decoderRegisterCode:raw.baseCode ?? raw.base?.decoderRegisterCode, widthBits:raw.base?.viewBits });
    const indexRegister = raw.index == null ? null : registerOf(raw.index, 'x86-decoded-instruction-unknown-memory-index', { decoderRegisterCode:raw.indexCode ?? raw.index?.decoderRegisterCode, widthBits:raw.index?.viewBits });
    const segment = segmentOf(raw.segment);
    const scale = raw.scale == null ? 1 : integer(raw.scale, 'x86-decoded-instruction-invalid-memory-scale', { min:1, max:8 });
    if (![1,2,4,8].includes(scale)) throw new TypeError('x86-decoded-instruction-invalid-memory-scale');
    return Object.freeze({
      ...common,
      memory:Object.freeze({
        base,
        index:indexRegister,
        scale,
        displacement:bigint(
          raw.displacement === undefined
            ? (raw.disp === undefined ? 0n : raw.disp)
            : raw.displacement,
          'x86-decoded-instruction-invalid-displacement',
        ),
        segment,
        addressSizeBits:addressSizeBitsOf(raw.addressSizeBits ?? 64, mode),
      }),
    });
  }
  return Object.freeze(common);
}

function prefixBytesOf(input, code) {
  if (input == null) return new Uint8Array();
  if (input instanceof Uint8Array) return input.slice();
  if (!Array.isArray(input)) throw new TypeError(code);
  const bytes = new Uint8Array(input.length);
  for (let index = 0; index < input.length; index += 1) {
    if (!Object.hasOwn(input, index)) throw new TypeError(code);
    const byte = input[index];
    if (typeof byte !== 'number' || !Number.isInteger(byte) || byte < 0 || byte > 0xff) {
      throw new TypeError(code);
    }
    bytes[index] = byte;
  }
  return bytes;
}

function normalizePrefixState(input = {}) {
  const legacy = prefixBytesOf(input.legacy, 'x86-decoded-instruction-invalid-legacy-prefix-byte');
  if (legacy.length > 4) throw new TypeError('x86-decoded-instruction-too-many-legacy-prefixes');
  const rex = input.rex == null ? null : integer(input.rex, 'x86-decoded-instruction-invalid-rex', { max:255 });
  const vector = input.vector == null ? null : Object.freeze({
    kind:text(input.vector.kind, 'x86-decoded-instruction-vector-prefix-kind'),
    bytes:prefixBytesOf(input.vector.bytes, 'x86-decoded-instruction-invalid-vector-prefix-byte'),
  });
  return Object.freeze({ legacy, rex, vector });
}

export function createX86DecodedInstruction(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('x86-decoded-instruction-required');
  const contractVersion = input.contractVersion ?? X86_DECODED_INSTRUCTION_CONTRACT_VERSION;
  if (contractVersion !== X86_DECODED_INSTRUCTION_CONTRACT_VERSION) throw new TypeError('x86-decoded-instruction-contract-version-mismatch');
  const length = integer(input.length ?? input.size, 'x86-decoded-instruction-invalid-length', { min:1, max:15 });
  const mode = text(input.mode ?? 'long-64', 'x86-decoded-instruction-mode-required');
  if (!X86_DECODE_MODES.includes(mode)) throw new TypeError('x86-decoded-instruction-mode-unsupported');
  const rawDetail = input.detail && typeof input.detail === 'object' ? input.detail : {};
  const rawOperands = rawDetail.operands ?? input.structuredOperands ?? (Array.isArray(input.operands) ? input.operands : []);
  const operands = rawOperands.map((operand, index) => normalizeOperand(operand, index, mode));
  const operandCount = integer(rawDetail.operandCount ?? input.operandCount ?? operands.length, 'x86-decoded-instruction-invalid-operand-count', { max:64 });
  if (operandCount !== operands.length) throw new TypeError('x86-decoded-instruction-operand-count-mismatch');
  // Strip provider-zero/nullish address-size metadata from the copied detail.
  // It means "not stated" and must not survive the raw detail spread as
  // canonical width authority.
  const { addressSizeBits:rawAddressSizeBits, ...detailWithoutAddressSizeBits } = rawDetail;
  // `detailStatus` is the single authority for decoder-detail availability.
  // Only canonical primitive status tokens are accepted: structured values
  // must never acquire exact-detail authority through String() coercion.
  // Legacy detailAvailable-only callers still map to complete/unavailable.
  const detailStatus = detailStatusOf(input.detailStatus, input.detailAvailable);
  const rawBytes = bytesOf(input.rawBytes ?? input.bytes, length);
  // This constructor only mints x86_64 records. A foreign architecture
  // identity (or two disagreeing ones) is a contradictory record, not a
  // defaultable field.
  for (const key of ['architecture', 'architectureId']) {
    const value = input[key];
    if (value != null && String(value).trim().toLowerCase() !== 'x86_64') {
      throw new TypeError('x86-decoded-instruction-architecture-mismatch');
    }
  }
  const result = {
    ...input,
    architecture: 'x86_64',
    architectureId: 'x86_64',
    contractVersion,
    decoderSemanticVersion:text(input.decoderSemanticVersion ?? X86_DECODER_SEMANTIC_VERSION, 'x86-decoder-semantic-version-required'),
    address:bigint(input.address, 'x86-decoded-instruction-address-required'),
    length,
    size:length,
    // The authoritative encoding must never share mutable storage with a
    // caller: `Object.freeze` cannot seal typed-array elements, so every read
    // publishes a fresh defensive copy.
    get rawBytes() { return rawBytes.slice(); },
    mode,
    instructionId:instructionIdOf(input.instructionId),
    // Capstone SKIPDATA records carry instruction id 0 by contract
    // (cs_insn.id is 0 in Skipdata mode). The zero code is admitted only
    // for skipdata records and must be exactly 0; every other record keeps
    // the historical min:1 domain.
    instructionCode:detailStatus === 'skipdata'
      ? integer(input.instructionCode ?? input.id, 'x86-decoded-instruction-id-required', { min:0, max:0 })
      : integer(input.instructionCode ?? input.id, 'x86-decoded-instruction-id-required', { min:1 }),
    instructionFamily:text(input.instructionFamily ?? input.family, 'x86-decoded-instruction-family-required'),
    decoderContractVersion:contractVersion,
    detailStatus,
    detail:Object.freeze({
      ...detailWithoutAddressSizeBits,
      // The provider leaves addressSizeBits 0 when Capstone does not populate
      // `addr_size` (no memory operand); 0 is "not stated", not a width.
      ...(rawAddressSizeBits == null || rawAddressSizeBits === 0
        ? {}
        : { addressSizeBits:addressSizeBitsOf(rawAddressSizeBits, mode) }),
      prefixes:normalizePrefixState(rawDetail.prefixes ?? input.prefixes),
      operandCount,
      operands:Object.freeze(operands),
      implicitReads:Object.freeze((rawDetail.implicitReads ?? input.implicitReads ?? []).map((value, index) => registerOf(value, 'x86-decoded-instruction-unknown-implicit-read', { decoderRegisterCode:rawDetail.implicitReadCodes?.[index] }))),
      implicitWrites:Object.freeze((rawDetail.implicitWrites ?? input.implicitWrites ?? []).map((value, index) => registerOf(value, 'x86-decoded-instruction-unknown-implicit-write', { decoderRegisterCode:rawDetail.implicitWriteCodes?.[index] }))),
      conditionCode:conditionCodeOf(rawDetail.conditionCode ?? input.conditionCode),
    }),
    detailAvailable:detailStatus === 'complete',
    mnemonic:String(input.mnemonic ?? ''),
    opStr:String(input.opStr ?? input.operandString ?? ''),
  };
  return Object.freeze(result);
}

export function x86DecodedInstructionIsStructured(input) {
  try { return createX86DecodedInstruction(input).detailAvailable; } catch { return false; }
}
