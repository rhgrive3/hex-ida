import { isProducerProjection, producerExpressionToken } from '../pipeline.js';
import { readExpressionHistoryConsumer } from '../pipeline-core.js';
import { captureProjectionIrData, PROJECTION_LIMITS } from './projection-origin.js';
import { expr, mapChildren, mergeSource, sourceOf } from '../ast/nodes.js';
import { expressionReadability, printExpression, printProgram } from '../pretty/c.js';
import { readProvedRewrites } from './pass-validation.js';
import {
  analysisIdentityMatches,
  canonicalAnalysisIdentity,
  isValidatedAnalysisIdentity,
} from './analysis-identity.js';
import { buildRenderProvenance } from './render-provenance.js';

const lineExpressionHistories = new WeakMap();
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

function prepareProjectionHistory(result, expressions, conditions, records, opts, reasons) {
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
      consumers:Object.freeze(consumers), records, observation };
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

function transformExpression(root, names, records, memo = new Map(), replacements = new Map(), tokenOf = () => null) {
  if (!root || memo.has(root)) return memo.get(root) ?? root;
  const replacement = replacements.get(root) ?? replacements.get(tokenOf(root));
  if (replacement) { memo.set(root,replacement); return replacement; }
  let mapped = mapChildren(root, (child) => transformExpression(child, names, records, memo, replacements, tokenOf));
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
export function applyPhase8Projection(result, analysis, opts = {}) {
  if (!result?.semantic || !result.semanticAst || !result.cAst || !analysis) return result;
  const original = result;
  const inherited = readProjectionHistory(original);
  const historyReasons = new Set();
  const hasPriorHistory = projectionHistories.has(original.cAst) || original.phase8Projection != null;
  if (hasPriorHistory && !inherited) historyReasons.add('unavailable-prior-projection-history');
  if (original.phase8Projection?.history?.completeness === 'incomplete') historyReasons.add('upstream-projection-history-incomplete');
  // Capture before this owned projection transforms or clones the descriptors.
  // A stack/return recovery that replaced the earlier expression has already
  // invalidated that consumer and is deliberately not rebound by similarity.
  const expressionConsumers = inherited ? [...inherited.expressions]
    : (result.cAst.body ?? []).map(node => hasPriorHistory ? null : readExpressionHistoryConsumer(node?.semantic, result.ir));
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
  const proved = proofRequested ? readProvedRewrites(analysis,proofContext) : null;
  if (proofRequested) {
    if (!isProducerProjection(original)) return original;
    if (!proved && opts.phase8RewritePlan.entries.length) return original;
    // The input projection remains intact on a late cancellation or refusal.
    result = {...result,semanticAst:{...result.semanticAst},cAst:{...result.cAst,
      body:(result.cAst.body ?? []).map(n=>({...n,semantic:n.semantic?{...n.semantic}:n.semantic}))}};
    for (const key of ['values','stores','outputs','conditions']) result.semanticAst[key] =
      (original.semanticAst[key] ?? []).map(item=>({...item}));
  }
  const records = [], replacements = new Map(), memo = new Map();
  if (proved) {
    const byId = new Map();
    for (const item of result.semanticAst.values ?? []) {
      byId.set(item.valueId,byId.has(item.valueId)?null:item);
    }
    for (const entry of proved.entries) {
      const item = byId.get(entry.rawValueId), root = item?.expression;
      if (!root || root.bits !== entry.bits || root.effect !== 'pure') continue;
      if (root.kind === 'const' && root.value === entry.value) continue;
      const source = evidenceSource(root.source,`Phase 8 solver proof ${entry.queryHash}`);
      let replacement = expr.constant(entry.value,entry.bits,root.signed,source);
      const token = producerExpressionToken(original,root);
      if (token == null) continue;
      const previous = replacements.get(token);
      if (previous && (previous.bits !== replacement.bits || previous.value !== replacement.value)) return original;
      if (previous) replacement = expr.constant(entry.value,entry.bits,root.signed,mergeSource(previous.source,source));
      replacements.set(token,replacement);
      records.push(Object.freeze({kind:'solver-constant',valueId:entry.valueId,
        proof:'canonical eligible solver equivalence proof',targets:Object.freeze(collectTargets(source,'solver-constant')),
        queryHash:entry.queryHash,planId:proved.planId,beforeHash:entry.beforeHash,afterHash:entry.afterHash,
        origin:Object.freeze({addresses:Object.freeze([...source.addresses]),rows:Object.freeze([...source.rows]),
          ir:Object.freeze([...source.ir]),ssaDefs:Object.freeze([...source.ssaDefs]),ssaUses:Object.freeze([...source.ssaUses])})}));
    }
  }
  const names = inductionNames(analysis);
  const transform = (expression) => transformExpression(expression, names, records, memo, replacements, node=>producerExpressionToken(original,node));

  for (const item of result.semanticAst.values || []) item.expression = transform(item.expression);
  for (const item of result.semanticAst.stores || []) if (item.expression) item.expression = transform(item.expression);
  for (const item of result.semanticAst.outputs || []) if (item.expression) item.expression = transform(item.expression);
  const conditions = conditionMap(result.semanticAst, transform);

  for (const node of result.cAst.body || []) {
    if (node?.semantic?.expression) {
      node.semantic.expression = transform(node.semantic.expression);
      if (node.semantic.op === 'return') node.text = `return ${printExpression(node.semantic.expression)};`;
      else if (node.semantic.op === 'store' && node.semantic.location?.text) {
        node.text = `${node.semantic.location.text} = ${printExpression(node.semantic.expression)};`;
      }
    }
    const rows = sourceOf(node.source).rows.map(Number);
    const candidates = [...new Set(rows.map((row) => conditions.get(row)).filter(Boolean))];
    if (candidates.length === 1) {
      const expression = printExpression(candidates[0]);
      const keyword = String(node.text || '').includes('if (') ? 'if' : String(node.text || '').includes('while (') ? 'while' : null;
      if (keyword) {
        const replacement = replaceCondition(node.text, keyword, expression);
        // Only a condition actually printed by this owned replacement can
        // supply a rendered edge. Ambiguous source rows remain unbound.
        const consumers = [...new Set(rows.map(row => conditionConsumers.get(row)).filter(Boolean))];
        if (replacement.replaced && consumers.length === 1) renderedConditions.set(node, consumers[0]);
        node.text = replacement.text;
      }
    }
  }

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
  const pendingHistory = prepareProjectionHistory(result, expressionConsumers, conditionBindings,
    retainedRecords, opts, historyReasons);
  const withLines = {
    ...result,
    lines,
    pseudocode:printed.text,
    sourceMap:printed.mapping,
    metrics:refreshMetrics(result, result.semanticAst, printed, records),
    phase8Projection:Object.freeze({
      version:1,
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
  if (proofRequested && (opts.shouldAbort?.() || !isProducerProjection(original) || proved && !readProvedRewrites(analysis,proofContext))) return original;
  const cancelled = opts.shouldAbort?.() === true;
  const stillCurrent = pendingHistory && pendingHistory.observation.matches()
    && pendingHistory.consumers.every(consumer => consumer.isCurrent());
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
