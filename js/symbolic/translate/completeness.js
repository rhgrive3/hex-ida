/** Shared query completeness data. Keep this contract independent of IR lowering
 * so each solver Worker can initialize without loading the analysis runtime.
 */

export const COMPLETENESS_STATUS = Object.freeze({
  COMPLETE: 'complete',
  PARTIAL: 'partial',
  UNSUPPORTED: 'unsupported',
});

export function createCompleteness({
  translation = COMPLETENESS_STATUS.COMPLETE,
  controlFlow = COMPLETENESS_STATUS.COMPLETE,
  memoryEffects = COMPLETENESS_STATUS.COMPLETE,
  pathCoverage = COMPLETENESS_STATUS.COMPLETE,
  queryScope = COMPLETENESS_STATUS.COMPLETE,
} = {}) {
  return Object.freeze({
    translation,
    controlFlow,
    memoryEffects,
    pathCoverage,
    queryScope,
  });
}

