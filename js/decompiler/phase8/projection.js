import { expr, mapChildren, mergeSource, sourceOf } from '../ast/nodes.js';
import { expressionReadability, printExpression, printProgram } from '../pretty/c.js';
import {
  analysisIdentityMatches,
  canonicalAnalysisIdentity,
  isValidatedAnalysisIdentity,
} from './analysis-identity.js';
import { buildRenderProvenance } from './render-provenance.js';

function integer(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
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
    removedRefs:Object.freeze([]),
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

function transformExpression(root, names, records, memo = new Map()) {
  if (!root || memo.has(root)) return memo.get(root) ?? root;
  let mapped = mapChildren(root, (child) => transformExpression(child, names, records, memo));
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
      removedRefs:Object.freeze([]),
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
  if (at < 0) return source;
  const open = at + keyword.length + 1;
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    const char = source[index];
    if (char === '(') depth += 1;
    else if (char === ')') {
      depth -= 1;
      if (depth === 0) return `${source.slice(0, open + 1)}${expression}${source.slice(index)}`;
    }
  }
  return source;
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

function resolveRenderAnalysisIdentity(result, analysis, override) {
  const canonical = canonicalAnalysisIdentity({ ir:result.ir, analysis });
  if (!canonical?.valid || !isValidatedAnalysisIdentity(canonical.identity)) return canonical;
  if (!override || typeof override !== 'object' || Array.isArray(override)) return canonical;
  if (override.valid !== true || !isValidatedAnalysisIdentity(override.identity)) return canonical;
  if (!analysisIdentityMatches(override.identity, canonical.identity)) return canonical;
  return override;
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
  const records = [];
  const names = inductionNames(analysis);
  const transform = (expression) => transformExpression(expression, names, records);

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
      if (String(node.text || '').includes('if (')) node.text = replaceCondition(node.text, 'if', expression);
      else if (String(node.text || '').includes('while (')) node.text = replaceCondition(node.text, 'while', expression);
    }
  }

  const printed = printProgram(result.cAst, { columnWidth:opts.columnWidth || opts.prettyColumnWidth || 88 });
  const lines = (result.cAst.body || []).map((node) => {
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
    return {
      kind:node.kind,
      indent:node.indent,
      text:node.text,
      row:source.rows?.[0] ?? null,
      addr:source.addresses?.[0] ?? null,
      note:null,
      source,
    };
  });
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
    }),
  };
  // HEX-C4-03: bind the map to the canonical current Semantic IR identity.
  // Caller-supplied identity is only an optimization hint: it must be a
  // validated wrapper and exactly match the identity recomputed from this IR.
  // Plain, stale, or malformed overrides fall back to the canonical result.
  const resolvedIdentity = resolveRenderAnalysisIdentity(result, analysis, opts.analysisIdentity);
  const renderProvenance = buildRenderProvenance({
    result:withLines,
    snapshotId:resolvedIdentity?.identity?.snapshotId ?? null,
    budget:opts.renderProvenanceBudget,
    shouldAbort:opts.shouldAbort,
  });
  return {
    ...withLines,
    renderProvenance,
  };
}
