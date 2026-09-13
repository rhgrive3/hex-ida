/** Three typed, bounded investigation recipes over the existing semantic VM.
 * Anchors are query selections/hypotheses, not allocator, sanitizer or length
 * authority. Each recipe executes the same demand/evidence publication path.
 */
import { compileSemanticQuery } from './plan.js';
import { normalizeDemandPrecision } from '../../scoped-demand-projection.js';
import { createEntityId, deepFreeze } from '../../../core/identity/index.js';
import { snapshotContractData, recordFields, exactEnum, exactInteger, stringSet, contractFail } from '../../../core/identity/structured.js';

export const DEMAND_TEMPLATE_VERSION = '1.0.0';
const PLANS = new WeakSet();
const RECIPES = Object.freeze({
  'source-to-sink': { from: 'source', to: 'sink', obligations: ['anchor-meaning', 'path-feasibility', 'call-and-memory-closure'] },
  'allocation-null-guard': { from: 'allocation', to: 'guard', obligations: ['allocator-contract', 'null-comparison', 'guard-dominance', 'call-result-binding'] },
  'length-to-buffer-use': { from: 'length', to: 'bufferUse', obligations: ['length-meaning', 'buffer-object-extent', 'access-width-and-overflow', 'guard-dominance'] },
});
export function compileDemandInvestigation(input, { world, assumptions } = {}) {
  const data = snapshotContractData(input, { maxBytes: 262144, maxNodes: 8192 });
  recordFields(data, ['template', 'functionIds', 'anchors', 'via', 'avoid', 'resultLimit', 'maxDepth', 'maxCallDepth', 'precision', 'maximumContexts'], 'demand-template-fields');
  const template = exactEnum(data.template, Object.keys(RECIPES), 'demand-template-kind'), recipe = RECIPES[template];
  const functionIds = stringSet(data.functionIds, 'demand-template-function-scope', 8);
  if (!functionIds.length) contractFail('demand-template-empty-scope');
  recordFields(data.anchors, [recipe.from, recipe.to], 'demand-template-anchor-fields');
  if (!data.anchors[recipe.from] || !data.anchors[recipe.to]) contractFail('demand-template-anchor-required');
  const resultLimit = exactInteger(data.resultLimit ?? 16, 'demand-template-result-limit', { min: 1, max: 64 });
  const compiled = compileSemanticQuery({ scope: { functionIds }, select: data.anchors[recipe.from],
    flow: { to: data.anchors[recipe.to], via: data.via ?? [], avoid: data.avoid ?? null,
      direction: 'forward', maxDepth: exactInteger(data.maxDepth ?? 64, 'demand-template-depth', { min: 1, max: 128 }),
      maxCallDepth: exactInteger(data.maxCallDepth ?? 2, 'demand-template-call-depth', { max: 4 }), maxPaths: resultLimit },
    projection: { includeOrigins: true, includeWitnesses: true }, resultLimit }, { world, assumptions });
  const intent = { schema: 'scoped-demand-investigation-intent/v1', version: DEMAND_TEMPLATE_VERSION, template,
    worldId: world.id, assumptionsId: assumptions.id, queryId: compiled.id,
    anchorRoles: { source: recipe.from, sink: recipe.to }, obligations: recipe.obligations,
    authority: 'hypothesis-and-possible-dependence; no-safety-or-executable-path-claim' };
  const result = deepFreeze({ request: { query: compiled.query, precision: normalizeDemandPrecision(data.precision),
    maximumContexts: exactInteger(data.maximumContexts ?? 32, 'demand-template-contexts', { min: 1, max: 32 }) },
    intent: { ...intent, id: createEntityId({ binaryId: world.binarySet[0].binaryId, kind: intent.schema, identity: intent }) } });
  PLANS.add(result.intent); return result;
}
export function assertDemandInvestigationIntent(value, { world, queryId } = {}) {
  if (!PLANS.has(value) || value.worldId !== world.id || value.queryId !== queryId) contractFail('demand-template-intent-unbound');
  return value;
}
