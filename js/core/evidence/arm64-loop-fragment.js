/** Independent byte-to-transition correspondence for one counted A64 loop.
 * The checker has no canonical decoder/range/CFG dependency. Its entry is the
 * first instruction and its exit is before RET, with normal fetch/execution.
 * It proves neither arbitrary incoming edges nor asynchronous exceptions. */
import { deepFreeze, stableStringify } from '../identity/index.js';
import { contractFail } from '../identity/structured.js';
import { assertScopedAnalysisWork } from '../budgets/scoped-work.js';
import { supportsIntegerFragmentProfile } from './arm64-integer-fragment.js';
import { checkScalarLoopInvariant, SCALAR_LOOP_SCHEMA, LOOP_OBSERVABLE_CONTRACT } from './loop-invariant.js';

export const ARM64_LOOP_CHECKER_VERSION = '1.0.0';
export const ARM64_LOOP_DOMAIN = Object.freeze({ entry: 'first-fragment-instruction-only', exit: 'before-final-ret',
  completion: 'normal-instruction-fetch-and-execution', observes: 'loop-register-and-nzcv-at-exit',
  excludes: 'incoming-edges-outside-fragment; instruction-fetch-faults; asynchronous-exceptions; timing' });
const iv = (lower, upper = lower) => ({ lower: lower.toString(), upper: upper.toString() });
const unknown = reason => deepFreeze({ status: 'unknown', reason, model: null, semanticProof: false });
const signed = (value, bits) => value & (2 ** (bits - 1)) ? value - 2 ** bits : value;

export function extractArm64ScalarLoop(bytes, { profile, work } = {}) {
  assertScopedAnalysisWork(work); work.checkpoint(); work.charge('workUnits', 64);
  if (!(bytes instanceof Uint8Array) || bytes.length > 4096) contractFail('native-loop-byte-budget');
  if (!supportsIntegerFragmentProfile(profile)) return unknown('native-loop-profile-unsupported');
  if (bytes.length !== 24) return unknown('native-loop-shape-unsupported');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const words = Array.from({ length: 6 }, (_, i) => view.getUint32(i * 4, true));
  const [init, cmp, exitBranch, update, backBranch, ret] = words;
  const bits = init >>> 31 ? 64 : 32, register = init & 31, maximum = (1n << BigInt(bits)) - 1n;
  const hw = (init >>> 21) & 3;
  if (((init & 0x7f800000) >>> 0) !== 0x52800000 || register === 31 || (bits === 32 && hw >= 2)) return unknown('native-loop-entry-must-be-movz');
  if (((cmp & 0x7f80001f) >>> 0) !== 0x7100001f || (cmp >>> 31 ? 64 : 32) !== bits
    || ((cmp >>> 5) & 31) !== register) return unknown('native-loop-compare-unsupported');
  if (((exitBranch & 0xff000010) >>> 0) !== 0x54000000
    || 8 + signed((exitBranch >>> 5) & 0x7ffff, 19) * 4 !== 20) return unknown('native-loop-exit-target-unsupported');
  if (((update & 0x1f800000) >>> 0) !== 0x11000000 || (update & 0x20000000)
    || (update >>> 31 ? 64 : 32) !== bits || (update & 31) !== register
    || ((update >>> 5) & 31) !== register) return unknown('native-loop-update-unsupported');
  if (((backBranch & 0xfc000000) >>> 0) !== 0x14000000
    || 16 + signed(backBranch & 0x03ffffff, 26) * 4 !== 4 || ret !== 0xd65f03c0) return unknown('native-loop-backedge-or-exit-unsupported');
  const initial = BigInt((init >>> 5) & 65535) << BigInt(hw * 16);
  const limit = BigInt((cmp >>> 10) & 4095) << BigInt(cmp & 0x00400000 ? 12 : 0);
  let step = BigInt((update >>> 10) & 4095) << BigInt(update & 0x00400000 ? 12 : 0);
  if (update & 0x40000000) step = -step;
  const condition = exitBranch & 15;
  let guard;
  if (condition === 2 && limit > 0n) guard = iv(0n, limit - 1n); // HS exits: unsigned >=.
  else if (condition === 3) guard = iv(limit, maximum); // LO exits: unsigned <.
  else if (condition === 8) guard = iv(0n, limit); // HI exits: unsigned >.
  else if (condition === 9 && limit < maximum) guard = iv(limit + 1n, maximum); // LS exits: unsigned <=.
  else return unknown('native-loop-guard-not-single-nonempty-unsigned-interval');
  const model = { schema: SCALAR_LOOP_SCHEMA, bits, entry: iv(initial), guard,
    step: step.toString(), observableContract: LOOP_OBSERVABLE_CONTRACT };
  return deepFreeze({ status: 'correspondence-checked', checkerVersion: ARM64_LOOP_CHECKER_VERSION, model,
    register: `x${register}`, compareImmediate: limit.toString(), exitCondition: condition, domain: ARM64_LOOP_DOMAIN,
    cfg: { entry: 0, header: 4, guard: 8, body: 12, backedge: 16, exit: 20 },
    effects: { memory: 'none', dataFaults: 'none-in-supported-instructions', otherRegisters: 'preserved',
      nzcv: 'last-header-unsigned-compare', upperRegisterBits: bits === 32 ? 'zero' : 'part-of-register' }, semanticProof: false });
}

export function checkArm64ScalarLoop(bytes, model, candidate, { profile, work } = {}) {
  const correspondence = extractArm64ScalarLoop(bytes, { profile, work });
  if (correspondence.status !== 'correspondence-checked') return correspondence;
  if (stableStringify(correspondence.model) !== stableStringify(model)) return deepFreeze({ status: 'rejected',
    reason: 'native-loop-model-correspondence-mismatch', correspondence, semanticProof: false });
  const induction = checkScalarLoopInvariant(model, candidate, { work });
  const verified = induction.status === 'verified-model' && induction.termination === 'verified-model';
  // NZCV is evaluated from the last CMP at the exit header, not from ADD/SUB.
  // Non-singleton exit intervals retain an exact expression, not sampled flags.
  const flags = { kind: 'a64-subtract-nzcv', bits: model.bits, left: { kind: 'exit-register', register: correspondence.register },
    right: correspondence.compareImmediate };
  return deepFreeze({ status: induction.status === 'rejected' ? 'rejected' : verified ? 'verified-fragment' : 'unknown',
    checkerVersion: ARM64_LOOP_CHECKER_VERSION, correspondence, induction, flags,
    obligations: { entryInitialization: true, headerReachabilityFromEntry: true, branchTargets: true, transitionCorrespondence: true,
      induction: induction.status === 'verified-model', termination: induction.termination === 'verified-model',
      nzcvExpression: true, noDataMemoryAccess: true },
    domain: ARM64_LOOP_DOMAIN, semanticProof: false, wholeFunctionProof: false, rewriteAuthorized: false,
    remaining: ['current-source-byte-binding-required', 'external-incoming-edges-and-fetch-environment-outside-fragment-domain'] });
}
