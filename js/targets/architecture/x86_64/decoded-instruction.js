import { x86RegisterDescriptor } from './registers.js';

export const X86_DECODED_INSTRUCTION_CONTRACT_VERSION = 'x86-64-decoded-instruction/v1';
export const X86_DECODER_SEMANTIC_VERSION = 'capstone-5-x86-structured-v2';
export const X86_DECODE_MODES = Object.freeze(['long-64']);

const OPERAND_TYPES = new Set(['register','immediate','memory','invalid']);
const ACCESS = new Set(['read','write','read-write','unknown']);

function integer(value, code, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < min || number > max) throw new TypeError(code);
  return number;
}

function bigint(value, code) {
  try { return BigInt(value); } catch { throw new TypeError(code); }
}

function text(value, code, { empty = false } = {}) {
  const out = String(value ?? '').trim();
  if (!empty && !out) throw new TypeError(code);
  return out;
}

function bytesOf(input, length) {
  const bytes = input instanceof Uint8Array ? input.slice() : Uint8Array.from(input || []);
  if (bytes.length !== length) throw new TypeError('x86-decoded-instruction-byte-length-mismatch');
  return bytes;
}

function accessOf(value) {
  const access = String(value ?? 'unknown');
  if (!ACCESS.has(access)) throw new TypeError('x86-decoded-instruction-invalid-access');
  return access;
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

function normalizeOperand(input, index) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('x86-decoded-instruction-invalid-operand');
  const type = String(input.type ?? input.kind ?? 'invalid').toLowerCase();
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
    const segment = raw.segment == null ? null : String(raw.segment).toLowerCase();
    const scale = raw.scale == null ? 1 : integer(raw.scale, 'x86-decoded-instruction-invalid-memory-scale', { min:1, max:8 });
    if (![1,2,4,8].includes(scale)) throw new TypeError('x86-decoded-instruction-invalid-memory-scale');
    return Object.freeze({
      ...common,
      memory:Object.freeze({
        base,
        index:indexRegister,
        scale,
        displacement:bigint(raw.displacement ?? raw.disp ?? 0, 'x86-decoded-instruction-invalid-displacement'),
        segment,
        addressSizeBits:integer(raw.addressSizeBits ?? 64, 'x86-decoded-instruction-invalid-address-size', { min:16, max:64 }),
      }),
    });
  }
  return Object.freeze(common);
}

function normalizePrefixState(input = {}) {
  const legacy = Uint8Array.from(input.legacy || []);
  if (legacy.length > 4) throw new TypeError('x86-decoded-instruction-too-many-legacy-prefixes');
  const rex = input.rex == null ? null : integer(input.rex, 'x86-decoded-instruction-invalid-rex', { max:255 });
  const vector = input.vector == null ? null : Object.freeze({
    kind:text(input.vector.kind, 'x86-decoded-instruction-vector-prefix-kind'),
    bytes:Uint8Array.from(input.vector.bytes || []),
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
  const operands = rawOperands.map(normalizeOperand);
  const operandCount = integer(rawDetail.operandCount ?? input.operandCount ?? operands.length, 'x86-decoded-instruction-invalid-operand-count', { max:64 });
  if (operandCount !== operands.length) throw new TypeError('x86-decoded-instruction-operand-count-mismatch');
  const result = {
    ...input,
    contractVersion,
    decoderSemanticVersion:text(input.decoderSemanticVersion ?? X86_DECODER_SEMANTIC_VERSION, 'x86-decoder-semantic-version-required'),
    address:bigint(input.address, 'x86-decoded-instruction-address-required'),
    length,
    size:length,
    rawBytes:bytesOf(input.rawBytes ?? input.bytes, length),
    mode,
    instructionId:input.instructionId,
    instructionCode:integer(input.instructionCode ?? input.id, 'x86-decoded-instruction-id-required', { min:1 }),
    instructionFamily:text(input.instructionFamily ?? input.family, 'x86-decoded-instruction-family-required'),
    decoderContractVersion:contractVersion,
    detailStatus:String(input.detailStatus ?? (input.detailAvailable === true ? 'complete' : 'unavailable')),
    detail:Object.freeze({
      ...rawDetail,
      prefixes:normalizePrefixState(rawDetail.prefixes ?? input.prefixes),
      operandCount,
      operands:Object.freeze(operands),
      implicitReads:Object.freeze((rawDetail.implicitReads ?? input.implicitReads ?? []).map((value, index) => registerOf(value, 'x86-decoded-instruction-unknown-implicit-read', { decoderRegisterCode:rawDetail.implicitReadCodes?.[index] }))),
      implicitWrites:Object.freeze((rawDetail.implicitWrites ?? input.implicitWrites ?? []).map((value, index) => registerOf(value, 'x86-decoded-instruction-unknown-implicit-write', { decoderRegisterCode:rawDetail.implicitWriteCodes?.[index] }))),
      conditionCode:(rawDetail.conditionCode ?? input.conditionCode) == null ? null : String(rawDetail.conditionCode ?? input.conditionCode).toLowerCase(),
    }),
    detailAvailable:input.detailAvailable === true || input.detailStatus === 'complete',
    mnemonic:String(input.mnemonic ?? ''),
    opStr:String(input.opStr ?? input.operandString ?? ''),
  };
  return Object.freeze(result);
}

export function x86DecodedInstructionIsStructured(input) {
  try { return createX86DecodedInstruction(input).detailAvailable; } catch { return false; }
}
