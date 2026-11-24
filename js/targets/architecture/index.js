import { assemble as assembleArm64 } from '../../patch.js';
import { extendArm64WithArm64eEffects, isArm64ePointerAuthenticationInstruction } from './arm64e/effects.js';
import { isArm64eAuthenticatedLoadInstruction } from './arm64e/effects-memory.js';
import { extendArm64eWithPacmEffects } from './arm64e/effects-pacm.js';
import { arm64ePointerAuthenticationOperandShapeFailureBundle } from './arm64e/encoding.js';
import { ARM64_MACHINE_EFFECTS_SEMANTIC_VERSION, liftArm64MachineEffects } from './arm64/effects/index.js';
import { decorateArm64BtypeEffects } from './arm64/effects/btype.js';
import { ARM64_IMPLICIT_BTI_LANDING_MNEMONICS, decorateArm64BtiGuardedPageEffects } from './arm64/effects/bti-guard-state.js';
import { createMachineEffectBundle } from '../../semantics/effects/index.js';
import { X86_64_MACHINE_EFFECTS_SEMANTIC_VERSION, liftX86MachineEffects, liftX86DecodedMachineEffects } from './x86_64/effects/index.js';
import { x86RegisterFile } from './x86_64/registers.js';
import { resolveX86SwitchTables } from './x86_64/jump-table.js';
import { riscv64IsStandardReturn } from './riscv64/control-flow.js';
import { RISCV64_INSTRUCTION_ALIGNMENT, RISCV64_MACHINE_EFFECTS_SEMANTIC_VERSION, liftRiscv64MachineEffects } from './riscv64/effects/index.js';
import { riscv64RegisterFile } from './riscv64/registers.js';
import { ArchitecturePluginV2, registerArchitecturePlugin, architecturePluginV2, architecturePluginsV2, canonicalArchitectureId, normalizeArchitecturePositiveInteger } from './registry.js';

const ARM64_RETURN_OPS = new Set(['ret','retaa','retab','retaasppc','retabsppc','retaasppcr','retabsppcr']);
const ARM64_CALL_OPS = new Set(['bl','blr','blraa','blrab','blraaz','blrabz']);
const ARM64_BRANCH_OPS = new Set(['b','br','braa','brab','braaz','brabz','b.al','b.nv','bc.al','bc.nv']);
const ARM64_COND_BRANCH_OPS = new Set(['cbz','cbnz','tbz','tbnz']);
const ARM64_UNKNOWN_OPS = new Set(['eret','eretaa','eretab','drps','brk','hlt','svc','hvc','smc']);

const X86_LOOP_OPS = new Set(['loop','loope','loopz','loopne','loopnz']);
const X86_UNKNOWN_OPS = new Set(['ud2','ud0','ud1','int3','int1','int','iret','iretd','iretq','ljmp','sysenter','sysexit','sysexitq']);
const X86_SYSCALL_OPS = new Set(['syscall','sysret','sysretq']);

const RISCV_COND_BRANCH_OPS = new Set(['beq','bne','blt','bge','bltu','bgeu']);
const RISCV_DIRECT_TARGET_OPS = new Set(['jal','beq','bne','blt','bge','bltu','bgeu']);

const ARM64_PAUTH_HINT_NOPS = new Set(['paciasp', 'pacibsp', 'autiasp', 'autibsp', 'paciaz', 'pacibz', 'autiaz', 'autibz', 'pacia1716', 'pacib1716', 'autia1716', 'autib1716', 'xpaclri']);

function arm64ControlFlow(instruction) {
  const rawMnemonic = instruction?.mnemonic;
  const op = typeof rawMnemonic === 'string' ? rawMnemonic.toLowerCase() : '';
  if (ARM64_RETURN_OPS.has(op)) return 'return';
  if (ARM64_CALL_OPS.has(op)) return 'call';
  if (ARM64_BRANCH_OPS.has(op)) return 'branch';
  // FEAT_HBC `BC.<cond>` is a PC-relative conditional branch: the same
  // control family as `B.<cond>` (Capstone 5 prints the B.cond space as
  // `bc.<cond>` when HBC is enabled), so its decoded branchTarget must
  // surface as a direct conditional-control target.
  if (ARM64_COND_BRANCH_OPS.has(op) || op.startsWith('b.') || op.startsWith('bc.')) return 'conditional-branch';
  if (ARM64_UNKNOWN_OPS.has(op)) return 'unknown';
  return 'fallthrough';
}

function x86ControlFlow(instruction) {
  const op = String(instruction?.instructionFamily || instruction?.mnemonic || '').toLowerCase();
  if (op.startsWith('ret')) return 'return';
  if (op === 'call') return 'call';
  if (op === 'jmp') return 'branch';
  if (X86_LOOP_OPS.has(op)) return 'conditional-branch';
  if (X86_UNKNOWN_OPS.has(op)) return 'unknown';
  if (X86_SYSCALL_OPS.has(op)) return 'branch';
  if (op.length >= 2 && op.charCodeAt(0) === 106 && op.charCodeAt(1) !== 109) return 'conditional-branch';
  return 'fallthrough';
}

/**
 * RV64 control-flow classification.
 *
 * Derived from the decoded instruction word, never from the printed mnemonic:
 * the Capstone RISC-V printer collapses `jal rd, off` and `jal x0, off` to the
 * same display form, so mnemonics cannot distinguish a call from a jump.
 *
 * rd == x0 means no link value is produced, which is the architectural
 * difference between a call and a plain jump. RAS prediction hints are kept
 * separate from semantic procedure returns: the frozen LP64 profile promotes
 * only the standard `jalr x0, x1, 0` return sequence.
 */
function riscv64ControlFlow(instruction) {
  const fields = instruction?.fields;
  if (!fields?.supported) return 'unknown';
  const op = fields.op;
  if (op === 'jal') return fields.rd === 'x0' ? 'branch' : (fields.rd === 'x1' || fields.rd === 'x5') ? 'call' : 'branch';
  if (op === 'jalr') {
    if (fields.rd === 'x1' || fields.rd === 'x5') return 'call';
    if (fields.rd !== 'x0') return 'branch';
    if (riscv64IsStandardReturn(fields)) return 'return';
    // An indirect jump. It is reported as a branch, matching how x86 classifies
    // an indirect `jmp`: the block ends and no fallthrough edge is invented,
    // because the transfer does not fall through. The honest "the target is a
    // computed value" statement lives in the MachineEffects control effect,
    // which records kind `indirect` with the computed target expression.
    return 'branch';
  }
  if (RISCV_COND_BRANCH_OPS.has(op)) return 'conditional-branch';
  if (op === 'ecall' || op === 'ebreak') return 'unknown';
  return 'fallthrough';
}

/** Decode-time constant target of a direct RV64 transfer, else null. */
function riscv64DirectControlTarget(instruction) {
  const fields = instruction?.fields;
  if (!fields?.supported || fields.imm == null) return null;
  if (!RISCV_DIRECT_TARGET_OPS.has(fields.op)) return null;
  try { return BigInt(instruction.address) + BigInt(fields.imm); }
  catch { return null; }
}

/**
 * Decode-time constant target of a direct ARM64 transfer, else null. The ARM64
 * decoder resolves PC-relative branch targets during decode and publishes them
 * as `branchTarget`, so no operand text is parsed here.
 */
function arm64DirectControlTarget(instruction) {
  const target = instruction?.branchTarget ?? instruction?.callTarget;
  if (target == null) return null;
  const kind = arm64ControlFlow(instruction);
  if (kind !== 'branch' && kind !== 'conditional-branch' && kind !== 'call') return null;
  try { return BigInt(target); }
  catch { return null; }
}

/** Decode-time constant target of a direct x86-64 transfer, else null. */
function x86DirectControlTarget(instruction) {
  const operand = instruction?.detail?.operands?.[0];
  if (operand?.type !== 'immediate' || operand.value == null) return null;
  const kind = x86ControlFlow(instruction);
  if (kind !== 'branch' && kind !== 'conditional-branch' && kind !== 'call') return null;
  try { return BigInt(operand.value); }
  catch { return null; }
}

const ARM64_REGISTERS = Object.freeze([
  ...Array.from({length:31}, (_x,i) => Object.freeze({ id:`x${i}`, bits:64, kind:'gp' })),
  Object.freeze({ id:'sp', bits:64, kind:'stack-pointer' }),
  Object.freeze({ id:'nzcv', bits:4, kind:'flags' }),
  Object.freeze({ id:'pstate.btype', bits:2, kind:'system-state' }),
  ...Array.from({length:32}, (_x,i) => Object.freeze({ id:`v${i}`, bits:128, kind:'vector' })),
]);

function sameBtiContextInputs(context) {
  const opts = context?.machineEffectsOptions ?? context?.options;
  if (!opts || typeof opts !== 'object') return true;
  const directGuard = context.btiGuardedPage ?? context.guardedPageState ?? context.pageGuardState ?? null;
  const mergedGuard = (opts.btiGuardedPage ?? context.btiGuardedPage)
    ?? (opts.guardedPageState ?? context.guardedPageState)
    ?? (opts.pageGuardState ?? context.pageGuardState) ?? null;
  return directGuard === mergedGuard
    && (context.featBti ?? context.hasBti ?? null) === ((opts.featBti ?? context.featBti) ?? (opts.hasBti ?? context.hasBti) ?? null)
    && (context.incomingBtype ?? context.btype ?? context.pstateBtype) === ((opts.incomingBtype ?? context.incomingBtype) ?? (opts.btype ?? context.btype) ?? (opts.pstateBtype ?? context.pstateBtype))
    && (context.sctlrBt ?? context.sctlr_elx_bt ?? context.btPolicy ?? context.sctlrPolicy) === ((opts.sctlrBt ?? context.sctlrBt) ?? (opts.sctlr_elx_bt ?? context.sctlr_elx_bt) ?? (opts.btPolicy ?? context.btPolicy) ?? (opts.sctlrPolicy ?? context.sctlrPolicy));
}

const liftArm64eMachineEffectsBase = extendArm64eWithPacmEffects(extendArm64WithArm64eEffects(liftArm64MachineEffects));
const liftArm64eMachineEffects = (decoded, context = {}) => {
  const encodingFailure = arm64ePointerAuthenticationOperandShapeFailureBundle(decoded, context);
  if (encodingFailure) return encodingFailure;
  const bundle = liftArm64eMachineEffectsBase(decoded, context);
  if (bundle == null) return null;
  const postState = decorateArm64BtiGuardedPageEffects(decoded, bundle, context);
  return decorateArm64BtypeEffects(decoded, context, postState);
};

const liftArm64ArchitectureMachineEffects = (decoded, context = {}) => {
  if (isArm64ePointerAuthenticationInstruction(decoded) || isArm64eAuthenticatedLoadInstruction(decoded)) {
    const pacRequested = context.pacRequested ?? context.pacPolicy?.pacRequested ?? context.aarch64SecurityFeatures?.pacRequested ?? context.arm64GnuProperty?.pacRequested ?? context.arm64Bti?.pacRequested ?? context.image?.metadata?.arm64GnuProperty?.pacRequested ?? context.image?.metadata?.arm64Bti?.pacRequested ?? null;
    const pacEnabled = context.pacEnabled ?? context.runtime?.pacEnabled ?? null;

    if (pacEnabled === true) {
      const arm64Context = {
        ...context,
        architectureId: 'arm64',
        mode: decoded.mode || context.mode || 'a64',
        arch: 'arm64',
      };
      const rawBundle = liftArm64eMachineEffects(decoded, arm64Context);
      if (rawBundle == null) return null;
      return createMachineEffectBundle({
        ...rawBundle,
        architectureId: 'arm64',
        mode: decoded.mode || context.mode || 'a64',
        metadata: {
          ...rawBundle.metadata,
          pauthFeatureExtension: true,
          abi: context.abi || 'aapcs64',
        },
      }, context?.machineEffectsOptions);
    }

    if (pacEnabled === false || pacRequested === false) {
      const mnemonic = typeof decoded?.mnemonic === 'string' ? decoded.mnemonic.toLowerCase() : '';
      if (ARM64_PAUTH_HINT_NOPS.has(mnemonic)) {
        const instructionId = decoded.instructionId || context.instructionId || 'arm64:pauth:nop';
        return createMachineEffectBundle({
          instructionId,
          architectureId: 'arm64',
          mode: decoded.mode || context.mode || 'a64',
          operations: [],
          controlEffect: { kind: 'fallthrough' },
          possibleFaults: [],
          origin: decoded.origin || context.origin || { instructionIds: [instructionId] },
          completeness: 'exact',
          statePreservation: { proven: true, reason: 'PAuth HINT instruction on system without PAC feature is an architectural NOP' },
          metadata: {
            family: 'arm64-pointer-authentication',
            mnemonic,
            pacFeature: 'absent',
          },
        }, context?.machineEffectsOptions);
      }
      const instructionId = decoded.instructionId || context.instructionId || 'arm64:pauth:undefined';
      return createMachineEffectBundle({
        instructionId,
        architectureId: 'arm64',
        mode: decoded.mode || context.mode || 'a64',
        operations: [],
        controlEffect: { kind: 'trap', reason: 'undefined-instruction-exception' },
        possibleFaults: [{ kind: 'undefined-instruction-exception' }],
        origin: decoded.origin || context.origin || { instructionIds: [instructionId] },
        completeness: 'partial',
        unknownEffects: { categories: ['control', 'registers', 'faults'], reason: 'arm64-pac-feature-absent-undefined-instruction' },
        metadata: {
          family: 'arm64-pointer-authentication',
          mnemonic,
          pacFeature: 'absent',
        },
      }, context?.machineEffectsOptions);
    }

    // PAC runtime state is unresolved/unknown -> fail closed to partial
    const mnemonic = typeof decoded?.mnemonic === 'string' ? decoded.mnemonic.toLowerCase() : '';
    const instructionId = decoded.instructionId || context.instructionId || 'arm64:pauth:unresolved';
    return createMachineEffectBundle({
      instructionId,
      architectureId: 'arm64',
      mode: decoded.mode || context.mode || 'a64',
      operations: [],
      controlEffect: { kind: 'unknown', reason: 'arm64-pac-runtime-state-unresolved' },
      possibleFaults: [],
      origin: decoded.origin || context.origin || { instructionIds: [instructionId] },
      completeness: 'partial',
      unknownEffects: { categories: ['control', 'registers'], reason: 'arm64-pac-runtime-state-unresolved' },
      metadata: {
        family: 'arm64-pointer-authentication',
        mnemonic,
        pacFeature: 'unresolved',
      },
    }, context?.machineEffectsOptions);
  }

  const bundle = liftArm64MachineEffects(decoded, context);
  if (bundle == null) return null;
  // liftArm64MachineEffects already ran decorateArm64BtiGuardedPageEffects
  // inside dispatcher.js. Skip the redundant second pass when the instruction
  // is not BTI/implicit-landing or when context and normalizedContext carry
  // identical BTI guard inputs.
  const mnemonic = typeof decoded?.mnemonic === 'string' ? decoded.mnemonic.trim().toLowerCase() : '';
  const needsSecondBtiPass = (mnemonic === 'bti' || ARM64_IMPLICIT_BTI_LANDING_MNEMONICS.has(mnemonic))
    && !sameBtiContextInputs(context);
  const postState = needsSecondBtiPass
    ? decorateArm64BtiGuardedPageEffects(decoded, bundle, context)
    : bundle;
  return decorateArm64BtypeEffects(decoded, context, postState);
};

export const ARM64_ARCHITECTURE = registerArchitecturePlugin({
  id:'arm64', semanticVersion:ARM64_MACHINE_EFFECTS_SEMANTIC_VERSION, instructionAlignment:4, fixedInstructionSize:4, viewerCompatible:true,
  modes:()=>Object.freeze(['a64']), registerFile:()=>ARM64_REGISTERS,
  decodeProvider:'capstone/backend', liftExact:liftArm64ArchitectureMachineEffects, assemble:assembleArm64, classifyControlFlow:arm64ControlFlow,
  directControlTarget:arm64DirectControlTarget, supportedInstructionEndianness:Object.freeze(['little']),
  // Phase 2 exposes exact low-level effects where implemented. Coverage is not
  // complete yet, so the proven legacy v1 path remains active and MachineEffects
  // stays a shadow semantic source until the compatibility differential is zero.
  capabilities:{ decode:'external', exactEffects:'partial', semanticAnalysis:'legacy-v1' },
});

export const ARM64E_ARCHITECTURE = registerArchitecturePlugin({
  id:'arm64e', semanticVersion:ARM64_MACHINE_EFFECTS_SEMANTIC_VERSION, instructionAlignment:4, fixedInstructionSize:4, viewerCompatible:true,
  modes:()=>Object.freeze(['a64','arm64e']), registerFile:()=>ARM64_REGISTERS,
  decodeProvider:'capstone/backend', liftExact:liftArm64eMachineEffects, assemble:assembleArm64, classifyControlFlow:arm64ControlFlow,
  directControlTarget:arm64DirectControlTarget, supportedInstructionEndianness:Object.freeze(['little']),
  capabilities:{ decode:'external', exactEffects:'partial', semanticAnalysis:'legacy-v1-partial' },
});

export const ARM64EC_ARCHITECTURE = registerArchitecturePlugin({
  id:'arm64ec', semanticVersion:ARM64_MACHINE_EFFECTS_SEMANTIC_VERSION, instructionAlignment:4, fixedInstructionSize:4, viewerCompatible:true,
  modes:()=>Object.freeze(['a64','arm64ec']), registerFile:()=>ARM64_REGISTERS,
  decodeProvider:'capstone/backend', liftExact:liftArm64ArchitectureMachineEffects, assemble:assembleArm64, classifyControlFlow:arm64ControlFlow,
  directControlTarget:arm64DirectControlTarget, supportedInstructionEndianness:Object.freeze(['little']),
  capabilities:{ decode:'external', exactEffects:'partial', semanticAnalysis:'legacy-v1' },
});

export const X86_64_ARCHITECTURE = registerArchitecturePlugin({
  id:'x86_64', semanticVersion:X86_64_MACHINE_EFFECTS_SEMANTIC_VERSION, instructionAlignment:1, fixedInstructionSize:null, viewerCompatible:false,
  modes:()=>Object.freeze(['long-64']), registerFile:x86RegisterFile,
  decodeProvider:'capstone/backend', liftExact:liftX86MachineEffects, classifyControlFlow:x86ControlFlow,
  liftDecodedExact:liftX86DecodedMachineEffects, resolveSwitchTables:resolveX86SwitchTables,
  directControlTarget:x86DirectControlTarget, supportedMemoryEndianness:Object.freeze(['little']), supportedInstructionEndianness:Object.freeze(['little']),
  // P5-5's bounded variable-length viewer implementation is integrated and
  // verified under tests/phase5/viewer/**. Public capability promotion is kept
  // conservative because the frozen global capability regression is outside
  // P5-I ownership; semantic/A6 maturity also remains partial pending P5-6.
  capabilities:{ decode:'external-structured-v1', exactEffects:'partial', semanticAnalysis:'phase5-shadow-partial' },
});

/**
 * RISC-V64, frozen Phase 6 profile RV64IMC / LP64 little-endian.
 *
 * `instructionAlignment` is 2 and `fixedInstructionSize` is null because the
 * "C" standard extension makes the instruction stream variable-width. There is
 * deliberately no flags register in `registerFile()`: RV64 has none, and the
 * whole point of Phase 6 is that the generic middle-end does not need one.
 */
export const RISCV64_ARCHITECTURE = registerArchitecturePlugin({
  id:'riscv64', semanticVersion:RISCV64_MACHINE_EFFECTS_SEMANTIC_VERSION, instructionAlignment:RISCV64_INSTRUCTION_ALIGNMENT, fixedInstructionSize:null, viewerCompatible:false,
  modes:()=>Object.freeze(['rv64im','rv64imc']), registerFile:riscv64RegisterFile,
  decodeProvider:'capstone/backend', liftExact:liftRiscv64MachineEffects, classifyControlFlow:riscv64ControlFlow,
  directControlTarget:riscv64DirectControlTarget, supportedMemoryEndianness:Object.freeze(['little']), supportedInstructionEndianness:Object.freeze(['little']),
  capabilities:{ decode:'external-structured-v1', exactEffects:'exact-for-rv64imc-profile', semanticAnalysis:'phase6-shared-middle-end' },
});

export const UNKNOWN_ARCHITECTURE = registerArchitecturePlugin({
  id:'unknown', semanticVersion:'1', instructionAlignment:1, fixedInstructionSize:null, viewerCompatible:false,
  capabilities:{ decode:'unsupported', exactEffects:'unsupported', semanticAnalysis:'unsupported' },
});

export { ArchitecturePluginV2, registerArchitecturePlugin, architecturePluginV2, architecturePluginsV2, canonicalArchitectureId, normalizeArchitecturePositiveInteger };
