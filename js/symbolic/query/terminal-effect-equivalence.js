/**
 * C4-04B terminal-control effect equivalence.
 *
 * This is deliberately narrower than finite-byte memory equivalence.  It proves
 * only the architectural terminal-control effect that the canonical executor
 * can already observe: the return target, its normal-completion predicate and
 * the ordered canonical fault predicates.  ABI return values and memory are not
 * part of this claim and therefore cannot be authorized by this receipt.
 */
import { stableDigest } from '../../core/identity/index.js';
import { queryRecord, queryArray } from '../memory/data-input.js';
import { createQueryGuard, QueryFailure, sameMemoryIdentity } from '../memory/query-state.js';
import { isExecutionResult } from '../memory/execution-snapshot.js';
import { TERMINAL_CONTROL_SCHEMA } from '../memory/terminal-control.js';
import { symbolicExecute } from '../executor.js';
import { createBool, createFreshSymbol, bvSort, createCompare, createConnective } from '../expr/index.js';
import { TieredBvBackend } from '../solver/tiered-backend.js';
import { ExhaustiveBvBackend } from '../solver/exhaustive-backend.js';
import { verifyBoundedEquivalence } from '../verify/equivalence.js';
import { isProvedEvidence } from '../evidence/symbolic-evidence.js';

const receipts = new WeakMap();
const LIMITS = Object.freeze({ workItems:50000, solverCalls:4 });
const FORBIDDEN = new Set(['backend','session','proof','solverResult','executionSnapshot']);

const conjunction = values => values.length ? createConnective('and', ...values) : createBool(true);
const disjunction = values => values.length ? createConnective('or', ...values) : createBool(false);
function equivalentExpression(left, right) {
  if (!left || !right || left.sort?.kind !== right.sort?.kind || left.sort?.width !== right.sort?.width) return createBool(false);
  return left.sort.kind === 'bool' ? createConnective('eq', left, right) : createCompare('eq', left, right);
}
function effectEquality(before, after) {
  const left = before.control, right = after.control;
  if (!left || !right || left.schemaVersion !== TERMINAL_CONTROL_SCHEMA || right.schemaVersion !== TERMINAL_CONTROL_SCHEMA
      || left.kind !== 'return' || right.kind !== 'return') return createBool(false);
  const terms = [equivalentExpression(left.target, right.target),
    equivalentExpression(left.normalCompletionCondition, right.normalCompletionCondition)];
  if (left.faults.length !== right.faults.length) return createBool(false);
  for (let index = 0; index < left.faults.length; index += 1) {
    const a = left.faults[index], b = right.faults[index];
    if (a.kind !== b.kind) return createBool(false);
    terms.push(equivalentExpression(a.condition, b.condition));
  }
  return conjunction(terms);
}
function validObservation(observation) {
  const control = observation?.control;
  return Number.isSafeInteger(observation?.pathIndex) && observation.pathIndex >= 0
    && Array.isArray(observation.constraints)
    && control?.schemaVersion === TERMINAL_CONTROL_SCHEMA && control.kind === 'return'
    && control.target?.sort?.kind === 'bv'
    && control.normalCompletionCondition?.sort?.kind === 'bool'
    && Array.isArray(control.faults)
    && control.faults.every(fault => typeof fault?.kind === 'string' && fault.kind.length > 0
      && fault.condition?.sort?.kind === 'bool');
}

export async function queryTerminalEffectEquivalence(request = {}) {
  let guard = null, session = null, before = null, after = null, scope = null;
  const stopped = (reason, verdict = 'unknown') => Object.freeze({ eligible:false, verdict, reason, scope,
    evidence:null, bindingDigest:scope ? stableDigest(scope) : null, metrics:guard?.metrics() ?? null });
  try {
    request = queryRecord(request);
    if (Object.keys(request).some(key => FORBIDDEN.has(key))) return stopped('external-proof-not-accepted');
    const identity = queryRecord(request.identity);
    guard = createQueryGuard({ ...request, identity, timeoutMs:request.timeoutMs ?? 1000 }, LIMITS); guard.check();
    const beforeIr = request.beforeIr, afterIr = request.afterIr;
    if (!beforeIr || !afterIr) throw new QueryFailure('missing-ir-pair');
    const backendTier = request.backendTier ?? 'tiered';
    if (!['tiered','exhaustive'].includes(backendTier)) throw new QueryFailure('unsupported-backend');
    const inputPairs = queryArray(request.inputs ?? [], guard, 64);
    const argumentExpressions = new Map(), inputBindings = [];
    for (let index = 0; index < inputPairs.length; index += 1) {
      guard.take('workItems');
      const pair = queryRecord(inputPairs[index], guard), b = queryRecord(pair.before, guard), a = queryRecord(pair.after, guard);
      if (b.kind !== 'arg' || a.kind !== 'arg' || !Number.isSafeInteger(b.bits) || b.bits < 1 || b.bits > 64 || a.bits !== b.bits
          || argumentExpressions.has(pair.before) || argumentExpressions.has(pair.after)) throw new QueryFailure('invalid-input-correspondence');
      const expression = createFreshSymbol(bvSort(b.bits), `terminal_effect_input_${index}`,
        { source:'argument', queryId:identity.queryId });
      argumentExpressions.set(pair.before, expression); argumentExpressions.set(pair.after, expression);
      inputBindings.push(Object.freeze({ before:pair.before, after:pair.after }));
    }
    const preconditions = queryArray(request.preconditions ?? [], guard, 256);
    for (const condition of preconditions) if (condition?.sort?.kind !== 'bool') throw new QueryFailure('precondition-sort');
    const execute = ir => symbolicExecute(ir, { captureValues:true, argumentExpressions,
      timeoutMs:Math.max(1, Math.floor(guard.remainingMilliseconds())), signal:request.signal,
      isCancelled:request.isCancelled,
      byteMemory:{ identity, addressBits:request.addressBits ?? 64, endian:request.endian ?? 'little',
        timeoutMs:Math.max(1, Math.floor(guard.remainingMilliseconds())), signal:request.signal,
        isCancelled:request.isCancelled, getCurrentIdentity:request.getCurrentIdentity } });
    before = execute(beforeIr); guard.check();
    after = execute(afterIr); guard.check();
    if (!isExecutionResult(before, identity, beforeIr) || !isExecutionResult(after, identity, afterIr)) throw new QueryFailure('stale-execution');
    if (before.terminalControlCoverage !== 'complete' || after.terminalControlCoverage !== 'complete') throw new QueryFailure('incomplete-terminal-control-coverage');
    const left = before.terminalControlObservations ?? [], right = after.terminalControlObservations ?? [];
    if (!left.length || !right.length || !left.every(validObservation) || !right.every(validObservation)) throw new QueryFailure('unsupported-terminal-control-observation');
    // A partial executor result is acceptable only when the sole missing fact is
    // normal completion itself; that is exactly the effect this query proves.
    for (const execution of [before, after]) {
      if (execution.status !== 'complete' && execution.reason !== 'return-control-normal-completion-unproved') {
        throw new QueryFailure(`execution:${execution.reason ?? 'partial'}`);
      }
    }
    guard.take('workItems', left.length * right.length + left.length + right.length + 2);
    const leftGuards = left.map(item => conjunction(item.constraints));
    const rightGuards = right.map(item => conjunction(item.constraints));
    const obligations = [disjunction(leftGuards), disjunction(rightGuards)];
    for (let i = 0; i < left.length; i += 1) for (let j = 0; j < right.length; j += 1) {
      obligations.push(createConnective('implies', conjunction([leftGuards[i], rightGuards[j]]), effectEquality(left[i], right[j])));
    }
    const obligation = conjunction(obligations);
    const symbols = [...new Set([...argumentExpressions.values()])];
    const tautology = conjunction(symbols.map(symbol => createCompare('eq', symbol, symbol)));
    scope = Object.freeze({ kind:'terminal-control-effects', version:1, identity,
      effects:Object.freeze(['terminal-control-target','terminal-control-normal-completion','terminal-fault-predicates']),
      beforePathCount:left.length, afterPathCount:right.length, faultKinds:Object.freeze([...new Set([...left,...right]
        .flatMap(item => item.control.faults.map(fault => fault.kind)))].sort()), unmodeledEffects:'rejected' });
    const backend = backendTier === 'tiered'
      ? new TieredBvBackend({ maxExprNodes:25000, maxVariables:32768, maxClauses:131072, maxDecisions:8192, maxPropagations:500000 })
      : new ExhaustiveBvBackend({ maxAssignments:4096, maxExprNodes:25000 });
    session = backend.createSession({ timeoutMs:Math.max(1,Math.floor(guard.remainingMilliseconds())), signal:request.signal });
    const proof = await verifyBoundedEquivalence({ beforeTarget:tautology, afterTarget:obligation,
      preconditions, correspondence:{ inputs:[] }, memoryRegions:[], session,
      options:{ proofScope:scope, architecture:identity.architecture,
        timeoutMs:Math.max(1,Math.floor(guard.remainingMilliseconds())), signal:request.signal } });
    guard.check();
    if (!isExecutionResult(before,identity,beforeIr) || !isExecutionResult(after,identity,afterIr)) throw new QueryFailure('stale-execution');
    if (proof.verdict !== 'proved' && proof.verdict !== 'refuted') return stopped(proof.reasonCode ?? 'proof-ineligible');
    if (proof.verdict === 'proved' && !isProvedEvidence(proof.evidence)) return stopped('unissued-proof');
    const result = Object.freeze({ eligible:proof.verdict === 'proved', verdict:proof.verdict,
      reason:proof.reasonCode ?? (proof.verdict === 'proved' ? 'proved-terminal-effect-equivalence' : 'terminal-effect-mismatch'),
      scope, evidence:proof.evidence, bindingDigest:stableDigest(scope), metrics:guard.metrics() });
    guard.check();
    if (!isExecutionResult(before,identity,beforeIr) || !isExecutionResult(after,identity,afterIr)) throw new QueryFailure('stale-execution');
    if (result.eligible) receipts.set(result, { beforeIr, afterIr, before, after, identity,
      inputs:Object.freeze(inputBindings), preconditions, signal:request.signal, isCancelled:request.isCancelled,
      getCurrentIdentity:request.getCurrentIdentity });
    return result;
  } catch (error) {
    if (!(error instanceof QueryFailure || error instanceof TypeError || error instanceof RangeError)) throw error;
    return stopped(error instanceof QueryFailure ? error.reason : 'invalid-terminal-effect-equivalence-input');
  } finally { session?.dispose(); }
}

export function isAdoptableTerminalEffectEquivalence(result, current = {}) {
  const receipt = receipts.get(result);
  if (!receipt) return false;
  try {
    current = queryRecord(current); const identity = queryRecord(current.identity);
    if (current.beforeIr !== receipt.beforeIr || current.afterIr !== receipt.afterIr || !sameMemoryIdentity(identity, receipt.identity)) return false;
    const inputs = queryArray(current.inputs ?? [], null, 64);
    if (inputs.length !== receipt.inputs.length) return false;
    for (let index = 0; index < inputs.length; index += 1) {
      const pair = queryRecord(inputs[index]), prior = receipt.inputs[index];
      if (pair.before !== prior.before || pair.after !== prior.after) return false;
    }
    const preconditions = current.preconditions ?? [];
    if (!Array.isArray(preconditions) || preconditions.length !== receipt.preconditions.length
        || preconditions.some((value,index) => value !== receipt.preconditions[index])) return false;
    return !receipt.signal?.aborted && !receipt.isCancelled?.()
      && (!receipt.getCurrentIdentity || sameMemoryIdentity(receipt.identity, receipt.getCurrentIdentity()))
      && isExecutionResult(receipt.before, receipt.identity, receipt.beforeIr)
      && isExecutionResult(receipt.after, receipt.identity, receipt.afterIr);
  } catch { return false; }
}
