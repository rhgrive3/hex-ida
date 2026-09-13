/** Bounded composition of selected canonical direct-branch-only functions.
 * Any memory, arithmetic, call, authentication or non-B control stops the walk.
 */
import { createEntityId } from '../../core/identity/index.js';
import { unsignedAddress } from '../../core/identity/structured.js';
import { canonicalDispatchSite } from '../query/semantic/call-targets.js';

function pureBranch(projection, work) {
  let branch = null;
  for (let i = 0; i < projection.size; i++) {
    work.charge('workUnits');
    const record = projection.recordAt(i);
    if (record.owner !== 'semantic-ir') continue;
    const node = projection.source(record.id), metadata = node.attributes?.machineEffects?.bundleMetadata;
    if (node.completeness !== 'complete' || node.unknown || metadata?.operation !== 'b') return null;
    if (node.kind === 'branch' && canonicalDispatchSite(node)?.address != null && !branch) branch = node;
    else if (node.kind === 'const' && node.attributes.constant?.widthBits === 2 && String(node.attributes.constant.value) === '0') continue;
    else if (node.kind === 'state-write' && node.variable?.physicalIdentity?.registerId === 'pstate.btype') continue;
    else return null;
  }
  return branch;
}
export async function nativeThunkCandidates(seeds, index, request, { world, projection, work }) {
  const candidates = [], chains = [], requirements = [];
  if (!request.families.includes('thunk-chain')) return { candidates, chains, requirements };
  for (const seed of seeds.slice(0, request.maxTargets)) {
    let current = index.functions.get(seed.targetEntityId);
    if (!current) continue;
    const seen = new Set(), chain = []; let cycle = false;
    for (let depth = 0; current && depth < request.maxHops; depth++) {
      if (seen.has(current.functionId)) { requirements.push('native-thunk-cycle'); cycle = true; break; }
      seen.add(current.functionId);
      const branch = pureBranch(current, work);
      if (!branch) break;
      const address = unsignedAddress(canonicalDispatchSite(branch).address), input = current.inputIdentity;
      const entries = [...index.functions.values()].filter(target => target.inputIdentity.binaryId === input.binaryId
        && target.inputIdentity.sourceLocation?.sliceId === input.sourceLocation?.sliceId && target.inputIdentity.sourceLocation?.start === address);
      if (entries.length !== 1) { requirements.push(entries.length ? 'native-thunk-entry-ambiguous' : 'native-thunk-target-outside-scope'); break; }
      const next = entries[0];
      chain.push({ from: current.functionId, to: next.functionId, family: 'thunk-chain', evidenceIds: [branch.id],
        requirements: ['native-thunk-code-validity-and-trap-domain-unqualified'] });
      current = next;
      if (depth + 1 === request.maxHops && pureBranch(current, work)) requirements.push('native-thunk-hop-budget');
      await work.yieldIfNeeded();
    }
    if (!chain.length) continue;
    if (chains.length >= request.maxTargets) { requirements.push('native-thunk-chain-budget'); break; }
    chains.push(chain);
    if (cycle) continue;
    if (candidates.length >= request.maxTargets) { requirements.push('native-target-result-cut'); break; }
    const input = current.inputIdentity, declaration = { callerInput: projection.inputIdentity,
      calleeInput: input, chain, executionFeasible: false, sideEffects: 'only-canonical-B-and-BTYPE-reset' };
    candidates.push({ targetEntityId: current.functionId, binaryId: input.binaryId,
      address: '0x' + BigInt(input.sourceLocation.start).toString(16), family: 'thunk-chain',
      evidenceIds: chain.flatMap(hop => hop.evidenceIds), requirements: ['native-thunk-code-validity-and-trap-domain-unqualified'],
      provenance: { schema: 'dispatch-owner-reference/v1', worldId: world.id, binaryId: input.binaryId,
        artifactId: projection.inputIdentity.producerArtifactId, ownerRevision: '1.0.0',
        id: createEntityId({ binaryId: input.binaryId, kind: 'native-thunk-reference', identity: declaration }), declaration } });
  }
  return { candidates, chains, requirements };
}
