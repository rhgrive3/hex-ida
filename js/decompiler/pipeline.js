import { enhanceSemanticDecompilation as enhanceCore } from './pipeline-core.js';
import { recoverExactStackPhiExpressions } from './passes/stack-phi-recovery.js';
import { recoverExactStackReturn } from './passes/stack-return-recovery.js';
import { expr, mapChildren, sourceOf } from './ast/nodes.js';
import { printExpression, printProgram } from './pretty/c.js';
import { PASS_STAGES as PHASE8_ALL_STAGES, runPhase8Stage } from './phase8/index.js';
import { applyPhase8Projection } from './phase8/projection.js';
import {
  canonicalMemoryForwardingContextForLoad,
  isCanonicalExactMemoryForwarding,
} from '../semantics/memoryssa/queries.js';

export { buildExpressionForTesting } from './pipeline-core.js';

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

function exactLegacySameBlockStackStore(load, ir) {
  if (!load?.reachingStore || load.loc?.kind !== 'stack' || !load.loc?.key) return null;
  const store = load.reachingStore;
  if (store.op !== 'store' || store.block !== load.block || store.loc?.kind !== 'stack'
      || store.loc.key !== load.loc.key || store.row == null || load.row == null
      || Number(store.row) >= Number(load.row)) return null;
  const block = ir?.blocks?.[load.block];
  if (!block) return null;
  for (const inst of block.insts || []) {
    if (inst === store || inst === load || inst?.row == null) continue;
    if (Number(inst.row) <= Number(store.row) || Number(inst.row) >= Number(load.row)) continue;
    if (inst.op === 'call' || inst.op === 'clobber' || inst.op === 'unknown') return null;
    if (inst.op === 'store' && (!inst.loc?.key || inst.loc?.kind === 'unknown')) return null;
  }
  return store;
}

/* Legacy-v1 keeps its historical MemorySSA `reachingStore` pointer. Use that
 * existing proof only for a trivially ordered same-block fixed-stack spill.
 * No CFG/path inference is added here, and any call/unknown barrier keeps the
 * load explicit. This is intentionally narrower than canonical v2 forwarding. */
function recoverLegacySameBlockStackSpills(result, opts = {}) {
  if (!result?.semanticAst || !result?.ir || result.ir.compat?.projection === 'semantic-ir-v2-to-v1') return result;
  const instructionById = new Map((result.ir.instructions || []).map((inst) => [String(inst.id), inst]));
  const expressions = new Map((result.semanticAst.values || []).map((item) => [String(item.valueId), item.expression]));
  const active = new Set();

  const rewrite = (node, depth = 0) => {
    if (!node || depth > 64) return node;
    if (node.kind === 'load' && node.location?.kind === 'stack' && node.location?.key) {
      const ids = [...new Set((node.source?.ir || []).map(String))];
      if (ids.length !== 1) return node;
      const load = instructionById.get(ids[0]);
      if (!load || load.op !== 'load' || load.loc?.key !== node.location.key) return node;
      const store = exactLegacySameBlockStackStore(load, result.ir);
      const storedValue = store?.args?.[0]?.value;
      if (!storedValue) return node;
      const key = String(storedValue.id);
      if (active.has(key)) return node;
      const replacement = expressions.get(key);
      if (!replacement) return node;
      active.add(key);
      let resolved = rewrite(replacement, depth + 1);
      active.delete(key);
      const bytes = Number(store.size || store.loc?.size || store.addr?.size || 0);
      const storeBits = bytes > 0 ? bytes * 8 : 0;
      if (storeBits > 0 && Number(resolved?.bits || storeBits) > storeBits) {
        resolved = expr.unary('trunc', resolved, storeBits, resolved.signed ?? null, {
          address:store.address,
          row:store.row,
          ir:store.id,
          evidence:[{ reason:`exact ${storeBits}-bit legacy stack store width` }],
        }, { fromBits:Number(resolved.bits || storeBits) });
      }
      return resolved;
    }
    return mapChildren(node, (child) => rewrite(child, depth + 1));
  };

  for (const item of result.semanticAst.values || []) {
    const resolved = rewrite(item.expression);
    item.expression = resolved;
    expressions.set(String(item.valueId), resolved);
  }
  for (const output of result.semanticAst.outputs || []) {
    if (output?.expression) output.expression = rewrite(output.expression);
  }

  let printedChanged = false;
  for (const node of result.cAst?.body || []) {
    if (!(node.semantic?.op === 'return' || /^return\b/.test(String(node.text || '').trim()))) continue;
    const expression = node.semantic?.expression;
    if (!expression) continue;
    const resolved = rewrite(expression);
    if (resolved === expression) continue;
    if (node.semantic) node.semantic.expression = resolved;
    node.text = `return ${printExpression(resolved)};`;
    printedChanged = true;
  }
  if (!printedChanged) return result;
  const printed = printProgram(result.cAst, { columnWidth:opts.columnWidth || opts.prettyColumnWidth || 88 });
  result.pseudocode = printed.text;
  result.sourceMap = printed.mapping;
  result.lines = result.cAst.body.map((node) => ({
    kind:node.kind, indent:node.indent, text:node.text,
    row:node.source?.rows?.[0] ?? null, addr:node.source?.addresses?.[0] ?? null,
    note:null, source:node.source,
  }));
  result.metrics = { ...(result.metrics || {}), sourceMappedNodes:printed.mapping.length };
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
      ...(opts.phase8TimeBudgetMs != null ? { timeBudgetMs:Number(opts.phase8TimeBudgetMs) } : {}),
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
  // Legacy-v1 can carry a return-slot LOAD whose same-block spill forwarding
  // would otherwise replace the return root before the stricter return proof
  // gets a chance to reconstruct it. Run the existing proof-only return pass
  // first on legacy input; canonical v2 keeps its established ordering.
  const legacyReturnRecovered = reanchored?.ir?.compat?.projection === 'semantic-ir-v2-to-v1'
    ? reanchored
    : recoverExactStackReturn(reanchored, opts);
  const legacySpillsRecovered = recoverLegacySameBlockStackSpills(legacyReturnRecovered, opts);
  const stackPhiRecovered = recoverExactStackPhiExpressions(legacySpillsRecovered, opts);
  const recovered = recoverExactStackReturn(reanchorExactStackReturn(stackPhiRecovered, opts), opts);
  return fullPhase8Projection(reanchorRecoveredReturnSource(recovered, opts), model, opts);
}
