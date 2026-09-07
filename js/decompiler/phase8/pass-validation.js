/**
 * Solver-backed, query-local Phase 8 constant projection plans.
 *
 * These are capabilities, not signed-looking JSON. Only the existing symbolic
 * query/judge can issue a usable plan. Serialization is audit evidence only.
 * The original IR is NEVER modified. The admitted domain is an unconditional,
 * total pure BV expression replaced by an equal constant; no instruction,
 * memory access, exceptional edge or architectural side effect is removed.
 */
import { stableDigest } from '../../core/identity/index.js';
import { committedProofOverlay } from './transaction.js';
import { OP } from '../../ir-base.js';
import { createTaintModels } from '../../symbolic/taint/models.js';
import { queryRecord, queryArray } from '../../symbolic/memory/data-input.js';
import { createQueryGuard, QueryFailure, memoryIdentity, sameMemoryIdentity } from '../../symbolic/memory/query-state.js';
import { semanticValueIdentity } from '../../symbolic/memory/value-identity.js';
import { createPassDescriptor, createPassResult, unchangedResult, ANALYSIS_KEYS } from './contract.js';

const plans = new WeakMap();
const validations = new WeakMap();
const artifacts = new WeakMap();
const EMPTY = Object.freeze([]);
const LIMITS = Object.freeze({targets:32, rewrites:32, workItems:100000, allocationUnits:100000});
const TOTAL_BINARY = new Set(['add','sub','mul','and','or','xor','shl','lshr','ashr']);
const TOTAL_UNARY = new Set(['not','neg','trunc','zext','sext']);
const DEFAULT_MODELS = createTaintModels({id:'phase8-empty', version:'1', provenance:'hex.phase8.explicit-empty-model/v1',sources:[],sinks:[]});

export const PROOF_REWRITE_PASS = createPassDescriptor({
  id:'phase8.solver-constants', version:'1.0.0', stage:'rendering',
  consumes:['ssa','origins'], produces:['provedRewrites'],
  preserves:ANALYSIS_KEYS.filter(key => key !== 'provedRewrites'),
  description:'Project unconditional solver-proved BV constants without changing canonical IR or effects.',
});

function string(value, name) {
  if (typeof value !== 'string' || !value.trim() || value.length > 1024) throw new QueryFailure(`invalid-${name}`);
  return value;
}
function scopeOptions(options) {
  const submitted = queryRecord(options);
  const identity = memoryIdentity(queryRecord(submitted.identity));
  const abiId = string(submitted.abiId, 'abi-identity');
  const preconditions = queryArray(submitted.preconditions ?? EMPTY);
  const correspondence = queryRecord(submitted.correspondence ?? {inputs:EMPTY});
  if (preconditions.length || queryArray(correspondence.inputs).length) throw new QueryFailure('conditional-projection-unsupported');
  for (const key of ['memoryObservables','effectObservables']) {
    if (queryArray(submitted[key] ?? EMPTY).length) throw new QueryFailure('effect-projection-unsupported');
  }
  if (Object.hasOwn(submitted,'executionSnapshot')) throw new QueryFailure('path-projection-unsupported');
  const out = { ...submitted, identity, abiId, preconditions:EMPTY, correspondence:Object.freeze({inputs:EMPTY}),
    memoryObservables:EMPTY, effectObservables:EMPTY, models:submitted.models ?? DEFAULT_MODELS };
  for (const key of ['memory','execution','analysisLimits','limits']) if (submitted[key] != null) out[key] = queryRecord(submitted[key]);
  return Object.freeze(out);
}

// This is an admission filter, not another evaluator. Meaning stays in the
// canonical scalar translator. In particular, syntactically pure division can
// still have architectural fault behavior and is not admitted here.
function totalTarget(target, guard) {
  const pending = [target], seen = new Set();
  while (pending.length) {
    guard.take('workItems');
    const value = queryRecord(pending.pop(), guard);
    if (seen.has(value.def ?? value)) continue;
    guard.take('allocationUnits'); seen.add(value.def ?? value);
    if (value.float === true || value.floatConst != null || value.bits < 1 || value.bits > 64) return false;
    if (value.kind === 'arg' || value.def == null && typeof value.const === 'bigint') continue;
    const def = queryRecord(value.def, guard);
    if (value.const != null && ![OP.CONST,OP.ADDR].includes(def.op)) return false;
    if (def.volatile || def.atomic) return false;
    if (def.extra != null) {
      const extra = queryRecord(def.extra, guard);
      if (extra.memoryAccess || extra.volatile || extra.atomic || extra.stateWrite && def.op !== OP.MOV) return false;
    }
    if (def.op === OP.BIN && !TOTAL_BINARY.has(def.sub ?? def.subOp)) return false;
    if (def.op === OP.UN && !TOTAL_UNARY.has(def.sub ?? def.subOp)) return false;
    if (![OP.CONST,OP.MOV,OP.BIN,OP.UN,OP.CMP].includes(def.op)) return false;
    const args = queryArray(def.args ?? EMPTY, guard);
    guard.take('allocationUnits',args.length);
    for (const arg of args) pending.push(queryRecord(arg,guard).value);
  }
  return true;
}

/** Prepare asynchronously; commit/projection remain in the existing Phase 8 runner. */
export async function preparePhase8RewritePlan(ir, options = {}) {
  let guard, submitted;
  const reject = reason => Object.freeze({schemaVersion:'hex-phase8-proof-plan/v1',status:'partial',reason,entries:EMPTY});
  try {
    submitted = scopeOptions(options);
    guard = createQueryGuard({...submitted, timeoutMs:submitted.timeoutMs ?? 1000}, LIMITS);
    guard.check();
    // Do not load the solver/e-graph on the ordinary synchronous decompile path.
    const [{querySymbolicAnalysis,isSymbolicAnalysisResult},{isAdoptableCandidate}]=await Promise.all([
      import('../../symbolic/query/analysis.js'),import('../../symbolic/taint/proof-consumer.js')]);
    guard.check();
    const raw = queryRecord(ir, guard, 128);
    const targets = queryArray(submitted.targets ?? raw.values ?? EMPTY, guard, 4096);
    guard.take('targets',targets.length); guard.take('allocationUnits',targets.length);
    const selected = [], rejected = [];
    for (const target of targets) {
      if (totalTarget(target,guard)) selected.push(target);
      else rejected.push(Object.freeze({valueId:semanticValueIdentity(target),reason:'non-total-or-effectful-target'}));
    }
    // The canonical query captures the exact IR, models, execution values and
    // lifecycle before solver work. It also enforces universal input scope.
    const analysis = await querySymbolicAnalysis(ir, {...submitted, targets:selected,
      timeoutMs:Math.max(0,Math.floor(guard.remainingMilliseconds()))});
    guard.check();
    if (analysis.status !== 'complete' || !isSymbolicAnalysisResult(analysis,guard.identity)) {
      return reject(analysis.reason ?? 'incomplete-symbolic-analysis');
    }
    const entries = [], internal = [];
    for (let index=0; index<analysis.targets.length; index++) {
      guard.take('workItems');
      const item = analysis.targets[index], target = selected[index];
      const candidate = item.candidates.find(c => c.after?.kind === 'const' && c.after.sort.kind === 'bv'
        && c.eligible && isAdoptableCandidate(c.verification,{identity:guard.identity}));
      if (!candidate) continue;
      guard.take('rewrites'); guard.take('allocationUnits',3);
      const binding = candidate.verification.binding;
      const entry = Object.freeze({valueId:item.valueId,rawValueId:target.id,bits:candidate.after.sort.width,
        value:candidate.after.value,beforeHash:binding.beforeHash,afterHash:binding.afterHash,
        queryHash:candidate.verification.evidence.queryHash,originRefs:Object.freeze([item.valueId])});
      entries.push(entry); internal.push({entry,target,candidate});
    }
    const binding = Object.freeze({identity:guard.identity,abiId:submitted.abiId,passId:PROOF_REWRITE_PASS.id,
      passVersion:PROOF_REWRITE_PASS.version,transformKind:'solver-constant',preconditions:EMPTY,
      correspondence:EMPTY,observableScope:'total-pure-bv-value-only',modelIdentity:analysis.taint.modelIdentity,
      entries:Object.freeze(entries)});
    const plan = Object.freeze({schemaVersion:'hex-phase8-proof-plan/v1',status:'complete',reason:null,
      planId:stableDigest(binding),...binding,rejected:Object.freeze(rejected),metrics:guard.metrics(),
      taintEvidence:analysis.taint.evidence,taintMetrics:analysis.taint.metrics,taintResult:analysis.taint});
    // metrics and lifecycle observers are callback boundaries. Check after all
    // materialization, before issuing a capability or exposing the analysis.
    guard.check();
    if (!isSymbolicAnalysisResult(analysis,guard.identity)) return reject('stale-symbolic-analysis');
    plans.set(plan,{ir,analysis,internal,submitted,isSymbolicAnalysisResult,isAdoptableCandidate});
    return plan;
  } catch (error) {
    if (error instanceof QueryFailure) return reject(error.reason);
    if (error instanceof TypeError || error instanceof RangeError) return reject('invalid-proof-request');
    throw error;
  }
}

function contextScope(input) {
  const context=queryRecord(input,null,128),opts=context.opts==null?{}:queryRecord(context.opts,null,128);
  return {ir:context.ir, identity:context.proofIdentity ?? opts.phase8ProofIdentity,
    abiId:context.abiId ?? opts.phase8AbiId,
    preconditions:context.preconditions ?? EMPTY, correspondence:context.correspondence ?? {inputs:EMPTY}};
}
export function isPhase8RewritePlan(plan, context = {}) {
  const record = plans.get(plan);
  if (!record) return false;
  try {
    const scope = contextScope(context);
    if (scope.ir !== record.ir || scope.abiId !== plan.abiId || !sameMemoryIdentity(queryRecord(scope.identity),plan.identity)) return false;
    if (queryArray(scope.preconditions).length || queryArray(queryRecord(scope.correspondence).inputs).length) return false;
    return record.internal.every(({candidate,target,entry}) => target.id === entry.rawValueId
      && record.isAdoptableCandidate(candidate.verification,{identity:plan.identity}))
      && record.isSymbolicAnalysisResult(record.analysis,plan.identity);
  } catch { return false; }
}

export function runProofRewritePass(context, budget, area) {
  const plan = context.proofRewritePlan ?? context.opts?.phase8RewritePlan;
  if (!isPhase8RewritePlan(plan,context)) throw new QueryFailure('stale-or-forged-proof-plan');
  if (!plan.entries.length) return unchangedResult(PROOF_REWRITE_PASS);
  const transforms = [];
  for (const entry of plan.entries) {
    if (budget.shouldAbort?.()) throw new QueryFailure('cancelled');
    const validation = Object.freeze({schemaVersion:'hex-phase8-rewrite-validation/v1',
      verifier:'hex.symbolic.verify.bounded-equivalence',planId:plan.planId,queryHash:entry.queryHash});
    validations.set(validation,{plan,entry});
    transforms.push({kind:'solver-constant',targets:[entry.valueId],originRefs:entry.originRefs,
      proof:'canonical solver proved unconditional total BV value equivalence',
      rewrite:Object.freeze({beforeHash:entry.beforeHash,afterHash:entry.afterHash}),validation});
  }
  const artifact = Object.freeze({version:1,completeness:'complete',planId:plan.planId,identity:plan.identity,
    abiId:plan.abiId,entries:plan.entries});
  artifacts.set(artifact,plan);
  area.stage('provedRewrites',artifact);
  return createPassResult({descriptor:PROOF_REWRITE_PASS,status:'changed',produced:['provedRewrites'],transforms});
}

/** One atomic batch: dropping a rejected transform while keeping its staged
 * analysis would still commit the rewrite. Refuse the whole transaction. */
export function proofAdmissionReason(result, stagedWrites, descriptor, context) {
  try {
    const solverTransforms = result.transforms.filter(t => t.kind === 'solver-constant' || t.rewrite != null || t.validation != null);
    if (!solverTransforms.length && !stagedWrites.has('provedRewrites')) return null;
    if (descriptor !== PROOF_REWRITE_PASS) return 'proof-pass-mismatch';
    const artifact = stagedWrites.get('provedRewrites'), plan = artifacts.get(artifact);
    if (!plan || !isPhase8RewritePlan(plan,context) || stagedWrites.size !== 1 || solverTransforms.length !== plan.entries.length) return 'proof-plan-mismatch';
    const seen = new Set();
    for (const transform of solverTransforms) {
      const record = validations.get(transform.validation);
      if (!record || record.plan !== plan || seen.has(record.entry)) return 'proof-receipt-invalid';
      const entry = record.entry;
      if (transform.kind !== 'solver-constant' || transform.targets.length !== 1 || transform.targets[0] !== entry.valueId
        || transform.originRefs.length !== entry.originRefs.length || transform.originRefs.some((ref,i)=>ref!==entry.originRefs[i])
        || transform.rewrite?.beforeHash !== entry.beforeHash || transform.rewrite?.afterHash !== entry.afterHash) return 'proof-transform-mismatch';
      seen.add(entry);
    }
    return null;
  } catch { return 'proof-admission-invalid'; }
}

/**
 * Convert a privately-authorized proof result into bounded publication data.
 * The returned validation/rewrite objects are audit records only; WeakMap
 * capability identity remains the sole adoption authority.
 */
export function proofPublicationResult(result) {
  try {
    if (!result || !Array.isArray(result.transforms)) return null;
    const transforms = result.transforms.map((transform) => {
      const record = validations.get(transform.validation);
      if (!record) return null;
      const entry = record.entry;
      return Object.freeze({
        kind: transform.kind,
        targets: transform.targets,
        proof: transform.proof,
        originRefs: transform.originRefs,
        rewrite: Object.freeze({ beforeHash: entry.beforeHash, afterHash: entry.afterHash }),
        validation: Object.freeze({
          schemaVersion: 'hex-phase8-rewrite-validation/v1',
          verifier: 'hex.symbolic.verify.bounded-equivalence',
          planId: record.plan.planId,
          queryHash: entry.queryHash,
        }),
      });
    });
    if (transforms.some((value) => value == null)) return null;
    return Object.freeze({ ...result, transforms: Object.freeze(transforms) });
  } catch { return null; }
}

/** Return only a currently valid transaction-produced overlay. */
export function readProvedRewrites(analysis, context) {
  const artifact = committedProofOverlay(analysis), plan = artifacts.get(artifact);
  return plan && isPhase8RewritePlan(plan,context) ? artifact : null;
}
