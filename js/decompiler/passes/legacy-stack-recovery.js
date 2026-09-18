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

function ownData(object, key) {
  if (object == null || (typeof object !== 'object' && typeof object !== 'function')) {
    return { present:false, valid:true, value:undefined };
  }
  const descriptor = Object.getOwnPropertyDescriptor(object, key);
  if (!descriptor) return { present:false, valid:true, value:undefined };
  if (!Object.hasOwn(descriptor, 'value')) return { present:true, valid:false, value:undefined };
  return { present:true, valid:true, value:descriptor.value };
}

function valueOf(object, key) {
  const field = ownData(object, key);
  return field.present && field.valid ? field.value : undefined;
}

function validRow(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function positiveSize(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null;
}

function memoryDescriptor(instruction) {
  const op = valueOf(instruction, 'op');
  if (op === 'load' || op === 'store') {
    const location = valueOf(instruction, 'loc');
    const kind = valueOf(location, 'kind');
    const key = valueOf(location, 'key');
    const precise = ['stack', 'global', 'field'].includes(kind)
      && typeof key === 'string' && key.length > 0 && key.trim() === key;
    return { op, kind, key:precise ? key : null, broad:!precise };
  }
  if (op === 'call' || op === 'clobber' || op === 'unknown') {
    return { op, kind:null, key:null, broad:true };
  }
  return null;
}

function collides(load, mutation) {
  if (!load || load.op !== 'load' || !mutation || mutation.op === 'load') return false;
  return load.broad || mutation.broad || load.key === mutation.key;
}

function sameRowMemoryCollision(left, right) {
  if (!left || !right) return false;
  if (left.op === 'load' && right.op !== 'load') return collides(left, right);
  if (right.op === 'load' && left.op !== 'load') return collides(right, left);
  if (left.op === 'load' || right.op === 'load') return false;
  return left.broad || right.broad || left.key === right.key;
}

function abortRequested(options) {
  const field = ownData(options, 'shouldAbort');
  if (!field.present) return false;
  if (!field.valid || typeof field.value !== 'function') return true;
  try { return field.value() === true; } catch { return true; }
}

export function exactLegacySameBlockStackStore(load, ir, options = {}) {
  if (abortRequested(options)) return null;
  const loadOp = valueOf(load, 'op');
  const loadLocation = valueOf(load, 'loc');
  const loadKind = valueOf(loadLocation, 'kind');
  const loadKey = valueOf(loadLocation, 'key');
  const reachingField = ownData(load, 'reachingStore');
  if (loadOp !== 'load' || loadKind !== 'stack' || typeof loadKey !== 'string' || loadKey.length === 0
      || !reachingField.present || !reachingField.valid) return null;
  const store = reachingField.value;
  const storeOp = valueOf(store, 'op');
  const storeLocation = valueOf(store, 'loc');
  const storeKind = valueOf(storeLocation, 'kind');
  const storeKey = valueOf(storeLocation, 'key');
  const loadBlock = valueOf(load, 'block');
  const storeBlock = valueOf(store, 'block');
  const loadRow = valueOf(load, 'row');
  const storeRow = valueOf(store, 'row');
  const loadSize = positiveSize(valueOf(loadLocation, 'size'));
  const storeSize = positiveSize(valueOf(storeLocation, 'size'));
  if (storeOp !== 'store' || storeKind !== 'stack' || storeKey !== loadKey
      || !validRow(loadBlock) || storeBlock !== loadBlock || !validRow(storeRow)
      || !validRow(loadRow) || storeRow >= loadRow || loadSize == null || storeSize !== loadSize) return null;
  const blocks = valueOf(ir, 'blocks');
  if (!Array.isArray(blocks) || loadBlock >= blocks.length) return null;
  const block = blocks[loadBlock];
  const instructions = valueOf(block, 'insts');
  if (!Array.isArray(instructions)) return null;
  let storeCount = 0, loadCount = 0;
  const byRow = new Map();
  for (const inst of instructions) {
    if (abortRequested(options)) return null;
    if (inst === store) storeCount++;
    if (inst === load) loadCount++;
    const descriptor = memoryDescriptor(inst);
    if (!descriptor) continue;
    const row = valueOf(inst, 'row');
    if (!validRow(row)) return null;
    const prior = byRow.get(row) || [];
    if (prior.some((entry) => sameRowMemoryCollision(descriptor, entry))) return null;
    prior.push(descriptor); byRow.set(row, prior);
  }
  if (storeCount !== 1 || loadCount !== 1) return null;
  for (const inst of instructions) {
    if (abortRequested(options)) return null;
    if (inst === store || inst === load) continue;
    const row = valueOf(inst, 'row');
    if (!validRow(row)) {
      if (memoryDescriptor(inst)) return null;
      continue;
    }
    if (row <= storeRow || row >= loadRow) continue;
    const descriptor = memoryDescriptor(inst);
    if (!descriptor) continue;
    if (descriptor.op === 'call' || descriptor.op === 'clobber' || descriptor.op === 'unknown'
        || (descriptor.op === 'store' && (descriptor.broad || descriptor.key === loadKey))) return null;
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
