/** Stable SSA identity at the v1/v2 compatibility boundary; never a register name.
 * Numeric legacy IDs are type-tagged. Canonical SSA IDs take precedence over
 * expression IDs because distinct state versions can reference one expression.
 */
import { QueryFailure } from './query-state.js';
export function semanticValueIdentity(value) {
  for (const field of ['semanticSsaValueId', 'semanticValueId']) {
    if (value?.[field] != null) {
      if (typeof value[field] !== 'string' || !value[field] || value[field].length > 1024) throw new QueryFailure('invalid-semantic-value-id');
      return value[field];
    }
  }
  const id = value?.id;
  if (typeof id === 'string' && id.length > 0 && id.length <= 1024) return id;
  if (typeof id === 'number' && Number.isSafeInteger(id) && id >= 0) return `legacy-number:${id}`;
  throw new QueryFailure('missing-semantic-value-id');
}
export function registerExecutionValue(value, state) {
  const id = semanticValueIdentity(value);
  if (!state.valueIdentities) return id;
  const previous = state.valueIdentities.get(value.id);
  if (previous && (previous.value !== value || previous.id !== id || previous.bits !== value.bits || previous.def !== value.def || previous.kind !== value.kind)) {
    throw new QueryFailure('semantic-value-identity-conflict');
  }
  const priorSemantic=state.semanticIdentities?.get(id);
  if(priorSemantic && priorSemantic!==value) throw new QueryFailure('semantic-value-identity-conflict');
  if (!previous) {
    state.byteMemory?.chargeExecution(1, 1);
    state.semanticIdentities?.set(id,value);
    state.valueIdentities.set(value.id, {id, bits:value.bits, def:value.def, kind:value.kind, value});
  }
  return id;
}
