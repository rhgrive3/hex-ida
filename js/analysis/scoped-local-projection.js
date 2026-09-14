/** Bounded local-owner projection on the existing platform worker. Invoked
 * immediately after that worker produced a canonical semantic-function result;
 * callers cannot supply a replacement IR/AST through this command.
 */
import { createAnalysisSurface } from './index.js';
import { exactEnum, exactString, recordFields, snapshotContractData, contractFail } from '../core/identity/structured.js';
import { deepFreeze } from '../core/identity/index.js';
import { projectCanonicalPhysicalTypes } from './types/scoped-physical.js';

export const SCOPED_LOCAL_PROJECTION_VERSION = '1.1.0';
export function projectScopedLocalOwners(semanticResult, request, { signal = null } = {}) {
  const input = snapshotContractData(request, { maxBytes: 16384, maxNodes: 256 });
  recordFields(input, ['kind', 'snapshotId', 'worldId', 'valueId', 'entityIds'], 'scoped-local-projection-fields');
  const kind = exactEnum(input.kind, ['points-to', 'summary', 'types'], 'scoped-local-projection-kind');
  exactString(input.snapshotId, 'scoped-local-projection-snapshot'); exactString(input.worldId, 'scoped-local-projection-world');
  if (kind === 'points-to') exactString(input.valueId, 'scoped-local-value');
  else if (input.valueId !== undefined) contractFail('scoped-local-unexpected-value');
  if (kind !== 'types' && input.entityIds !== undefined) contractFail('scoped-local-unexpected-entities');
  const pipeline = semanticResult?.pipeline, ir = pipeline?.semanticIr;
  const base = { schema: 'scoped-local-owner-projection/v1', version: SCOPED_LOCAL_PROJECTION_VERSION,
    kind, worldId: input.worldId, snapshotId: input.snapshotId, binaryId: pipeline?.binaryId ?? null,
    functionId: pipeline?.functionId ?? null, exact: false, authority: 'existing-local-owner-projection; not-independently-verified' };
  const check = () => { if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError'); };
  check();
  if (pipeline?.instrumentation?.v2Executed !== true || !ir || pipeline.functionId !== ir.functionId) {
    return deepFreeze({ ...base, status: 'unsupported', reason: 'canonical-worker-pipeline-unavailable' });
  }
  // A bounded function, not whole-program eager analysis. These are the real
  // owner budget names; unsupported options would not bound synchronous work.
  if (!Array.isArray(ir.nodes) || !Array.isArray(ir.values) || ir.nodes.length > 1024 || ir.values.length > 2048
    || (pipeline.ssa?.definitions?.length ?? 0) > 4096 || (pipeline.ssa?.uses?.length ?? 0) > 8192) {
    return deepFreeze({ ...base, status: 'unsupported', reason: 'local-owner-structural-budget' });
  }
  if (kind === 'types') {
    const types = projectCanonicalPhysicalTypes(pipeline, input.entityIds, { snapshotId: input.snapshotId, worldId: input.worldId, signal });
    check();
    return deepFreeze({ ...base, status: types.status, reason: types.reason ?? null, types });
  }
  const surface = createAnalysisSurface({ ir, cfg: pipeline.cfg, ssa: pipeline.ssa, memorySsa: pipeline.memorySsa,
    snapshotId: input.snapshotId, options: { signal,
      budget: { maxValues: 2048, maxIterations: 8, widenAfterIterations: 3, maxTargetsPerSet: 8 },
      memorySsaBinding: { snapshotId: input.snapshotId, functionId: pipeline.functionId,
        semanticIrVersion: ir.contractVersion, memorySsaBuildVersion: pipeline.memorySsa?.buildVersion ?? null,
        completeness: ir.completeness === 'complete' ? 'complete' : 'partial' } } });
  let result;
  if (kind === 'points-to') {
    const owner = surface.pointsTo(); check();
    const set = owner?.pointsTo?.get(input.valueId) ?? owner?.ssaPointsTo?.get(input.valueId) ?? null;
    result = { ...base, status: set ? 'completed' : 'unsupported', reason: set ? null : 'points-to-value-unavailable',
      valueId: input.valueId, set, ownerStatus: owner?.status ?? null, iterations: owner?.iterations ?? 0 };
  } else {
    const owner = surface.functionSummary(); check();
    result = { ...base, status: owner?.summary ? 'completed' : 'unsupported',
      reason: owner?.summary ? null : owner?.status?.stopReason ?? 'local-summary-unavailable',
      summary: owner?.summary ?? null, ownerStatus: owner?.status ?? null };
  }
  return deepFreeze(result);
}
