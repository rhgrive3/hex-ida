import {queryRecord,queryArray} from '../memory/data-input.js';
/** Production composition of the existing executor, taint owner, translator and
 * proof consumer. This publishes analysis plus IR-bound pure-expression proposals;
 * it never mutates IR or substitutes for a decompiler transaction.
 */
import { OP } from '../../ir-base.js';
import { restoreFreshSymbol } from '../expr/factory.js';
import { createQueryGuard, QueryFailure, sameMemoryIdentity } from '../memory/query-state.js';
import { semanticValueIdentity } from '../memory/value-identity.js';
import { isExecutionSnapshotTarget } from '../memory/execution-snapshot.js';
import { assertMemoryExpr } from '../memory/byte-memory.js';
import { translateExecutionValue } from '../translate/memory.js';
import { queryTaint, isTaintQueryResult } from './taint.js';
import { queryEqualitySaturation } from './equality-saturation.js';
import { EGRAPH_RULE_ORDERS } from '../egraph/graph.js';
import { queryDeobfuscationCandidates } from './deobfuscation.js';
import { isAdoptableCandidate } from '../taint/proof-consumer.js';

const issued = new WeakMap();
const LIMITS = Object.freeze({ targets: 32, candidates: 64, workItems: 250000, allocationUnits: 100000 });
const PURE = new Set([OP.CONST, OP.ADDR, OP.MOV, OP.BIN, OP.UN, OP.CMP]);

// Eligibility only. Meaning is lowered by the same typed scalar bridge used by
// execution, not by reinterpreting legacy sub/width fields in the raw translator.
function validatePureTarget(root, guard) {
  const pending = [[root, 0, false]], marks = new Map(), ordered = [];
  while (pending.length) {
    guard.take('workItems');
    const [value, depth, finish] = pending.pop();
    if (!value || depth > 64) throw new QueryFailure('target-expression-depth');
    if (finish) { marks.set(value, 'done'); ordered.push(value); continue; }
    if (marks.get(value) === 'done') continue;
    if (marks.has(value)) throw new QueryFailure('target-expression-cycle');
    guard.take('allocationUnits', 2); marks.set(value, 'active');
    if (!Number.isSafeInteger(value.bits) || value.bits < 1 || value.bits > 64) throw new QueryFailure('invalid-target-width');
    const def = value.def;
    if (value.const != null && (value.kind === 'arg' || def && ![OP.CONST, OP.ADDR].includes(def.op))) throw new QueryFailure('derived-constant-translation-handoff');
    pending.push([value, depth, true]);
    if (value.kind === 'arg' || !def && value.const != null) continue;
    if (!def || !PURE.has(def.op) || def.extra?.memoryAccess) throw new QueryFailure('non-pure-target-handoff');
    if (def.dst !== value) throw new QueryFailure('instruction-definition-mismatch');
    guard.take('workItems', (def.args ?? []).length);
    guard.take('allocationUnits', (def.args ?? []).length);
    for (const argument of def.args ?? []) pending.push([argument.value, depth + 1, false]);
  }
  return ordered;
}

function translatePureTarget(root, guard) {
  const ordered = validatePureTarget(root, guard);
  // Resource-only facade for the existing scalar bridge: intentionally no load,
  // store, alias or path functions. There is no second byte-memory state here.
  const resources = Object.freeze({
    chargeExecution(work = 1, allocation = 0) {
      guard.take('workItems', work); guard.take('allocationUnits', allocation);
    },
  });
  const state = { byteMemory: resources, values: new Map(), scalarCache: new Map(),
    valueIdentities: new Map(), semanticIdentities: new Map() };
  let inputOrdinal = 0;
  const inputs = [];
  for (const value of ordered) {
    // Universal inputs, not the concrete/path-configured symbolicArgs used to
    // execute this invocation. Each SSA dependency is lowered once, in order.
    let expression = translateExecutionValue(value, state);
    // The pure query is a fresh, closed session over this exact SSA slice.
    // Restore a deterministic query-local input manifest (not name-based alias
    // inference); distinct input positions keep distinct canonical symbolIds.
    // Do not reset or replace the global Expr allocator.
    if (value.kind === 'arg' && expression.kind === 'fresh_symbol') {
      expression = restoreFreshSymbol(expression.sort, expression.name,
        `sym_${++inputOrdinal}_${expression.name}`, expression.meta);
      guard.take('allocationUnits');
      inputs.push(Object.freeze({ value, valueId:semanticValueIdentity(value), rawValueId:value.id,
        bits:value.bits, symbol:expression }));
    }
    assertMemoryExpr(expression, guard);
    guard.take('allocationUnits'); state.values.set(value.id, expression);
  }
  return Object.freeze({ scope:'query-local-universal-inputs', expression:state.values.get(root.id),
    inputs:Object.freeze(inputs) });
}

/** Read only the actual translator-produced input relation for this issued
 * query and exact target. Names, serialized manifests and matching IDs cannot
 * issue it. It conveys input correspondence, not proof/adoption authority. */
export function readSymbolicTargetInputs(result, target, identity) {
  try {
    const record = issued.get(result), binding = record?.targetInputs.get(target);
    if (!binding || !isSymbolicAnalysisResult(result, identity === undefined ? result.identity : identity)) return null;
    for (const input of binding.inputs) {
      const value = queryRecord(input.value);
      if (value.kind !== 'arg' || value.id !== input.rawValueId || value.bits !== input.bits
          || semanticValueIdentity(value) !== input.valueId) return null;
    }
    return binding;
  } catch { return null; }
}

export function isSymbolicAnalysisResult(result, identity) {
  const record = issued.get(result);
  if(!record)return false;
  if(identity === undefined) identity = result.identity;
  return sameMemoryIdentity(result.identity, identity)
    && result.targets.every(target => target.candidates.every(candidate => !candidate.eligible || isAdoptableCandidate(candidate.verification, { identity })))
    && isTaintQueryResult(record.taint, identity);
}

export async function querySymbolicAnalysis(ir, inputOptions = {}) {
  const submitted=queryRecord(inputOptions,null,128);
  const options=Object.freeze({...submitted,targets:queryArray(submitted.targets??[]),
    ...(submitted.memory!=null?{memory:queryRecord(submitted.memory)}:{}),
    ...(submitted.execution!=null?{execution:queryRecord(submitted.execution)}:{}),
    ...(submitted.analysisLimits!=null?{analysisLimits:queryRecord(submitted.analysisLimits)}:{})});
  const guard = createQueryGuard({ ...options, timeoutMs: options.timeoutMs ?? 250, limits: options.analysisLimits }, LIMITS);
  let candidateQueries = 0;
  const remaining = () => Math.max(0, Math.floor((options.timeoutMs ?? 250) - guard.metrics().wallClock));
  const result = (status, reason, taint = null, targets = []) => Object.freeze({
    schemaVersion: 'hex-symbolic-analysis/v1', identity: guard.identity, status, reason,
    scope: 'analysis-and-pure-candidates', irMutated: false, taint, targets: Object.freeze(targets),
    metrics: Object.freeze({ ...guard.metrics(), candidateQueries }),
  });
  try {
    guard.check();
    if (options.candidateStrategy != null && !['local-rewrites','equality-saturation','translate-only'].includes(options.candidateStrategy)) throw new QueryFailure('unknown-candidate-strategy');
    if (options.ruleOrder !== undefined && (options.candidateStrategy !== 'equality-saturation'
      || !EGRAPH_RULE_ORDERS.includes(options.ruleOrder))) throw new QueryFailure('invalid-egraph-rule-order');
    if (Object.hasOwn(options, 'executionSnapshot')) throw new QueryFailure('execution-path-proof-handoff');
    if (options.preconditions != null && (!Array.isArray(options.preconditions) || options.preconditions.length)) throw new QueryFailure('analysis-precondition-handoff');
    if (['memoryObservables', 'effectObservables'].some(key => options[key] != null && (!Array.isArray(options[key]) || options[key].length))) throw new QueryFailure('memory-effect-judge-handoff');
    const requested = options.targets ?? [];
    if (!Array.isArray(requested)) throw new QueryFailure('invalid-analysis-targets');
    guard.take('targets', requested.length); guard.take('allocationUnits', requested.length);
    const targets = requested;
    const taint = queryTaint(ir, { ...options, timeoutMs: Math.min(120, remaining()) });
    guard.check();
    if (taint.status !== 'complete') throw new QueryFailure(taint.reason ?? 'incomplete-taint');
    if (!isTaintQueryResult(taint, guard.identity)) throw new QueryFailure('stale-analysis-input');
    const seen = new Set(), output = [], targetInputs = new Map();
    for (const target of targets) {
      guard.take('workItems');
      if (!taint.execution.paths.some(path => isExecutionSnapshotTarget(path.snapshot, target, guard.identity, ir))) throw new QueryFailure('target-not-bound-to-execution');
      const valueId = semanticValueIdentity(target);
      if (seen.has(valueId)) throw new QueryFailure('duplicate-analysis-target');
      seen.add(valueId);
      const translated = translatePureTarget(target, guard), expression = translated.expression;
      guard.check();
      const translateOnly = options.candidateStrategy === 'translate-only';
      if (!translateOnly) candidateQueries++;
      const equalitySaturation = options.candidateStrategy === 'equality-saturation';
      const queryCandidates = equalitySaturation ? queryEqualitySaturation : queryDeobfuscationCandidates;
      const candidates = translateOnly ? {status:'complete',candidates:Object.freeze([]),metrics:null} : await queryCandidates({
        expression, valueId, identity: guard.identity,
        memoryObservables: [], effectObservables: [], taintResult: taint,
        signal: options.signal, isCancelled: options.isCancelled, getCurrentIdentity: options.getCurrentIdentity,
        timeoutMs: Math.min(equalitySaturation ? 1000 : 120, remaining()), backendTier: options.backendTier,
        ...(equalitySaturation ? {ruleOrder:options.ruleOrder} : {}),
        limits: { candidates: Math.min(equalitySaturation ? 8 : 32, guard.limits.candidates - guard.metrics().candidates) },
      });
      guard.check();
      if (!isTaintQueryResult(taint, guard.identity)) throw new QueryFailure('stale-analysis-input');
      if (candidates.status !== 'complete') throw new QueryFailure(candidates.reason ?? 'incomplete-candidate-query');
      guard.take('candidates', candidates.candidates.length);
      guard.take('allocationUnits', candidates.candidates.length + 1);
      output.push(Object.freeze({ valueId, expression, candidates: candidates.candidates, metrics: candidates.metrics,
        ...(equalitySaturation ? {ruleOrder:candidates.ruleOrder} : {}) }));
      targetInputs.set(target, translated);
    }
    guard.check();
    if (!isTaintQueryResult(taint, guard.identity)) throw new QueryFailure('stale-analysis-input');
    const complete = result('complete', null, taint, output);
    guard.check();
    if (!isTaintQueryResult(taint,guard.identity)) throw new QueryFailure('stale-analysis-input');
    issued.set(complete, { taint, targetInputs });
    return complete;
  } catch (error) {
    if (!(error instanceof QueryFailure)) throw error;
    // Atomic publication across target groups: earlier receipts and evidence are
    // never exposed by a cancelled, stale, unsupported or over-budget batch.
    return result('partial', error.reason);
  }
}
