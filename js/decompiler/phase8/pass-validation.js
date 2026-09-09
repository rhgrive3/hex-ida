/**
 * Solver-backed, query-local Phase 8 scalar projection plans.
 *
 * These are capabilities, not signed-looking JSON. Only the existing symbolic
 * query/judge can issue a usable plan. Serialization is audit evidence only.
 * The original IR is NEVER modified. The admitted domain is an unconditional,
 * total pure BV expression replaced by an independently proved scalar; no instruction,
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
import { compileProofExpression } from './proof-expression.js';

const plans = new WeakMap();
const validations = new WeakMap();
const artifacts = new WeakMap();
const EMPTY = Object.freeze([]);
const LIMITS = Object.freeze({targets:32, rewrites:32, workItems:100000, allocationUnits:100000});
const TOTAL_BINARY = new Set(['add','sub','mul','and','or','xor','shl','lshr','ashr']);
const TOTAL_UNARY = new Set(['not','neg','trunc','zext','sext']);
const DEFAULT_MODELS = createTaintModels({id:'phase8-empty', version:'1', provenance:'hex.phase8.explicit-empty-model/v1',sources:[],sinks:[]});

export const PROOF_REWRITE_PASS = createPassDescriptor({
  id:'phase8.solver-constants', version:'2.3.0', stage:'rendering',
  consumes:['ssa','origins'], produces:['provedRewrites'],
  preserves:ANALYSIS_KEYS.filter(key => key !== 'provedRewrites'),
  description:'Project unconditional solver-proved BV scalars without changing canonical IR or effects (legacy pass ID).',
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

// Bounded audit data from the already-issued symbolic result and eligible
// candidate, never caller-supplied metadata or another proof capability. The
// search-wide rule set is not a derivation certificate for this particular term.
function equalityGeneratorAudit(item,candidate,guard) {
  const limits = queryRecord(item.generatorLimits,guard,32);
  const metrics = queryRecord(item.metrics,guard,32);
  const cost = queryRecord(candidate.cost,guard,8);
  const rules = queryArray(candidate.rules,guard,128);
  const resources = {};
  const invalid = () => { throw new QueryFailure('invalid-egraph-generator-audit'); };
  for (const [key,maximum] of Object.entries(limits)) {
    guard.take('workItems');
    if (key.length > 64 || !Number.isSafeInteger(maximum) || maximum < 0
      || !Number.isSafeInteger(metrics[key]) || metrics[key] < 0 || metrics[key] > maximum) invalid();
    resources[key] = metrics[key];
  }
  if (!Object.keys(limits).length || !Number.isSafeInteger(metrics.verificationQueries)
    || metrics.verificationQueries < 1 || metrics.verificationQueries > limits.candidates
    || candidate.ruleOrder !== item.ruleOrder) invalid();
  resources.verificationQueries = metrics.verificationQueries;
  for (const key of ['treeNodes','depth','expensiveOps']) {
    if (!Number.isSafeInteger(cost[key]) || cost[key] < 0) invalid();
  }
  if (cost.treeNodes < 1 || cost.depth < 1 || cost.depth > cost.treeNodes || cost.expensiveOps > cost.treeNodes) invalid();
  if (new Set(rules).size !== rules.length) invalid();
  const appliedRules = rules.map(rule => string(rule,'generator-rule'));
  guard.take('allocationUnits',appliedRules.length + Object.keys(limits).length * 2 + 12);
  return Object.freeze({schemaVersion:'hex-phase8-generator-audit/v1',strategy:'equality-saturation',
    scope:'whole-query-search-not-per-candidate-derivation-or-proof',
    candidateId:string(candidate.candidateId,'generator-candidate'),
    rulesetVersion:string(candidate.rulesetVersion,'generator-ruleset'),
    ruleOrder:string(candidate.ruleOrder,'generator-rule-order'),appliedRules:Object.freeze(appliedRules),
    extractionCost:Object.freeze({treeNodes:cost.treeNodes,depth:cost.depth,expensiveOps:cost.expensiveOps}),
    limits:Object.freeze(limits),resources:Object.freeze(resources),
    proofQueryHash:string(candidate.verification.evidence.queryHash,'generator-proof-query')});
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
  let requested = null;
  const reject = reason => Object.freeze({schemaVersion:'hex-phase8-proof-plan/v1',status:'partial',reason,entries:EMPTY,
    targetDecisions:Object.freeze((requested ?? []).map(target => Object.freeze({ ...target,
      disposition:'unknown', reason, candidateCount:null }))),
    decisionCoverage:Object.freeze({ requested:requested?.length ?? null, complete:false }),
  });
  try {
    submitted = scopeOptions(options);
    guard = createQueryGuard({...submitted, timeoutMs:submitted.timeoutMs ?? 1000}, LIMITS);
    guard.check();
    // Do not load the solver/e-graph on the ordinary synchronous decompile path.
    const [{querySymbolicAnalysis,isSymbolicAnalysisResult,readSymbolicTargetInputs},{isAdoptableCandidate}]=await Promise.all([
      import('../../symbolic/query/analysis.js'),import('../../symbolic/taint/proof-consumer.js')]);
    guard.check();
    const raw = queryRecord(ir, guard, 128);
    const targets = queryArray(submitted.targets ?? raw.values ?? EMPTY, guard, 4096);
    guard.take('targets',targets.length); guard.take('allocationUnits',targets.length);
    requested = targets.map((target, requestedIndex) => {
      guard.take('allocationUnits');
      const value = queryRecord(target, guard), definition = value.def == null ? null : queryRecord(value.def, guard);
      const operator = definition?.sub ?? definition?.subOp ?? definition?.op ?? value.kind ?? null;
      const rawValueId = typeof value.id === 'string' && value.id.length <= 1024
        || typeof value.id === 'number' && Number.isSafeInteger(value.id) ? value.id : null;
      return Object.freeze({ requestedIndex, valueId:semanticValueIdentity(target), rawValueId,
        bits:Number.isSafeInteger(value.bits) ? value.bits : null,
        operator:typeof operator === 'string' && operator.length <= 128 ? operator : null });
    });
    const selected = [], selectedIndices = [], rejected = [], decisions = [];
    for (const [index, target] of targets.entries()) {
      if (totalTarget(target,guard)) { selected.push(target); selectedIndices.push(index); }
      else {
        rejected.push(Object.freeze({valueId:semanticValueIdentity(target),reason:'non-total-or-effectful-target'}));
        decisions[index] = Object.freeze({ ...requested[index], disposition:'unsupported',
          reason:'non-total-or-effectful-target', candidateCount:0 });
      }
    }
    // The canonical query captures the exact IR, models, execution values and
    // lifecycle before solver work. It also enforces universal input scope.
    const representationRules = submitted.candidateStrategy === 'representation-rules';
    const representationQuery = representationRules ? (await import('./representation-candidates.js')).queryRepresentationCandidates : null;
    guard.check();
    const analysis = await querySymbolicAnalysis(ir, {...submitted, targets:selected,
      candidateStrategy:representationRules ? 'translate-only' : submitted.candidateStrategy,
      timeoutMs:Math.max(0,Math.floor(guard.remainingMilliseconds()))});
    guard.check();
    if (analysis.status !== 'complete' || !isSymbolicAnalysisResult(analysis,guard.identity)) {
      return reject(analysis.reason ?? 'incomplete-symbolic-analysis');
    }
    const entries = [], internal = [];
    for (let index=0; index<analysis.targets.length; index++) {
      guard.take('workItems');
      const item = analysis.targets[index], target = selected[index];
      const inputBinding = readSymbolicTargetInputs(analysis, target, guard.identity);
      if (!inputBinding || inputBinding.expression !== item.expression) return reject('unavailable-target-input-binding');
      const generated = representationQuery ? await representationQuery({expression:item.expression,
        valueId:item.valueId,inputBinding,identity:guard.identity,taintResult:analysis.taint,
        backendTier:submitted.backendTier,signal:submitted.signal,isCancelled:submitted.isCancelled,
        getCurrentIdentity:submitted.getCurrentIdentity,timeoutMs:Math.max(0,Math.floor(guard.remainingMilliseconds()))}) : null;
      guard.check();
      if (generated && generated.status !== 'complete') return reject(generated.reason);
      if (generated) {
        guard.take('workItems',generated.metrics.workItems);
        guard.take('allocationUnits',generated.metrics.allocationUnits);
      }
      const candidates = generated?.candidates ?? item.candidates;
      const generatorDecision = generated ? {ruleCoverage:generated.ruleCoverage}
        : item.ruleOrder ? {ruleOrder:item.ruleOrder} : {};
      let candidate, projection;
      for (const option of candidates) {
        if (option.after?.sort.kind !== 'bv' || !option.eligible
          || !isAdoptableCandidate(option.verification,{identity:guard.identity})) continue;
        const recipe = compileProofExpression(option.after,inputBinding,guard);
        if (recipe) { candidate = option; projection = recipe; break; }
      }
      const requestIndex = selectedIndices[index];
      if (!candidate) {
        const unsupportedProjection = candidates.some(c => c.eligible
          && isAdoptableCandidate(c.verification,{identity:guard.identity}));
        const allRefuted = candidates.length > 0 && candidates.every(c => c.verification?.verdict === 'refuted');
        const disposition = unsupportedProjection ? 'unsupported' : !candidates.length ? 'unchanged' : allRefuted ? 'refuted' : 'unknown';
        decisions[requestIndex] = Object.freeze({ ...requested[requestIndex], ...generatorDecision, disposition,
          reason:unsupportedProjection ? 'proved-candidate-outside-scalar-projection' : !candidates.length ? 'no-generated-candidate'
            : allRefuted ? 'all-generated-candidates-refuted' : 'no-eligible-scalar-candidate', candidateCount:candidates.length });
        continue;
      }
      guard.take('rewrites'); guard.take('allocationUnits',3 + inputBinding.inputs.length);
      const binding = candidate.verification.binding;
      const kind = candidate.after.kind === 'const' ? 'solver-constant' : 'solver-scalar';
      const generatorAudit = candidate.rule === 'equality-saturation' ? equalityGeneratorAudit(item,candidate,guard) : null;
      const entry = Object.freeze({valueId:item.valueId,rawValueId:target.id,bits:candidate.after.sort.width,kind,projection,
        ...(generatorAudit ? {generatorAudit} : {}),
        value:kind === 'solver-constant' ? candidate.after.value : null,beforeHash:binding.beforeHash,afterHash:binding.afterHash,
        queryHash:candidate.verification.evidence.queryHash,originRefs:Object.freeze([item.valueId]),
        inputBindings:Object.freeze(inputBinding.inputs.map(input => Object.freeze({ valueId:input.valueId,
          rawValueId:input.rawValueId, bits:input.bits, symbolId:input.symbol.symbolId }))) });
      entries.push(entry); internal.push({entry,target,candidate,inputBinding});
      decisions[requestIndex] = Object.freeze({ ...requested[requestIndex], ...generatorDecision, disposition:'selected',
        reason:kind === 'solver-constant' ? 'eligible-constant-projection' : 'eligible-scalar-projection', candidateCount:candidates.length, queryHash:entry.queryHash });
    }
    if (decisions.length !== requested.length || requested.some((_target, index) => !decisions[index])) {
      return reject('incomplete-target-decisions');
    }
    // Complete decision coverage can contain unknown/unsupported rows. It is
    // an audit of the requested denominator, never another proof capability.
    const binding = Object.freeze({identity:guard.identity,abiId:submitted.abiId,passId:PROOF_REWRITE_PASS.id,
      passVersion:PROOF_REWRITE_PASS.version,transformKind:'solver-scalar',preconditions:EMPTY,
      candidateStrategy:submitted.candidateStrategy ?? 'local-rewrites',
      ...(submitted.candidateStrategy === 'equality-saturation' ? {ruleOrder:submitted.ruleOrder ?? 'canonical'} : {}),
      correspondence:EMPTY,observableScope:'total-pure-bv-value-only',modelIdentity:analysis.taint.modelIdentity,
      entries:Object.freeze(entries), targetDecisions:Object.freeze(decisions),
      decisionCoverage:Object.freeze({ requested:requested.length, complete:true }) });
    const plan = Object.freeze({schemaVersion:'hex-phase8-proof-plan/v1',status:'complete',reason:null,
      planId:stableDigest(binding),...binding,rejected:Object.freeze(rejected),metrics:guard.metrics(),
      taintEvidence:analysis.taint.evidence,taintMetrics:analysis.taint.metrics,taintResult:analysis.taint});
    // metrics and lifecycle observers are callback boundaries. Check after all
    // materialization, before issuing a capability or exposing the analysis.
    guard.check();
    if (!isSymbolicAnalysisResult(analysis,guard.identity)) return reject('stale-symbolic-analysis');
    const inputBindings = Object.freeze(internal.map(item => Object.freeze({ entry:item.entry, binding:item.inputBinding })));
    plans.set(plan,{ir,analysis,internal,inputBindings,submitted,isSymbolicAnalysisResult,isAdoptableCandidate,readSymbolicTargetInputs});
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
    return record.internal.every(({candidate,target,entry,inputBinding}) => target.id === entry.rawValueId
      && record.readSymbolicTargetInputs(record.analysis,target,plan.identity) === inputBinding
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
    transforms.push({kind:entry.kind,targets:[entry.valueId],originRefs:entry.originRefs,
      proof:'canonical solver proved unconditional total BV value equivalence',
      rewrite:Object.freeze({beforeHash:entry.beforeHash,afterHash:entry.afterHash}),validation});
  }
  const artifact = Object.freeze({version:1,completeness:'complete',planId:plan.planId,identity:plan.identity,
    abiId:plan.abiId,entries:plan.entries,targetDecisions:plan.targetDecisions,decisionCoverage:plan.decisionCoverage});
  artifacts.set(artifact,plan);
  area.stage('provedRewrites',artifact);
  return createPassResult({descriptor:PROOF_REWRITE_PASS,status:'changed',produced:['provedRewrites'],transforms});
}

/** One atomic batch: dropping a rejected transform while keeping its staged
 * analysis would still commit the rewrite. Refuse the whole transaction. */
export function proofAdmissionReason(result, stagedWrites, descriptor, context) {
  try {
    const solverTransforms = result.transforms.filter(t => ['solver-constant','solver-scalar'].includes(t.kind) || t.rewrite != null || t.validation != null);
    if (!solverTransforms.length && !stagedWrites.has('provedRewrites')) return null;
    if (descriptor !== PROOF_REWRITE_PASS) return 'proof-pass-mismatch';
    const artifact = stagedWrites.get('provedRewrites'), plan = artifacts.get(artifact);
    if (!plan || !isPhase8RewritePlan(plan,context) || stagedWrites.size !== 1 || solverTransforms.length !== plan.entries.length) return 'proof-plan-mismatch';
    const seen = new Set();
    for (const transform of solverTransforms) {
      const record = validations.get(transform.validation);
      if (!record || record.plan !== plan || seen.has(record.entry)) return 'proof-receipt-invalid';
      const entry = record.entry;
      if (transform.kind !== entry.kind || transform.targets.length !== 1 || transform.targets[0] !== entry.valueId
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

/** Private producer correspondence crosses the render boundary only through a
 * currently valid committed overlay. Public inputBindings on entries are audit
 * IDs; neither those IDs nor a staged/copied artifact authorizes this relation. */
export function readProvedInputBindings(analysis, context) {
  const artifact = readProvedRewrites(analysis, context);
  if (!artifact) return null;
  const record = plans.get(artifacts.get(artifact));
  return Object.freeze({ artifact, bindings:record.inputBindings });
}
