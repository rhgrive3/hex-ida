/*
 * Resolve only exact legacy-v1 stack reloads whose reaching store is already
 * proven by the legacy IR. This runs after the typed semantic AST is built and
 * before the higher-level return recovery consumes those expressions.
 *
 * Canonical v2 projections are excluded: their MemorySSA facts remain the sole
 * authority. Ambiguous, cyclic, mismatched, or unproven stack loads stay loads.
 */
import { mergeSource, structuralKey } from './ast/nodes.js';
import { expressionOriginHistory } from './rewrite/engine.js';
import { readExpressionHistoryConsumer } from './pipeline-core.js';
import { captureRecoveryIrData, PROJECTION_LIMITS } from './phase8/projection-origin.js';

const valueHistories = new WeakMap();
export function readLegacyStackValueHistory(entry, ir) {
  const binding = valueHistories.get(entry);
  if (!binding || binding.ir !== ir) return null;
  const data = key => Object.getOwnPropertyDescriptor(entry, key)?.value;
  return data('expression') === binding.expression && data('valueId') === binding.valueId
    && binding.isCurrent() ? binding : null;
}

const source = inst => ({ address:inst.address, row:inst.row, ir:inst.id, ssaDef:inst.dst?.id,
  ssaUses:(inst.args || []).map(arg => arg?.value?.id).filter(id => id != null) });
const cap = (value, maximum) => Number.isSafeInteger(value) && value >= 0 ? Math.min(value, maximum) : maximum;
function retain(trace, records) {
  for (const record of records) {
    if (trace.records.has(record)) continue;
    if (trace.records.size < trace.maximum) trace.records.add(record);
    else trace.truncated = true;
  }
}

function exactStoredExpression(value, astById, result, stores, localHistories, trace, active = new Set()) {
  if (!value) return null;
  const key = value.id ?? value;
  if (active.has(key)) return null;
  const entry = astById.get(value.id);
  const node = entry?.expression ?? null;
  if (!node) return null;
  if (node.kind !== 'load' || node.location?.kind !== 'stack') {
    const local = localHistories.get(entry);
    if (local?.expression === node) { retain(trace, local.records); return node; }
    const prior = readLegacyStackValueHistory(entry, result.ir);
    if (prior) { retain(trace, prior.records); trace.priors.add(prior); }
    return node;
  }

  const load = value.def;
  if (load?.op !== 'load' || load.loc?.kind !== 'stack' || load.loc.key !== node.location?.key) return null;
  const store = load.reachingStore;
  if (store?.op !== 'store' || store.loc?.kind !== 'stack' || store.loc.key !== load.loc.key) return null;
  const stored = store.args?.[0]?.value;
  if (!stored) return null;

  const consumer = stores.get(String(store.id));
  if (consumer && consumer.expression === astById.get(stored.id)?.expression) {
    retain(trace, consumer.records); trace.priors.add(consumer);
  }

  active.add(key);
  const resolved = exactStoredExpression(stored, astById, result, stores, localHistories, trace, active);
  active.delete(key);
  if (resolved && resolved !== node) {
    if (trace.records.size >= trace.maximum || trace.remainingNew <= 0) trace.truncated = true;
    else {
      trace.remainingNew--;
      retain(trace, [Object.freeze({
        rule:'legacy-stack-value-materialization', phase:'memory-ssa', valueId:value.id,
        before:structuralKey(node), after:structuralKey(resolved),
        evidence:Object.freeze({ kind:'legacy-reaching-store', detail:'existing legacy semantic-value materialization from its reaching-store chain' }),
        originHistory:expressionOriginHistory({ source:mergeSource(node.source, source(load), source(store)) }, resolved),
      })]);
    }
  }
  return resolved;
}

export function materializeLegacyExactStackValues(result) {
  if (!result?.ir || !Array.isArray(result?.semanticAst?.values)) return result;
  if (result.ir.compat?.projection === 'semantic-ir-v2-to-v1') return result;

  const astById = new Map(result.semanticAst.values.map((entry) => [entry.valueId, entry]));
  const opts = result.opts || {}, stores = new Map(), localHistories = new Map();
  for (const node of result.cAst?.body || []) {
    if (node.semantic?.op !== 'store') continue;
    const id = String(node.semantic.ir), binding = readExpressionHistoryConsumer(node.semantic, result.ir);
    stores.set(id, stores.has(id) ? null : binding);
  }
  const maximum = cap(opts.renderProvenanceBudget?.maxTransformRecords, 1024);
  const maxConsumers = cap(opts.renderProvenanceBindingBudget?.maxConsumers, 4096);
  const retained = new Set(result.rewriteProof || []), added = [], transitions = [], priors = new Set();
  const reasons = new Set(result.expressionBindingBudget?.reasons || []);
  for (const value of result.ir.values ?? []) {
    const entry = astById.get(value?.id);
    if (entry?.expression?.kind !== 'load' || entry.expression.location?.kind !== 'stack') continue;
    const trace = { maximum, remainingNew:Math.max(0, maximum - added.length), records:new Set(), priors:new Set(), truncated:false };
    const before = entry.expression;
    const resolved = exactStoredExpression(value, astById, result, stores, localHistories, trace);
    if (!resolved || (resolved.kind === 'load' && resolved.location?.kind === 'stack')) continue;
    entry.expression = resolved;
    for (const record of trace.records) {
      if (retained.has(record)) continue;
      if (added.length < maximum) { retained.add(record); added.push(record); }
      else trace.truncated = true;
    }
    if (trace.truncated) reasons.add('legacy-value-history-budget');
    for (const prior of trace.priors) priors.add(prior);
    if (transitions.length < maxConsumers) {
      const records = Object.freeze([...trace.records].filter(record => retained.has(record)));
      transitions.push({ entry, before, records });
      localHistories.set(entry, { expression:resolved, records });
    } else reasons.add('legacy-value-binding-budget');
  }
  if (added.length) result.rewriteProof = [...(result.rewriteProof || []), ...added];
  // One current observation over the actual completed transitions. Local
  // dependencies above never require recursive observer closures or repeated
  // whole-graph observations for every semantic value.
  if (transitions.length) publishValueHistory(result, transitions, priors, opts, reasons);
  if (reasons.size) {
    result.expressionBindingBudget ??= { consumers:0, edges:0, reasons:new Set() };
    for (const reason of reasons) result.expressionBindingBudget.reasons.add(reason);
    result.expressionHistoryBinding = Object.freeze({ ...result.expressionHistoryBinding,
      completeness:'incomplete', reasons:Object.freeze([...reasons].sort()) });
  }
  return result;
}

function publishValueHistory(result, transitions, priors, opts, reasons) {
  try {
    const observation = captureRecoveryIrData(result.ir, [
      transitions.map(item => [item.before, item.entry.expression, item.records]),
      [...priors].map(prior => [prior.expression, prior.records]),
    ], opts.shouldAbort);
    if (observation.metrics.edges > cap(opts.renderProvenanceBindingBudget?.maxEdges, PROJECTION_LIMITS.edges)
        || transitions.length > cap(opts.renderProvenanceBindingBudget?.maxConsumers, 4096)) {
      reasons.add('legacy-value-binding-budget'); return;
    }
    if (![...priors].every(prior => prior.isCurrent())) { reasons.add('stale-legacy-value-history'); return; }
    for (const { entry, records } of transitions) valueHistories.set(entry, Object.freeze({
      ir:result.ir, valueId:entry.valueId, expression:entry.expression, records,
      isCurrent:() => observation.matches(),
    }));
  } catch { reasons.add('legacy-value-observation-unavailable'); }
}
