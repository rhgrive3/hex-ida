/** Private input assumptions for a READ-ONLY SCCP fork. The ordinary compiler
 * cannot deserialize this capability or reuse a conditional range artifact.
 * Transfer functions continue to be owned by sccp.js/range.js.
 */
import { fullFact, refineFactByComparison } from './range.js';
import { analysisIdentityMatches } from './analysis-identity.js';
import { createEntityId, deepFreeze } from '../../core/identity/index.js';
import { contractFail } from '../../core/identity/structured.js';
const BINDINGS = new WeakMap();
export function createConditionalSccpInputs(analysis, ownerIdentity, constraints, assumptions) {
  if (!Array.isArray(constraints) || !constraints.length || constraints.length > 32
    || !analysis?.get || !ownerIdentity?.binaryId) contractFail('sccp-context-input-binding');
  const values = new Map((analysis.get('ssa')?.values ?? []).map(value => [value.id, value]));
  const facts = new Map();
  for (const constraint of constraints) {
    const value = values.get(constraint.valueId);
    // Never overwrite a defined expression or fabricate a register parameter.
    if (!value || value.kind !== 'arg' || value.def != null || value.bits !== constraint.bits
      || !assumptions.predicates.includes(constraint.assumptionId)) contractFail('sccp-context-input-not-entry-argument');
    const before = facts.get(value.id) ?? fullFact(value.bits, { valueId: value.id });
    const fact = refineFactByComparison(before, constraint.operator, BigInt(constraint.constant), constraint.truth);
    facts.set(value.id, fact);
  }
  const token = deepFreeze({ schema: 'conditional-sccp-inputs/v1', id: createEntityId({ binaryId: ownerIdentity.binaryId,
    kind: 'conditional-sccp-inputs', identity: { ownerIdentity, constraints, assumptionsId: assumptions.id } }),
    conditionalOn: [...new Set(constraints.map(row => row.assumptionId))].sort(), assumptionsId: assumptions.id });
  BINDINGS.set(token, { analysis, ownerIdentity, facts }); return token;
}
export function conditionalSccpInput(token, analysis, ownerIdentity, valueId = null) {
  if (token == null) return null;
  const binding = BINDINGS.get(token);
  if (!binding || binding.analysis !== analysis || !analysisIdentityMatches(binding.ownerIdentity, ownerIdentity)) contractFail('sccp-context-capability-not-bound');
  return valueId == null ? token : binding.facts.get(valueId) ?? null;
}
