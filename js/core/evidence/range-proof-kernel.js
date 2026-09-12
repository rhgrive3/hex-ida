/** Small typed composition kernel. A premise is usable only after canonical
 * replay verified it in the same world; serialized statuses are never read. */
import { snapshotContractData, recordFields, exactString, contractFail } from '../identity/structured.js';
import { stableStringify } from '../identity/index.js';
import { assertScopedAnalysisWork } from '../budgets/scoped-work.js';
import { INTEGER_FRAGMENT_KIND, INTEGER_FRAGMENT_DOMAIN } from './arm64-integer-fragment.js';

export const RANGE_PROOF_KIND = 'scpa-typed-range-derivation';
export const RANGE_PROOF_SCHEMA = 'scpa-typed-range-rule/v1';
export const RANGE_PROOF_VERSION = '1.0.0';
const same = (a, b) => stableStringify(a) === stableStringify(b);
function range(value) {
  recordFields(value, ['kind', 'subject', 'bits', 'lower', 'upper'], 'range-proof-conclusion-fields');
  if (value.kind !== 'unsigned-range' || ![32, 64].includes(value.bits)) contractFail('range-proof-conclusion-kind');
  exactString(value.subject, 'range-proof-subject');
  for (const key of ['lower', 'upper']) if (typeof value[key] !== 'string' || !/^(0|[1-9][0-9]{0,19})$/.test(value[key])) contractFail('range-proof-bound');
  const lower = BigInt(value.lower), upper = BigInt(value.upper);
  if (lower > upper || upper >= 1n << BigInt(value.bits)) contractFail('range-proof-bound-order');
  return { lower, upper };
}
export function integerFragmentProofScope(fragment) {
  return { worldId: fragment.worldId, assumptionsId: fragment.assumptionsId, snapshotId: fragment.snapshotId,
    functionId: fragment.functionId, source: fragment.source, domain: INTEGER_FRAGMENT_DOMAIN };
}
export function registerRangeProofKernel(registry, { work } = {}) {
  assertScopedAnalysisWork(work);
  return registry.register({ id: 'scpa.typed-range-composition', version: RANGE_PROOF_VERSION,
    semanticKind: RANGE_PROOF_KIND, level: 'derivation-checked', execution: 'local-bounded', check: (node, context) => {
      work.charge('workUnits', 8);
      const reply = (status, reason, detail = {}) => ({ status, reason, detail, worldId: context.world.id,
        assumptionsId: context.assumptions.id, nodeId: node.id, propositionChecked: true });
      const rule = snapshotContractData(node.payload.rule, { maxBytes: 16384, maxNodes: 256 });
      recordFields(rule, ['schema', 'version', 'rule', 'scope', 'premises', 'conclusion'], 'range-proof-rule-fields');
      if (rule.schema !== RANGE_PROOF_SCHEMA || rule.version !== RANGE_PROOF_VERSION
        || !['integer-range-projection', 'range-weaken', 'range-intersection'].includes(rule.rule)) return reply('unknown', 'range-proof-rule-unsupported');
      if (rule.scope?.worldId !== context.world.id || rule.scope?.assumptionsId !== context.assumptions.id) return reply('rejected', 'range-proof-scope-mismatch');
      if (context.assumptions.satisfiability === 'inconsistent') return reply('unknown', 'range-proof-inconsistent-assumptions');
      const expectedCount = rule.rule === 'range-intersection' ? 2 : 1;
      if (!Array.isArray(rule.premises) || rule.premises.length !== expectedCount || new Set(rule.premises).size !== expectedCount
        || rule.premises.includes(node.id)) return reply('rejected', 'range-proof-independent-premises-required');
      const wanted = range(rule.conclusion), values = [];
      for (const id of rule.premises) {
        exactString(id, 'range-proof-premise'); work.charge('workUnits');
        const premise = context.getNode(id), checked = context.getCheckedPremise?.(node.id, id);
        if (!premise || !checked || !['derivation-checked', 'independent-proof-checked'].includes(checked.checker?.level)) return reply('unknown', 'range-proof-premise-not-independently-replayed');
        if (rule.rule === 'integer-range-projection') {
          const f = premise.payload.fragment, detail = checked.detail;
          if (premise.semanticKind !== INTEGER_FRAGMENT_KIND || !f || !same(rule.scope, integerFragmentProofScope(f))
            || f.semanticValueId !== rule.conclusion.subject || f.conclusion.bits !== rule.conclusion.bits
            || detail?.bits !== rule.conclusion.bits || !same(detail.domain, INTEGER_FRAGMENT_DOMAIN)) return reply('rejected', 'range-proof-integer-premise-type-or-scope-mismatch');
          values.push(range({ ...rule.conclusion, lower: detail.lower, upper: detail.upper }));
        } else {
          const detail = checked.detail;
          if (premise.semanticKind !== RANGE_PROOF_KIND || !same(detail?.scope, rule.scope)
            || detail?.proposition?.subject !== rule.conclusion.subject || detail.proposition.bits !== rule.conclusion.bits) return reply('rejected', 'range-proof-premise-type-or-scope-mismatch');
          values.push(range(detail.proposition));
        }
      }
      const lower = values.reduce((a, v) => a > v.lower ? a : v.lower, 0n);
      const upper = values.reduce((a, v) => a < v.upper ? a : v.upper, (1n << BigInt(rule.conclusion.bits)) - 1n);
      // Empty intersections cannot be exploited as ex-falso range proofs.
      if (lower > upper) return reply('unknown', 'range-proof-inconsistent-premises');
      if (wanted.lower > lower || wanted.upper < upper) return reply('rejected', 'range-proof-conclusion-not-implied');
      return reply('verified', 'typed-range-premises-compose', { scope: rule.scope, proposition: rule.conclusion,
        rule: rule.rule, premisesChecked: expectedCount, entryReachability: 'outside-fragment-domain',
        flagsAndFaults: 'excluded-by-inherited-integer-fragment-domain' });
    } });
}
