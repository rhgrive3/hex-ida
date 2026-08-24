import { createX86EffectContext, x86MemoryFaults, x86RegisterOperand } from './common.js';
import { x86EffectiveAddressExpression } from './addressing.js';
import { emitX86Condition } from './flags.js';
import { resolveX86Long64FeatureEnvelope } from '../feature-contract.js';

const CONDITION_COUNT_BRANCHES = Object.freeze(new Map([
  ['jrcxz','rcx'],
  ['jecxz','ecx'],
]));
const LOOP_BRANCHES = Object.freeze(new Set(['loop','loope','loopz','loopne','loopnz']));

function loopCountRegister(instruction) {
  const detailWidth = Number(instruction?.detail?.addressSizeBits);
  if (detailWidth === 32) return 'ecx';
  const legacy = Array.from(instruction?.detail?.prefixes?.legacy ?? []);
  return legacy.includes(0x67) ? 'ecx' : 'rcx';
}

const PREFIX_GROUPS = Object.freeze([
  Object.freeze(new Set([0xf0,0xf2,0xf3])),
  Object.freeze(new Set([0x2e,0x36,0x3e,0x26,0x64,0x65])),
  Object.freeze(new Set([0x66])),
  Object.freeze(new Set([0x67])),
]);

function validateControlPrefixState(instruction, family) {
  if (instruction?.detail?.prefixes?.vector != null) return 'x86-control-vector-prefix-invalid';
  const rex = instruction?.detail?.prefixes?.rex;
  if (rex != null && (!Number.isInteger(Number(rex)) || Number(rex) < 0x40 || Number(rex) > 0x4f)) return 'x86-control-rex-prefix-invalid';
  const legacy = Array.from(instruction?.detail?.prefixes?.legacy ?? []);
  if (legacy.some((prefix) => !PREFIX_GROUPS.some((group) => group.has(prefix)))) return 'x86-control-legacy-prefix-invalid';
  for (const group of PREFIX_GROUPS) {
    if (legacy.filter((prefix) => group.has(prefix)).length > 1) return 'x86-control-conflicting-legacy-prefixes';
  }
  if (legacy.includes(0xf0)) return 'x86-control-lock-prefix-invalid';
  const expectedAddressSize = legacy.includes(0x67) ? 32 : 64;
  const observedAddressSize = Number(instruction?.detail?.addressSizeBits);
  if (Number.isFinite(observedAddressSize) && observedAddressSize !== 0 && observedAddressSize !== expectedAddressSize) return 'x86-control-address-size-prefix-mismatch';
  if (family === 'jcxz') return 'x86-jcxz-illegal-in-long-64';
  if (family === 'jrcxz' && expectedAddressSize !== 64) return 'x86-jrcxz-address-size-mismatch';
  if (family === 'jecxz' && expectedAddressSize !== 32) return 'x86-jecxz-address-size-mismatch';
  return null;
}

function x86ControlTargetFault(operation, conditional = false) {
  return Object.freeze({
    kind:'control-transfer-fault',
    condition:Object.freeze({ kind:'x86-non-canonical-control-target', when:conditional ? 'taken' : 'always' }),
    detail:Object.freeze({ vector:'#GP(0)', exceptionClass:'fault', operation }),
  });
}

function addressRef(value) { return Object.freeze({ kind:'absolute-address', value:BigInt(value).toString(), widthBits:64 }); }
function fallthrough(instruction) { return addressRef(BigInt(instruction.address) + BigInt(instruction.length)); }
function directTarget(operand) { return operand?.type === 'immediate' ? operand.value : null; }

function trapEffect(ctx, family, featureMetadata) {
  if (family === 'ud2') {
    return ctx.finish({
      family:'control',
      controlEffect:{ kind:'trap', reason:'x86-ud2-invalid-opcode' },
      possibleFaults:[{
        kind:'invalid-opcode',
        condition:{ kind:'always' },
        detail:{ vector:'#UD', exceptionClass:'fault', operation:'ud2' },
      }],
      metadata:{ ...featureMetadata, operation:'ud2', architecturalTrap:true },
    });
  }
  return ctx.finish({
    family:'control',
    controlEffect:{ kind:'trap', reason:'x86-int3-breakpoint' },
    possibleFaults:[{
      kind:'breakpoint-trap',
      condition:{ kind:'always' },
      detail:{ vector:'#BP', exceptionClass:'trap', operation:'int3' },
    }],
    metadata:{ ...featureMetadata, operation:'int3', architecturalTrap:true },
  });
}

function resolveIndirectTarget(ctx, operand, operation) {
  if (operand?.type === 'register') {
    if (operand.widthBits !== 64) return null;
    const target = ctx.readRegister(operand);
    return target == null ? null : Object.freeze({ target, faults:[] });
  }
  if (operand?.type !== 'memory' || operand.widthBits !== 64) return null;
  const address = x86EffectiveAddressExpression(ctx.instruction, operand);
  if (!address) return null;
  const target = ctx.readMemory(address.expression, 64, {
    space:address.space,
    metadata:{ ...address.metadata, controlTarget:true, operation },
  });
  return Object.freeze({ target, faults:x86MemoryFaults('read',64) });
}

export function liftX86ControlEffects(instruction, context = {}) {
  const family = String(instruction?.instructionFamily || '').toLowerCase();
  const conditional = (family.startsWith('j') && family !== 'jmp') || LOOP_BRANCHES.has(family);
  if (!conditional && !['jmp','call','ret','retq','nop','ud2','int3'].includes(family)) return null;
  const ctx = createX86EffectContext(instruction, context);
  const featureEnvelope = resolveX86Long64FeatureEnvelope(ctx.instruction, context);
  if (!featureEnvelope.supported) {
    return ctx.partial(featureEnvelope.reason, ['control','other'], {
      controlEffect:{ kind:'unknown', reason:featureEnvelope.reason },
      detail:{ featureProfileId:featureEnvelope.profileId, featureState:featureEnvelope.featureState ?? null, featureContractVersion:featureEnvelope.contractVersion, featureDetail:featureEnvelope.detail ?? null },
      metadata:{ featureProfileId:featureEnvelope.profileId, featureContractVersion:featureEnvelope.contractVersion },
    });
  }
  const prefixFailure = validateControlPrefixState(ctx.instruction, family);
  if (prefixFailure) {
    return ctx.partial(prefixFailure, ['control','other'], {
      controlEffect:{ kind:'unknown', reason:prefixFailure },
      metadata:{ featureProfileId:featureEnvelope.profileId, featureContractVersion:featureEnvelope.contractVersion },
    });
  }
  const featureMetadata = { featureProfileId:featureEnvelope.profileId, featureContractVersion:featureEnvelope.contractVersion, featureState:featureEnvelope.featureState };

  if (family === 'nop') {
    // Intel's multi-byte NOP encodings (0F 1F /0) carry a syntactic r/m
    // operand even though the operand is architecturally not read and no
    // memory access occurs.  Capstone therefore exposes one register/memory
    // operand for these encodings.  Treat that decoder shape as the same
    // proven state-preserving NOP; only shapes no architectural NOP can have
    // remain fail-closed.
    const nopOperand = ctx.operands[0] ?? null;
    const rawBytes = Array.from(ctx.instruction.rawBytes ?? []);
    let opcodeIndex = 0;
    while (opcodeIndex < rawBytes.length && (
      PREFIX_GROUPS.some((group) => group.has(rawBytes[opcodeIndex]))
      || (rawBytes[opcodeIndex] >= 0x40 && rawBytes[opcodeIndex] <= 0x4f)
    )) opcodeIndex += 1;
    const multiByteNop = rawBytes[opcodeIndex] === 0x0f
      && rawBytes[opcodeIndex + 1] === 0x1f
      && ((rawBytes[opcodeIndex + 2] ?? 0xff) & 0x38) === 0;
    const validNopShape = ctx.operands.length === 0 || (
      ctx.operands.length === 1
      && multiByteNop
      && (nopOperand?.type === 'memory' || nopOperand?.type === 'register')
      && [16,32,64].includes(Number(nopOperand?.widthBits))
    );
    if (!validNopShape) return ctx.partial('x86-nop-operand-shape-unmodelled', ['control','other'], { controlEffect:{ kind:'unknown', reason:'x86-nop-operand-shape-unmodelled' } });
    return ctx.finish({
      family:'control',
      statePreservation:{ proven:true, reason:'x86-nop-architectural-state-preservation' },
      metadata:{ operation:'nop', ...featureMetadata },
    });
  }

  if (family === 'ud2' || family === 'int3') {
    if (ctx.operands.length !== 0) return ctx.partial(`x86-${family}-operand-shape-unmodelled`, ['control','faults'], { controlEffect:{ kind:'unknown', reason:`x86-${family}-operand-shape-unmodelled` } });
    return trapEffect(ctx, family, featureMetadata);
  }

  if (conditional) {
    if (ctx.operands.length !== 1) {
      return ctx.partial(`x86-${family}-operand-shape-unmodelled`, ['control'], {
        controlEffect:{ kind:'unknown', reason:`x86-${family}-operand-shape-unmodelled` },
      });
    }
    const target = directTarget(ctx.operands[0]);
    if (target == null) {
      return ctx.partial(`x86-${family}-target-unmodelled`, ['control'], {
        controlEffect:{ kind:'unknown', reason:`x86-${family}-target-unmodelled` },
      });
    }

    if (LOOP_BRANCHES.has(family)) {
      const countRegister = loopCountRegister(ctx.instruction);
      const countOperand = x86RegisterOperand(countRegister);
      const oldCount = countOperand ? ctx.readRegister(countOperand) : null;
      if (!oldCount) {
        return ctx.partial(`x86-${family}-count-register-unmodelled`, ['control','registers'], { controlEffect:{ kind:'unknown', reason:`x86-${family}-count-register-unmodelled` } });
      }
      const bits = countOperand.widthBits;
      const decremented = ctx.valueOp('sub', [oldCount,ctx.constant(bits,1n)], bits, { widthBits:bits, semantic:`${countRegister} - 1`, loopCounter:true });
      if (!ctx.writeRegister(countOperand, decremented)) {
        return ctx.partial(`x86-${family}-count-register-write-unmodelled`, ['control','registers'], { controlEffect:{ kind:'unknown', reason:`x86-${family}-count-register-write-unmodelled` } });
      }
      const nonZero = ctx.valueOp('icmp.ne', [decremented,ctx.constant(bits,0n)], 1, { predicate:'ne', signed:false, widthBits:bits, semantic:`${countRegister} != 0 after decrement` });
      let condition = nonZero;
      let conditionKind = 'loop-count';
      if (family !== 'loop') {
        const zf = ctx.readFlag('ZF');
        const wantsZero = family === 'loope' || family === 'loopz';
        const zfCondition = wantsZero ? zf : ctx.valueOp('xor', [zf,ctx.constant(1,1n)], 1, { semantic:'ZF == 0' });
        condition = ctx.valueOp('and', [nonZero,zfCondition], 1, { semantic:wantsZero ? 'count != 0 && ZF == 1' : 'count != 0 && ZF == 0' });
        conditionKind = wantsZero ? 'loop-count-and-zf' : 'loop-count-and-not-zf';
      }
      return ctx.finish({ family:'control', controlEffect:{ kind:'conditional-branch', target:addressRef(target), fallthrough:fallthrough(ctx.instruction), condition }, possibleFaults:[x86ControlTargetFault(family, true)], metadata:{ ...featureMetadata, operation:family, conditionKind, countRegister, countDecremented:true, flagsPreserved:true, instructionLength:ctx.instruction.length } });
    }

    const countRegister = CONDITION_COUNT_BRANCHES.get(family);
    let condition;
    let conditionKind = 'rflags';
    if (countRegister) {
      const count = ctx.readRegister(x86RegisterOperand(countRegister));
      if (!count) {
        return ctx.partial(`x86-${family}-count-register-unmodelled`, ['control','registers'], {
          controlEffect:{ kind:'unknown', reason:`x86-${family}-count-register-unmodelled` },
        });
      }
      condition = ctx.valueOp('is-zero', [count], 1, {
        widthBits:x86RegisterOperand(countRegister).widthBits,
        semantic:`${countRegister} == 0`,
      });
      conditionKind = 'count-register';
    } else {
      const code = ctx.instruction.detail.conditionCode ?? family.slice(1);
      condition = emitX86Condition(ctx, code);
      if (!condition) {
        return ctx.partial(`x86-${family}-condition-unmodelled`, ['control','flags'], {
          controlEffect:{ kind:'unknown', reason:`x86-${family}-condition-unmodelled` },
        });
      }
    }

    return ctx.finish({
      family:'control',
      controlEffect:{
        kind:'conditional-branch',
        target:addressRef(target),
        fallthrough:fallthrough(ctx.instruction),
        condition,
      },
      possibleFaults:[x86ControlTargetFault(family, true)],
      metadata:{
        ...featureMetadata,
        operation:family,
        conditionKind,
        ...(conditionKind === 'rflags' ? { conditionCode:ctx.instruction.detail.conditionCode ?? family.slice(1) } : { countRegister }),
        instructionLength:ctx.instruction.length,
      },
    });
  }

  if (family === 'jmp') {
    const operand = ctx.operands[0];
    if (ctx.operands.length !== 1) {
      return ctx.partial('x86-jmp-operand-shape-unmodelled', ['control'], {
        controlEffect:{ kind:'unknown', reason:'x86-jmp-operand-shape-unmodelled' },
      });
    }
    const direct = directTarget(operand);
    if (direct != null) {
      return ctx.finish({
        family:'control',
        controlEffect:{ kind:'branch', target:addressRef(direct) },
        possibleFaults:[x86ControlTargetFault('jmp')],
        metadata:{ ...featureMetadata, operation:'jmp', direct:true, instructionLength:ctx.instruction.length },
      });
    }
    const indirect = resolveIndirectTarget(ctx, operand, 'jmp');
    if (indirect) {
      return ctx.finish({
        family:'control',
        controlEffect:{ kind:'indirect', target:indirect.target },
        possibleFaults:[...indirect.faults,x86ControlTargetFault('jmp')],
        metadata:{ ...featureMetadata, operation:'jmp', direct:false, memoryIndirect:operand?.type === 'memory', instructionLength:ctx.instruction.length },
      });
    }
    return ctx.partial('x86-jmp-target-unmodelled', ['control','registers','memory'], {
      controlEffect:{ kind:'unknown', reason:'x86-jmp-target-unmodelled' },
    });
  }

  if (family === 'call') {
    if (ctx.operands.length !== 1) {
      return ctx.partial('x86-call-operand-shape-unmodelled', ['control','registers','memory'], {
        controlEffect:{ kind:'unknown', reason:'x86-call-operand-shape-unmodelled' },
      });
    }
    const operand = ctx.operands[0];
    const returnAddress = BigInt(ctx.instruction.address) + BigInt(ctx.instruction.length);

    const direct = directTarget(operand);
    let target = direct == null ? null : addressRef(direct);
    let targetFaults = [];
    if (target == null) {
      const indirect = resolveIndirectTarget(ctx, operand, 'call');
      if (indirect) {
        target = indirect.target;
        targetFaults = indirect.faults;
      }
    }
    if (target == null) {
      return ctx.partial('x86-call-target-unmodelled', ['control','registers','memory'], {
        controlEffect:{ kind:'unknown', reason:'x86-call-target-unmodelled' },
      });
    }

    const oldRsp = ctx.readRegister(x86RegisterOperand('rsp'));
    if (!oldRsp) {
      return ctx.partial('x86-call-stack-state-unmodelled', ['control','registers','memory'], {
        controlEffect:{ kind:'unknown', reason:'x86-call-stack-state-unmodelled' },
      });
    }
    const nextRsp = ctx.valueOp('sub', [oldRsp,ctx.constant(64,8n)], 64, { stackDelta:-8, semantic:'x86-near-call-push-return-address' });
    ctx.writeMemory(nextRsp, 64, ctx.constant(64,returnAddress), { metadata:{ stackAccess:true, returnAddress:true } });
    if (!ctx.writeRegister(x86RegisterOperand('rsp'), nextRsp)) {
      return ctx.partial('x86-call-rsp-write-unmodelled', ['control','registers','memory'], {
        controlEffect:{ kind:'unknown', reason:'x86-call-rsp-write-unmodelled' },
      });
    }
    return ctx.finish({
      family:'control',
      controlEffect:{ kind:'call', target, fallthrough:addressRef(returnAddress) },
      possibleFaults:[...targetFaults,...x86MemoryFaults('write',64),x86ControlTargetFault('call')],
      metadata:{
        ...featureMetadata,
        operation:'call',
        direct:direct != null,
        memoryIndirect:operand?.type === 'memory',
        abiSemantics:false,
        stackDelta:-8,
        returnAddress:returnAddress.toString(),
        instructionLength:ctx.instruction.length,
      },
    });
  }

  if (ctx.operands.length > 1 || (ctx.operands[0] != null && ctx.operands[0].type !== 'immediate')) {
    return ctx.partial('x86-ret-operand-shape-unmodelled', ['control','registers','memory'], {
      controlEffect:{ kind:'unknown', reason:'x86-ret-operand-shape-unmodelled' },
    });
  }
  const oldRsp = ctx.readRegister(x86RegisterOperand('rsp'));
  if (!oldRsp) {
    return ctx.partial('x86-ret-stack-state-unmodelled', ['control','registers','memory'], {
      controlEffect:{ kind:'unknown', reason:'x86-ret-stack-state-unmodelled' },
    });
  }
  const target = ctx.readMemory(oldRsp, 64, { metadata:{ stackAccess:true, returnAddress:true } });
  const extra = ctx.operands[0]?.type === 'immediate' ? BigInt(ctx.operands[0].value) : 0n;
  if (extra < 0n || extra > 0xffffn) {
    return ctx.partial('x86-ret-immediate-unmodelled', ['control','registers','memory'], {
      controlEffect:{ kind:'unknown', reason:'x86-ret-immediate-unmodelled' },
    });
  }
  const total = 8n + extra;
  const nextRsp = ctx.valueOp('add', [oldRsp,ctx.constant(64,total)], 64, { stackDelta:total.toString(), semantic:'x86-near-ret-pop-return-address' });
  if (!ctx.writeRegister(x86RegisterOperand('rsp'), nextRsp)) {
    return ctx.partial('x86-ret-rsp-write-unmodelled', ['control','registers','memory'], {
      controlEffect:{ kind:'unknown', reason:'x86-ret-rsp-write-unmodelled' },
    });
  }
  return ctx.finish({
    family:'control',
    controlEffect:{ kind:'return', target },
    possibleFaults:[...x86MemoryFaults('read',64),x86ControlTargetFault('ret')],
    metadata:{ ...featureMetadata, operation:'ret', abiSemantics:false, stackDelta:total.toString(), immediateAdjustment:extra.toString(), instructionLength:ctx.instruction.length },
  });
}
