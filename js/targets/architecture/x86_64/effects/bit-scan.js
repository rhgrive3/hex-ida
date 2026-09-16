import { x86MemoryFaults } from './common.js';
import { x86RegisterDescriptor } from '../registers.js';
import { materializeX86Address } from './addressing.js';
import { emitX86UndefinedFlags } from './flags.js';

const STRUCTURED_DECODER_SEMANTIC_VERSION = 'capstone-5-x86-structured-v2';
const STRUCTURED_DECODER_ABI = 'capstone-5-wasm32-x86-detail/v1';
const ENCODED_GPRS = Object.freeze([
  'rax', 'rcx', 'rdx', 'rbx', 'rsp', 'rbp', 'rsi', 'rdi',
  'r8', 'r9', 'r10', 'r11', 'r12', 'r13', 'r14', 'r15',
]);

function encodedGpr(index, width) {
  const full = ENCODED_GPRS[index];
  if (full == null) return null;
  if (width === 64) return full;
  if (index < 8) {
    const aliases = width === 32
      ? ['eax','ecx','edx','ebx','esp','ebp','esi','edi']
      : ['ax','cx','dx','bx','sp','bp','si','di'];
    return aliases[index];
  }
  return `${full}${width === 32 ? 'd' : 'w'}`;
}

function signedDisplacement(bytes, offset, size) {
  let value = 0n;
  for (let index = 0; index < size; index++) value |= BigInt(bytes[offset + index]) << BigInt(index * 8);
  const bits = BigInt(size * 8);
  return (value & (1n << (bits - 1n))) === 0n ? value : value - (1n << bits);
}

function parseBitScanEncoding(bytes, modrmOffset, rex) {
  const modrm = bytes[modrmOffset];
  const mod = modrm >>> 6;
  let end = modrmOffset + 1;
  let displacementSize = 0;
  let base = null;
  let index = null;
  let scale = 1;
  if (mod !== 3) {
    const rm = modrm & 7;
    let sibBase = null;
    if (rm === 4) {
      if (end >= bytes.length) return null;
      const sib = bytes[end];
      sibBase = sib & 7;
      const sibIndex = (sib >>> 3) & 7;
      scale = 1 << (sib >>> 6);
      if (sibIndex !== 4 || (rex & 0x02) !== 0) index = ENCODED_GPRS[sibIndex + ((rex & 0x02) !== 0 ? 8 : 0)];
      if (mod !== 0 || sibBase !== 5) base = ENCODED_GPRS[sibBase + ((rex & 0x01) !== 0 ? 8 : 0)];
      end++;
    } else if (mod === 0 && rm === 5) {
      base = 'rip';
    } else {
      base = ENCODED_GPRS[rm + ((rex & 0x01) !== 0 ? 8 : 0)];
    }
    if (mod === 1) displacementSize = 1;
    else if (mod === 2 || (mod === 0 && (rm === 5 || sibBase === 5))) displacementSize = 4;
  }
  const displacementOffset = displacementSize === 0 ? 0 : end;
  if (end + displacementSize > bytes.length) return null;
  return {
    modrm, mod, end:end + displacementSize, displacementOffset, displacementSize,
    destinationIndex:((modrm >>> 3) & 7) + ((rex & 0x04) !== 0 ? 8 : 0),
    sourceIndex:(modrm & 7) + ((rex & 0x01) !== 0 ? 8 : 0),
    base, index, scale,
    displacement:displacementSize === 0 ? 0n : signedDisplacement(bytes, displacementOffset, displacementSize),
    sib:mod !== 3 && (modrm & 7) === 4 ? bytes[modrmOffset + 1] : 0,
  };
}

function sameRegister(operand, expectedName) {
  const expected = x86RegisterDescriptor(expectedName);
  return operand?.register?.id === expected?.id
    && operand.register.physicalId === expected.physicalId
    && operand.register.viewBits === expected.viewBits;
}

function validateBitScanEncoding(instruction, family, destination, source) {
  const width = Number(destination?.widthBits);
  if (instruction.mode !== 'long-64' || !instruction.detailAvailable || instruction.detailStatus !== 'complete') return false;
  if (instruction.decoderSemanticVersion !== STRUCTURED_DECODER_SEMANTIC_VERSION
    || instruction.detail.abiContractVersion !== STRUCTURED_DECODER_ABI) return false;
  if (!(instruction.rawBytes instanceof Uint8Array) || instruction.rawBytes.length !== instruction.length) return false;
  if (!['bsf', 'bsr'].includes(family) || ![16, 32, 64].includes(width)) return false;
  if (instruction.detail.operands.length !== 2 || destination?.type !== 'register') return false;
  if (!['register', 'memory'].includes(source?.type) || Number(source.widthBits) !== width) return false;
  if (destination.access !== 'write' || source.access !== 'read') return false;
  if (instruction.detail.prefixes.vector != null || (instruction.detail.unavailableFacts || []).length !== 0) return false;
  if ((instruction.detail.implicitReads || []).length !== 0) return false;
  const implicitWrites = (instruction.detail.implicitWrites || []).map((register) => register?.physicalId);
  if (implicitWrites.length !== 1 || implicitWrites[0] !== 'rflags') return false;

  const bytes = instruction.rawBytes;
  const legacy = [...instruction.detail.prefixes.legacy];
  if (legacy.some((byte) => byte !== 0x66) || legacy.length > 1) return false;
  let offset = 0;
  if (legacy.length === 1) {
    if (bytes[offset] !== 0x66) return false;
    offset++;
  }
  const rex = instruction.detail.prefixes.rex;
  if (rex != null) {
    if (rex < 0x40 || rex > 0x4f || bytes[offset] !== rex) return false;
    offset++;
  }
  if (bytes[offset] !== 0x0f || bytes[offset + 1] !== (family === 'bsf' ? 0xbc : 0xbd)) return false;
  const modrmOffset = offset + 2;
  if (modrmOffset >= bytes.length || instruction.detail.encodingOffsets?.modrmOffset !== modrmOffset) return false;
  const modrm = bytes[modrmOffset];
  if (instruction.detail.modrm !== modrm) return false;
  if ((source.type === 'register') !== ((modrm >>> 6) === 3)) return false;
  const encoding = parseBitScanEncoding(bytes, modrmOffset, rex ?? 0);
  if (encoding == null || instruction.detail.addressSizeBits !== 64 || encoding.end !== bytes.length) return false;
  if (instruction.detail.encodingOffsets?.displacementSize !== encoding.displacementSize
    || instruction.detail.encodingOffsets?.displacementOffset !== encoding.displacementOffset) return false;
  if (instruction.detail.sib !== encoding.sib) return false;
  if (instruction.detail.encodingOffsets?.immediateOffset !== 0
    || instruction.detail.encodingOffsets?.immediateSize !== 0) return false;
  const encodedWidth = rex != null && (rex & 0x08) !== 0 ? 64 : legacy.length === 1 ? 16 : 32;
  if (encodedWidth !== width || (width !== 64 && rex != null && (rex & 0x08) !== 0)) return false;
  if (!sameRegister(destination, encodedGpr(encoding.destinationIndex, width))) return false;
  if (source.type === 'register') {
    if (!sameRegister(source, encodedGpr(encoding.sourceIndex, width))) return false;
  } else {
    const memory = source.memory;
    if (memory?.addressSizeBits !== 64 || memory.segment != null) return false;
    if ((memory.base?.id ?? null) !== encoding.base || (memory.index?.id ?? null) !== encoding.index
      || memory.scale !== encoding.scale || memory.displacement !== encoding.displacement) return false;
  }
  return instruction.detail.opcodeBytes?.[0] === 0x0f
    && instruction.detail.opcodeBytes?.[1] === (family === 'bsf' ? 0xbc : 0xbd);
}

export function liftX86BitScanEffects(ctx) {
  const [destination, sourceOperand] = ctx.operands;
  const width = Number(destination?.widthBits);
  if (!validateBitScanEncoding(ctx.instruction, ctx.family, destination, sourceOperand)) {
    return ctx.partial('x86-bit-scan-decoded-form-not-proven', ['memory', 'registers', 'flags', 'other'], {
      possibleFaults:sourceOperand?.type === 'memory' && [16, 32, 64].includes(Number(sourceOperand.widthBits))
        ? x86MemoryFaults('read', Number(sourceOperand.widthBits)) : [],
      metadata:{
        family:'bit-manipulation',
        operation:ctx.family,
        encodingValidated:false,
        exactArchitecturalSummary:false,
      },
    });
  }

  const faults = [];
  let source = null;
  if (sourceOperand.type === 'register') {
    source = ctx.readRegister(sourceOperand);
  } else {
    const address = materializeX86Address(ctx, sourceOperand);
    if (address != null) {
      source = ctx.readMemory(address, width, { metadata:{ operation:ctx.family, sourceForm:'memory' } });
      faults.push(...x86MemoryFaults('read', width));
    }
  }
  if (source == null) {
    return ctx.partial('x86-bit-scan-source-not-representable', ['memory', 'registers', 'flags'], {
      possibleFaults:faults,
      metadata:{ operation:ctx.family, encodingValidated:false, exactArchitecturalSummary:false },
    });
  }

  const fullMask = `0x${((1n << BigInt(width)) - 1n).toString(16)}`;
  const [result] = ctx.intrinsic(`x86.integer.${ctx.family}.destination`, [source], [width], {
    determinism:'input-dependent',
    symbolicDetail:'summary-only',
    undefinedResult:{
      widthBits:width,
      mask:fullMask,
      class:'conditional',
      reason:`x86-${ctx.family}-source-zero-destination-undefined`,
      condition:{ kind:'source-zero', operandIndex:0 },
    },
    metadata:{
      operation:ctx.family,
      resultRole:'destination',
      sourceZeroBehavior:'destination-fully-undefined',
      nonzeroBehavior:`${ctx.family}-bit-index`,
      exactArchitecturalSummary:true,
    },
  });
  ctx.writeRegister(destination, result);

  const [zeroFlag] = ctx.intrinsic(`x86.integer.${ctx.family}.zero-flag`, [source], [1], {
    determinism:'input-dependent',
    symbolicDetail:'summary-only',
    metadata:{ operation:ctx.family, resultRole:'ZF', semanticRule:'source-equals-zero', exactArchitecturalSummary:true },
  });
  ctx.writeFlag('ZF', zeroFlag, { operation:ctx.family, definedness:'defined', semanticRule:'source-equals-zero' });
  emitX86UndefinedFlags(ctx, ['CF', 'PF', 'AF', 'SF', 'OF'], ctx.family, width, {
    semanticRule:'architecturally-undefined-after-bit-scan',
  });

  return ctx.finish({
    family:'integer',
    possibleFaults:faults,
    metadata:{
      operation:ctx.family,
      sourceForm:sourceOperand.type,
      operandWidthBits:width,
      encodingValidated:true,
      exactArchitecturalSummary:true,
      undefinedDestinationCondition:'source-zero',
    },
  });
}
