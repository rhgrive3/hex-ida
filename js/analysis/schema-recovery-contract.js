import { normalizeSchemaRecoveryLimit } from '../schema.js';

/**
 * Reduce the shared string/program inputs to the schema artifact's
 * completeness contract.  Both the legacy App producer and the modern UI
 * task must use this exact reduction so cache behavior cannot depend on which
 * entry point was called first.
 */
export function dependencyCompleteness(strings, program) {
  const reasons = [];
  if (strings?.complete !== true) reasons.push(strings?.truncationReason || 'strings-partial');
  const graph = program?.graphCompleteness;
  const programComplete = !!program && program.complete !== false && program.truncated !== true
    && program.unsupported !== true && program.completeness?.complete !== false
    && graph?.callsComplete !== false && graph?.refsComplete !== false;
  if (!programComplete) reasons.push(program?.queryIncompleteReason || program?.incompleteReason || graph?.reasons?.[0] || 'program-partial');
  return { complete:reasons.length === 0, reasons:[...new Set(reasons.filter(Boolean))] };
}

/**
 * Attach the canonical identity and completeness metadata to one schema
 * collection.  Metadata is deliberately non-enumerable to preserve the
 * existing array API while making cache reuse fail closed.
 */
export function annotateSchemaResult(value, completeness = {}, { epoch = null, maxSchemas = null } = {}) {
  const schemas = Array.isArray(value) ? value : [];
  const reasons = [...new Set((Array.isArray(completeness.reasons) ? completeness.reasons : []).filter(Boolean))];
  const dependencyComplete = completeness.complete === true && reasons.length === 0;
  const ownIncomplete = schemas.complete === false || schemas.truncated === true || schemas.unsupported === true;
  const complete = dependencyComplete && !ownIncomplete;
  const reason = !complete
    ? schemas.incompleteReason || schemas.truncationReason || reasons[0] || 'schema-recovery-partial'
    : null;
  const budgetPartial = !complete && dependencyComplete
    && String(reason || '').split(';').includes('schema-recovery-limit');
  Object.defineProperties(schemas, {
    complete:{ value:complete, enumerable:false, configurable:true },
    incompleteReason:{ value:reason, enumerable:false, configurable:true },
    dependencyReasons:{ value:Object.freeze(reasons), enumerable:false, configurable:true },
    schemaRecoveryEpoch:{ value:epoch, enumerable:false, configurable:true },
    schemaRecoveryMaxSchemas:{ value:normalizeSchemaRecoveryLimit(maxSchemas), enumerable:false, configurable:true },
    schemaRecoveryDependencyComplete:{ value:dependencyComplete, enumerable:false, configurable:true },
    schemaRecoveryBudgetPartial:{ value:budgetPartial, enumerable:false, configurable:true },
  });
  return schemas;
}

/**
 * A schema array can satisfy a request only when it is a current, typed
 * artifact. Complete results are safe to reuse; incomplete results are
 * reusable only when dependencies were complete (the intentional budget
 * partial case). Dependency-partial/failure results must be retried.
 */
export function schemaResultSatisfies(result, epoch, maxSchemas) {
  if (!Array.isArray(result)) return false;
  if (result.schemaRecoveryEpoch !== epoch) return false;
  if (!Number.isSafeInteger(result.schemaRecoveryMaxSchemas)) return false;
  if (result.complete === true) return true;
  return result.schemaRecoveryDependencyComplete === true
    && result.schemaRecoveryBudgetPartial === true
    && result.schemaRecoveryMaxSchemas >= normalizeSchemaRecoveryLimit(maxSchemas);
}
