import { createMemoryAccess } from '../../../../semantics/effects/index.js';
import { createX86EffectContext, x86MemoryFaults, x86RegisterOperand } from './common.js';
import {
  baseFamily, registerName, vexInfo, memoryAddress, possibleFeatureFault,
  trustedCapstoneInstruction, physicalIds,
} from './extended-state-helpers.js';

export function liftVzero(instruction,context,family){
  const ctx=createX86EffectContext(instruction,context),vex=vexInfo(ctx.instruction),raw=Uint8Array.from(ctx.instruction.rawBytes||[]);
  if(!vex||vex.map!==1||vex.pp!==0||vex.vvvv!==15||raw[vex.prefixOffset+vex.prefixLength]!==0x77)return null;
  if(family==='vzeroall'&&vex.width!==256)return null;
  if(family==='vzeroupper'&&vex.width!==128)return null;
  for(let index=0;index<16;index+=1){
    const zmm=x86RegisterOperand(`zmm${index}`);if(!zmm)return ctx.partial('x86-maxvl-register-state-unavailable',['registers']);
    if(family==='vzeroall'){
      if(!ctx.writeRegister(zmm,ctx.constant(512,0n)))return ctx.partial('x86-vzeroall-zmm-write-failed',['registers']);
    }else{
      const old=ctx.readRegister(zmm);if(!old)return ctx.partial('x86-vzeroupper-zmm-read-failed',['registers']);
      const low=ctx.valueOp('extract',[old],128,{lsb:0,widthBits:128,physicalBits:512,physicalId:`zmm${index}`,view:`xmm${index}`});
      if(!ctx.writeRegister(zmm,ctx.coerce(low,128,512,false)))return ctx.partial('x86-vzeroupper-zmm-write-failed',['registers']);
    }
  }
  return ctx.finish({family:'simd',possibleFaults:[possibleFeatureFault('invalid-opcode')],metadata:{operation:family,maxVlBits:512,architecturalRegisterRange:'zmm0-zmm15',low128:family==='vzeroupper'?'preserved':'zero',bits128To511:'zero',extendedVectorStateModeled:true}});
}
export function liftEmms(instruction, context) {
  const family = String(instruction?.instructionFamily || '').toLowerCase();
  const ctx = createX86EffectContext(instruction, context);
  const raw = Uint8Array.from(ctx.instruction.rawBytes || []);
  if (raw.length < 2 || raw[raw.length - 2] !== 0x0f || (raw[raw.length - 1] !== 0x77 && raw[raw.length - 1] !== 0x0e)) return null;
  const fptw = x86RegisterOperand('fptw');
  if (!fptw || !ctx.writeRegister(fptw, ctx.constant(16, 0xffffn))) return ctx.partial('x86-emms-tag-write-failed', ['registers']);
  return ctx.finish({
    family: 'simd',
    possibleFaults: [possibleFeatureFault('device-not-available')],
    metadata: { operation: family === 'femms' ? 'femms' : 'emms', x87TagWord: 'all-empty', mmxDataPreserved: true, mmxX87AliasModeled: true },
  });
}
const X87_PUSH = new Set(['fld','fld1','fldz','fldl2e','fldl2t','fldlg2','fldln2','fldpi','fild','fbld']);
const X87_STORE = new Set(['fst','fist','fbstp','fstpnce']);
const X87_STORE_POP = new Set(['fstp','fistp','fisttp']);
const X87_ARITH = new Set(['fadd','fiadd','fsub','fisub','fsubr','fisubr','fmul','fimul','fdiv','fidiv','fdivr','fidivr']);
const X87_ARITH_POP = new Set(['faddp','fsubp','fsubrp','fmulp','fdivp','fdivrp','fyl2x','fyl2xp1']);
const X87_COMPARE = new Set(['fcom','fucom','ficom','ftst','fxam']);
const X87_COMPARE_POP = new Set(['fcomp','fucomp','fcompp','fucompp','ficomp']);
const X87_COMPARE_FLAGS = new Set(['fcomi','fucomi']);
const X87_COMPARE_FLAGS_POP = new Set(['fcompi','fucompi']);
const X87_CMOV = new Set(['fcmovb','fcmovbe','fcmove','fcmovnb','fcmovnbe','fcmovne','fcmovnu','fcmovu']);
const X87_TRANSCENDENTAL = new Set(['fcos','fsin','fsincos','fptan','fpatan','fxtract']);
const X87_UNARY = new Set(['fsqrt','frndint','fscale','fprem','fprem1','f2xm1']);
const X87_SIGN = new Set(['fchs','fabs']);
const X87_ENV_READ = new Set(['fldenv','frstor','fxrstor','fxrstor64']);
const X87_ENV_WRITE = new Set(['fnstenv','fstenv','fnsave','fsave','fxsave','fxsave64']);

const D3NOW_FAMILIES = new Set([
  'pavgusb','pf2id','pf2iw','pfacc','pfadd','pfcmpeq','pfcmpge','pfcmpgt',
  'pfmax','pfmin','pfmul','pfnacc','pfpnacc','pfrcpit1','pfrcpit2','pfrcp',
  'pfrsqit1','pfrsqrt','pfsubr','pfsub','pi2fd','pi2fw','pmulhrw','pswapd',
]);
const PROVEN_3DNOW_FAMILIES = new Set([]);
const PROVEN_X87_FAMILIES = new Set([]);

export function lift3DNow(instruction, context = {}) {
  const family = String(instruction?.instructionFamily || '').toLowerCase();
  if (!D3NOW_FAMILIES.has(family)) return null;
  const ctx = createX86EffectContext(instruction, context);
  if (!PROVEN_3DNOW_FAMILIES.has(family)) {
    return ctx.partial('x86-3dnow-family-requires-dedicated-semantics', ['memory', 'registers', 'flags', 'other'], {
      metadata:{ family:'simd', operation:family, exactArchitecturalSummary:false, requiresDedicatedOperandRoles:true },
    });
  }
  const operands = ctx.operands;
  const inputs = [], registersRead = [], registersWritten = [], memoryReads = [];
  let faults = [possibleFeatureFault('device-not-available')];

  for (let index = 0; index < operands.length; index += 1) {
    const operand = operands[index];
    if (operand?.type === 'register') {
      const value = ctx.readRegister(operand);
      if (value) { inputs.push(value); registersRead.push(...physicalIds(operand.register)); }
      if (index === 0) registersWritten.push(...physicalIds(operand.register));
    } else if (operand?.type === 'memory') {
      const modeled = memoryAddress(ctx, operand);
      const width = Number(operand.widthBits || 64);
      if (modeled) {
        inputs.push(ctx.readMemory(modeled.expression, width, { space: modeled.space, metadata: { ...modeled.metadata, '3dnow': true } }));
        memoryReads.push(createMemoryAccess({ space: modeled.space, addressExpr: modeled.expression, widthBits: width, endian: 'little' }));
        faults.push(...x86MemoryFaults('read', width));
        for (const register of [operand.memory?.base, operand.memory?.index]) registersRead.push(...physicalIds(register));
      }
    }
  }

  const dest = operands[0];
  const outputs = ctx.intrinsic(`x86.3dnow.${family}`, inputs, [64], {
    registersRead: [...new Set(registersRead)].sort(),
    registersWritten: [...new Set(registersWritten)].sort(),
    memoryRead: memoryReads.length ? { scope: 'accesses', accesses: memoryReads } : { scope: 'none' },
    memoryWrite: { scope: 'none' },
    determinism: 'input-dependent',
    symbolicDetail: 'summary-only',
    metadata: { operation: family, '3dnow': true, exactArchitecturalSummary: true },
  });

  if (dest?.type === 'register') {
    ctx.writeRegister(dest, outputs[0]);
  }

  return ctx.finish({
    family: 'simd',
    possibleFaults: faults,
    metadata: { operation: family, '3dnow': true },
  });
}

function x87Plan(base, ctx) {
  const hasMemory = ctx.operands.some((op) => op?.type === 'memory');
  const pointerWrites = ['fop', 'fip', ...(hasMemory ? ['fdp'] : [])];
  if (X87_PUSH.has(base)) return { reads: ['x87-stack', 'fpcw', 'fpsw', 'fptw'], writes: ['x87-stack', 'fpsw', 'fptw', ...pointerWrites], memory: hasMemory ? 'read' : 'none' };
  if (X87_STORE.has(base)) return { reads: ['x87-stack', 'fpcw', 'fpsw', 'fptw'], writes: ['fpsw', ...pointerWrites, ...(ctx.operands.some((op) => op?.type === 'register' && /^st\(/.test(registerName(op))) ? ['x87-stack'] : [])], memory: hasMemory ? 'write' : 'none' };
  if (X87_STORE_POP.has(base)) return { reads: ['x87-stack', 'fpcw', 'fpsw', 'fptw'], writes: ['x87-stack', 'fpsw', 'fptw', ...pointerWrites], memory: hasMemory ? 'write' : 'none' };
  if (X87_ARITH.has(base)) return { reads: ['x87-stack', 'fpcw', 'fpsw', 'fptw'], writes: ['x87-stack', 'fpsw', ...pointerWrites], memory: hasMemory ? 'read' : 'none' };
  if (X87_ARITH_POP.has(base)) return { reads: ['x87-stack', 'fpcw', 'fpsw', 'fptw'], writes: ['x87-stack', 'fpsw', 'fptw', ...pointerWrites], memory: hasMemory ? 'read' : 'none' };
  if (X87_COMPARE.has(base)) return { reads: ['x87-stack', 'fpcw', 'fpsw', 'fptw'], writes: ['fpsw', ...pointerWrites], memory: hasMemory ? 'read' : 'none' };
  if (X87_COMPARE_POP.has(base)) return { reads: ['x87-stack', 'fpcw', 'fpsw', 'fptw'], writes: ['fpsw', 'fptw', ...pointerWrites], memory: hasMemory ? 'read' : 'none' };
  if (X87_COMPARE_FLAGS.has(base)) return { reads: ['x87-stack', 'fpsw'], writes: [...pointerWrites], writesFlags: true, memory: 'none' };
  if (X87_COMPARE_FLAGS_POP.has(base)) return { reads: ['x87-stack', 'fpsw', 'fptw'], writes: ['fpsw', 'fptw', ...pointerWrites], writesFlags: true, memory: 'none' };
  if (X87_CMOV.has(base)) return { reads: ['x87-stack', 'fpsw'], writes: ['x87-stack', ...pointerWrites], readsFlags: true, memory: 'none' };
  if (X87_TRANSCENDENTAL.has(base)) return { reads: ['x87-stack', 'fpcw', 'fpsw', 'fptw'], writes: ['x87-stack', 'fpsw', 'fptw', ...pointerWrites], memory: 'none' };
  if (base === 'fxch') return { reads: ['x87-stack', 'fpsw', 'fptw'], writes: ['x87-stack', 'fpsw', 'fop', 'fip'], memory: 'none' };
  if (X87_UNARY.has(base)) return { reads: ['x87-stack', 'fpcw', 'fpsw', 'fptw'], writes: ['x87-stack', 'fpsw', 'fop', 'fip'], memory: 'none' };
  if (X87_SIGN.has(base)) return { reads: ['x87-stack', 'fpsw', 'fptw'], writes: ['x87-stack', 'fop', 'fip'], memory: 'none' };
  if (base === 'fdecstp' || base === 'fincstp') return { reads: ['fpsw'], writes: ['fpsw', 'fop', 'fip'], memory: 'none' };
  if (base === 'ffree' || base === 'ffreep') return { reads: ['fptw'], writes: ['fptw', 'fop', 'fip'], memory: 'none' };
  if (base === 'fldcw') return { reads: [], writes: ['fpcw'], memory: 'read' };
  if (base === 'fnstcw' || base === 'fstcw') return { reads: ['fpcw'], writes: [], memory: 'write' };
  if (base === 'fnstsw' || base === 'fstsw') return { reads: ['fpsw'], writes: [], memory: hasMemory ? 'write' : 'none', explicitRegisterWrite: true };
  if (X87_ENV_READ.has(base)) return { reads: [], writes: ['x87-stack', 'fpcw', 'fpsw', 'fptw'], memory: 'read' };
  if (X87_ENV_WRITE.has(base)) return { reads: ['x87-stack', 'fpcw', 'fpsw', 'fptw'], writes: [], memory: 'write' };
  if (base === 'fninit' || base === 'finit') return { reads: [], writes: ['x87-stack', 'fpcw', 'fpsw', 'fptw'], memory: 'none' };
  if (base === 'fnclex' || base === 'fclex') return { reads: ['fpsw'], writes: ['fpsw'], memory: 'none' };
  if (base === 'fnop' || base === 'fdisi8087_nop' || base === 'feni8087_nop' || base === 'fsetpm') return { reads: [], writes: [], memory: 'none' };
  if (base === 'fwait' || base === 'wait') return { reads: ['fpcw', 'fpsw'], writes: [], memory: 'none', waitOnly: true };
  return null;
}

export function liftX87(instruction, context, family) {
  if (!trustedCapstoneInstruction(instruction, family)) {
    const ctx = createX86EffectContext(instruction, context);
    return ctx.partial('x86-x87-trusted-decoder-provenance-required', ['registers', 'memory', 'faults', 'other'], { metadata: { family: 'fp', operation: family, x87PhysicalStateModeled: true } });
  }
  const base = baseFamily(family);
  const ctx = createX86EffectContext(instruction, context);
  if (!PROVEN_X87_FAMILIES.has(base)) {
    return ctx.partial('x86-x87-family-requires-dedicated-semantics', ['memory', 'registers', 'flags', 'faults', 'other'], {
      metadata:{ family:'fp', operation:family, exactArchitecturalSummary:false, requiresDedicatedOperandRoles:true, x87PhysicalStateModeled:true },
    });
  }
  const plan = x87Plan(base, ctx);
  if (!plan) return null;
  const inputs = [], registersRead = [], stateWriteOperands = [], memoryReads = [], memoryWrites = [];
  let faults = [possibleFeatureFault('device-not-available')];

  for (const name of plan.reads) {
    const operand = x86RegisterOperand(name);
    const value = operand ? ctx.readRegister(operand) : null;
    if (!operand || !value) return ctx.partial('x86-x87-state-unavailable', ['registers'], { metadata: { operation: family, state: name } });
    inputs.push(value);
    registersRead.push(...physicalIds(operand.register));
  }
  for (const name of plan.writes) {
    const operand = x86RegisterOperand(name);
    if (!operand) return ctx.partial('x86-x87-state-unavailable', ['registers'], { metadata: { operation: family, state: name } });
    stateWriteOperands.push(operand);
  }
  if (plan.readsFlags) {
    for (const flag of ['CF', 'ZF', 'PF']) {
      inputs.push(ctx.readFlag(flag));
    }
  }

  for (const operand of ctx.operands) {
    if (operand?.type === 'memory') {
      const address = memoryAddress(ctx, operand);
      const width = Number(operand.widthBits || 0);
      if (!address || !width) return ctx.partial('x86-x87-memory-shape-unmodelled', ['memory', 'registers'], { metadata: { operation: family } });
      const access = createMemoryAccess({ space: address.space, addressExpr: address.expression, widthBits: width, endian: 'little' });
      if (plan.memory === 'read') {
        inputs.push(ctx.readMemory(address.expression, width, { space: address.space, metadata: { ...address.metadata, x87: true } }));
        memoryReads.push(access);
        faults.push(...x86MemoryFaults('read', width));
      } else if (plan.memory === 'write') {
        memoryWrites.push({ operand, address, width, access });
        faults.push(...x86MemoryFaults('write', width));
      }
      for (const register of [operand.memory?.base, operand.memory?.index]) registersRead.push(...physicalIds(register));
    } else if (operand?.type === 'immediate') {
      inputs.push(ctx.constant(Number(operand.widthBits || operand.encodedWidthBits || 8), operand.value));
    }
  }

  if (!family.startsWith('fn')) faults.push(Object.freeze({ kind: 'x87-floating-point-exception', condition: { kind: 'x87-control-status-dependent' }, detail: { exceptionClass: '#MF' } }));
  if (plan.waitOnly) return ctx.finish({ family: 'fp', possibleFaults: faults, metadata: { operation: family, x87PhysicalStateModeled: true, x87EnvironmentModeled: true, waitInstruction: true } });

  const explicitRegisterWrites = [];
  if (plan.explicitRegisterWrite) {
    for (const operand of ctx.operands) {
      if (operand?.type === 'register' && !/^st\(/.test(registerName(operand))) explicitRegisterWrites.push(operand);
    }
  }

  const outputTargets = [
    ...stateWriteOperands.map((operand) => ({ kind: 'state', operand, width: Number(operand.widthBits || operand.register.viewBits) })),
    ...explicitRegisterWrites.map((operand) => ({ kind: 'register', operand, width: Number(operand.widthBits || operand.register.viewBits) })),
    ...memoryWrites.map((item) => ({ kind: 'memory', ...item, width: item.width })),
  ];
  if (plan.writesFlags) {
    outputTargets.push(...['CF', 'PF', 'ZF'].map((flag) => ({ kind: 'flag', flag, width: 1 })));
  }

  if (outputTargets.length === 0) return ctx.finish({ family: 'fp', possibleFaults: faults, metadata: { operation: family, x87PhysicalStateModeled: true, x87EnvironmentModeled: true, topRelativeStack: true } });

  const registersWritten = [...new Set(outputTargets.flatMap((target) => (target.kind === 'memory' || target.kind === 'flag') ? [] : physicalIds(target.operand.register)))].sort();
  const outputs = ctx.intrinsic(`x86.x87.${family}`, inputs, outputTargets.map((target) => target.width), {
    registersRead: [...new Set(registersRead)].sort(),
    registersWritten,
    memoryRead: memoryReads.length ? { scope: 'accesses', accesses: memoryReads } : { scope: 'none' },
    memoryWrite: memoryWrites.length ? { scope: 'accesses', accesses: memoryWrites.map(({ access }) => access) } : { scope: 'none' },
    determinism: 'input-dependent',
    symbolicDetail: 'summary-only',
    metadata: { operation: family, x87EnvironmentContract: 'x86-x87-state/v1', topRelativeStack: true, tagWordModeled: true, exactArchitecturalSummary: true },
  });

  for (let i = 0; i < outputTargets.length; i += 1) {
    const target = outputTargets[i], value = outputs[i];
    if (target.kind === 'memory') ctx.writeMemory(target.address.expression, target.width, value, { space: target.address.space, metadata: { ...target.address.metadata, x87: true } });
    else if (target.kind === 'flag') ctx.writeFlag(target.flag, value, { operation: family, x87: true });
    else if (!ctx.writeRegister(target.operand, value)) return ctx.partial('x86-x87-state-write-failed', ['registers'], { metadata: { operation: family, target: registerName(target.operand) } });
  }

  return ctx.finish({
    family: 'fp',
    possibleFaults: faults,
    metadata: { operation: family, x87PhysicalStateModeled: true, x87EnvironmentModeled: true, topRelativeStack: true, stateWrites: Object.freeze(plan.writes) },
  });
}
