/** Independent interval-induction checker for ONE explicit unsigned scalar
 * transition model. It does not discover loops, decode instructions, or adopt
 * rewrites. An induction failure is a model-state witness, NOT an executable
 * counterexample. Machine/CFG/source adequacy remains a separate obligation.
 */
import { snapshotContractData, recordFields, exactInteger, contractFail } from '../identity/structured.js';
import { deepFreeze, stableStringify } from '../identity/index.js';
import { assertScopedAnalysisWork } from '../budgets/scoped-work.js';

export const SCALAR_LOOP_SCHEMA = 'scpa-scalar-loop-model/v1';
export const LOOP_CHECKER_VERSION = '1.0.0';
export const LOOP_OBSERVABLE_CONTRACT = 'unsigned-register-at-header-and-exit-only';
const dec = (s, signed = false) => {
  if (typeof s !== 'string' || !(signed ? /^(0|-?[1-9][0-9]{0,19})$/ : /^(0|[1-9][0-9]{0,19})$/).test(s)) contractFail('loop-decimal');
  return BigInt(s);
};
const interval = (v, maximum) => {
  recordFields(v, ['lower', 'upper'], 'loop-interval-fields');
  const lower = dec(v.lower), upper = dec(v.upper);
  if (lower > upper || upper > maximum) contractFail('loop-interval-range');
  return { lower, upper };
};
const intersect = (a, b) => {
  const lower = a.lower > b.lower ? a.lower : b.lower, upper = a.upper < b.upper ? a.upper : b.upper;
  return lower <= upper ? { lower, upper } : null;
};
const contains = (a, b) => !b || (a.lower <= b.lower && a.upper >= b.upper);
const outside = (a, b) => !b ? [a] : [a.lower < b.lower ? { lower: a.lower, upper: b.lower - 1n } : null,
  a.upper > b.upper ? { lower: b.upper + 1n, upper: a.upper } : null].filter(Boolean);
const data = v => v && ({ lower: v.lower.toString(), upper: v.upper.toString() });
const mod = (n, m) => ((n % m) + m) % m;
function image(v, step, modulus) {
  if (!v) return [];
  const lo = v.lower + step, hi = v.upper + step;
  const wrap = n => n >= 0n ? n / modulus : (n - modulus + 1n) / modulus;
  return wrap(lo) === wrap(hi) ? [{ lower: mod(lo, modulus), upper: mod(hi, modulus) }]
    : [{ lower: 0n, upper: mod(hi, modulus) }, { lower: mod(lo, modulus), upper: modulus - 1n }];
}
function missingPoint(v, expected) { return v.lower < expected.lower ? v.lower : v.upper > expected.upper ? v.upper : null; }

export function checkScalarLoopInvariant(modelInput, candidateInput, { work } = {}) {
  assertScopedAnalysisWork(work); work.checkpoint(); work.charge('workUnits', 32);
  const model = snapshotContractData(modelInput, { maxBytes: 8192, maxNodes: 128 });
  const candidate = snapshotContractData(candidateInput, { maxBytes: 4096, maxNodes: 64 });
  work.charge('residentBytes', (stableStringify(model).length + stableStringify(candidate).length) * 2);
  recordFields(model, ['schema', 'bits', 'entry', 'guard', 'step', 'observableContract'], 'loop-model-fields');
  recordFields(candidate, ['invariant', 'postcondition'], 'loop-candidate-fields');
  if (model.schema !== SCALAR_LOOP_SCHEMA || model.observableContract !== LOOP_OBSERVABLE_CONTRACT) contractFail('loop-model-contract');
  const bits = exactInteger(model.bits, 'loop-bits', { min: 1, max: 64 }), modulus = 1n << BigInt(bits), maximum = modulus - 1n;
  const entry = interval(model.entry, maximum), guard = interval(model.guard, maximum), step = dec(model.step, true);
  if (step < -maximum || step > maximum) contractFail('loop-step-range');
  const invariant = interval(candidate.invariant, maximum), post = interval(candidate.postcondition, maximum);
  const body = intersect(invariant, guard), images = image(body, step, modulus), exits = outside(invariant, body);
  const initiation = contains(invariant, entry), preservation = images.every(v => contains(invariant, v));
  const postcondition = exits.every(v => contains(post, v));
  let firstFailure = null;
  if (!initiation) firstFailure = { obligation: 'initiation', headerValue: missingPoint(entry, invariant).toString() };
  else if (!preservation) {
    const bad = missingPoint(images.find(v => !contains(invariant, v)), invariant);
    firstFailure = { obligation: 'preservation', headerValue: mod(bad - step, modulus).toString(), nextValue: bad.toString() };
  } else if (!postcondition) firstFailure = { obligation: 'postcondition', exitValue: missingPoint(exits.find(v => !contains(post, v)), post).toString() };
  // This proof is analytic over EVERY state in the interval. No sample count
  // or bounded unroll may substitute for a preservation or ranking obligation.
  const noWrap = !body || (body.lower + step >= 0n && body.upper + step < modulus);
  const ranked = !body || (step !== 0n && noWrap);
  const ranking = !body ? { kind: 'zero-iterations-on-invariant', lowerBound: '0' } : ranked
    ? { kind: step > 0n ? 'guard-upper-plus-one-minus-value' : 'value-minus-guard-lower-plus-one',
      strictDecrease: (step > 0n ? step : -step).toString(), lowerBound: '1',
      maximumIterations: (((body.upper - body.lower) / (step > 0n ? step : -step)) + 1n).toString() } : null;
  work.checkpoint();
  return deepFreeze({ schema: 'scpa-loop-induction-result/v1', checkerVersion: LOOP_CHECKER_VERSION,
    status: firstFailure ? 'rejected' : 'verified-model', inductive: initiation && preservation,
    postconditionChecked: !firstFailure, obligations: { initiation, preservation, postcondition }, firstFailure,
    witnessDomain: firstFailure ? 'transition-model-state; reachability-not-established' : null,
    body: data(body), image: images.map(data), exit: exits.map(data),
    termination: !firstFailure && ranked ? 'verified-model' : 'unknown', ranking: firstFailure ? null : ranking,
    exact: false, semanticProof: false, wholeFunctionProof: false, rewriteAuthorized: false,
    remaining: ['machine-cfg-and-model-correspondence-unproved', 'entry-reachability-unproved',
      'flags-memory-exceptions-and-other-registers-not-modeled', ...(!ranked ? ['termination-ranking-unproved'] : [])] });
}
