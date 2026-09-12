/** Native scoped dispatch candidates. This adapter joins existing Phase8/SSA
 * facts to ALREADY selected canonical function entries; it neither discovers
 * functions nor publishes target-set closure or authentication truth.
 */
import { contractFail, unsignedAddress } from '../../core/identity/structured.js';
import { createEntityId } from '../../core/identity/index.js';
import { indexScopedFunctionEntries, scopedCallTargetRows, assertNativeTargetDemand, canonicalDispatchSite } from '../query/semantic/call-targets.js';
import { nativeMemoryDispatchCandidates } from './native-memory-targets.js';
import { nativeThunkCandidates } from './native-thunks.js';

export const NATIVE_DEMAND_DISPATCH_VERSION = '1.2.0';
/** Backward navigation is only a possible dependency cut. It is deliberately
 * not a pointer evaluator, a new MemorySSA walker, or an executable witness.
 */
export async function nativeLoadCut(projection, node, work, maxHops) {
  const pending = [];
  for (const id of (canonicalDispatchSite(node)?.targetValueIds ?? []).slice(0, 64)) {
    work.charge('workUnits');
    for (const reference of projection.valueReferenceIds(id)) {
      work.charge('workUnits');
      if (pending.length >= 256) return { loads: new Map(), cut: true };
      pending.push({ reference, depth: 0 });
    }
  }
  const seen = new Set(), loads = new Map(); let cut = false, edgeCount = 0;
  for (let head = 0; head < pending.length; head++) {
    work.charge('workUnits'); work.charge('queueOperations');
    const { reference, depth } = pending[head]; if (seen.has(reference)) continue;
    if (seen.size >= 64) { cut = true; break; } seen.add(reference);
    const row = projection.record(reference), source = row && projection.source(reference);
    if (row?.owner === 'semantic-ir' && source?.kind === 'load') loads.set(source.id, source);
    if (depth >= Math.min(8, maxHops)) { if (projection.adjacent(reference, 'backward').length) cut = true; continue; }
    for (const id of projection.adjacent(reference, 'backward')) {
      work.charge('edges'); if (++edgeCount > 128) { cut = true; break; }
      const edge = projection.edge(id);
      if (edge && !seen.has(edge.from)) pending.push({ reference: edge.from, depth: depth + 1 });
    }
    if (cut && edgeCount > 128) break;
    await work.yieldIfNeeded();
  }
  return { loads, cut };
}
export function createNativeDemandDispatchResolver({ queryPointer = null, readMemory = null } = {}) {
  if (queryPointer !== null && typeof queryPointer !== 'function') contractFail('native-pointer-query-owner');
  if (readMemory !== null && typeof readMemory !== 'function') contractFail('native-dispatch-memory-owner');
  return { id: 'native-demand-dispatch', version: NATIVE_DEMAND_DISPATCH_VERSION,
    families: ['direct', 'register', 'tail-call', 'thunk-chain', ...(readMemory ? ['jump-table', 'import-stub'] : []),
      ...(queryPointer ? ['chained-fixup', 'authenticated-pointer'] : [])],
    async resolve(request, { world, assumptions, projection, nativeContext = null, work }) {
      const result = { status: 'completed', worldId: world.id, assumptionsId: assumptions.id,
        projectionId: projection.id, callSiteId: request.callSiteId, candidates: [], chains: [],
        requirements: ['selected-entries-not-world-closure', 'target-feasibility-not-proven'] };
      if (!nativeContext?.member || !Array.isArray(nativeContext.members) || nativeContext.members.length > 16
        || nativeContext.member.projection !== projection) return { ...result, status: 'unsupported',
        reason: 'native-demand-context-required' };
      const demand = assertNativeTargetDemand(nativeContext.member.demand, projection);
      if (!demand) return { ...result, status: 'unsupported', reason: 'native-demand-owner-required' };
      const reference = projection.entityReference('semantic-ir', request.callSiteId);
      const node = reference && projection.source(reference);
      const site = canonicalDispatchSite(node);
      if (!site) return { ...result, status: 'unsupported', reason: 'native-call-site-unbound' };
      const index = indexScopedFunctionEntries(nativeContext.members.map(member => member.projection));
      work.charge('workUnits', Math.min(64, site.targetValueIds?.length ?? 0) * 512 + nativeContext.members.length);
      for (const row of scopedCallTargetRows(projection, node, index, demand)) {
        work.charge('workUnits');
        if (!row.inSelectedScope || row.reason || !row.targetFunctionId) {
          result.requirements.push(row.reason ?? 'target-not-in-selected-native-scope'); continue;
        }
        if (result.candidates.length === request.maxTargets) { result.requirements.push('native-target-result-cut'); break; }
        const target = index.functions.get(row.targetFunctionId), source = projection.inputIdentity;
        const declaration = { reference: row, ownerDigests: source.ownerDigests,
          conditional: false, scopeClosure: 'unknown', valueAuthority: 'existing-canonical-and-phase8-owners' };
        result.candidates.push({ targetEntityId: target.functionId, binaryId: target.inputIdentity.binaryId,
          address: row.address == null ? null : '0x' + BigInt(row.address).toString(16), family: 'register',
          evidenceIds: [node.id, ...(row.sourceBinding?.literal?.rangeFactIds ?? [])],
          requirements: ['normal-target-vs-trap-domain-not-qualified', 'selected-call-meaning-not-proven'],
          provenance: { schema: 'dispatch-owner-reference/v1', worldId: world.id, binaryId: target.inputIdentity.binaryId,
            artifactId: source.producerArtifactId, ownerRevision: NATIVE_DEMAND_DISPATCH_VERSION,
            id: createEntityId({ binaryId: source.binaryId, kind: 'native-demand-target', identity: declaration }), declaration } });
        await work.yieldIfNeeded();
      }
      if (readMemory && result.candidates.length < request.maxTargets) {
        const memory = await nativeMemoryDispatchCandidates(projection, node, demand,
          { ...request, maxTargets: request.maxTargets - result.candidates.length },
          { world, assumptions, work, readMemory, members: nativeContext.members });
        result.candidates.push(...memory.candidates); result.requirements.push(...memory.requirements);
      }
      if (queryPointer && result.candidates.length < request.maxTargets) {
        const cut = await nativeLoadCut(projection, node, work, request.maxHops);
        if (cut.cut) result.requirements.push('native-pointer-dependency-cut');
        const sources = new Set(); let slots = 0;
        for (const access of demand.memoryObjects?.accesses ?? []) {
          work.charge('workUnits');
          if (!cut.loads.has(access.nodeId) || access.widthBits !== 64) continue;
          const set = demand.objects.find(row => row.valueId === access.addressValueId)?.pointsTo;
          if (!set || set.top) { result.requirements.push('pointer-storage-address-open'); continue; }
          for (const target of set.targets) {
            work.charge('workUnits');
            if (target.rootKind !== 'absolute' || target.address == null || target.offsetRange?.min == null
              || target.offsetRange.min !== target.offsetRange.max) continue;
            const address = BigInt(target.address) + BigInt(target.offsetRange.min);
            if (address < 0n || address >= 1n << 64n) continue;
            const key = address.toString(); if (sources.has(key)) continue; sources.add(key);
            if (++slots > 4) { result.requirements.push('native-pointer-slot-cut'); break; }
            const value = await work.await(() => queryPointer({ storageAddress: key }, { world, assumptions, work }));
            work.checkpoint();
            if (value?.status !== 'completed') { result.requirements.push(value?.reason ?? 'native-loader-pointer-unavailable'); continue; }
            const input = projection.inputIdentity;
            if (value.schema !== 'scoped-apple-pointer-view/v1' || value.worldId !== world.id
              || value.assumptionsId !== assumptions.id || value.snapshotId !== input.snapshotId
              || value.source?.binaryId !== input.binaryId || value.source.sliceId !== input.sourceLocation?.sliceId
              || String(value.pointer?.storageAddress) !== key || value.exact !== false) contractFail('native-loader-pointer-scope-binding');
            result.requirements.push(...value.remaining, 'memory-content-stability-not-proven', 'possible-load-to-target-not-identity-proof');
            if (value.pointer.status !== 'recorded-site' || value.pointer.decoded?.bind || value.pointer.decoded?.target == null) continue;
            const decoded = BigInt(value.pointer.decoded.target);
            if (decoded < 0n || decoded >= 1n << 64n) contractFail('native-loader-target-width');
            const selected = nativeContext.members.filter(member => member.inputIdentity.binaryId === value.source.binaryId
              && member.inputIdentity.sourceLocation?.sliceId === value.source.sliceId
              && member.inputIdentity.sourceLocation?.start === unsignedAddress(decoded));
            if (!selected.length) result.requirements.push('loader-target-outside-selected-canonical-entries');
            for (const member of selected) {
              if (result.candidates.length >= request.maxTargets) { result.requirements.push('native-target-result-cut'); break; }
              // Raw owner declaration carries the independent source bytes, not
              // just an address digest. Authentication remains an obligation.
              const { cost: _cost, ...pointerView } = value;
              const declaration = { pointerView, access, callerInput: input, calleeInput: member.inputIdentity,
                relation: 'possible-memory-load-to-call-target', staticMemoryContentsProven: false };
              result.candidates.push({ targetEntityId: member.functionId, binaryId: member.inputIdentity.binaryId,
                address: '0x' + decoded.toString(16), family: value.pointer.decoded.authenticated ? 'authenticated-pointer' : 'chained-fixup',
                evidenceIds: [...new Set([node.id, access.nodeId, access.memoryEntityId, ...value.source.evidenceIds])],
                requirements: ['authenticated-normal-execution-unqualified', 'memory-content-stability-not-proven'],
                provenance: { schema: 'dispatch-owner-reference/v1', worldId: world.id, binaryId: member.inputIdentity.binaryId,
                  artifactId: value.source.artifactId, ownerRevision: value.source.ownerVersion,
                  id: createEntityId({ binaryId: input.binaryId, kind: 'native-load-pointer-target', identity: declaration }), declaration } });
            }
          }
          if (slots > 4) break;
          await work.yieldIfNeeded();
        }
      }
      if (result.candidates.length < request.maxTargets) {
        const thunks = await nativeThunkCandidates(result.candidates, index,
          { ...request, maxTargets: request.maxTargets - result.candidates.length }, { world, projection, work });
        result.candidates.push(...thunks.candidates); result.chains.push(...thunks.chains); result.requirements.push(...thunks.requirements);
      }
      return result;
    } };
}
