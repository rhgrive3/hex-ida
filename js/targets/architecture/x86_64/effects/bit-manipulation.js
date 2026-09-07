import { createMemoryAccess } from '../../../../semantics/effects/index.js';
import { createX86EffectContext, x86MemoryFaults, x86RegisterOperand } from './common.js';
import { x86RegisterDescriptor } from '../registers.js';
import { materializeX86Address, x86EffectiveAddressExpression } from './addressing.js';
import { emitX86UndefinedFlags } from './flags.js';

const BIT_MANIP_NAMES = new Set([
  'adcx', 'adox', 'bsf', 'bsr', 'bswap', 'bt', 'btc', 'btr', 'bts', 'crc32', 'lzcnt', 'popcnt', 'tzcnt',
  'andn', 'bextr', 'blsi', 'blsmsk', 'blsr', 'bzhi', 'mulx', 'pdep', 'pext', 'rorx', 'sarx', 'shlx', 'shrx',
  'blcfill', 'blci', 'blcic', 'blcmsk', 'blcs', 'blsfill', 'blsic', 't1mskc', 'tzmsk',
  'movbe', 'rcl', 'rcr', 'shld', 'shrd',
  'enter', 'leave', 'xlatb', 'xlat',
]);

const MEMORY_BIT_STRING_NAMES = new Set(['bt', 'btc', 'btr', 'bts']);
const PROVEN_GENERIC_BIT_MANIPULATION_FAMILIES = new Set([]);
const STRUCTURED_DECODER_SEMANTIC_VERSION = 'capstone-5-x86-structured-v2';
const STRUCTURED_DECODER_ABI = 'capstone-5-wasm32-x86-detail/v1';

function hasLock(instruction) {
  return [...(instruction?.detail?.prefixes?.legacy || [])].includes(0xf0);
}

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

function liftBitScan(ctx) {
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

export function liftX86BitManipulationEffects(instruction, context = {}) {
  const family = String(instruction?.instructionFamily || '').toLowerCase();
  if (!BIT_MANIP_NAMES.has(family)) return null;
  const ctx = createX86EffectContext(instruction, context);
  const operands = ctx.operands;
  const hasMemory = operands.some((op) => op?.type === 'memory');
  const faults = [];
  const inputs = [], registersRead = [], registersWritten = [], memoryReads = [], memoryWrites = [];

  // LOCK changes these operations into atomic read-modify-write transactions.
  // This generic intrinsic lane does not yet carry that ordering contract, so
  // consuming the instruction here would silently discard architectural
  // atomicity.  Keep ownership, but fail closed until the atomic lane models it.
  if (hasLock(ctx.instruction)) {
    return ctx.partial(
      hasMemory ? 'x86-lock-prefixed-family-not-modelled-in-bit-manipulation' : 'x86-lock-prefix-without-memory-operand',
      ['memory', 'registers', 'flags', 'other'],
      { metadata:{ family:'bit-manipulation', operation:family, lockPrefix:true, lockIgnored:false } },
    );
  }

  if (family === 'bsf' || family === 'bsr') return liftBitScan(ctx);

  // Intel memory BT/BTC/BTR/BTS operands are bit strings: an out-of-element
  // bit index selects a different byte/word/dword/qword beyond the encoded
  // effective address.  A plain memory access at the encoded address is not an
  // exact summary, even without LOCK.  Preserve conservative ownership until
  // that index-derived address adjustment is represented explicitly.
  if (MEMORY_BIT_STRING_NAMES.has(family) && operands[0]?.type === 'memory') {
    const width = Number(operands[0].widthBits || 32);
    return ctx.partial('x86-memory-bit-string-address-adjustment-unmodelled', ['memory', 'registers', 'flags'], {
      possibleFaults:x86MemoryFaults(family === 'bt' ? 'read' : 'read-write', width),
      metadata:{ family:'bit-manipulation', operation:family, bitStringAddressing:true },
    });
  }

  if (!PROVEN_GENERIC_BIT_MANIPULATION_FAMILIES.has(family)) {
    return ctx.partial('x86-bit-manipulation-family-requires-dedicated-semantics', ['memory', 'registers', 'flags', 'other'], {
      metadata:{
        family:'bit-manipulation',
        operation:family,
        exactArchitecturalSummary:false,
        requiresDedicatedOperandRoles:true,
      },
    });
  }

  if (family === 'leave') {
    const rbp = x86RegisterOperand('rbp');
    const rsp = x86RegisterOperand('rsp');
    const rbpVal = ctx.readRegister(rbp);
    if (!rbpVal) return ctx.partial('x86-leave-rbp-unmodelled', ['registers']);
    ctx.writeRegister(rsp, rbpVal);
    const read = ctx.readMemory(rbpVal, 64, { metadata: { stackAccess: true, leavePop: true } });
    memoryReads.push(createMemoryAccess({ space: 'memory', addressExpr: rbpVal, widthBits: 64, endian: 'little' }));
    faults.push(...x86MemoryFaults('read', 64));
    const nextRsp = ctx.valueOp('add', [rbpVal, ctx.constant(64, 8n)], 64, { stackDelta: 8 });
    ctx.writeRegister(rsp, nextRsp);
    ctx.writeRegister(rbp, read);
    return ctx.finish({
      family: 'integer',
      possibleFaults: faults,
      metadata: { operation: 'leave', stackDelta: 8 },
    });
  }

  if (family === 'enter') {
    const allocSize = operands[0]?.type === 'immediate' ? BigInt(operands[0].value) : 0n;
    const rbp = x86RegisterOperand('rbp');
    const rsp = x86RegisterOperand('rsp');
    const oldRsp = ctx.readRegister(rsp);
    const oldRbp = ctx.readRegister(rbp);
    if (!oldRsp || !oldRbp) return ctx.partial('x86-enter-registers-unmodelled', ['registers']);
    const nextRsp = ctx.valueOp('sub', [oldRsp, ctx.constant(64, 8n)], 64, { stackDelta: -8 });
    ctx.writeMemory(nextRsp, 64, oldRbp, { metadata: { stackAccess: true, enterPush: true } });
    memoryWrites.push(createMemoryAccess({ space: 'memory', addressExpr: nextRsp, widthBits: 64, endian: 'little' }));
    faults.push(...x86MemoryFaults('write', 64));
    ctx.writeRegister(rbp, nextRsp);
    const finalRsp = allocSize > 0n ? ctx.valueOp('sub', [nextRsp, ctx.constant(64, allocSize)], 64, { stackAlloc: allocSize }) : nextRsp;
    ctx.writeRegister(rsp, finalRsp);
    return ctx.finish({
      family: 'integer',
      possibleFaults: faults,
      metadata: { operation: 'enter', allocSize: Number(allocSize) },
    });
  }

  if (family === 'xlatb' || family === 'xlat') {
    const al = x86RegisterOperand('al');
    const rbx = x86RegisterOperand('rbx');
    const alVal = ctx.readRegister(al);
    const rbxVal = ctx.readRegister(rbx);
    if (!alVal || !rbxVal) return ctx.partial('x86-xlat-registers-unmodelled', ['registers']);
    const offset = ctx.coerce(alVal, 8, 64, false);
    const addr = ctx.valueOp('add', [rbxVal, offset], 64, { xlatAddress: true });
    const byteVal = ctx.readMemory(addr, 8, { metadata: { xlat: true } });
    memoryReads.push(createMemoryAccess({ space: 'memory', addressExpr: addr, widthBits: 8, endian: 'little' }));
    faults.push(...x86MemoryFaults('read', 8));
    ctx.writeRegister(al, byteVal);
    return ctx.finish({
      family: 'integer',
      possibleFaults: faults,
      metadata: { operation: 'xlatb' },
    });
  }

  for (let i = 0; i < operands.length; i += 1) {
    const op = operands[i];
    if (op?.type === 'register') {
      const val = ctx.readRegister(op);
      if (val) {
        inputs.push(val);
        registersRead.push(op.register.physicalId);
      }
    } else if (op?.type === 'immediate') {
      inputs.push(ctx.constant(Number(op.widthBits || op.encodedWidthBits || 8), op.value));
    } else if (op?.type === 'memory') {
      const addr = x86EffectiveAddressExpression(ctx.instruction, op);
      const width = Number(op.widthBits || 32);
      if (addr) {
        const memVal = ctx.readMemory(addr.expression, width, { space: addr.space, metadata: { ...addr.metadata, operation: family } });
        inputs.push(memVal);
        memoryReads.push(createMemoryAccess({ space: addr.space, addressExpr: addr.expression, widthBits: width, endian: 'little' }));
        faults.push(...x86MemoryFaults('read', width));
        if (['btc', 'btr', 'bts'].includes(family) && i === 0) {
          memoryWrites.push(createMemoryAccess({ space: addr.space, addressExpr: addr.expression, widthBits: width, endian: 'little' }));
          faults.push(...x86MemoryFaults('write', width));
        }
        for (const reg of [op.memory?.base, op.memory?.index]) {
          if (reg?.physicalId) registersRead.push(reg.physicalId);
        }
      }
    }
  }

  if (family === 'adcx') inputs.push(ctx.readFlag('CF'));
  if (family === 'adox') inputs.push(ctx.readFlag('OF'));
  if (family === 'mulx') {
    const rdx = x86RegisterOperand('rdx');
    const rdxVal = rdx ? ctx.readRegister(rdx) : null;
    if (rdxVal) { inputs.push(rdxVal); registersRead.push('rdx'); }
  }

  const destOperands = [];
  if (family === 'bt') {
    // BT only sets CF, no register destination
  } else if (family === 'mulx' && operands.length >= 2) {
    destOperands.push(operands[0], operands[1]);
  } else if (['btc', 'btr', 'bts'].includes(family)) {
    if (operands[0]?.type === 'register') destOperands.push(operands[0]);
  } else if (operands[0]?.type === 'register') {
    destOperands.push(operands[0]);
  }

  const outputWidths = destOperands.map((d) => Number(d.widthBits || d.register?.viewBits || 32));
  const flagOutputs = ['adcx', 'adox', 'bsf', 'bsr', 'bt', 'btc', 'btr', 'bts', 'popcnt', 'lzcnt', 'tzcnt', 'andn', 'bextr', 'blsi', 'blsmsk', 'blsr', 'bzhi', 'blcfill', 'blci', 'blcic', 'blcmsk', 'blcs', 'blsfill', 'blsic', 't1mskc', 'tzmsk', 'rcl', 'rcr', 'shld', 'shrd'].includes(family);
  if (flagOutputs) {
    outputWidths.push(1);
  }

  const outputs = ctx.intrinsic(`x86.integer.${family}`, inputs, outputWidths, {
    registersRead: [...new Set(registersRead)].sort(),
    registersWritten: [...new Set(destOperands.filter((d) => d.type === 'register').map((d) => d.register.physicalId))].sort(),
    memoryRead: memoryReads.length ? { scope: 'accesses', accesses: memoryReads } : { scope: 'none' },
    memoryWrite: memoryWrites.length ? { scope: 'accesses', accesses: memoryWrites } : { scope: 'none' },
    determinism: 'input-dependent',
    symbolicDetail: 'summary-only',
    metadata: { operation: family, exactArchitecturalSummary: true },
  });

  for (let i = 0; i < destOperands.length; i += 1) {
    const dest = destOperands[i];
    if (dest?.type === 'register') {
      ctx.writeRegister(dest, outputs[i]);
    }
  }

  if (['btc', 'btr', 'bts'].includes(family) && operands[0]?.type === 'memory') {
    const addr = x86EffectiveAddressExpression(ctx.instruction, operands[0]);
    const width = Number(operands[0].widthBits || 32);
    if (addr && outputs[0]) {
      ctx.writeMemory(addr.expression, width, outputs[0], { space: addr.space, metadata: { ...addr.metadata, operation: family } });
    }
  }

  if (flagOutputs && outputs.length > destOperands.length) {
    const flagVal = outputs[outputs.length - 1];
    if (family === 'adcx') ctx.writeFlag('CF', flagVal, { operation: family });
    else if (family === 'adox') ctx.writeFlag('OF', flagVal, { operation: family });
    else if (['bt', 'btc', 'btr', 'bts'].includes(family)) ctx.writeFlag('CF', flagVal, { operation: family });
    else if (['bsf', 'bsr'].includes(family)) ctx.writeFlag('ZF', flagVal, { operation: family });
    else if (['lzcnt', 'tzcnt'].includes(family)) { ctx.writeFlag('CF', flagVal, { operation: family }); ctx.writeFlag('ZF', flagVal, { operation: family }); }
    else if (family === 'popcnt') ctx.writeFlag('ZF', flagVal, { operation: family });
    else {
      ctx.writeFlag('ZF', flagVal, { operation: family });
      ctx.writeFlag('SF', flagVal, { operation: family });
      ctx.writeFlag('CF', flagVal, { operation: family });
      ctx.writeFlag('OF', flagVal, { operation: family });
    }
  }

  return ctx.finish({
    family: hasMemory && operands[0]?.type === 'memory' ? 'memory' : 'integer',
    possibleFaults: faults,
    metadata: { operation: family },
  });
}
