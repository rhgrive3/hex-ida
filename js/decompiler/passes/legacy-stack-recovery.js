import { expr, mapChildren, mergeSource, structuralKey } from '../ast/nodes.js';
import { printExpression, printProgram } from '../pretty/c.js';
import { expressionOriginHistory } from '../rewrite/engine.js';
import { readExpressionHistoryConsumer } from '../pipeline-core.js';
import { readLegacyStackValueHistory } from '../legacy-exact-return-repair.js';
import { captureRecoveryIrData, PROJECTION_LIMITS } from '../phase8/projection-origin.js';

const consumers = new WeakMap();
export function readLegacyStackHistoryConsumer(semantic, ir) {
  const binding = consumers.get(semantic);
  if (!binding || binding.ir !== ir) return null;
  const data = key => Object.getOwnPropertyDescriptor(semantic, key)?.value;
  return data('expression') === binding.expression && data('op') === binding.op
    && data('ir') === binding.instructionId && data('location') === binding.location
    && binding.isCurrent() ? binding : null;
}

export function exactLegacySameBlockStackStore(load, ir) {
  if (!load?.reachingStore || load.loc?.kind !== 'stack' || !load.loc?.key) return null;
  const store = load.reachingStore;
  const loadSize = Number(load.loc?.size);
  const storeSize = Number(store?.loc?.size);
  if (!Number.isSafeInteger(loadSize) || loadSize <= 0
      || !Number.isSafeInteger(storeSize) || storeSize !== loadSize) return null;
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

const cap = (value, maximum) => Number.isSafeInteger(value) && value >= 0 ? Math.min(value, maximum) : maximum;
const origin = inst => ({ address:inst.address, row:inst.row, ir:inst.id,
  ssaDef:inst.dst?.id, ssaUses:(inst.args || []).map(arg => arg?.value?.id).filter(id => id != null) });

function bindTransitions(result, transitions, priors, opts, reasons) {
  try {
    const observation = captureRecoveryIrData(result.ir, [
      transitions.map(item => [item.before, item.node.semantic.expression, item.records]),
      [...priors].map(prior => [prior.expression, prior.records]),
    ], opts.shouldAbort);
    if (observation.metrics.edges > cap(opts.renderProvenanceBindingBudget?.maxEdges, PROJECTION_LIMITS.edges)) {
      reasons.add('legacy-binding-budget');
    } else if (![...priors].every(prior => prior.isCurrent())) {
      reasons.add('stale-legacy-input-history');
    } else {
      let remaining = cap(opts.renderProvenanceBindingBudget?.maxConsumers, 4096);
      for (const item of transitions) {
        if (remaining-- <= 0) { reasons.add('legacy-binding-budget'); continue; }
        const semantic = item.node.semantic;
        consumers.set(semantic, Object.freeze({ ir:result.ir, expression:semantic.expression,
          op:semantic.op, instructionId:semantic.ir, location:semantic.location,
          records:item.records, isCurrent:() => observation.matches(),
        }));
      }
    }
  } catch { reasons.add('legacy-binding-observation-unavailable'); }
}

// The existing legacy-v1 recovery, with its same reachingStore/width/barrier
// contract. Canonical v2 forwarding remains owned by its MemorySSA producer.
export function recoverLegacySameBlockStackSpills(result, opts = {}) {
  if (!result?.semanticAst || !result?.ir || result.ir.compat?.projection === 'semantic-ir-v2-to-v1') return result;
  const instructionById = new Map((result.ir.instructions || []).map(inst => [String(inst.id), inst]));
  const expressions = new Map((result.semanticAst.values || []).map(item => [String(item.valueId), item.expression]));
  const originals = new Map(expressions), histories = new Map(), stores = new Map();
  const active = new Set(), priors = new Set(), records = [];
  const reasons = new Set(result.expressionHistoryBinding?.reasons || []);
  const maximum = cap(opts.renderProvenanceBudget?.maxTransformRecords, 1024);
  const maxConsumers = cap(opts.renderProvenanceBindingBudget?.maxConsumers, 4096);
  for (const item of result.semanticAst.values || []) {
    const prior = readLegacyStackValueHistory(item, result.ir);
    if (prior) { histories.set(String(item.valueId), prior.records); priors.add(prior); }
  }
  for (const node of result.cAst?.body || []) {
    if (node.semantic?.op !== 'store') continue;
    const key = String(node.semantic.ir);
    const binding = readExpressionHistoryConsumer(node.semantic, result.ir);
    stores.set(key, stores.has(key) ? null : binding);
  }
  const retain = (trace, additions) => {
    for (const record of additions) {
      if (trace.has(record)) continue;
      if (trace.size < maximum) trace.add(record);
      else reasons.add('legacy-rewrite-history-budget');
    }
  };

  const rewrite = (node, trace, depth = 0) => {
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
      retain(trace, histories.get(key) || []);
      const prior = stores.get(String(store.id));
      if (prior && prior.expression === originals.get(key)) {
        retain(trace, prior.records); priors.add(prior);
      }
      active.add(key);
      let resolved = rewrite(replacement, trace, depth + 1);
      active.delete(key);
      const bytes = Number(store.size || store.loc?.size || store.addr?.size || 0);
      const storeBits = bytes > 0 ? bytes * 8 : 0;
      if (storeBits > 0 && Number(resolved?.bits || storeBits) > storeBits) {
        resolved = expr.unary('trunc', resolved, storeBits, resolved.signed ?? null, {
          address:store.address, row:store.row, ir:store.id,
          evidence:[{ reason:`exact ${storeBits}-bit legacy stack store width` }],
        }, { fromBits:Number(resolved.bits || storeBits) });
      }
      if (resolved !== node) {
        if (records.length < maximum) {
          const record = Object.freeze({ rule:'legacy-stack-spill-forwarding', phase:'memory-ssa',
            before:structuralKey(node), after:structuralKey(resolved),
            evidence:Object.freeze({ kind:'legacy-same-block-reaching-store', detail:'same-slot same-width reaching store without an intervening unknown memory effect' }),
            originHistory:expressionOriginHistory({ source:mergeSource(node.source, origin(load), origin(store)) }, resolved),
          });
          records.push(record); retain(trace, [record]);
        } else reasons.add('legacy-rewrite-history-budget');
      }
      return resolved;
    }
    // A no-op traversal is not a new producer. Keep the actual expression and
    // its private input history when no child was recovered; cloning here
    // would force unrelated scalar histories through stack-recovery authority.
    let changed = false;
    const mapped = mapChildren(node, child => {
      const resolved = rewrite(child, trace, depth + 1);
      changed ||= resolved !== child;
      return resolved;
    });
    return changed ? mapped : node;
  };

  for (const item of result.semanticAst.values || []) {
    const trace = new Set();
    retain(trace, histories.get(String(item.valueId)) || []);
    const resolved = rewrite(item.expression, trace);
    item.expression = resolved;
    expressions.set(String(item.valueId), resolved);
    histories.set(String(item.valueId), Object.freeze([...trace]));
  }
  for (const output of result.semanticAst.outputs || []) {
    if (output?.expression) output.expression = rewrite(output.expression, new Set());
  }

  let printedChanged = false;
  const transitions = [];
  for (const node of result.cAst?.body || []) {
    if (!(node.semantic?.op === 'return' || /^return\b/.test(String(node.text || '').trim()))) continue;
    const expression = node.semantic?.expression;
    if (!expression) continue;
    const trace = new Set();
    const prior = readLegacyStackHistoryConsumer(node.semantic, result.ir) || readExpressionHistoryConsumer(node.semantic, result.ir);
    if (prior) { retain(trace, prior.records); priors.add(prior); }
    const resolved = rewrite(expression, trace);
    if (resolved === expression) continue;
    node.semantic.expression = resolved;
    node.text = `return ${printExpression(resolved)};`;
    if (trace.size) {
      if (transitions.length < maxConsumers) transitions.push({ node, before:expression, records:Object.freeze([...trace]) });
      else reasons.add('legacy-binding-budget');
    }
    printedChanged = true;
  }
  if (records.length) result.rewriteProof = [...(result.rewriteProof || []), ...records];
  if (transitions.length) bindTransitions(result, transitions, priors, opts, reasons);
  if (reasons.size) result.expressionHistoryBinding = Object.freeze({
    ...result.expressionHistoryBinding, completeness:'incomplete', reasons:Object.freeze([...reasons].sort()),
  });
  if (!printedChanged) return result;
  const printed = printProgram(result.cAst, { columnWidth:opts.columnWidth || opts.prettyColumnWidth || 88 });
  result.pseudocode = printed.text;
  result.sourceMap = printed.mapping;
  result.lines = result.cAst.body.map(node => ({ kind:node.kind, indent:node.indent, text:node.text,
    row:node.source?.rows?.[0] ?? null, addr:node.source?.addresses?.[0] ?? null, note:null, source:node.source }));
  result.metrics = { ...(result.metrics || {}), sourceMappedNodes:printed.mapping.length };
  return result;
}
