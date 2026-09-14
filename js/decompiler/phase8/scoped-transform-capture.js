/** Bounded snapshots from the ACTUAL before/after Phase8 projection. This
 * producer proposes relations; the independent proof checker does not run here.
 */
import { deepFreeze, stableDigest, stableStringify, lossyTypeWitness } from '../../core/identity/index.js';
import { snapshotContractData } from '../../core/identity/structured.js';
export const SCOPED_TRANSFORM_CAPTURE_SCHEMA = 'phase8-transform-capture/v1';
const MAX_STATEMENTS = 128;
const typed = value => stableStringify([value, lossyTypeWitness(value)]);
const copy = value => snapshotContractData(value, { allowBigInt: true, maxNodes: 4096, maxBytes: 262144 });
function slots(result) {
  if ((result.semanticAst?.conditions?.length ?? 0) > 2048) throw new TypeError('condition-capture-budget');
  const conditions = new Map();
  for (const condition of result.semanticAst?.conditions ?? []) {
    if (condition?.row == null || !condition.expression) continue;
    const key = Number(condition.row);
    conditions.set(key, conditions.has(key) ? null : condition.expression);
  }
  return (result.cAst?.body ?? []).slice(0, MAX_STATEMENTS).map((node, index) => {
    const source = copy(node.source ?? {}), rows = (source.rows ?? []).map(Number);
    const conditional = /(?:^|\s)(?:if|while)\s*\(/.test(String(node.text ?? ''));
    const candidates = conditional ? [...new Set(rows.map(row => conditions.get(row)).filter(Boolean))] : [];
    const ambiguous = conditional && (candidates.length > 1 || rows.some(row => conditions.has(row) && conditions.get(row) === null));
    const expression = node.semantic?.expression ?? (!ambiguous && candidates.length === 1 ? candidates[0] : null);
    return { index, statementKind: node.semantic?.op ?? node.kind, text: node.text,
      expression: expression ? copy(expression) : null, source,
      location: node.semantic?.location == null ? null : copy(node.semantic.location),
      conditionAmbiguous: !node.semantic?.expression && ambiguous };
  });
}
export function beginScopedTransformCapture(result, enabled) {
  if (enabled !== true) return null;
  try { return { before: slots(result), statementCount: result.cAst?.body?.length ?? 0 }; }
  catch (error) { return { reason: `capture-incomplete:${error.message}` }; }
}
export function finishScopedTransformCapture(start, result) {
  if (!start) return null;
  const base = { schema: SCOPED_TRANSFORM_CAPTURE_SCHEMA, ruleVersion: '1.1.0',
    scope: 'phase8-expression-view-only', proofStatus: 'not-checked', exact: false };
  if (start.reason) return deepFreeze({ ...base, relations: [], remaining: [start.reason] });
  try {
    const after = slots(result), remaining = [], relations = [];
    if (start.statementCount > MAX_STATEMENTS) remaining.push('statement-capture-truncated');
    if ((result.cAst?.body?.length ?? 0) !== start.statementCount) remaining.push('statement-membership-changed');
    for (let i = 0; i < Math.min(start.before.length, after.length); i++) {
      const before = start.before[i], next = after[i];
      if (before.conditionAmbiguous || next.conditionAmbiguous) { remaining.push('condition-mapping-ambiguous'); continue; }
      if (!before.expression || !next.expression) {
        if (before.text !== next.text) remaining.push('unmapped-statement-change');
        continue;
      }
      if (typed(before.expression) === typed(next.expression) && before.text === next.text) continue;
      relations.push({ before: before.expression, after: next.expression,
        beforeStatement: before, afterStatement: next,
        statementId: `phase8-statement:${i}`, statementIndex: i,
        mapping: 'actual-final-statement-index-and-source; rendering-equivalence-unproved' });
    }
    const body = { ...base, relations, finalExpressionStatements: after, remaining: [...new Set(remaining)], statementCount: start.statementCount,
      renderedDigest: stableDigest({ lines: result.lines, typed: lossyTypeWitness(result.lines) }) };
    // Total cap, not just a per-expression cap. Incomplete capture is explicit.
    return deepFreeze(snapshotContractData(body, { allowBigInt: true, maxNodes: 65536, maxBytes: 4194304 }));
  } catch (error) { return deepFreeze({ ...base, relations: [], remaining: [`capture-incomplete:${error.message}`] }); }
}
