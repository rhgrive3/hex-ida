import { synthesizeScalarLoopInvariant } from '../../../core/evidence/loop-synthesis.js';
import { PORTABLE_LOOP_SCHEMA, normalizePortableLoop } from '../../../core/evidence/portable-loop.js';
import { LOOP_CHECKER_VERSION } from '../../../core/evidence/loop-invariant.js';
import { extractArm64ScalarLoop, checkArm64ScalarLoop, ARM64_LOOP_CHECKER_VERSION } from '../../../core/evidence/arm64-loop-fragment.js';
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
  if (!context || context.reason) return { status: 'unsupported', reason: context?.reason ?? 'current-loop-model-unavailable', exact: false };
  const current = () => isCurrent?.() === true && context?.isCurrent?.() === true;
  if (!current()) contractFail('loop-model-owner-stale');
  const binding = snapshotContractData(context.binding, { maxBytes: 16384, maxNodes: 256 });
  recordFields(binding, ['worldId', 'assumptionsId', 'snapshotId', 'functionLocator', 'loopId', 'modelRevision', 'artifactId', 'sourceReferences'], 'loop-owner-binding-fields');
  if (binding.worldId !== world.id || binding.assumptionsId !== assumptions.id || binding.snapshotId !== snapshotId
    || binding.functionLocator !== input.functionId || binding.loopId !== input.loopId) contractFail('loop-owner-binding');
  exactString(binding.modelRevision, 'loop-model-revision'); exactString(binding.artifactId, 'loop-model-artifact');
  if (!Array.isArray(binding.sourceReferences) || !binding.sourceReferences.length || binding.sourceReferences.length > 32) contractFail('loop-source-references');
  binding.sourceReferences.forEach(v => exactString(v, 'loop-source-reference'));
  let nativeFragment = null, nativeBytes = null, correspondence = null;
  if (context.nativeSource !== undefined) {
    const source = snapshotContractData(context.nativeSource, { maxBytes: 4096, maxNodes: 32 });
    recordFields(source, ['binaryId', 'offset', 'virtualStart', 'length'], 'loop-native-source-fields');
    if (!world.binarySet.some(row => row.binaryId === source.binaryId) || source.length !== 24
      || !['offset', 'virtualStart'].every(key => typeof source[key] === 'string' && /^(0|[1-9][0-9]{0,19})$/.test(source[key]))
      || BigInt(source.virtualStart) % 4n || BigInt(source.offset) + 24n > (1n << 64n)
      || BigInt(source.virtualStart) + 24n > (1n << 64n) || typeof context.readNativeBytes !== 'function') contractFail('loop-native-source-binding');
    work.charge('bytesRead', source.length); work.charge('residentBytes', source.length);
    const response = await work.await(signal => context.readNativeBytes({ signal }));
    work.checkpoint(); if (!current()) contractFail('loop-native-source-stale');
    if (response?.worldId !== world.id || response?.snapshotId !== snapshotId || response?.binaryId !== source.binaryId
      || response?.offset !== source.offset || response?.virtualStart !== source.virtualStart
      || !(response?.bytes instanceof Uint8Array) || response.bytes.length !== source.length) contractFail('loop-native-byte-response-binding');
    nativeBytes = response.bytes.slice();
    correspondence = extractArm64ScalarLoop(nativeBytes, { profile: world.profile, work });
    if (correspondence.status !== 'correspondence-checked') return deepFreeze({ status: 'unsupported', reason: correspondence.reason,
      binding, sourceBinding: 'current-source-bytes', exact: false, semanticClosure: 'unknown' });
    nativeFragment = { checkerVersion: ARM64_LOOP_CHECKER_VERSION, profile: world.profile, source,
      bytesHex: [...nativeBytes].map(value => value.toString(16).padStart(2, '0')).join('') };
  }
  const model = snapshotContractData(context.model ?? correspondence?.model, { maxBytes: 8192, maxNodes: 128 });
  const synthesis = input.synthesize === true ? synthesizeScalarLoopInvariant(model, input.postcondition, { work }) : null;
  const candidate = synthesis ? synthesis.candidate : { invariant: input.invariant, postcondition: input.postcondition };
  const checked = synthesis ? synthesis.checked : checkScalarLoopInvariant(model, candidate, { work });
  const nativeChecked = nativeBytes && candidate ? checkArm64ScalarLoop(nativeBytes, model, candidate, { profile: world.profile, work }) : null;
  const capsule = candidate ? normalizePortableLoop({ schema: PORTABLE_LOOP_SCHEMA, checkerVersion: LOOP_CHECKER_VERSION,
    binding, model, candidate, ...(nativeFragment ? { nativeFragment } : {}),
    remaining: nativeChecked?.status === 'verified-fragment' ? ['external-incoming-edges-and-fetch-environment-outside-fragment-domain'] : ['host-model-only; machine-correspondence-unproved'] }) : null;
  if (input.capsule !== undefined && (!capsule || stableStringify(normalizePortableLoop(input.capsule)) !== stableStringify(capsule))) {
    work.checkpoint(); if (!current()) contractFail('loop-model-stale-before-publication');
    return deepFreeze({status:'rejected',reason:'portable-loop-current-owner-or-model-mismatch',exact:false,semanticProof:false,capsuleRebound:false});
  }
  work.checkpoint(); if (!current()) contractFail('loop-model-stale-before-publication');
  return deepFreeze({ schema: 'scpa-loop-evidence/v1', status: 'completed', binding, model,
    candidate: snapshotContractData(candidate), checked, nativeChecked, synthesis, capsule, capsuleRebound: input.capsule !== undefined,
    sourceBinding: nativeChecked?.status === 'verified-fragment' ? 'current-source-bytes-and-independent-fragment-correspondence'
      : nativeBytes ? 'current-source-bytes; fragment-proof-unproved' : 'current-host-model-references; not-independent-machine-binding', exact: false,
    semanticClosure: 'unknown', canonicalTruthChanged: false, defaultActivation: false, releaseQualified: false });
}
