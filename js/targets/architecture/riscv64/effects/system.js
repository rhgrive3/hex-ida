import { createRiscv64EffectContext } from './common.js';
import { createIntrinsicEffectSummary } from '../../../../semantics/effects/index.js';

/**
 * FENCE and the two base-ISA environment-call instructions.
 *
 * `fence` is a memory-ordering barrier; its predecessor/successor sets are
 * carried into the barrier scope so the ordering is not silently widened or
 * narrowed. `ecall`/`ebreak` transfer control to the execution environment.
 * Their values are unknowable from the binary, but their complete footprint is
 * knowable: every mutable integer register and addressable state space may be
 * read or written, control traps, and the result is nondeterministic. That is a
 * complete intrinsic boundary, never a convenient no-op or preservation claim.
 */

const FENCE_BIT_NAMES = Object.freeze(['input', 'output', 'read', 'write']);
const ENVIRONMENT_REGISTERS = Object.freeze([
  ...Array.from({ length: 31 }, (_unused, index) => `x${index + 1}`),
  'sys:riscv64.execution-environment',
]);
const ENVIRONMENT_SPACES = Object.freeze(['code', 'io', 'memory', 'tls']);

function fenceSet(mask) {
  const value = Number(mask) & 0b1111;
  return Object.freeze(FENCE_BIT_NAMES.filter((_name, index) => (value & (1 << (3 - index))) !== 0));
}

export function liftRiscv64SystemEffects(decoded, context = {}) {
  const ctx = createRiscv64EffectContext(decoded, context);
  const fields = ctx.fields;
  if (!fields.supported) return null;

  if (fields.op === 'fence') {
    ctx.addOperation({
      kind: 'barrier',
      scope: {
        kind: 'riscv64-fence',
        predecessor: fenceSet(fields.predecessor),
        successor: fenceSet(fields.successor),
        fenceMode: Number(fields.fenceMode) === 0b1000
          && Number(fields.predecessor) === 0b0011
          && Number(fields.successor) === 0b0011 ? 'tso' : 'normal',
      },
    });
    return ctx.finish({ family: 'barrier', metadata: { operation: 'fence' } });
  }

  if (fields.op === 'fence.i') {
    ctx.addOperation({ kind: 'barrier', scope: { kind: 'riscv64-instruction-fence' } });
    return ctx.finish({ family: 'barrier', metadata: { operation: 'fence.i', extension: 'Zifencei' } });
  }

  if (fields.op === 'ecall' || fields.op === 'ebreak') {
    const controlEffect = { kind: 'trap', reason: `riscv64-${fields.op}` };
    ctx.addOperation({
      kind: 'intrinsic',
      intrinsicId: `riscv64.environment.${fields.op}`,
      effectSummary: createIntrinsicEffectSummary({
        inputs: [],
        outputs: [],
        registersRead: ENVIRONMENT_REGISTERS,
        registersWritten: ENVIRONMENT_REGISTERS,
        memoryRead: { scope: 'all', spaces: ENVIRONMENT_SPACES },
        memoryWrite: { scope: 'all', spaces: ENVIRONMENT_SPACES },
        controlEffects: [controlEffect],
        determinism: 'nondeterministic',
        symbolicDetail: 'summary-only',
      }),
      metadata: {
        environmentBoundary: true,
        preservation: 'none-assumed',
      },
    });
    return ctx.finish({
      completeness: 'exact-with-intrinsic',
      controlEffect,
      family: 'system',
      metadata: { operation: fields.op, environmentCall: true, environmentFootprintComplete: true },
    });
  }

  return null;
}
