import { synthesizeScalarLoopInvariant } from '../../../core/evidence/loop-synthesis.js';
import { PORTABLE_LOOP_SCHEMA, normalizePortableLoop } from '../../../core/evidence/portable-loop.js';
import { LOOP_CHECKER_VERSION } from '../../../core/evidence/loop-invariant.js';
import { stableStringify } from '../../../core/identity/index.js';
/** Host model binding is read-only and never supplied by an AI query. Even a
 * current source model plus checked induction does not establish ISA adequacy.
 */
import { recordFields, exactString, snapshotContractData, contractFail } from '../../../core/identity/structured.js';
import { deepFreeze } from '../../../core/identity/index.js';
import { assertWorldScope, assertAssumptionSet } from '../../../core/identity/world.js';
import { assertScopedAnalysisWork } from '../../../core/budgets/scoped-work.js';
import { checkScalarLoopInvariant } from '../../../core/evidence/loop-invariant.js';

export async function queryLoopInvariant(request, { world, assumptions, snapshotId, work, getContext, isCurrent } = {}) {
  assertWorldScope(world); assertAssumptionSet(assumptions, world); assertScopedAnalysisWork(work);
  const input = snapshotContractData(request, { maxBytes: 65536, maxNodes: 2048 });
  recordFields(input, ['functionId', 'loopId', 'invariant', 'postcondition', 'synthesize', 'capsule'], 'loop-query-fields');
  exactString(input.functionId, 'loop-function'); exactString(input.loopId, 'loop-id');
  if (input.synthesize !== undefined && typeof input.synthesize !== 'boolean') contractFail('loop-synthesis-option');
  if (input.synthesize === true && input.invariant !== undefined) contractFail('loop-synthesis-invariant-conflict');
  if (typeof getContext !== 'function') return { status: 'unsupported', reason: 'current-loop-model-owner-required', exact: false };
  const context = await work.await(signal => getContext(input.functionId, input.loopId, { world, assumptions, snapshotId, signal }));
  work.checkpoint();
  const current = () => isCurrent?.() === true && context?.isCurrent?.() === true;
  if (!current()) contractFail('loop-model-owner-stale');
  const model = snapshotContractData(context.model, { maxBytes: 8192, maxNodes: 128 });
  const binding = snapshotContractData(context.binding, { maxBytes: 16384, maxNodes: 256 });
  recordFields(binding, ['worldId', 'assumptionsId', 'snapshotId', 'functionLocator', 'loopId', 'modelRevision', 'artifactId', 'sourceReferences'], 'loop-owner-binding-fields');
  if (binding.worldId !== world.id || binding.assumptionsId !== assumptions.id || binding.snapshotId !== snapshotId
    || binding.functionLocator !== input.functionId || binding.loopId !== input.loopId) contractFail('loop-owner-binding');
  exactString(binding.modelRevision, 'loop-model-revision'); exactString(binding.artifactId, 'loop-model-artifact');
  if (!Array.isArray(binding.sourceReferences) || !binding.sourceReferences.length || binding.sourceReferences.length > 32) contractFail('loop-source-references');
  binding.sourceReferences.forEach(v => exactString(v, 'loop-source-reference'));
  const synthesis = input.synthesize === true ? synthesizeScalarLoopInvariant(model, input.postcondition, { work }) : null;
  const candidate = synthesis ? synthesis.candidate : { invariant: input.invariant, postcondition: input.postcondition };
  const checked = synthesis ? synthesis.checked : checkScalarLoopInvariant(model, candidate, { work });
  const capsule = candidate ? normalizePortableLoop({ schema: PORTABLE_LOOP_SCHEMA, checkerVersion: LOOP_CHECKER_VERSION,
    binding, model, candidate, remaining: ['host-model-only; machine-correspondence-unproved'] }) : null;
  if (input.capsule !== undefined && (!capsule || stableStringify(normalizePortableLoop(input.capsule)) !== stableStringify(capsule))) {
    work.checkpoint(); if (!current()) contractFail('loop-model-stale-before-publication');
    return deepFreeze({status:'rejected',reason:'portable-loop-current-owner-or-model-mismatch',exact:false,semanticProof:false,capsuleRebound:false});
  }
  work.checkpoint(); if (!current()) contractFail('loop-model-stale-before-publication');
  return deepFreeze({ schema: 'scpa-loop-evidence/v1', status: 'completed', binding, model,
    candidate: snapshotContractData(candidate), checked, synthesis, capsule, capsuleRebound: input.capsule !== undefined,
    sourceBinding: 'current-host-model-references; not-independent-machine-binding', exact: false,
    semanticClosure: 'unknown', canonicalTruthChanged: false, defaultActivation: false, releaseQualified: false });
}
