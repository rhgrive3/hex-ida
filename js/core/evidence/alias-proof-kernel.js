/** One-byte address relations, conditional on independently replayed integer
 * values. The canonical alias owner still owns relation construction. This
 * rule never establishes pointer validity or aliases of larger accesses. */
import { INTEGER_FRAGMENT_KIND } from './arm64-integer-fragment.js';
import { integerFragmentProofScope } from './range-proof-kernel.js';
import { stableStringify } from '../identity/index.js';
import { snapshotContractData, recordFields, exactString } from '../identity/structured.js';
import { assertScopedAnalysisWork } from '../budgets/scoped-work.js';

export const ALIAS_PROOF_KIND = 'scpa-single-byte-address-alias';
export const ALIAS_PROOF_SCHEMA = 'scpa-single-byte-address-alias/v1';
export const ALIAS_PROOF_VERSION = '1.0.0';
export const ALIAS_PROOF_INTERPRETATION = 'one-byte-cells-at-integer-addresses; pointer-validity-and-memory-effects-unproved';
const same = (a, b) => stableStringify(a) === stableStringify(b);

export function supportedAliasCell(object, fragment) {
  const status = object?.ownerStatus, set = object?.pointsTo, t = set?.targets?.[0], constant = fragment?.conclusion?.constant;
  if (object?.valueId !== fragment?.semanticValueId || status?.completeness !== 'complete' || status.stopReason !== null
    || status.snapshotId !== fragment?.snapshotId || object.unknowns?.length !== 0 || set?.top !== false
    || set.lossReasons?.length !== 0 || set.targets?.length !== 1 || fragment?.conclusion?.bits !== 64
    || typeof constant !== 'string' || !/^(0|[1-9][0-9]{0,19})$/.test(constant)
    || BigInt(constant) >= 1n << 64n || t?.rootKind !== 'absolute' || t.rootIdentity !== null || t.rootEntityId !== null
    || t.widthBits !== 64 || t.addressSpace !== 'memory' || t.address !== constant
    || String(t.offsetRange?.min) !== '0' || String(t.offsetRange?.max) !== '0' || t.offsetRange?.exact !== true) return false;
  return true;
}

export function registerAliasProofKernel(registry, { work, compareCanonicalCells, onResult = null } = {}) {
  assertScopedAnalysisWork(work);
  return registry.register({ id: 'scpa.checked-single-byte-alias', version: ALIAS_PROOF_VERSION,
    semanticKind: ALIAS_PROOF_KIND, level: 'derivation-checked', execution: 'local-bounded', check: (node, context) => {
      work.charge('workUnits', 16);
      const reply = (status, reason, detail = {}) => {
        const result = { status, reason, detail, worldId: context.world.id, assumptionsId: context.assumptions.id,
          nodeId: node.id, propositionChecked: true }; onResult?.(result); return result;
      };
      const rule = snapshotContractData(node.payload.rule, { maxBytes: 16384, maxNodes: 256 });
      recordFields(rule, ['schema', 'version', 'scope', 'interpretation', 'premises', 'conclusion'], 'alias-proof-rule-fields');
      if (rule.schema !== ALIAS_PROOF_SCHEMA || rule.version !== ALIAS_PROOF_VERSION) return reply('unknown', 'alias-proof-rule-unsupported');
      if (rule.scope?.worldId !== context.world.id || rule.scope?.assumptionsId !== context.assumptions.id) return reply('rejected', 'alias-proof-scope-mismatch');
      if (context.assumptions.satisfiability === 'inconsistent') return reply('unknown', 'alias-proof-inconsistent-assumptions');
      if (rule.interpretation !== ALIAS_PROOF_INTERPRETATION) return reply('rejected', 'alias-proof-interpretation-mismatch');
      recordFields(rule.premises, ['leftInteger', 'rightInteger', 'leftObject', 'rightObject'], 'alias-proof-premise-fields');
      recordFields(rule.conclusion, ['leftValueId', 'rightValueId', 'relation', 'addressSpace', 'widthBytes'], 'alias-proof-conclusion-fields');
      const conclusion = rule.conclusion, ids = Object.values(rule.premises);
      if (new Set(ids).size !== 4 || ids.includes(node.id)) return reply('rejected', 'alias-proof-independent-premises-required');
      if (!['no', 'must'].includes(conclusion.relation) || conclusion.addressSpace !== 'memory' || conclusion.widthBytes !== 1)
        return reply('unknown', 'alias-proof-only-single-byte-address-cells-supported');
      const objects = [], addresses = [];
      for (const side of ['left', 'right']) {
        const integerId = rule.premises[`${side}Integer`], objectId = rule.premises[`${side}Object`];
        exactString(integerId, 'alias-integer-premise'); exactString(objectId, 'alias-object-premise');
        const integer = context.getNode(integerId), object = context.getNode(objectId);
        const checkedInteger = context.getCheckedPremise?.(node.id, integerId), checkedObject = context.getCheckedPremise?.(node.id, objectId);
        if (!checkedInteger || !checkedObject) return reply('unknown', 'alias-proof-premises-not-replayed');
        const f = integer?.payload.fragment, o = object?.payload.projection, detail = checkedInteger.detail;
        if (integer?.semanticKind !== INTEGER_FRAGMENT_KIND || object?.semanticKind !== 'scpa-demand-object-view'
          || !['derivation-checked', 'independent-proof-checked'].includes(checkedInteger.checker?.level)
          || checkedObject.checker?.level !== 'source-binding-checked') return reply('unknown', 'alias-proof-premise-check-level-insufficient');
        if (!f || !same(rule.scope, integerFragmentProofScope(f)) || object.payload.functionId !== f.functionId
          || node.binaryId !== f.source.binaryId || integer.binaryId !== f.source.binaryId || object.binaryId !== f.source.binaryId
          || conclusion[`${side}ValueId`] !== f.semanticValueId) return reply('rejected', 'alias-proof-source-point-or-value-mismatch');
        if (!supportedAliasCell(o, f)) return reply('unknown', 'alias-proof-absolute-singleton-owner-required');
        if (detail?.bits !== 64 || !same(detail.domain, rule.scope.domain) || detail.constant !== f.conclusion.constant
          || detail.lower !== detail.constant || detail.upper !== detail.constant)
          return reply('unknown', 'alias-proof-integer-singleton-not-derived');
        objects.push(o); addresses.push(detail.constant);
      }
      if (typeof compareCanonicalCells !== 'function') return reply('unknown', 'alias-proof-canonical-alias-owner-unbound');
      const actual = compareCanonicalCells(objects[0], objects[1]);
      if (!['no', 'must'].includes(actual?.relation) || actual.status?.completeness !== 'complete')
        return reply('unknown', 'alias-proof-canonical-relation-unproved');
      // Independently verify the declared one-byte theorem from the two
      // byte-derived integers. Repeating a faulty alias-owner verdict alone
      // must not become proof, even when the proposed conclusion matches it.
      if (actual.relation !== (addresses[0] === addresses[1] ? 'must' : 'no'))
        return reply('rejected', 'alias-proof-canonical-relation-contradicts-checked-cells');
      if (actual.relation !== conclusion.relation) return reply('rejected', 'alias-proof-conclusion-contradicts-derived-addresses');
      return reply('verified', 'independent-integers-and-canonical-alias-rule', { scope: rule.scope, proposition: conclusion,
        interpretation: rule.interpretation, reasonCodes: actual.reasonCodes, analyzer: actual.proof?.analyzer ?? null,
        pointerValidity: 'unproved', memoryAccessFootprint: 'unproved', largerAccessAlias: 'unproved', reachability: 'unproved' });
    } });
}
