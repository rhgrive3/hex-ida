import { enhanceSemanticDecompilation as enhanceCore } from './pipeline-core.js';
import { recoverExactStackPhiExpressions } from './passes/stack-phi-recovery.js';
import { recoverExactStackReturn } from './passes/stack-return-recovery.js';
import { recoverLegacySameBlockStackSpills } from './passes/legacy-stack-recovery.js';
import { expr, sourceOf } from './ast/nodes.js';
import { printExpression, printProgram } from './pretty/c.js';
import { PASS_STAGES as PHASE8_ALL_STAGES, runPhase8Stage } from './phase8/index.js';
import { applyPhase8Projection } from './phase8/projection.js';
import { captureProjectionData, captureProjectionIrData } from './phase8/projection-origin.js';
import { preparePhase8RewritePlan, isPhase8RewritePlan } from './phase8/pass-validation.js';
import { queryRecord, queryArray } from '../symbolic/memory/data-input.js';
import {
  canonicalMemoryForwardingContextForLoad,
  isCanonicalExactMemoryForwarding,
} from '../semantics/memoryssa/queries.js';

export { buildExpressionForTesting } from './pipeline-core.js';
export { exactLegacySameBlockStackStore } from './passes/legacy-stack-recovery.js';

// Only this existing producer issues a usable projection. Neither a serialized
// AST nor a caller-supplied valueId map establishes the IR -> rendered binding.
const producerProjections = new WeakMap();
function producerIrRoots(result) {
  const irValues = queryArray(queryRecord(result?.ir,null,128).values ?? [],null,10000);
  const byId = new Map();
  for (const value of irValues) {
    const id = queryRecord(value,null,128).id;
    if (id == null || byId.has(id)) throw new TypeError('projection-ir-value-identity-invalid');
    byId.set(id,value);
  }
  const rendered = queryArray(queryRecord(result?.semanticAst,null,128).values ?? [],null,10000);
  const roots = [];
  for (const item of rendered) {
    const valueId = queryRecord(item,null,64).valueId;
    if (!byId.has(valueId)) throw new TypeError('projection-ir-value-binding-missing');
    roots.push(byId.get(valueId));
  }
  return Object.freeze(roots);
}
function sameProducerIrRoots(result, expected) {
  const current = producerIrRoots(result);
  return current.length === expected.length && current.every((value,index) => value === expected[index]);
}
function rememberProducerProjection(result, options) {
  if (options.phase8PrepareProof !== true || !result?.semanticAst || !result?.cAst) return result;
  try {
    const observation = captureProjectionData([result.semanticAst,result.cAst],options.shouldAbort);
    const irRoots = producerIrRoots(result);
    const irObservation = captureProjectionIrData(irRoots,options.shouldAbort);
    producerProjections.set(result.semanticAst,{ir:result.ir,cAst:result.cAst,observation,irRoots,irObservation});
  } catch { /* The ordinary decompile still works; optional proof is withheld. */ }
  return result;
}
export function producerExpressionToken(result, expression) {
  const record = producerProjections.get(result?.semanticAst);
  return record?.ir === result?.ir && record?.cAst === result?.cAst ? record.observation.tokenOf(expression) : null;
}
export function isProducerProjection(result) {
  try {
    const raw = queryRecord(result,null,256), record = producerProjections.get(raw.semanticAst);
    return !!record && record.ir===raw.ir && record.cAst===raw.cAst
      && sameProducerIrRoots(raw,record.irRoots) && record.irObservation.matches() && record.observation.matches();
  } catch { return false; }
}

/** Resolve actual SSA input objects through this producer's observed value/AST
 * relation. No caller-provided ID/name map can stand in for either endpoint. */
export function readProducerInputExpressions(result, values) {
  try {
    if (!isProducerProjection(result)) return null;
    const requested = queryArray(values, null, 4096);
    const record = producerProjections.get(result.semanticAst), byValue = new Map();
    for (const [index, value] of record.irRoots.entries()) {
      byValue.set(value, byValue.has(value) ? null : result.semanticAst.values[index].expression);
    }
    const inputs = [];
    for (const value of requested) {
      const fields = queryRecord(value), expression = byValue.get(value);
      if (fields.kind !== 'arg' || !expression || expression.effect !== 'pure' || expression.bits !== fields.bits) return null;
      const token = record.observation.tokenOf(expression);
      if (token == null) return null;
      inputs.push(Object.freeze({ value, expression, token }));
    }
    return Object.freeze(inputs);
  } catch { return null; }
}

function valueOf(arg) { return arg?.value || null; }

const INVERSE_CONDITION = {
  eq:'ne', ne:'eq', hs:'lo', lo:'hs', cs:'cc', cc:'cs',
  hi:'ls', ls:'hi', ge:'lt', lt:'ge', gt:'le', le:'gt',
  mi:'pl', pl:'mi', vs:'vc', vc:'vs',
};

function isZeroValue(value) {
  return value?.const === 0n || (value?.def?.op === 'const' && (value.def.extra?.value ?? value.const) === 0n);
}

/* pipeline-core expresses ordinary CMP relations but intentionally leaves raw
 * N-flag conditions conservative. For the extremely common `cmp value,#0`, MI
 * and PL are exactly signed `< 0` and `>= 0`, so normalize them to the relational
 * conditions the semantic AST already models. */
function relationalSignCondition(inst, cond) {
  if (cond !== 'mi' && cond !== 'pl') return cond;
  const flags = valueOf(inst?.args?.[2] || inst?.args?.at?.(-1));
  const compare = flags?.def;
  if (compare?.op !== 'cmp' || compare?.sub !== 'sub' || !isZeroValue(valueOf(compare.args?.[1]))) return cond;
  return cond === 'mi' ? 'lt' : 'ge';
}

/* CNEG/CINC/CINV are aliases of CSNEG/CSINC/CSINV with the condition inverted. */
function normalizeConditionalSelectAliases(ir) {
  const changes = [];
  const alias = { cneg:'neg', cinc:'inc', cinv:'inv' };
  for (const inst of ir?.instructions || []) {
    const replacement = alias[inst?.sub];
    if (replacement) {
      let inverse = INVERSE_CONDITION[inst.cond];
      if (!inverse) continue;
      inverse = relationalSignCondition(inst, inverse);
      changes.push({ inst, sub:inst.sub, cond:inst.cond });
      inst.sub = replacement;
      inst.cond = inverse;
      continue;
    }
    const relational = relationalSignCondition(inst, inst?.cond);
    if (relational !== inst?.cond) {
      changes.push({ inst, sub:inst.sub, cond:inst.cond });
      inst.cond = relational;
    }
  }
  return () => {
    for (let i = changes.length - 1; i >= 0; i--) {
      const { inst, sub, cond } = changes[i];
      inst.sub = sub;
      inst.cond = cond;
    }
  };
}

function constrainSemanticValueWidths(result) {
  if (!result?.semanticAst?.values || !result?.ir?.values) return result;
  const irValues = new Map((result.ir.values || []).map((value) => [value.id, value]));
  for (const item of result.semanticAst.values) {
    const value = irValues.get(item.valueId);
    const node = item.expression;
    const targetBits = Number(value?.bits || 0);
    const sourceBits = Number(node?.bits || 0);
    if (!node || !targetBits || !sourceBits || sourceBits <= targetBits) continue;
    item.expression = expr.unary('trunc', node, targetBits, value?.signed ?? node.signed ?? null, node.source,
      { fromBits: sourceBits, proof: 'SSA value width after Memory-SSA substitution' });
  }
  return result;
}

function canonicalScalarReturnRegister(result, opts = {}) {
  const adapter = opts.abiAdapter || result?.abiAdapter || result?.ctx?.abiAdapter || null;
  const returnType = opts.returnType
    ?? opts.functionPrototype?.returnType
    ?? opts.prototype?.returnType
    ?? result?.prototype?.returnType
    ?? result?.types?.ret?.type
    ?? null;
  const returnBits = opts.returnBits
    ?? opts.functionPrototype?.returnBits
    ?? opts.prototype?.returnBits
    ?? result?.prototype?.returnBits
    ?? result?.types?.ret?.bits
    ?? null;
  if (adapter?.supported === true) {
    try {
      const functionPrototype = {
        ...(opts.functionPrototype || opts.prototype || result?.prototype || {}),
        ...(returnType != null ? { returnType } : {}),
        ...(returnBits != null ? { returnBits } : {}),
        returnsValue:true,
      };
      const locations = adapter.returnLocations?.({ functionPrototype, returnType, returnBits });
      if (Array.isArray(locations)) {
        return locations.length === 1 && locations[0]?.kind === 'register'
          && locations[0]?.aggregate !== true && typeof locations[0]?.reg === 'string'
          ? locations[0].reg : null;
      }
    } catch { return null; }
    return null;
  }
  if (adapter) return null;
  // The old ARM64 facade predates the canonical ABI envelope. Preserve its
  // presentation-only fallback, while a v2 IR without an adapter remains
  // unknown rather than inheriting AAPCS64's x0 return register.
  if (opts.legacyAArch64 === true || result?.ir?.compat?.projection !== 'semantic-ir-v2-to-v1') return 'x0';
  return null;
}

function latestReturnStackLoad(ir, ret, returnRegister) {
  const explicit = valueOf(ret?.args?.[0]);
  if (explicit?.def?.op === 'load' && explicit.def.loc?.kind === 'stack') return { value: explicit, load: explicit.def };

  // For implicit ABI returns, only the actual latest reaching definition of the
  // canonical return register may authorize a stack-load re-anchor. A
  // historical stack load is not return truth when a later ADD/SUB/call/etc.
  // redefines that register (#914). Never substitute AAPCS64's x0 here: on
  // RISC-V it is the hardwired zero register.
  if (!returnRegister) return null;
  let value = null, bestRow = -Infinity;
  for (const candidate of ir?.values || []) {
    const def = candidate?.def;
    if (candidate?.reg !== returnRegister || !def || (ret?.row != null && def.row >= ret.row)) continue;
    if (def.row > bestRow) { value = candidate; bestRow = def.row; }
  }
  return value?.def?.op === 'load' && value.def.loc?.kind === 'stack' ? { value, load:value.def } : null;
}

function reanchorExactStackReturn(result, opts = {}) {
  if (!result?.semanticAst || !result?.ir) return result;
  const ret = [...(result.ir.instructions || [])].reverse().find((inst) => inst.op === 'ret');
  const returnRegister = canonicalScalarReturnRegister(result, opts);
  const found = ret ? latestReturnStackLoad(result.ir, ret, returnRegister) : null;
  if (!found?.load?.loc?.key) return result;
  const output = result.semanticAst.outputs?.find((x) => x.name === 'return');
  if (!output) return result;
  const { value, load } = found;
  output.expression = expr.load({ kind:'stack', key:load.loc.key, name:load.loc.name || `stack_${load.loc.key}`, text:load.loc.name || `stack_${load.loc.key}` },
    value?.bits || Number((load.size || 8) * 8), {
      address:load.address, row:load.row, ir:load.id, ssaDef:value?.id ?? null,
      evidence:[{ reason:'SSA return stack load re-anchor' }],
    }, { signed:load.signed ?? value?.signed ?? null });
  return result;
}


/* When a return stack LOAD has a proven same-slot reaching STORE, the spill
 * STORE remains proof provenance but does not own the reconstructed C return
 * statement after the stack temporary has been eliminated. Drop only that one
 * statement-level source row; every other source/proof entry is preserved. */
function reanchorRecoveredReturnSource(result, opts = {}) {
  if (!result?.ir || !result?.cAst) return result;
  const ret = [...(result.ir.instructions || [])].reverse().find((inst) => inst.op === 'ret');
  if (!ret) return result;
  let changed = false;
  for (const node of result.cAst.body || []) {
    if (!(node.semantic?.op === 'return' || /^return\b/.test(String(node.text || '').trim()))) continue;
    if (/\blocal_[0-9A-F]+\b/i.test(String(node.text || ''))) continue;
    const current = sourceOf(node.source);
    const sourceRows = new Set((current.rows || []).map((row) => String(row)));
    let load = null;
    for (const inst of result.ir.instructions || []) {
      if (inst?.op !== 'load' || inst?.loc?.kind !== 'stack' || inst?.row == null || ret.row == null || inst.row >= ret.row) continue;
      if (!sourceRows.has(String(inst.row))) continue;
      const fact = inst.memoryForwarding ?? inst.extra?.memoryForwarding ?? null;
      const store = inst.reachingStore || ((fact && isCanonicalExactMemoryForwarding(fact,
        canonicalMemoryForwardingContextForLoad(fact, inst,
          inst.memoryForwardingContext ?? inst.extra?.memoryForwardingContext)))
        ? (result.ir.instructions || []).find((candidate) => {
          const definitionId = candidate?.memDef?.definitionId ?? candidate?.extra?.memoryDefinitionId ?? null;
          return candidate?.op === 'store'
            && candidate?.loc?.kind === 'stack'
            && candidate.loc.key === inst.loc.key
            && candidate.row != null
            && definitionId != null
            && fact.contributingDefinitionIds?.includes(String(definitionId));
        })
        : null);
      if (!store || store.row == null) continue;
      if (!sourceRows.has(String(store.row))) continue;
      if (!load || inst.row > load.row) load = inst;
    }
    const spillFact = load?.memoryForwarding ?? load?.extra?.memoryForwarding ?? null;
    const spill = load?.reachingStore || (isCanonicalExactMemoryForwarding(spillFact,
      canonicalMemoryForwardingContextForLoad(spillFact, load,
        load?.memoryForwardingContext ?? load?.extra?.memoryForwardingContext))
      ? (result.ir.instructions || []).find((candidate) => {
        const definitionId = candidate?.memDef?.definitionId ?? candidate?.extra?.memoryDefinitionId ?? null;
        return candidate?.op === 'store'
          && candidate?.loc?.kind === 'stack'
          && candidate.loc.key === load.loc.key
          && candidate.row != null
          && definitionId != null
          && spillFact.contributingDefinitionIds.includes(String(definitionId));
      })
      : null);
    if (!load || !spill) continue;
    const spillRow = String(spill.row);
    const alignedAddresses = current.addresses.length === current.rows.length;
    const alignedIr = current.ir.length === current.rows.length;
    node.source = {
      ...current,
      rows:current.rows.filter((row) => String(row) !== spillRow),
      addresses:alignedAddresses
        ? current.addresses.filter((_, index) => String(current.rows[index]) !== spillRow)
        : current.addresses,
      ir:alignedIr
        ? current.ir.filter((_, index) => String(current.rows[index]) !== spillRow)
        : current.ir,
      evidence:[...(current.evidence || []), { reason:'eliminated stack spill is proof-only provenance' }],
    };
    changed = true;
  }
  if (!changed) return result;
  const printed = printProgram(result.cAst, { columnWidth:opts.columnWidth || opts.prettyColumnWidth || 88 });
  result.pseudocode = printed.text;
  result.sourceMap = printed.mapping;
  result.lines = result.cAst.body.map((node) => ({
    kind:node.kind, indent:node.indent, text:node.text,
    row:node.source?.rows?.[0] ?? null, addr:node.source?.addresses?.[0] ?? null,
    note:null, source:node.source,
  }));
  result.metrics = { ...(result.metrics || {}), sourceMappedNodes:result.sourceMap?.length || 0 };
  return result;
}

function fullPhase8Projection(result, model, opts) {
  if (opts.phase8Optimize !== true || !result?.semantic || !result?.ir) return result;
  const stage = runPhase8Stage(
    { ir:result.ir, types:result.types, opts },
    {
      stages:PHASE8_ALL_STAGES,
      ...(opts.phase8TimeBudgetMs != null ? { timeBudgetMs:opts.phase8TimeBudgetMs } : {}),
      ...(opts.phase8WorkBudget != null ? { maxWorkItems:opts.phase8WorkBudget } : {}),
      shouldAbort:opts.shouldAbort,
      budgetClass:'standard',
    },
  );
  const priorPipeline = result.ctx?.decompilerPipeline || {};
  let updated = {
    ...result,
    phase8:stage.ledger,
    ctx:{
      ...(result.ctx || {}),
      decompilerPipeline:{
        ...priorPipeline,
        completeness:stage.ledger?.published === true && stage.ledger?.completeness === 'complete'
          ? priorPipeline.completeness
          : 'partial',
        phase8:stage.ledger,
        phase8Timings:stage.timings,
        phase8ElapsedMs:stage.elapsedMs,
      },
    },
  };
  if (stage.ledger?.published !== true || stage.ledger?.completeness !== 'complete' || !stage.analysis) return updated;
  updated = applyPhase8Projection(updated, stage.analysis, opts);
  return updated;
}

export function enhanceSemanticDecompilation(result, model, opts = {}) {
  const restore = normalizeConditionalSelectAliases(result?.ir);
  let core;
  try {
    // The final Phase 8 path executes the full optimizer set once below, after
    // the existing representation pipeline reaches its stable AST. The core is
    // kept on its interactive/canonical lane here so the optimizer is not run
    // twice and does not borrow the PassManager rewrite deadline.
    core = constrainSemanticValueWidths(enhanceCore(result, model, { ...opts, phase8Optimize:false }));
  } finally { restore(); }
  const reanchored = reanchorExactStackReturn(core, opts);
  const legacySpillsRecovered = recoverLegacySameBlockStackSpills(reanchored, opts);
  const stackPhiRecovered = recoverExactStackPhiExpressions(legacySpillsRecovered, opts);
  const recovered = recoverExactStackReturn(reanchorExactStackReturn(stackPhiRecovered, opts), opts);
  return rememberProducerProjection(fullPhase8Projection(reanchorRecoveredReturnSource(recovered, opts), model, opts),opts);
}

/** Demand-driven asynchronous proof path. The representation result comes from
 * the existing decompiler; publication uses the existing Phase 8 stage and final
 * projection, never a second optimizer or an in-place IR rewrite. */
export async function optimizeSemanticDecompilation(result, options = {}) {
  const started = globalThis.performance?.now?.() ?? Date.now();
  let submitted, original = {}, preparedPlan = null;
  const fail = reason => ({...original, proofOptimization:Object.freeze({status:'partial',reason,adopted:0,
    targetDecisions:Object.freeze((preparedPlan?.targetDecisions ?? []).map(decision => Object.freeze({ ...decision,
      disposition:'unknown', reason }))),
    decisionCoverage:Object.freeze({ requested:preparedPlan?.decisionCoverage?.requested ?? null, complete:false }),
    phase8OptimizeStage:null,elapsedMs:(globalThis.performance?.now?.() ?? Date.now())-started})});
  try {
    submitted = queryRecord(options);
    original = queryRecord(result,null,256);
    if (!result?.semantic || !result.ir || !result.semanticAst || !result.cAst) return fail('semantic-projection-required');
    if (!isProducerProjection(result)) return fail('unissued-or-stale-projection');
    // Snapshot request scope before any asynchronous work. The prepared plan
    // will separately bind the exact execution-relevant IR graph.
    const identity = queryRecord(submitted.identity);
    const rawValues = queryArray(queryRecord(original.ir,null,128).values ?? []);
    const auto=[];
    for(const value of rawValues) {
      const fields=queryRecord(value), definition=fields.def==null?null:queryRecord(fields.def);
      if(fields.const==null && ['bin','un','cmp','mov'].includes(definition?.op)) auto.push(value);
    }
    const targets = queryArray(submitted.targets ?? auto);
    const plan = await preparePhase8RewritePlan(result.ir,{...submitted,identity,targets,backendTier:submitted.backendTier ?? 'tiered'});
    preparedPlan = plan;
    const proofContext = {ir:result.ir,proofIdentity:identity,abiId:submitted.abiId};
    if (!isProducerProjection(result) || plan.status !== 'complete' || !isPhase8RewritePlan(plan,proofContext)) return fail(plan.reason ?? 'stale-proof-plan');
    // Keep hot-loop cancellation checks O(1). Full IR/proof freshness is
    // revalidated by admission and the final publication boundary.
    const aborted = () => {try {if(submitted.signal?.aborted)return true;const stopped=submitted.isCancelled?.()===true;return stopped || submitted.signal?.aborted===true;} catch {return true;}};
    // fullPhase8Projection is also the synchronous production callsite. The
    // plan is opt-in and never reaches the ordinary interactive stage.
    const projected = fullPhase8Projection(result,null,{phase8Optimize:true,phase8RewritePlan:plan,
      phase8ProofIdentity:identity,phase8AbiId:submitted.abiId,
      phase8TimeBudgetMs:submitted.phase8TimeBudgetMs ?? 120,
      phase8WorkBudget:submitted.phase8WorkBudget ?? 1000000,shouldAbort:aborted});
    if (aborted() || !isProducerProjection(result) || !isPhase8RewritePlan(plan,proofContext) || projected.phase8?.published !== true || projected.phase8?.completeness !== 'complete') return fail('optimizer-withheld');
    const applied = projected.phase8Projection?.transforms.filter(t=>t.kind==='solver-constant') ?? [];
    const targetDecisions = Object.freeze(plan.targetDecisions.map(decision => {
      if (decision.disposition !== 'selected') return decision;
      const adopted = applied.some(transform => transform.valueId === decision.valueId && transform.queryHash === decision.queryHash);
      return Object.freeze({ ...decision, disposition:adopted ? 'adopted' : 'unknown',
        reason:adopted ? 'committed-and-rendered-constant-projection' : 'selected-projection-not-rendered' });
    }));
    const proofOptimization = Object.freeze({status:'complete',reason:null,
      adopted:applied.length,targetDecisions,decisionCoverage:plan.decisionCoverage,
      planId:plan.planId,scope:plan.observableScope,taintEvidence:plan.taintEvidence,taintMetrics:plan.taintMetrics,taint:plan.taintResult,
      phase8OptimizeStage:projected.ctx?.decompilerPipeline?.phase8ElapsedMs ?? null,
      elapsedMs:(globalThis.performance?.now?.() ?? Date.now())-started});
    if (aborted() || !isProducerProjection(result) || !isPhase8RewritePlan(plan,proofContext)) return fail('cancelled-before-projection-publication');
    const final=rememberProducerProjection({...projected,proofOptimization},{phase8PrepareProof:true,shouldAbort:aborted});
    if(aborted() || !isProducerProjection(final) || !isProducerProjection(result) || !isPhase8RewritePlan(plan,proofContext)) return fail('cancelled-or-stale-at-final-publication');
    return final;
  } catch { return fail('invalid-or-unsupported-proof-optimization'); }
}
