import { isProducerProjection, producerExpressionToken, readProducerInputExpressions, producerUsesProofOnlyRewrites } from '../pipeline.js';
import { readExpressionHistoryConsumer, readStoreSpellingProducer, readInitialControlConsumer, readCallResultSpellingProducer } from '../pipeline-core.js';
import { expressionOriginHistory } from '../rewrite/engine.js';
import { readStackPhiHistoryConsumer } from '../passes/stack-phi-recovery.js';
import { readStackReturnHistoryConsumer } from '../passes/stack-return-recovery.js';
import { readLegacyStackHistoryConsumer } from '../passes/legacy-stack-recovery.js';
import { captureProjectionIrData, PROJECTION_LIMITS } from './projection-origin.js';
import { children, expr, mapChildren, mergeSource, sourceOf } from '../ast/nodes.js';
import { expressionReadability, printExpression, printProgram } from '../pretty/c.js';
import { readProvedRewrites, readProvedInputBindings } from './pass-validation.js';
import { renderProofExpression, sameProofExpression } from './proof-expression.js';
import {
  analysisIdentityMatches,
  canonicalAnalysisIdentity,
  isValidatedAnalysisIdentity,
} from './analysis-identity.js';
import { buildRenderProvenance } from './render-provenance.js';
import { readDceResultProof } from './dce.js';

export const PHASE8_PROJECTION_VERSION = 3;

const lineExpressionHistories = new WeakMap();
const controlConsumerSources = new WeakMap();
// One current snapshot per owned AST, never a chain of previous projections.
// Ordinary result wrappers may retain this AST; copied/replaced AST data cannot
// manufacture the private transition that carries the original consumers.
const projectionHistories = new WeakMap();
function readProjectionHistory(result) {
  const entry = projectionHistories.get(result.cAst);
  if (!entry || entry.ir !== result.ir || entry.semanticAst !== result.semanticAst
      || entry.body !== result.cAst.body || entry.conditions !== result.semanticAst.conditions
      || entry.rewriteProof !== result.rewriteProof || entry.projection !== result.phase8Projection
      || entry.producerDisposition !== result.expressionHistoryBinding
      || !entry.observation.matches() || !entry.consumers.every(consumer => consumer.isCurrent())) return null;
  return entry;
}

function prepareProjectionHistory(result, expressions, conditions, records, opts, reasons, proofExpressions) {
  const consumers = [...new Set([...expressions, ...conditions].filter(Boolean))];
  const cap = (value, maximum) => Number.isSafeInteger(value) && value >= 0 ? Math.min(value, maximum) : maximum;
  const budget = opts.renderProvenanceBindingBudget;
  if (consumers.length > cap(budget?.maxConsumers, 4096)) {
    reasons.add('projection-history-budget');
    return null;
  }
  try {
    const observation = captureProjectionIrData(
      [result.cAst.body, result.semanticAst.conditions, result.rewriteProof, records], opts.shouldAbort);
    if (observation.metrics.edges > cap(budget?.maxEdges, PROJECTION_LIMITS.edges)) {
      reasons.add('projection-history-budget');
      return null;
    }
    if (!consumers.every(consumer => consumer.isCurrent())) {
      reasons.add('stale-projection-consumer');
      return null;
    }
    return { ir:result.ir, semanticAst:result.semanticAst, body:result.cAst.body,
      conditions:result.semanticAst.conditions, rewriteProof:result.rewriteProof,
      producerDisposition:result.expressionHistoryBinding,
      expressions:Object.freeze(expressions), conditionConsumers:Object.freeze(conditions),
      consumers:Object.freeze(consumers), records, observation, proofExpressions };
  } catch {
    reasons.add('projection-history-observation-unavailable');
    return null;
  }
}

export function readLineExpressionHistory(line, ir) {
  const entry = lineExpressionHistories.get(line);
  return entry && entry.ir === ir && entry.consumers.every(consumer => consumer.isCurrent()) && entry.observation.matches()
    ? entry.records : null;
}

function integer(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null;
}

function evidenceSource(source, reason) {
  const current = sourceOf(source);
  return { ...current, evidence:[...(current.evidence || []), { reason }] };
}

// The translator's actual before slice crosses only the committed private
// binding. Never infer this lineage from names or unrelated uses/consumers.
function provedSliceSource(root, binding, shouldAbort) {
  if (!Array.isArray(binding.dependencies) || binding.dependencies.length > PROJECTION_LIMITS.nodes) return null;
  const source = sourceOf(root), keys = ['addresses','rows','ir','ssaDefs','ssaUses'];
  const seen = Object.fromEntries(keys.map(key => [key,new Set(source[key])]));
  for (const value of binding.dependencies) {
    if (shouldAbort?.()) return null;
    const def = value.def;
    const origin = sourceOf({address:def?.address,row:def?.row,ir:def?.id,ssaDef:value.id,
      ssaUses:[...(def?.args ?? []).map(arg => arg.value?.id),def?.conditionValue?.id]});
    for (const key of keys) for (const item of origin[key]) if (!seen[key].has(item)) {
      seen[key].add(item); source[key].push(item);
    }
  }
  return source;
}

function recordViewCollapse(records, { proof, outerBits, innerBits, sourceBits, source, kind = 'exact-view-collapse' }) {
  records.push(Object.freeze({
    kind,
    proof,
    targets:Object.freeze(collectTargets(source, proof)),
    outerBits,
    innerBits,
    sourceBits,
    origin:Object.freeze({
      addresses:Object.freeze([...(source.addresses || [])]),
      rows:Object.freeze([...(source.rows || [])]),
      ir:Object.freeze([...(source.ir || [])]),
      ssaDefs:Object.freeze([...(source.ssaDefs || [])]),
      ssaUses:Object.freeze([...(source.ssaUses || [])]),
    }),
  }));
}

/**
 * HEX-C4-03: every rewrite must say which canonical entities it rewrote. The
 * merged source of a collapse carries the union of consumed rows/ir/ssa refs,
 * so the target set is derived from the same evidence the proof consumed —
 * never from rendered text.
 */
function collectTargets(source, proof) {
  const targets = [];
  for (const ref of source.ir || []) targets.push(`ir:${ref}`);
  for (const def of source.ssaDefs || []) targets.push(`ssa:def:${def}`);
  for (const row of source.rows || []) targets.push(`row:${row}`);
  for (const address of source.addresses || []) targets.push(`addr:${address}`);
  for (const use of source.ssaUses || []) targets.push(`ssa:use:${use}`);
  if (targets.length === 0) targets.push(`proof:${proof}`);
  return targets;
}

function collapseExactNestedTruncation(node, records) {
  if (node?.kind !== 'unary' || node.op !== 'trunc') return node;
  const inner = node.arg;
  if (inner?.kind !== 'unary' || inner.op !== 'trunc') return node;
  const outerBits = integer(node.bits);
  const innerBits = integer(inner.bits);
  const sourceBits = integer(inner.arg?.bits);
  if (outerBits == null || innerBits == null || sourceBits == null) return node;
  if (!(outerBits <= innerBits && innerBits <= sourceBits)) return node;
  const source = mergeSource(node.source, inner.source, inner.arg?.source);
  recordViewCollapse(records, {
    proof:'trunc_N(trunc_M(x)) == trunc_N(x) for N <= M <= width(x)',
    outerBits,
    innerBits,
    sourceBits,
    source,
  });
  return expr.unary('trunc', inner.arg, outerBits, node.signed ?? false,
    evidenceSource(source, 'Phase 8 exact nested-truncation proof'), {
      fromBits:sourceBits,
      phase8Proof:'nested-truncation',
    });
}

/**
 * Collapse an extension that is provably hidden by an outer unsigned truncation.
 *
 * These are bit-vector identities, not pretty-printer elision:
 *
 *   trunc_N(zext_M(x:S)) == zext_N(x)   when S < N <= M
 *   trunc_N(ext_M(x:S))  == trunc_N(x)  when N <= S <= M
 *
 * The first identity is deliberately restricted to zext because the C projection
 * represents `trunc` as an unsigned view. Replacing `trunc_N(sext_M(x))` with
 * `sext_N(x)` when S < N would change the recovered signed view even though the
 * low N bits agree. The second identity is safe for zext and sext because the
 * extension contributes only bits that the outer truncation discards.
 */
function collapseExactExtensionUnderTruncation(node, records) {
  if (node?.kind !== 'unary' || node.op !== 'trunc') return node;
  const inner = node.arg;
  if (inner?.kind !== 'unary' || !['zext', 'sext'].includes(inner.op)) return node;
  const outerBits = integer(node.bits);
  const innerBits = integer(inner.bits);
  const sourceBits = integer(inner.arg?.bits);
  if (outerBits == null || innerBits == null || sourceBits == null) return node;
  if (!(sourceBits <= innerBits && outerBits <= innerBits)) return node;

  const source = mergeSource(node.source, inner.source, inner.arg?.source);
  if (outerBits <= sourceBits) {
    recordViewCollapse(records, {
      proof:'trunc_N(ext_M(x:S)) == trunc_N(x) for N <= S <= M',
      outerBits,
      innerBits,
      sourceBits,
      source,
    });
    return expr.unary('trunc', inner.arg, outerBits, node.signed ?? false,
      evidenceSource(source, 'Phase 8 exact extension-hidden-by-truncation proof'), {
        fromBits:sourceBits,
        phase8Proof:'extension-hidden-by-truncation',
      });
  }

  if (inner.op !== 'zext') return node;
  recordViewCollapse(records, {
    proof:'trunc_N(zext_M(x:S)) == zext_N(x) for S < N <= M',
    outerBits,
    innerBits,
    sourceBits,
    source,
  });
  return expr.unary('zext', inner.arg, outerBits, node.signed ?? false,
    evidenceSource(source, 'Phase 8 exact zero-extension narrowing proof'), {
      fromBits:sourceBits,
      phase8Proof:'narrowed-zero-extension',
    });
}

function collapseExactRepeatedExtension(node, records) {
  if (node?.kind !== 'unary' || !['zext', 'sext'].includes(node.op)) return node;
  const inner = node.arg;
  if (inner?.kind !== 'unary' || inner.op !== node.op) return node;
  const outerBits = integer(node.bits);
  const innerBits = integer(inner.bits);
  const sourceBits = integer(inner.arg?.bits);
  if (outerBits == null || innerBits == null || sourceBits == null) return node;
  if (!(sourceBits <= innerBits && innerBits <= outerBits)) return node;
  const source = mergeSource(node.source, inner.source, inner.arg?.source);
  recordViewCollapse(records, {
    proof:`${node.op}_N(${node.op}_M(x)) == ${node.op}_N(x) for width(x) <= M <= N`,
    outerBits,
    innerBits,
    sourceBits,
    source,
  });
  return expr.unary(node.op, inner.arg, outerBits, node.signed ?? inner.signed ?? null,
    evidenceSource(source, `Phase 8 exact repeated-${node.op} proof`), {
      fromBits:sourceBits,
      phase8Proof:`repeated-${node.op}`,
    });
}

function inductionNames(analysis) {
  const facts = analysis?.get?.('induction');
  if (!facts || facts.completeness === 'unknown') return new Map();
  const candidates = [];
  for (const loop of facts.loops || []) {
    if (loop?.classification !== 'natural') continue;
    for (const fact of loop.inductions || []) {
      const valueId = Number(fact?.valueId);
      if (!Number.isSafeInteger(valueId) || fact?.step == null || fact?.stepReason != null) continue;
      if (!(fact?.origin?.instructionIds || []).length) continue;
      candidates.push({ valueId, header:Number(loop.header ?? 0) });
    }
  }
  candidates.sort((left, right) => left.header - right.header || left.valueId - right.valueId);
  const names = new Map();
  for (const item of candidates) if (!names.has(item.valueId)) names.set(item.valueId, `induction_${names.size}`);
  return names;
}

function provenValueId(node, names) {
  if (node?.kind !== 'var' || !/^(?:v|tmp|call_)\d+$/.test(String(node.name || ''))) return null;
  const source = sourceOf(node.source);
  const ids = [...new Set([...(source.ssaDefs || []), ...(source.ssaUses || [])]
    .map(Number).filter((id) => Number.isSafeInteger(id) && names.has(id)))];
  if (ids.length !== 1) return null;
  return ids[0];
}

function transformExpression(root, names, records, memo = new Map(), replacements = new Map(), tokenOf = () => null, proofOnly = false) {
  if (!root || memo.has(root)) return memo.get(root) ?? root;
  const replacement = replacements.get(root) ?? replacements.get(tokenOf(root));
  if (replacement) { memo.set(root,replacement); return replacement; }
  let mapped = mapChildren(root, (child) => transformExpression(child, names, records, memo, replacements, tokenOf, proofOnly));
  if (proofOnly) { memo.set(root,mapped); return mapped; }
  mapped = collapseExactNestedTruncation(mapped, records);
  mapped = collapseExactExtensionUnderTruncation(mapped, records);
  mapped = collapseExactRepeatedExtension(mapped, records);
  const valueId = provenValueId(mapped, names);
  if (valueId != null) {
    const name = names.get(valueId);
    const source = evidenceSource(mapped.source, `Phase 8 induction proof for SSA value ${valueId}`);
    mapped = { ...mapped, name, source, phase8Proof:'induction-variable', phase8ValueId:valueId };
    records.push(Object.freeze({
      kind:'induction-variable',
      valueId,
      name,
      proof:'upstream natural-loop induction fact has a proved fixed step',
      targets:Object.freeze(collectTargets(source, 'induction-variable')),
      origin:Object.freeze({
        addresses:Object.freeze([...(source.addresses || [])]),
        rows:Object.freeze([...(source.rows || [])]),
        ir:Object.freeze([...(source.ir || [])]),
        ssaDefs:Object.freeze([...(source.ssaDefs || [])]),
        ssaUses:Object.freeze([...(source.ssaUses || [])]),
      }),
    }));
  }
  memo.set(root, mapped);
  return mapped;
}

function replaceCondition(text, keyword, expression) {
  const source = String(text || '');
  const marker = `${keyword} (`;
  const at = source.indexOf(marker);
  if (at < 0) return { text:source, replaced:false };
  const open = at + keyword.length + 1;
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    const char = source[index];
    if (char === '(') depth += 1;
    else if (char === ')') {
      depth -= 1;
      if (depth === 0) return { text:`${source.slice(0, open + 1)}${expression}${source.slice(index)}`, replaced:true };
    }
  }
  return { text:source, replaced:false };
}

function conditionMap(semanticAst, transform) {
  const byRow = new Map();
  for (const condition of semanticAst?.conditions || []) {
    if (condition?.row == null || !condition.expression) continue;
    const expression = transform(condition.expression);
    const prior = byRow.get(Number(condition.row));
    if (prior) byRow.set(Number(condition.row), null);
    else byRow.set(Number(condition.row), expression);
    condition.expression = expression;
    condition.text = printExpression(expression);
  }
  return byRow;
}

function refreshMetrics(result, semanticAst, printed, records) {
  const expressionMetrics = (semanticAst?.values || []).map((item) => expressionReadability(item.expression));
  const text = printed.text;
  return {
    ...(result.metrics || {}),
    rawAssemblyFallbacks:(text.match(/__asm\(/g) || []).length,
    gotos:(text.match(/\bgoto\b/g) || []).length,
    temporaries:(text.match(/\b(?:v|tmp|call_)\d+\b/g) || []).length,
    redundantCasts:expressionMetrics.reduce((total, metric) => total + metric.casts, 0),
    sourceMappedNodes:printed.mapping.length,
    phase8ProjectionTransforms:records.length,
  };
}

// Render one shared computation only after both source values have crossed the
// existing solver admission boundary. GVN names/hashes and expression text are
// not equivalence authority. This initial adoption is local to one straight-line
// block and immutable entry inputs; it never removes canonical instructions.
function shareProvedScalars(result, bindings, consumers, records, shouldAbort) {
  const body = result.cAst.body;
  const ordered = result.ir.instructions ?? [];
  if (body.length > 4096 || bindings.size > 32 || ordered.length > PROJECTION_LIMITS.nodes) return;
  const instructions = new Map(ordered.map(inst => [inst.id, inst]));
  if (instructions.size !== ordered.length) return;
  const groups = [];
  let remaining = PROJECTION_LIMITS.edges;
  for (const [index, node] of body.entries()) {
    if (--remaining < 0 || shouldAbort?.()) return;
    const expression = node.semantic?.expression, binding = bindings.get(expression);
    const instruction = instructions.get(node.semantic?.ir), consumer = consumers[index];
    if (!binding?.entryInputs || !consumer?.isCurrent() || node.kind !== 'stmt'
      || !['store', 'return'].includes(node.semantic?.op) || instruction?.block == null
      || instruction.op !== (node.semantic.op === 'return' ? 'ret' : 'store') || expression?.signed !== false
      || node.semantic.op === 'store' && !node.semantic.location?.text
      || ![8, 16, 32, 64].includes(expression.bits) || ['var', 'const'].includes(expression.kind)) continue;
    const found = groups.find(group => group.block === instruction.block && group.indent === node.indent
      && sameProofExpression(group.binding.recipe, group.binding.inputs, binding.recipe, binding.inputs));
    const item = { index, node, expression, consumer, instruction };
    if (found) found.items.push(item);
    else groups.push({ block:instruction.block, indent:node.indent, binding, items:[item] });
  }
  const plans = [];
  let serial = 0;
  for (const group of groups) {
    if (--remaining < 0 || shouldAbort?.()) return;
    if (group.items.length < 2) continue;
    const first = group.items[0], last = group.items.at(-1);
    // No branch, label, scope change or unrelated statement is crossed. The
    // canonical instruction order must agree with the actual rendered order.
    if (last.index - first.index + 1 !== group.items.length
      || group.items.some((item, i) => i && result.ir.instructions.indexOf(item.instruction)
        <= result.ir.instructions.indexOf(group.items[i - 1].instruction))) continue;
    let name;
    do {
      if (--remaining < 0 || shouldAbort?.()) return;
      name = `hex_cse_${serial++}`;
    } while (body.some(node => new RegExp(`\\b${name}\\b`).test(node.text ?? '')));
    const source = mergeSource(...group.items.map(item => item.expression.source));
    const record = Object.freeze({ kind:'proved-scalar-cse',
      proof:'identical admitted solver recipes and immutable entry inputs in one straight-line rendered block',
      targets:Object.freeze(collectTargets(source, 'proved-scalar-cse')),
      origin:Object.freeze({ addresses:Object.freeze([...source.addresses]), rows:Object.freeze([...source.rows]),
        ir:Object.freeze([...source.ir]), ssaDefs:Object.freeze([...source.ssaDefs]), ssaUses:Object.freeze([...source.ssaUses]) }),
      name, useCount:group.items.length, canonicalInstructionsRetained:true });
    const expression = { ...first.expression, source };
    const node = { kind:'stmt', indent:group.indent,
      text:`uint${expression.bits}_t ${name} = ${printExpression(expression)};`, source,
      semantic:{ op:'cse-binding', name, expression } };
    const retained = [...new Set(group.items.flatMap(item => item.consumer.records))];
    const consumer = Object.freeze({ ir:result.ir, expression,
      records:Object.freeze([...retained, record]),
      isCurrent:() => group.items.every(item => item.consumer.isCurrent()) });
    plans.push({ group, name, source, record, node, consumer });
  }
  // All checks precede writes. The surrounding proof projection rechecks the
  // source/plan and cancellation before publication, including after printing.
  for (const plan of plans.sort((a, b) => b.group.items[0].index - a.group.items[0].index)) {
    const { group, name, source, record, node, consumer } = plan;
    for (const item of group.items) {
      item.node.semantic.expression = expr.variable(name, item.expression.bits, false, source);
      item.node.text = item.node.semantic.op === 'return' ? `return ${name};` : `${item.node.semantic.location.text} = ${name};`;
      consumers[item.index] = Object.freeze({ ...item.consumer,
        records:Object.freeze([...item.consumer.records, record]) });
    }
    body.splice(group.items[0].index, 0, node);
    consumers.splice(group.items[0].index, 0, consumer);
    bindings.set(node.semantic.expression, group.binding);
    records.push(record);
  }
}

function boundAnalysisIdentity(result, analysis, supplied) {
  const canonical = canonicalAnalysisIdentity({ ir:result.ir, analysis });
  if (supplied == null) return canonical;
  if (supplied?.valid !== true || !isValidatedAnalysisIdentity(supplied.identity)) return canonical;
  if (canonical?.valid !== true || !isValidatedAnalysisIdentity(canonical.identity)) return canonical;
  return analysisIdentityMatches(supplied.identity, canonical.identity) ? supplied : canonical;
}

/**
 * Final Phase 8 product cutover.
 *
 * This projection never mutates Semantic IR/SSA/MemorySSA. It consumes only
 * published Phase 8 facts and exact AST bit-width identities, then rebuilds the
 * high-level projection while retaining the union of the original source/evidence.
 * Refused or ambiguous facts remain unchanged.
 */
// The canonical fixed point authorizes discarding a dead result, never the
// observable CALL. Its RHS comes only from the actual initial emitter. Text
// scanning below is a rejection guard for residual rendered references, not
// positive liveness or expression authority.
function deadCallResultPlans(result, analysis, consumers, shouldAbort) {
  const body = result.cAst.body ?? [];
  if (body.length > 4096 || shouldAbort?.()) return [];
  const spellings = body.map(node => readCallResultSpellingProducer(node, result.ir));
  if (!spellings.some(Boolean)) return [];
  const proof = readDceResultProof(analysis, result.ir);
  if (!proof) return [];
  const dead = new Set(proof.facts.deadButObservable.map(row => row.valueId));
  const values = new Set(result.ir.values), instructions = new Set(result.ir.instructions);
  const plans = [];
  for (const [index, spelling] of spellings.entries()) {
    if (shouldAbort?.()) return [];
    if (!spelling || spelling.consumer !== consumers[index]) continue;
    const value = spelling.value, node = body[index];
    if (!dead.has(value.id) || !values.has(value) || !instructions.has(value.def)
        || value.def.op !== 'call' || value.def.dst !== value || node.kind !== 'stmt'
        || node.semantic?.op !== 'call-render' || node.semantic.ir !== value.def.id
        || !/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(spelling.name)
        || node.text !== `${spelling.name} = ${spelling.callText}`) continue;
    plans.push({ index, spelling, proof });
  }
  const mentions = new Map(plans.map(plan => [plan.spelling.name, 0]));
  let units = PROJECTION_LIMITS.expandedUnits, edges = PROJECTION_LIMITS.edges;
  for (const node of body) {
    if (shouldAbort?.() || typeof node.text !== 'string' || (units -= node.text.length) < 0) return [];
    for (const match of node.text.matchAll(/[A-Za-z_$][A-Za-z0-9_$]*/g)) {
      if (--edges < 0 || shouldAbort?.()) return [];
      if (mentions.has(match[0])) mentions.set(match[0], mentions.get(match[0]) + 1);
    }
  }
  return proof.isCurrent() ? plans.filter(plan => mentions.get(plan.spelling.name) === 1) : [];
}

export function applyPhase8Projection(result, analysis, opts = {}) {
  if (!result?.semantic || !result.semanticAst || !result.cAst || !analysis) return result;
  const original = result;
  const proofOnly = opts.phase8ProofOnlyRewrites === true || producerUsesProofOnlyRewrites(original);
  const inherited = readProjectionHistory(original);
  const historyReasons = new Set();
  const hasPriorHistory = projectionHistories.has(original.cAst) || original.phase8Projection != null;
  if (hasPriorHistory && !inherited) historyReasons.add('unavailable-prior-projection-history');
  if (original.phase8Projection?.history?.completeness === 'incomplete') historyReasons.add('upstream-projection-history-incomplete');
  // Capture before this owned projection transforms or clones the descriptors.
  // Recovery supplies its own observed transition; it does not inherit the
  // earlier consumer by source or expression similarity.
  const expressionConsumers = inherited ? [...inherited.expressions]
    : (result.cAst.body ?? []).map(node => hasPriorHistory ? null
      : readStackReturnHistoryConsumer(node?.semantic, result.ir)
        || readStackPhiHistoryConsumer(node?.semantic, result.ir)
        || readLegacyStackHistoryConsumer(node?.semantic, result.ir) || readExpressionHistoryConsumer(node?.semantic, result.ir));
  const storeSpellings = (result.cAst.body ?? []).map(node => hasPriorHistory ? null : readStoreSpellingProducer(node, result.ir));
  const controlSources = expressionConsumers.map(consumer => consumer
    ? controlConsumerSources.get(consumer) || readInitialControlConsumer(consumer) : null);
  const conditionBindings = inherited ? [...inherited.conditionConsumers]
    : (result.semanticAst.conditions ?? []).map(condition => hasPriorHistory ? null : readExpressionHistoryConsumer(condition, result.ir));
  const conditionConsumers = new Map();
  for (const [index, condition] of (result.semanticAst.conditions ?? []).entries()) {
    if (condition.row == null) continue;
    const row = Number(condition.row);
    conditionConsumers.set(row, conditionConsumers.has(row) ? null : conditionBindings[index]);
  }
  const renderedConditions = new Map();
  const proofRequested = opts.phase8RewritePlan != null;
  const proofContext = {ir:result.ir,opts};
  const provedInputs = proofRequested ? readProvedInputBindings(analysis,proofContext) : null;
  const proved = provedInputs?.artifact ?? null;
  const dcePlans = hasPriorHistory ? [] : deadCallResultPlans(result, analysis, expressionConsumers, opts.shouldAbort);
  const currentDce = () => !opts.shouldAbort?.() && (!dcePlans.length || dcePlans[0].proof.isCurrent())
    && dcePlans.every(plan => readCallResultSpellingProducer(original.cAst.body[plan.index], original.ir) === plan.spelling);
  if (proofRequested) {
    if (!isProducerProjection(original)) return original;
    if (!proved && opts.phase8RewritePlan.entries.length) return original;
  }
  if (proofRequested || dcePlans.length) {
    // The input projection remains intact on a late cancellation or refusal.
    result = {...result,semanticAst:{...result.semanticAst},cAst:{...result.cAst,
      body:(result.cAst.body ?? []).map(n=>({...n,semantic:n.semantic?{...n.semantic}:n.semantic}))}};
    for (const key of ['values','stores','outputs','conditions']) result.semanticAst[key] =
      (original.semanticAst[key] ?? []).map(item=>({...item}));
  }
  const records = [], replacements = new Map(), memo = new Map(), proofExpressions = new Map(), proofRecords = new Map();
  if (proved) {
    const selectedReplacements = new Map();
    const inputValues = [...new Set(provedInputs.bindings.flatMap(input => input.binding.inputs.map(input => input.value)))];
    const renderedInputs = readProducerInputExpressions(original, inputValues);
    if (!renderedInputs) return original;
    const inputExpressions = new Map(renderedInputs.map(input => [input.value, input.expression]));
    const byId = new Map();
    for (const item of result.semanticAst.values ?? []) {
      byId.set(item.valueId,byId.has(item.valueId)?null:item);
    }
    for (const entry of proved.entries) {
      const inputBinding = provedInputs.bindings.find(input => input.entry === entry)?.binding;
      if (!inputBinding || inputBinding.inputs.some(input => inputExpressions.get(input.value)?.bits !== input.bits)) return original;
      const item = byId.get(entry.rawValueId), root = item?.expression;
      if (!root || root.bits !== entry.bits || root.effect !== 'pure') continue;
      if (entry.kind === 'solver-constant' && root.kind === 'const' && root.value === entry.value) continue;
      const canonicalSource = provedSliceSource(root.source,inputBinding,opts.shouldAbort);
      if (!canonicalSource) return original;
      const source = evidenceSource(canonicalSource,`Phase 8 solver proof ${entry.queryHash}`);
      const inputs = inputBinding.inputs.map(input => inputExpressions.get(input.value));
      const token = producerExpressionToken(original,root);
      if (token == null) continue;
      // Shared observed roots must agree before replay/no-op handling too.
      const selected = selectedReplacements.get(token);
      if (selected && !sameProofExpression(selected.recipe,selected.inputs,entry.projection,inputs)) return original;
      selectedReplacements.set(token,{recipe:entry.projection,inputs});
      const prior = inherited?.proofExpressions?.get(root);
      if (prior && sameProofExpression(prior.recipe,prior.inputs,entry.projection,inputs)) {
        // Keep an actually published expression and its private recipe on replay;
        // public proof IDs/text cannot manufacture this idempotence relation.
        replacements.set(token,root); proofExpressions.set(root,prior); continue;
      }
      const recipeRoot = entry.projection.nodes[entry.projection.root];
      if (recipeRoot.kind === 'fresh_symbol' && root === inputs[recipeRoot.input]) continue;
      let replacement = renderProofExpression(entry.projection,inputs,opts.shouldAbort);
      if (!replacement || replacement.bits !== entry.bits || replacement.effect !== 'pure') return original;
      replacement = {...replacement,source:mergeSource(replacement.source,source)};
      const previous = replacements.get(token);
      if (previous) replacement = {...replacement,source:mergeSource(previous.source,replacement.source)};
      if (entry.kind === 'solver-constant') replacement.signed = root.signed;
      replacements.set(token,replacement);
      proofExpressions.set(replacement,{recipe:entry.projection,inputs:Object.freeze(inputs),
        entryInputs:inputBinding.inputs.every(input => input.value.kind === 'arg' && input.value.def == null)
          && inputs.every(input => input.kind === 'var')});
      const record = Object.freeze({kind:entry.kind,valueId:entry.valueId,
        proof:'canonical eligible solver equivalence proof',targets:Object.freeze(collectTargets(source,entry.kind)),
        queryHash:entry.queryHash,planId:proved.planId,beforeHash:entry.beforeHash,afterHash:entry.afterHash,
        ...(entry.generatorAudit ? {generatorAudit:entry.generatorAudit} : {}),
        origin:Object.freeze({addresses:Object.freeze([...source.addresses]),rows:Object.freeze([...source.rows]),
          ir:Object.freeze([...source.ir]),ssaDefs:Object.freeze([...source.ssaDefs]),ssaUses:Object.freeze([...source.ssaUses])})});
      records.push(record);
      proofRecords.set(token,[...(proofRecords.get(token) ?? []),record]);
    }
  }
  // A before-source union is not a rendered consumer edge. Bind solver records
  // to owned expressions containing the actual replaced token, not to another
  // statement that merely shares an input. Retain this relation through replay.
  let proofConsumerEdges = PROJECTION_LIMITS.edges;
  const boundConsumers = new Map();
  const bindProofConsumer = (consumer, expression = null) => {
    if (!proofRecords.size) return consumer;
    const priorConsumer = consumer;
    // A deferred ordinary rewrite has no history consumer yet. Its actual C
    // node is still owned by the existing prepared producer. Use that same
    // private observer, not a source-shaped substitute, for the first proof.
    if (!consumer && expression && producerExpressionToken(original,expression) != null) {
      consumer = Object.freeze({ir:original.ir,expression,records:Object.freeze([]),
        isCurrent:() => isProducerProjection(original)});
    }
    if (!consumer) return null;
    if (boundConsumers.has(consumer)) return boundConsumers.get(consumer);
    const found = new Set(), seen = new Set(), pending = [consumer.expression];
    while (pending.length) {
      if (--proofConsumerEdges < 0 || opts.shouldAbort?.()) { historyReasons.add('proof-consumer-binding-budget'); return consumer; }
      const node = pending.pop(); if (!node || seen.has(node)) continue; seen.add(node);
      const token = producerExpressionToken(original,node);
      for (const record of proofRecords.get(token) ?? []) found.add(record);
      // Match transformExpression: an outer replacement wins before visiting
      // its children. Inner proofs may change their own semantic value view,
      // but must not claim this line when that output was never consumed here.
      if (!replacements.has(token)) pending.push(...children(node));
    }
    const bound = found.size ? Object.freeze({...consumer,records:Object.freeze([...new Set([...consumer.records,...found])])}) : priorConsumer;
    const control = controlConsumerSources.get(consumer) || readInitialControlConsumer(consumer);
    if (control) controlConsumerSources.set(bound,control);
    boundConsumers.set(consumer,bound);
    return bound;
  };
  for (let index = 0; index < expressionConsumers.length; index++) {
    const prior = expressionConsumers[index];
    const next = bindProofConsumer(prior,original.cAst.body[index]?.semantic?.expression);
    expressionConsumers[index] = next;
    // Adding an owned proof record changes the consumer wrapper, not the
    // observed store emitter. Carry only the already validated exact pair
    // through this private transition; source/text similarity is insufficient.
    const spelling = storeSpellings[index];
    if (prior && next && next !== prior && spelling?.consumer === prior) {
      storeSpellings[index] = Object.freeze({...spelling,consumer:next});
    }
  }
  for (let index = 0; index < conditionBindings.length; index++) conditionBindings[index] = bindProofConsumer(
    conditionBindings[index],original.semanticAst.conditions[index]?.expression);
  conditionConsumers.clear();
  for (const [index,condition] of (original.semanticAst.conditions ?? []).entries()) {
    if (condition.row == null) continue;
    const row = Number(condition.row);
    conditionConsumers.set(row,conditionConsumers.has(row) ? null : conditionBindings[index]);
  }
  const names = inductionNames(analysis);
  const transform = (expression) => transformExpression(expression, names, records, memo, replacements, node=>producerExpressionToken(original,node), proofOnly);

  for (const item of result.semanticAst.values || []) item.expression = transform(item.expression);
  for (const item of result.semanticAst.stores || []) if (item.expression) item.expression = transform(item.expression);
  for (const item of result.semanticAst.outputs || []) if (item.expression) item.expression = transform(item.expression);
  const conditions = conditionMap(result.semanticAst, transform);

  const spellingRecords = [], controlRecords = [], dceRecords = [];
  const spellingLimit = Number.isSafeInteger(opts.renderProvenanceBudget?.maxTransformRecords)
    && opts.renderProvenanceBudget.maxTransformRecords >= 0 ? Math.min(opts.renderProvenanceBudget.maxTransformRecords, 1024) : 1024;
  let controlHandoffEdges = Number.isSafeInteger(opts.renderProvenanceBindingBudget?.maxEdges)
    ? Math.max(0, Math.min(PROJECTION_LIMITS.edges, opts.renderProvenanceBindingBudget.maxEdges)) : PROJECTION_LIMITS.edges;
  const dceByIndex = new Map(dcePlans.map(plan => [plan.index, plan]));
  for (const [index, node] of (result.cAst.body || []).entries()) {
    const dce = dceByIndex.get(index);
    if (dce) {
      // Whole-batch observations are rechecked before publication. Do not
      // rewalk every other call's history for each isolated text write.
      if ((result.rewriteProof?.length || 0) + dceRecords.length >= spellingLimit || opts.shouldAbort?.()) return original;
      const source = sourceOf(node.source), consumer = expressionConsumers[index];
      const record = Object.freeze({ rule:'eliminate-dead-call-result', phase:'phase8-render', valueId:dce.spelling.value.id,
        before:'call:result-assignment', after:'call:discarded-result',
        evidence:Object.freeze({ kind:'canonical-dce-dead-result-call-retained',
          detail:'committed fixed-point liveness; only the result binding is removed, with the exact observable call retained' }),
        originHistory:expressionOriginHistory({ source }, { source }),
        renderedRemoval:Object.freeze({ scope:'pre-transform-render', operation:'remove', lineIndex:index, kind:node.kind }),
      });
      node.text = dce.spelling.callText;
      dceRecords.push(record);
      expressionConsumers[index] = Object.freeze({ ...consumer, records:Object.freeze([...consumer.records, record]),
        isCurrent:() => consumer.isCurrent() && dce.proof.isCurrent() });
    }
    if (node?.semantic?.expression) {
      const retainedBinding = node.semantic.op === 'cse-binding' && inherited?.proofExpressions.get(node.semantic.expression);
      if (retainedBinding) {
        memo.set(node.semantic.expression, node.semantic.expression);
        proofExpressions.set(node.semantic.expression, retainedBinding);
      } else node.semantic.expression = transform(node.semantic.expression);
      if (node.semantic.op === 'return') node.text = `return ${printExpression(node.semantic.expression)};`;
      else if (node.semantic.op === 'cse-binding') node.text = `uint${node.semantic.expression.bits}_t ${node.semantic.name} = ${printExpression(node.semantic.expression)};`;
      else if (node.semantic.op === 'store' && node.semantic.location?.text) {
        const text = `${node.semantic.location.text} = ${printExpression(node.semantic.expression)};`;
        const spelling = storeSpellings[index], consumer = expressionConsumers[index];
        if (!hasPriorHistory && !spelling && consumer?.records.some(record => record.rule === 'render-compound-store')) {
          historyReasons.add('unavailable-store-spelling-producer');
        }
        if (spelling && (spelling.consumer !== consumer || spelling.text !== node.text)) historyReasons.add('stale-store-spelling-producer');
        if (spelling && spelling.consumer === consumer && spelling.text === node.text && node.text !== text) {
          if ((result.rewriteProof?.length || 0) + spellingRecords.length >= spellingLimit) historyReasons.add('store-spelling-history-budget');
          else {
            const source = mergeSource(node.source, consumer.expression?.source, node.semantic.expression.source);
            const record = Object.freeze({ rule:'expand-projected-store-spelling', phase:'phase8-render', valueId:spelling.valueId,
              before:`store:${spelling.form}`, after:'store:assignment',
              evidence:Object.freeze({ kind:'observed-store-spelling-not-memory-equivalence',
                detail:'actual owned C AST to projected assignment transition; no memory equivalence proof' }),
              originHistory:expressionOriginHistory({ source }, { source }),
            });
            spellingRecords.push(record);
            expressionConsumers[index] = Object.freeze({ ...consumer, records:Object.freeze([...consumer.records, record]) });
          }
        }
        node.text = text;
      }
    }
    const rows = sourceOf(node.source).rows.map(Number);
    const candidates = [...new Set(rows.map((row) => conditions.get(row)).filter(Boolean))];
    if (candidates.length === 1) {
      const expression = printExpression(candidates[0]);
      const keyword = String(node.text || '').includes('if (') ? 'if' : String(node.text || '').includes('while (') ? 'while' : null;
      if (keyword) {
        const beforeText = node.text, control = controlSources[index];
        let priorControl = null;
        if (control && expressionConsumers[index]?.isCurrent()) {
          try {
            if (controlHandoffEdges <= 0) throw new Error('initial-control-handoff-budget');
            const captured = captureProjectionIrData([node]);
            controlHandoffEdges -= captured.metrics.edges;
            if (controlHandoffEdges < 0) throw new Error('initial-control-handoff-budget');
            priorControl = captured;
          }
          catch { historyReasons.add('initial-control-handoff-unavailable'); }
        }
        const replacement = replaceCondition(node.text, keyword, expression);
        // Only a condition actually printed by this owned replacement can
        // supply a rendered edge. Ambiguous source rows remain unbound.
        const consumers = [...new Set(rows.map(row => conditionConsumers.get(row)).filter(Boolean))];
        if (replacement.replaced && consumers.length === 1) renderedConditions.set(node, consumers[0]);
        node.text = replacement.text;
        if (replacement.replaced && priorControl) {
          // This exact owned text write is the only permitted difference.
          // Keep the original emitter/IR check, refresh the output observation,
          // and never accumulate a chain of old output snapshots on replay.
          const writes = Object.freeze([Object.freeze({ object:node, key:'text', before:beforeText, after:replacement.text })]);
          try {
            const output = captureProjectionIrData([node], opts.shouldAbort);
            controlHandoffEdges -= output.metrics.edges;
            if (controlHandoffEdges < 0 || !priorControl.matchesThroughWrites(writes)
                || !control.isCurrent() || !output.matches()) throw new Error('initial-control-handoff-unavailable');
            const retained = expressionConsumers[index].records;
            let record = null;
            if (beforeText !== replacement.text) {
              if ((result.rewriteProof?.length || 0) + spellingRecords.length + controlRecords.length >= spellingLimit) throw new Error('initial-control-handoff-budget');
              const source = mergeSource(node.source, candidates[0].source);
              record = Object.freeze({ rule:'replace-initial-control-condition', phase:'phase8-render',
                before:`control:${keyword}:initial-condition`, after:`control:${keyword}:canonical-condition`,
                evidence:Object.freeze({ kind:'observed-control-render-not-cfg-equivalence', detail:'actual owned condition spelling replacement; not a new CFG/flag equivalence proof' }),
                originHistory:expressionOriginHistory({ source }, { source }),
              });
              controlRecords.push(record);
            }
            const next = Object.freeze({ ...expressionConsumers[index], records:record ? Object.freeze([...retained, record]) : retained,
              isCurrent:() => control.isCurrent() && priorControl.matchesThroughWrites(writes) && output.matches() });
            expressionConsumers[index] = next; controlConsumerSources.set(next, control);
          } catch { historyReasons.add('initial-control-handoff-unavailable'); }
        }
      }
    }
  }

  if (spellingRecords.length || controlRecords.length || dceRecords.length) result = { ...result, rewriteProof:[...(result.rewriteProof || []), ...spellingRecords, ...controlRecords, ...dceRecords] };

  if (proved && (!hasPriorHistory || inherited)) shareProvedScalars(result, proofExpressions, expressionConsumers, records, opts.shouldAbort);

  if (dceRecords.length && !currentDce()) return original;
  if (proofRequested && (opts.shouldAbort?.() || !isProducerProjection(original) || proved && !readProvedRewrites(analysis,proofContext))) return original;
  const printed = printProgram(result.cAst, { columnWidth:opts.columnWidth || opts.prettyColumnWidth || 88 });
  const lines = (result.cAst.body || []).map((node, index) => {
    // HEX-C4-03: a rendered line is produced by its own node location AND by
    // the rewritten semantic expression that now renders into it. The merged
    // expression source carries the union of every consumed origin across the
    // rewrite chain, which is exactly what reverse navigation must reach.
    const expressionSource = node?.semantic?.expression
      ? sourceOf(node.semantic.expression.source)
      : null;
    const conditionSource = (() => {
      const rows = sourceOf(node.source).rows.map(Number);
      const candidates = [...new Set(rows.map((row) => conditions.get(row)).filter(Boolean))];
      return candidates.length === 1 ? sourceOf(candidates[0].source) : null;
    })();
    const sources = [node?.source, expressionSource, conditionSource].filter(Boolean);
    const source = sources.length === 1 ? sources[0] : mergeSource(...sources);
    const line = {
      kind:node.kind,
      indent:node.indent,
      text:node.text,
      row:source.rows?.[0] ?? null,
      addr:source.addresses?.[0] ?? null,
      note:null,
      source,
    };
    const consumers = [expressionConsumers[index], renderedConditions.get(node)].filter(Boolean);
    if (consumers.length && consumers.every(consumer => consumer.isCurrent())) {
      try {
        const observation = captureProjectionIrData([line], opts.shouldAbort);
        const records = Object.freeze([...new Set(consumers.flatMap(consumer => consumer.records))]);
        lineExpressionHistories.set(line, { ir:result.ir, consumers, records, observation });
      } catch { /* No inferred edge when the bounded observation is unavailable. */ }
    }
    return line;
  });
  if (proofRequested && (opts.shouldAbort?.() || !isProducerProjection(original) || proved && !readProvedRewrites(analysis,proofContext))) return original;
  const retainedRecords = Object.freeze([...(inherited?.records ?? []), ...records]);
  for (const [expression,binding] of inherited?.proofExpressions ?? []) {
    if (memo.get(expression) === expression) proofExpressions.set(expression,binding);
  }
  const pendingHistory = prepareProjectionHistory(result, expressionConsumers, conditionBindings,
    retainedRecords, opts, historyReasons, proofExpressions);
  const adoptedCse = records.some(record => record.kind === 'proved-scalar-cse');
  const requiresCompleteHistory = adoptedCse || dceRecords.length > 0;
  if (requiresCompleteHistory && (!pendingHistory || historyReasons.size)) return original;
  const withLines = {
    ...result,
    lines,
    pseudocode:printed.text,
    sourceMap:printed.mapping,
    metrics:refreshMetrics(result, result.semanticAst, printed, records),
    phase8Projection:Object.freeze({
      version:PHASE8_PROJECTION_VERSION,
      transformCount:records.length,
      transforms:Object.freeze(records),
      inductionNames:Object.freeze(Object.fromEntries(names)),
      history:Object.freeze({ completeness:historyReasons.size ? 'incomplete' : 'complete',
        reasons:Object.freeze([...historyReasons]), transformCount:retainedRecords.length, transforms:retainedRecords }),
    }),
  };
  // HEX-C4-03: bidirectional render provenance. Caller-supplied identity may
  // only be used when it is a validated wrapper that exactly matches the
  // canonical identity derived from the current Semantic IR. Stale/plain
  // overrides fall back to the canonical result instead of minting snapshot
  // authority for a different IR.
  const resolvedIdentity = boundAnalysisIdentity(result, analysis, opts.analysisIdentity);
  let renderProvenance = buildRenderProvenance({
    result:withLines,
    snapshotId:resolvedIdentity?.identity?.snapshotId ?? null,
    budget:opts.renderProvenanceBudget,
    shouldAbort:opts.shouldAbort,
  });
  if (requiresCompleteHistory && renderProvenance.completeness !== 'complete') return original;
  if (dceRecords.length && !currentDce()) return original;
  if (proofRequested && (opts.shouldAbort?.() || !isProducerProjection(original) || proved && !readProvedRewrites(analysis,proofContext))) return original;
  const cancelled = opts.shouldAbort?.() === true;
  const stillCurrent = pendingHistory && pendingHistory.observation.matches()
    && pendingHistory.consumers.every(consumer => consumer.isCurrent());
  if (requiresCompleteHistory && (cancelled || !stillCurrent)) return original;
  if (cancelled) {
    if (proofRequested) return original;
    renderProvenance = buildRenderProvenance({ result:withLines, budget:opts.renderProvenanceBudget, shouldAbort:() => true });
  } else if (pendingHistory && !stillCurrent) {
    renderProvenance = Object.freeze({ ...renderProvenance, completeness:'incomplete',
      reasons:Object.freeze([...new Set([...renderProvenance.reasons, 'stale-projection-history'])]) });
  } else if (stillCurrent) {
    projectionHistories.set(result.cAst, { ...pendingHistory, projection:withLines.phase8Projection });
  }
  return {
    ...withLines,
    renderProvenance,
  };
}
