/* Conflict-resistant public panel boundary.
 * The historical panel implementation remains byte-for-byte in panels-base.js.
 * Architecture-neutral query-driven panels are explicit overrides so
 * first-party UI does not duplicate backend/query lifecycle policy. */
export * from './panels-base.js';
export { showFunctions, showFunctionSummary } from './ui/panels/function-analysis.js';
export { showStrings, showXrefs } from './ui/panels/navigation.js';
export { showField } from './ui/panels/field-access.js';
export { showDataTables } from './ui/panels/schema-recovery.js';
export { showSearch } from './ui/panels/search.js';
export { showCandidates, showOverview } from './ui/panels/investigation.js';
