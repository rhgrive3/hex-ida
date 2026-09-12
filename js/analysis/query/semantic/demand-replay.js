/** Bounded canonical-owner replay for the demand certificate. The checker
 * rebuilds current owner views; a serialized graph or matching checksum alone
 * cannot satisfy these rules. ISA/oracle and path-feasibility proof stay open.
 */
import { registerIntegerFragmentChecker } from '../../../core/evidence/arm64-integer-fragment.js';
import { CertificateCheckerRegistry } from '../../../core/evidence/certificate.js';
import { jsonSafe, stableStringify, lossyTypeWitness } from '../../../core/identity/index.js';
import { contractFail } from '../../../core/identity/structured.js';
import { assertScopedAnalysisWork } from '../../../core/budgets/scoped-work.js';

const same = (a, b) => stableStringify(jsonSafe(a)) === stableStringify(jsonSafe(b));
export async function prepareDemandOwnerReplay(bundle, graph, { world, assumptions, work, loadOwner, isCurrent } = {}) {
  assertScopedAnalysisWork(work);
  if (!Array.isArray(bundle.ownerInputs) || bundle.ownerInputs.length > 8 || typeof loadOwner !== 'function'
    || bundle.worldId !== world.id || bundle.assumptionsId !== assumptions.id || isCurrent?.() !== true) contractFail('demand-owner-replay-binding');
  const loaded = new Map(), unavailable = [], mismatches = [], counters = { ownerReferences: 0, valueFacts: 0, objectViews: 0, integerDerivations: 0, integerUnknown: 0, integerRejected: 0 };
  try {
    for (const input of bundle.ownerInputs) {
      work.charge('workUnits');
      if (typeof input.locator !== 'string' || !input.precision) { unavailable.push({ reason: 'legacy-answer-owner-request-missing' }); continue; }
      const owner = await loadOwner(input.locator, work, input.precision);
      if (owner?.projection) {
        const identity = owner.projection.inputIdentity;
        if (identity.functionId !== input.inputIdentity.functionId || !same(identity.ownerDigests, input.inputIdentity.ownerDigests)) {
          owner.projection.release(); mismatches.push({ functionId: input.inputIdentity.functionId, reason: 'current-owner-digests-differ' });
        } else loaded.set(identity.functionId, owner);
      } else unavailable.push({ functionId: input.inputIdentity.functionId, reason: owner?.reason ?? 'current-demand-owner-unavailable' });
      work.checkpoint(); if (isCurrent() !== true) contractFail('demand-owner-replay-stale');
      await work.yieldIfNeeded();
    }
    const checkers = new CertificateCheckerRegistry();
    const checked = (node, status, reason) => ({ worldId: world.id, assumptionsId: assumptions.id,
      nodeId: node.id, propositionChecked: true, status, reason });
    checkers.register({ id: 'scpa.current-owner-reference', version: '1.0.0', semanticKind: 'scpa-canonical-owner-reference', level: 'source-binding-checked', execution: 'local-bounded',
      check: async node => {
        work.charge('workUnits');
        const ref = node.payload.reference, owner = loaded.get(ref?.functionId);
        if (!owner) return checked(node, mismatches.some(row => row.functionId === ref?.functionId) ? 'rejected' : 'unknown', 'current-canonical-owner-binding-unavailable');
        const id = owner.projection.entityReference(ref.owner, ref.entityId);
        if (!id) return checked(node, 'rejected', 'referenced-current-owner-row-missing');
        const source = owner.projection.source(id), current = owner.projection.present(id).reference;
        const valid = current.ownerDigest === ref.ownerDigest && same(source, node.payload.ownerRow)
          && same(lossyTypeWitness(source), node.payload.originalTypes);
        counters.ownerReferences++;
        return checked(node, valid ? 'verified' : 'rejected', valid ? 'current-canonical-row-replayed' : 'canonical-row-or-type-witness-mismatch');
      } });
    checkers.register({ id: 'scpa.current-phase8-range', version: '1.0.0', semanticKind: 'scpa-demand-range-fact', level: 'source-binding-checked', execution: 'local-bounded',
      check: async node => {
        work.charge('workUnits');
        const payload = node.payload, functionId = payload.ownerIdentity?.functionId;
        const range = loaded.get(functionId)?.demand.ranges;
        if (!range) return checked(node, mismatches.some(row => row.functionId === functionId) ? 'rejected' : 'unknown', 'current-range-owner-unavailable');
        const fact = range.values.find(row => row.localId === payload.value?.localId);
        if (!fact) return checked(node, 'unknown', 'value-outside-current-demand');
        counters.valueFacts++;
        const valid = same(range.ownerIdentity, payload.ownerIdentity) && same(fact, payload.value)
          && same(range.bindings, payload.bindings) && same(lossyTypeWitness(fact), payload.originalTypes);
        return checked(node, valid ? 'verified' : 'rejected', valid ? 'current-phase8-owner-fact-matches; independent-derivation-and-ISA-profile-unqualified' : 'phase8-demand-fact-mismatch');
      } });
    checkers.register({ id: 'scpa.current-object-view', version: '1.0.0', semanticKind: 'scpa-demand-object-view', level: 'source-binding-checked', execution: 'local-bounded',
      check: async node => {
        work.charge('workUnits');
        const object = loaded.get(node.payload.functionId)?.demand.objects.find(row => row.valueId === node.payload.projection?.valueId);
        if (!object) return checked(node, 'unknown', 'current-object-owner-unavailable');
        counters.objectViews++;
        const valid = same(object, node.payload.projection) && same(lossyTypeWitness(object), node.payload.originalTypes);
        return checked(node, valid ? 'verified' : 'rejected', valid ? 'current-points-to-partition-projection-replayed; no-alias-authority' : 'object-projection-mismatch');
      } });
    registerIntegerFragmentChecker(checkers, { work, onResult: result => {
      if (result.status === 'verified') counters.integerDerivations++;
      else if (result.status === 'rejected') counters.integerRejected++;
      else counters.integerUnknown++;
    } });
    return { checkers, counters, unavailable, mismatches,
      resolveCanonicalNode: async id => {
        work.checkpoint(); if (isCurrent() !== true) contractFail('demand-owner-replay-stale');
        // Shape/integrity binding is distinct from the rule checks above. The
        // rule owns whether the stored row agrees with freshly loaded inputs.
        return { worldId: world.id, node: graph.getNode(id) };
      },
      close: () => { for (const owner of loaded.values()) owner.projection.release(); loaded.clear(); } };
  } catch (error) { for (const owner of loaded.values()) owner.projection.release(); throw error; }
}
