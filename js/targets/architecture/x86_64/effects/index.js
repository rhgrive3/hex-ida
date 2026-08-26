// Exact-head CI retrigger marker; semantic no-op.
import { liftX86ControlEffects } from './control.js';
import { liftX86IntegerEffects, liftX86LeaEffects } from './integer.js';
import { liftX86ImplicitSignExtensionEffects } from './implicit-sign-extension.js';
import { liftX86BitManipulationEffects } from './bit-manipulation.js';
import { liftX86MemoryEffects } from './memory.js';
import { liftX86StringEffects } from './string.js';
import { liftX86AtomicEffects } from './atomic.js';
import { liftX86FloatingPointEffects } from './fp.js';
import { liftX86SimdEffects } from './simd.js';
import { liftX86SimdAndNotEffects } from './simd-and-not.js';
import { liftX86SystemEffects } from './system.js';
import { liftX86SystemRegisterMoveEffects } from './system-register-move.js';
import { dispatchX86TerminalResidualEffects } from './terminal-residual.js';
import {
  dispatchX86ExtendedStateEffects,
  liftX86ExtendedStateEffects,
  integrateX86ExtendedStateAliases,
} from './extended-state.js';
import { closeTrustedX86Partial } from './trusted-decoder-terminal.js';
import { normalizeX86Instruction, X86_64_MACHINE_EFFECTS_SEMANTIC_VERSION } from './common.js';

function liftX86IntegerFamily(instruction, context) {
  return liftX86ImplicitSignExtensionEffects(instruction, context)
    ?? liftX86IntegerEffects(instruction, context)
    ?? liftX86BitManipulationEffects(instruction, context);
}

function liftX86SimdFamily(instruction, context) {
  return liftX86SimdAndNotEffects(instruction, context) ?? liftX86SimdEffects(instruction, context);
}

const FAMILIES = Object.freeze([
  Object.freeze({ id:'control', lift:liftX86ControlEffects }),
  Object.freeze({ id:'memory', lift:liftX86MemoryEffects }),
  Object.freeze({ id:'lea', lift:liftX86LeaEffects }),
  Object.freeze({ id:'integer', lift:liftX86IntegerFamily }),
  Object.freeze({ id:'string', lift:liftX86StringEffects }),
  Object.freeze({ id:'atomic', lift:liftX86AtomicEffects }),
  Object.freeze({ id:'fp', lift:liftX86FloatingPointEffects }),
  Object.freeze({ id:'simd', lift:liftX86SimdFamily }),
  Object.freeze({ id:'system', lift:liftX86SystemEffects }),
]);

export { X86_64_MACHINE_EFFECTS_SEMANTIC_VERSION };

function invalidNonEvexExtendedVector(instruction) {
  const evex = String(instruction?.detail?.prefixes?.vector?.kind || '').toLowerCase() === 'evex';
  if (evex) return false;
  const registers = [
    ...(instruction?.detail?.operands || []).filter((operand) => operand?.type === 'register').map((operand) => operand.register),
    ...(instruction?.detail?.implicitReads || []), ...(instruction?.detail?.implicitWrites || []),
  ];
  return registers.some((register) => register?.evexOnly === true || /^(?:zmm(?:[0-9]|[12][0-9]|3[01])|(?:xmm|ymm)(?:1[6-9]|2[0-9]|3[01]))$/.test(String(register?.id || '').toLowerCase()));
}

const STRUCTURED_FAIL_CLOSED_REASON = /(?:structured-implicit-accumulator-missing|prefix-state-unmodelled|f2-repeat-prefix|implicit-state-unmodelled|address-size-unmodelled|operand-shape-unmodelled)/;

function terminalize(instruction, ownerId, result, context) {
  // Decoder acceptance is not architectural validity. Family lifters mark
  // byte/family combinations that fail their architectural encoding policy
  // with encodingValidated:false; those records must remain fail-closed even
  // when they came from the trusted Capstone decoder. Likewise, a trusted
  // decoder provenance token cannot repair deliberately inconsistent structured
  // evidence (missing implicit state, malformed prefix/operand shape, etc.).
  const reason = String(result?.unknownEffects?.reason || '');
  if (result?.completeness === 'partial' && (
    result?.metadata?.encodingValidated === false
    || result?.metadata?.exactWideAtomicClaim === false
    || result?.metadata?.structuredImplicitAccumulatorMissing === true
    || STRUCTURED_FAIL_CLOSED_REASON.test(reason)
  )) return result;
  return closeTrustedX86Partial(instruction, ownerId, result, context);
}

export function dispatchX86MachineEffects(decoded, context = {}) {
  const instruction = normalizeX86Instruction(decoded, context);
  if (!instruction.detailAvailable) return Object.freeze({ ownerId: 'fallback', result: null });
  if (invalidNonEvexExtendedVector(instruction)) throw new TypeError('x86-decoded-instruction-high-vector-register-requires-evex');

  // Capstone emits the architectural MOV family for 0F20/21/22/23. These
  // encodings must be claimed before the generic integer MOV owner or their
  // CR/DR physical state and privilege/debug effects would be lost.
  const systemRegisterMove = liftX86SystemRegisterMoveEffects(instruction, context);
  if (systemRegisterMove != null) {
    return Object.freeze({ ownerId:'system', result:terminalize(instruction, 'system', systemRegisterMove, context) });
  }

  // The terminal long-64 residual lane is deliberately provenance- and
  // raw-encoding-gated. It owns only families for which the frozen decoder
  // denominator exposed a concrete architectural surface that is not covered
  // by the older broad family lifters. VEX results still pass through the
  // canonical MAXVL alias integrator before they become externally visible.
  const terminalResidual = dispatchX86TerminalResidualEffects(instruction, context);
  if (terminalResidual != null && terminalResidual.result != null) {
    const integrated = integrateX86ExtendedStateAliases(instruction, terminalResidual.result, context);
    return Object.freeze({
      ownerId:terminalResidual.ownerId,
      result:terminalize(instruction, terminalResidual.ownerId, integrated, context),
    });
  }

  const extended = dispatchX86ExtendedStateEffects(instruction, context);
  if (extended != null && extended.result != null) {
    return Object.freeze({
      ownerId: extended.ownerId,
      result: terminalize(instruction, extended.ownerId, extended.result, context),
    });
  }
  for (const family of FAMILIES) {
    const result = family.lift(instruction, context);
    if (result != null) {
      const integrated = integrateX86ExtendedStateAliases(instruction, result, context);
      return Object.freeze({
        ownerId: family.id,
        result: terminalize(instruction, family.id, integrated, context),
      });
    }
  }
  return Object.freeze({ ownerId: 'fallback', result: null });
}

export function liftX86MachineEffects(decoded, context = {}) {
  const dispatch = dispatchX86MachineEffects(decoded, context);
  return dispatch.result;
}

export function x86MachineEffectFamilies() { return Object.freeze(FAMILIES.map(({ id }) => id)); }
