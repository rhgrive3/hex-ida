import { createMemoryAccess } from '../../../../semantics/effects/index.js';
import { createX86EffectContext, x86MemoryFaults, x86RegisterOperand } from './common.js';
import { x86EffectiveAddressExpression } from './addressing.js';

const BIT_MANIP_NAMES = new Set([
  'adcx', 'adox', 'bsf', 'bsr', 'bswap', 'bt', 'btc', 'btr', 'bts', 'crc32', 'lzcnt', 'popcnt', 'tzcnt',
  'andn', 'bextr', 'blsi', 'blsmsk', 'blsr', 'bzhi', 'mulx', 'pdep', 'pext', 'rorx', 'sarx', 'shlx', 'shrx',
  'blcfill', 'blci', 'blcic', 'blcmsk', 'blcs', 'blsfill', 'blsic', 't1mskc', 'tzmsk',
  'movbe', 'rcl', 'rcr', 'shld', 'shrd',
  'enter', 'leave', 'xlatb', 'xlat',
]);

export function liftX86BitManipulationEffects(instruction, context = {}) {
  const family = String(instruction?.instructionFamily || '').toLowerCase();
  if (!BIT_MANIP_NAMES.has(family)) return null;
  const ctx = createX86EffectContext(instruction, context);
  const operands = ctx.operands;
  const hasMemory = operands.some((op) => op?.type === 'memory');
  const faults = [];
  const inputs = [], registersRead = [], registersWritten = [], memoryReads = [], memoryWrites = [];

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
