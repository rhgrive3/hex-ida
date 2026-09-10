import { sourceOf } from '../ast/nodes.js';
import { renderProvenanceRecord } from './contract.js';
import { readLineExpressionHistory } from './projection.js';
import { readSwitchLineHistory, readSwitchRenderHistory } from '../switch.js';
import { readSemanticSuppressionHistory, readSemanticStoreLineHistory, readSemanticStoreRenderHistory } from '../semantic-core.js';
import { readProjectedStateNormalization, projectedStateNormalizationExpected } from '../../semantics/compat/semantic-ir-v2-to-v1.js';
import { readFacadeStateNormalization } from '../../ir-core.js';

const PUBLIC_STATE_RULES = Object.freeze(['suppress-unused-entry-state', 'reorder-public-state-slot', 'renumber-public-state-version']);
const readPublicStateNormalization = ir => readFacadeStateNormalization(ir) || readProjectedStateNormalization(ir);

function readRenderedHistory(line, ir) {
  return readLineExpressionHistory(line, ir) || readSwitchLineHistory(line, ir)?.records
    || readSemanticStoreLineHistory(line, ir)?.records || null;
}

export const RENDER_PROVENANCE_VERSION = 1;

const DEFAULT_BUDGET = Object.freeze({
  maxEntities:4096,
  // Measured over the locked Phase 8 corpus: the densest legitimately merged
  // origin set reaches ~340 entries (induction + repeated view collapses on a
  // long chain). 512 keeps headroom while still bounding pathological merges.
  maxOriginsPerEntity:512,
  maxTransformRecords:1024,
});

const VALIDATION_ENTITY_STATES_LIMIT = 32;

const ORIGIN_KINDS = Object.freeze(['addresses', 'rows', 'ir', 'ssaDefs', 'ssaUses']);

/**
 * HEX-C4-03: some rendered lines carry no semantic claim at all — the function
 * signature, brace scaffolding, and goto labels are projections of structure,
 * not of instructions. They are classified explicitly as `structural` so the
 * hard-zero provenance-loss gate stays meaningful for lines that DO claim
 * semantics. Classification is intentionally narrow: anything outside these
 * exact shapes with no evidence fails closed as provenance loss.
 */
function structuralRole(kind, text) {
  if (kind === 'sig') return true;
  if (kind === 'ctrl') {
    const value = String(text ?? '').trim();
    return value === '{' || value === '}'
      || value === '} else {' || value === 'else {' || value === 'do {'
      || /^loc_\w+:$/.test(value);
  }
  return false;
}

function fail(code) { throw new TypeError(code); }

function nonEmptyString(value, code) {
  if (typeof value !== 'string' || value.length === 0) fail(code);
  return value;
}

function validateBudget(budget) {
  if (budget == null) return DEFAULT_BUDGET;
  if (typeof budget !== 'object' || Array.isArray(budget)) fail('phase8-render-provenance-budget-invalid');
  const resolved = { ...DEFAULT_BUDGET };
  for (const key of Object.keys(DEFAULT_BUDGET)) {
    const value = budget[key];
    if (value == null) continue;
    if (!Number.isSafeInteger(Number(value)) || Number(value) < 1) fail('phase8-render-provenance-budget-invalid');
    resolved[key] = Number(value);
  }
  return Object.freeze(resolved);
}

function canonicalScalar(value) {
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
  if (typeof value === 'string' && value.length > 0) return value;
  if (value == null) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : String(value);
}

function canonicalList(values, sortNumeric) {
  const seen = new Set();
  const out = [];
  for (const value of values ?? []) {
    const canonical = canonicalScalar(value);
    if (canonical == null) continue;
    const key = String(canonical);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(canonical);
  }
  out.sort((left, right) => {
    if (sortNumeric && typeof left === 'number' && typeof right === 'number') return left - right;
    return String(left).localeCompare(String(right), 'en');
  });
  return out;
}

function canonicalOrigins(raw) {
  return {
    rows: canonicalList(raw.rows, true),
    addresses: canonicalList(raw.addresses, false),
    ir: canonicalList(raw.ir, false),
    ssaRefs: [
      ...canonicalList((raw.ssaDefs ?? []).map((value) => `def:${value}`), false),
      ...canonicalList((raw.ssaUses ?? []).map((value) => `use:${value}`), false),
    ].sort((left, right) => left.localeCompare(right, 'en')),
  };
}

function mergeOrigins(left, right) {
  const rightCanonical = canonicalOrigins(right);
  return {
    rows:canonicalList([...left.rows, ...rightCanonical.rows], true),
    addresses:canonicalList([...left.addresses, ...rightCanonical.addresses], false),
    ir:canonicalList([...left.ir, ...rightCanonical.ir], false),
    ssaRefs:canonicalList([...left.ssaRefs, ...rightCanonical.ssaRefs], false),
  };
}

function originKey(kind, value) {
  return `${kind}:${String(value)}`;
}

function entityOriginEntries(origins) {
  return [
    ...origins.rows.map((value) => ['row', value]),
    ...origins.addresses.map((value) => ['addr', value]),
    ...origins.ir.map((value) => ['ir', value]),
    ...origins.ssaRefs.map((value) => ['ssa', value]),
  ];
}

function originKeySet(origins) {
  return new Set(entityOriginEntries(origins).map(([kind, value]) => originKey(kind, value)));
}

function recordFeedsEntity(record, entityOriginKeys, bound) {
  // An initial omission has no pre-existing C line and no known replacement.
  // Sharing an origin with a visible expression is not a producer edge.
  if (record.kind === 'display-suppression' || record.kind === 'public-state-normalization') return false;
  // A rewrite's consumed/remaining sources do not establish which C line
  // uses its result. In particular, a shared input is not a replacement edge.
  // Keep these records queryable without inventing a rendered consumer.
  if (record.originHistory) return bound;
  const recordOrigins = canonicalOrigins(record?.origin ?? {});
  return entityOriginEntries(recordOrigins)
    .some(([kind, value]) => entityOriginKeys.has(originKey(kind, value)));
}

function emptyOrigins() {
  return { rows:[], addresses:[], ir:[], ssaRefs:[] };
}

function originsTotalSize(origins) {
  return origins.rows.length + origins.addresses.length + origins.ir.length + origins.ssaRefs.length;
}

function truncateOrigins(origins, cap) {
  const truncated = emptyOrigins();
  let remaining = cap;
  for (const [kind, values] of [['rows', origins.rows], ['addresses', origins.addresses], ['ir', origins.ir], ['ssaRefs', origins.ssaRefs]]) {
    const taken = values.slice(0, Math.max(remaining, 0));
    truncated[kind] = taken;
    remaining -= taken.length;
  }
  return truncated;
}

function freezeOrigins(origins) {
  return Object.freeze({
    rows:Object.freeze(origins.rows),
    addresses:Object.freeze(origins.addresses),
    ir:Object.freeze(origins.ir),
    ssaRefs:Object.freeze(origins.ssaRefs),
  });
}

function expressionHistoryRecord(record, cap) {
  const removal = record.renderedRemoval;
  if (removal && (removal.scope !== 'pre-transform-render' || !['remove', 'suppress'].includes(removal.operation)
      || !Number.isSafeInteger(removal.lineIndex) || removal.lineIndex < 0
      || typeof removal.kind !== 'string' || !removal.kind || removal.kind.length > 128)) {
    fail('phase8-render-removal-invalid');
  }
  const before = canonicalOrigins(record.originHistory.before);
  const after = canonicalOrigins(record.originHistory.after);
  const truncated = record.originHistory.truncated === true || originsTotalSize(before) > cap || originsTotalSize(after) > cap;
  const consumed = [...originKeySet(truncateOrigins(before, cap))];
  const produced = [...originKeySet(truncateOrigins(after, cap))];
  const producedSet = new Set(produced);
  const boundedBefore = truncateOrigins(before, cap), boundedAfter = truncateOrigins(after, cap);
  const refs = [...boundedBefore.ssaRefs, ...boundedAfter.ssaRefs];
  return renderProvenanceRecord({
    kind:'expression-rewrite',
    proof:nonEmptyString(typeof record.evidence === 'string' ? record.evidence : record.evidence?.kind,
      'phase8-expression-proof-kind-required'),
    rule:nonEmptyString(record.rule, 'phase8-expression-rule-required'),
    phase:record.phase,
    before:record.before,
    after:record.after,
    valueId:record.valueId ?? null,
    ...(removal ? { renderedRemoval:Object.freeze({ scope:removal.scope, operation:removal.operation,
      lineIndex:removal.lineIndex, kind:removal.kind }) } : {}),
    targets:consumed,
    // These origins feed a line only through an observed producer binding.
    origin:{
      rows:canonicalList([...boundedBefore.rows, ...boundedAfter.rows], true),
      addresses:canonicalList([...boundedBefore.addresses, ...boundedAfter.addresses], false),
      ir:canonicalList([...boundedBefore.ir, ...boundedAfter.ir], false),
      ssaDefs:canonicalList(refs.filter(ref => ref.startsWith('def:')).map(ref => ref.slice(4)), false),
      ssaUses:canonicalList(refs.filter(ref => ref.startsWith('use:')).map(ref => ref.slice(4)), false),
    },
    originHistory:Object.freeze({
      scope:'replacement-expression-source',
      consumedRefs:Object.freeze(consumed),
      producedRefs:Object.freeze(produced),
      // A truncated after-set cannot prove that an origin was removed.
      elidedRefs:Object.freeze(truncated ? [] : consumed.filter(ref => !producedSet.has(ref))),
      completeness:truncated ? 'incomplete' : 'complete',
    }),
    renderedBinding:'unresolved',
  });
}

function publicStateRecord(event, cap) {
  const values = [...new Set([event.output, ...event.beforeInputs].filter(Boolean))];
  const definitions = [...new Set([event.source, ...values.map(value => value.def)].filter(Boolean))];
  const full = canonicalOrigins({ addresses:definitions.map(inst => inst.address), rows:definitions.map(inst => inst.row),
    ir:definitions.map(inst => inst.id), ssaDefs:values.map(value => value.id), ssaUses:[] });
  const bounded = truncateOrigins(full, cap), truncated = originsTotalSize(full) > cap || values.length > cap;
  const identity = value => Object.freeze(Object.fromEntries(Object.entries(value).map(([key, value]) => [key, canonicalScalar(value)])));
  const consumedRefs = Object.freeze(values.slice(0, cap).map(value => `ssa:def:${value.id}`));
  return { truncated, record:renderProvenanceRecord({ kind:'public-state-normalization',
    proof:'observed-public-state-normalization-not-equivalence', rule:event.kind,
    targets:consumedRefs, origin:{ addresses:bounded.addresses, rows:bounded.rows, ir:bounded.ir,
      ssaDefs:bounded.ssaRefs.map(ref => ref.slice(4)), ssaUses:[] },
    publicStateTransition:Object.freeze({ scope:'compatibility-public-state', ordinal:event.ordinal,
      before:event.identity ? identity(event.before) : event.before.id,
      after:event.identity ? identity(event.after) : event.after.id,
      slot:event.identity ? null : event.key,
      consumedRefs, producedRefs:Object.freeze([`ssa:def:${event.output.id}`]),
      completeness:truncated ? 'incomplete' : 'complete', canonicalValuesRetained:true }),
  }) };
}

export function buildRenderProvenance({ result, snapshotId = null, budget = null, shouldAbort = null } = {}) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) fail('phase8-render-provenance-result-required');
  if (!Array.isArray(result.lines)) fail('phase8-render-provenance-result-required');
  if (snapshotId != null && (typeof snapshotId !== 'string' || snapshotId.length === 0)) fail('phase8-render-provenance-snapshot-required');
  const resolvedBudget = validateBudget(budget);
  if (typeof shouldAbort === 'function' && shouldAbort() === true) return cancelledMap(resolvedBudget);

  const reasons = new Set();
  const publicState = readPublicStateNormalization(result.ir);
  if (projectedStateNormalizationExpected(result.ir) && !publicState) reasons.add('unavailable-public-state-history');
  if (publicState?.completeness === 'incomplete') reasons.add('incomplete-public-state-history');
  const suppressions = readSemanticSuppressionHistory(result);
  if (result.semanticSuppressionHistory?.completeness === 'incomplete') reasons.add('incomplete-semantic-suppression-history');
  if ((result.semanticSuppressionHistory || result.ctx?.suppressed?.length) && !suppressions) {
    reasons.add('unavailable-semantic-suppression-history');
  }
  if (result.expressionHistoryBinding?.completeness === 'incomplete') reasons.add('incomplete-expression-binding');
  const switches = readSwitchRenderHistory(result);
  if (result.switchRenderHistory?.completeness === 'incomplete') reasons.add('incomplete-switch-history');
  if (result.switchRenderHistory && !switches && !result.cAst) reasons.add('unavailable-switch-history');
  const initialStores = readSemanticStoreRenderHistory(result);
  if (result.semanticStoreRenderHistory?.completeness === 'incomplete') reasons.add('incomplete-initial-store-history');
  if (result.semanticStoreRenderHistory && !initialStores && !result.cAst) reasons.add('unavailable-initial-store-history');
  if (result.phase8Projection?.history?.completeness === 'incomplete') reasons.add('incomplete-projection-history');
  const truncatedScopes = [];
  let entitiesTruncated = 0;
  let ledgerTruncated = 0;

  const rewritten = Array.isArray(result.rewriteProof) ? result.rewriteProof : [];
  const expressionRecords = switches || initialStores
    ? [...new Set([...rewritten, ...(switches?.records || []), ...(initialStores?.records || [])])] : rewritten;
  const projection = result.phase8Projection;
  const rawRecords = Array.isArray(projection?.history?.transforms) ? projection.history.transforms
    : Array.isArray(projection?.transforms) ? projection.transforms : [];
  const suppressionRecords = suppressions?.records ?? [];
  const publicStateEvents = publicState?.events || [];
  const rawRecordCount = expressionRecords.length + rawRecords.length + suppressionRecords.length + publicStateEvents.length;
  const ledgerRecords = [];
  for (const record of suppressionRecords.slice(0, Math.max(0, resolvedBudget.maxTransformRecords - ledgerRecords.length))) {
    ledgerRecords.push(renderProvenanceRecord(record));
  }
  const historyProducers = new Map();
  let unavailableExpressionHistory = 0;
  for (const record of expressionRecords) {
    if (typeof shouldAbort === 'function' && shouldAbort() === true) return cancelledMap(resolvedBudget);
    if (!record?.originHistory?.before || !record?.originHistory?.after) {
      unavailableExpressionHistory++;
      continue;
    }
    if (ledgerRecords.length >= resolvedBudget.maxTransformRecords) break;
    const normalized = expressionHistoryRecord(record, resolvedBudget.maxOriginsPerEntity);
    ledgerRecords.push(normalized);
    historyProducers.set(normalized, record);
    if (normalized.originHistory.completeness !== 'complete') {
      truncatedScopes.push('expression-history-origins');
      reasons.add('truncated');
    }
  }
  if (unavailableExpressionHistory) reasons.add('missing-expression-history');
  for (const record of rawRecords.slice(0, Math.max(0, resolvedBudget.maxTransformRecords - ledgerRecords.length))) {
    if (record?.kind === 'public-state-normalization' || record?.publicStateTransition) {
      reasons.add('unissued-public-state-history'); continue;
    }
    if (record?.kind === 'display-suppression' || record?.suppressedRender) {
      reasons.add('unissued-semantic-suppression-history'); continue;
    }
    ledgerRecords.push(renderProvenanceRecord(record));
  }
  // Preserve the existing ledger's budget priority; append this newly observed
  // class without displacing previously retained omission/expression records.
  for (const event of publicStateEvents.slice(0, Math.max(0, resolvedBudget.maxTransformRecords - ledgerRecords.length))) {
    if (typeof shouldAbort === 'function' && shouldAbort() === true) return cancelledMap(resolvedBudget);
    const normalized = publicStateRecord(event, resolvedBudget.maxOriginsPerEntity);
    ledgerRecords.push(normalized.record);
    if (normalized.truncated) { reasons.add('truncated'); truncatedScopes.push('public-state-origins'); }
  }
  if (rawRecordCount > ledgerRecords.length + unavailableExpressionHistory) {
    ledgerTruncated = rawRecordCount - ledgerRecords.length - unavailableExpressionHistory;
    truncatedScopes.push('ledger');
    reasons.add('truncated');
  }

  const entities = {};
  const reverse = new Map();
  const entityRefsByRecord = ledgerRecords.map(() => new Set());
  const boundLines = [];
  const lineCount = Math.min(result.lines.length, resolvedBudget.maxEntities);
  if (result.lines.length > lineCount) {
    entitiesTruncated = result.lines.length - lineCount;
    truncatedScopes.push('entities');
    reasons.add('truncated');
  }

  for (let index = 0; index < lineCount; index += 1) {
    if (typeof shouldAbort === 'function' && shouldAbort() === true) return cancelledMap(resolvedBudget);
    const line = result.lines[index];
    if (!line || typeof line !== 'object' || Array.isArray(line)) fail('phase8-render-provenance-entity-source-invalid');
    const entityKey = `L${index}:${line.kind ?? 'null'}`;
    const raw = sourceOf(line.source || (switches ? { address:line.addr, row:line.row } : null));
    const binding = readRenderedHistory(line, result.ir);
    const boundRecords = new Set(binding ?? []);
    if (binding) boundLines.push([line, binding]);
    let origins = canonicalOrigins(raw);
    let entityOriginKeys = originKeySet(origins);

    const recordRefs = [];
    for (let recordIndex = 0; recordIndex < ledgerRecords.length; recordIndex += 1) {
      const record = ledgerRecords[recordIndex];
      if (!recordFeedsEntity(record, entityOriginKeys, boundRecords.has(historyProducers.get(record)))) continue;
      recordRefs.push(recordIndex);
      entityRefsByRecord[recordIndex].add(entityKey);
      origins = mergeOrigins(origins, record.origin);
      entityOriginKeys = originKeySet(origins);
    }

    const entityReasons = [];
    let complete = originsTotalSize(origins) > 0;
    let role = 'semantic';
    if (originsTotalSize(origins) > resolvedBudget.maxOriginsPerEntity) {
      origins = truncateOrigins(origins, resolvedBudget.maxOriginsPerEntity);
      entityReasons.push('truncated');
      truncatedScopes.push('origins');
      reasons.add('truncated');
      complete = false;
    }
    if (!complete && structuralRole(line.kind, line.text)) {
      role = 'structural';
      complete = true;
    }
    if (!complete) {
      entityReasons.push('provenance-loss');
      reasons.add('provenance-loss');
    }

    entities[entityKey] = Object.freeze({
      entityKey,
      lineIndex:index,
      kind:line.kind ?? null,
      role,
      origins:freezeOrigins(origins),
      complete,
      reasons:Object.freeze(entityReasons),
      recordRefs:Object.freeze(recordRefs),
    });
    for (const [kind, value] of entityOriginEntries(origins)) {
      const key = originKey(kind, value);
      if (!reverse.has(key)) reverse.set(key, new Set());
      reverse.get(key).add(entityKey);
    }
  }

  const reverseObject = {};
  for (const key of [...reverse.keys()].sort((left, right) => left.localeCompare(right, 'en'))) {
    reverseObject[key] = Object.freeze([...reverse.get(key)].sort((left, right) => left.localeCompare(right, 'en')));
  }

  const ledger = ledgerRecords.map((record, recordIndex) => Object.freeze({
    ...record,
    ...(record.originHistory ? { renderedBinding:entityRefsByRecord[recordIndex].size ? 'producer-bound' : 'unresolved' } : {}),
    origin:Object.freeze({
      addresses:Object.freeze(canonicalList(record.origin.addresses, false)),
      rows:Object.freeze(canonicalList(record.origin.rows, true)),
      ir:Object.freeze(canonicalList(record.origin.ir, false)),
      ssaDefs:Object.freeze(canonicalList(record.origin.ssaDefs, false)),
      ssaUses:Object.freeze(canonicalList(record.origin.ssaUses, false)),
    }),
    producedRefs:Object.freeze([...entityRefsByRecord[recordIndex]].sort((left, right) => left.localeCompare(right, 'en'))),
    // Transform-local render tombstones never identify a current line or a
    // canonical semantic entity. Public copied metadata cannot bind one.
    removedRefs:Object.freeze(record.renderedRemoval && entityRefsByRecord[recordIndex].size
      ? [`before:${recordIndex}:L${record.renderedRemoval.lineIndex}:${record.renderedRemoval.kind}`] : []),
    version:RENDER_PROVENANCE_VERSION,
  }));

  // Canonical origin -> transform record. Kept separate from origin -> line:
  // an elided source can have a history even when no rendered consumer is known.
  const transformReverse = {};
  for (let index = 0; index < ledger.length; index++) {
    const record = ledger[index];
    const refs = record.originHistory
      ? [...record.originHistory.consumedRefs, ...record.originHistory.producedRefs]
      : [...originKeySet(canonicalOrigins(record.origin))];
    for (const ref of new Set(refs)) (transformReverse[ref] ??= []).push(index);
  }
  for (const refs of Object.values(transformReverse)) Object.freeze(refs);

  let completeness = 'complete';
  if (publicState && readPublicStateNormalization(result.ir) !== publicState) reasons.add('stale-public-state-history');
  if (suppressions && readSemanticSuppressionHistory(result) !== suppressions) reasons.add('stale-semantic-suppression-history');
  if (boundLines.some(([line, binding]) => readRenderedHistory(line, result.ir) !== binding)) {
    reasons.add('stale-expression-binding');
  }
  if (snapshotId == null) {
    reasons.add('missing-snapshot');
  }
  if (reasons.size > 0) completeness = 'incomplete';

  const provenanceLoss = Object.values(entities).filter((entity) => !entity.complete).length;
  const structuralEntities = Object.values(entities).filter((entity) => entity.role === 'structural').length;
  return Object.freeze({
    version:RENDER_PROVENANCE_VERSION,
    snapshotId,
    entities:Object.freeze(entities),
    reverse:Object.freeze(reverseObject),
    transformReverse:Object.freeze(transformReverse),
    ledger:Object.freeze(ledger),
    transformCount:rawRecordCount,
    budget:Object.freeze({
      ...resolvedBudget,
      truncated:truncatedScopes.length > 0,
      truncatedScopes:Object.freeze(truncatedScopes),
    }),
    completeness,
    reasons:Object.freeze([...reasons]),
    counts:Object.freeze({
      entities:Object.keys(entities).length,
      entitiesTruncated,
      transformRecords:rawRecordCount,
      ledgerTruncated,
      provenanceLoss,
      structuralEntities,
      unavailableExpressionHistory,
    }),
  });
}

function cancelledMap(resolvedBudget) {
  return Object.freeze({
    version:RENDER_PROVENANCE_VERSION,
    snapshotId:null,
    entities:Object.freeze({}),
    reverse:Object.freeze({}),
    transformReverse:Object.freeze({}),
    ledger:Object.freeze([]),
    transformCount:0,
    budget:Object.freeze({ ...resolvedBudget, truncated:false, truncatedScopes:Object.freeze([]) }),
    completeness:'incomplete',
    reasons:Object.freeze(['cancelled']),
    counts:Object.freeze({
      entities:0,
      entitiesTruncated:0,
      transformRecords:0,
      ledgerTruncated:0,
      provenanceLoss:0,
      structuralEntities:0,
    }),
  });
}

export function validateRenderProvenance(provenanceMap, { snapshotId = null, shouldAbort = null } = {}) {
  if (!provenanceMap || typeof provenanceMap !== 'object' || Array.isArray(provenanceMap)) fail('phase8-render-provenance-map-invalid');
  if (provenanceMap.version !== RENDER_PROVENANCE_VERSION) fail('phase8-render-provenance-map-version-invalid');
  if (!provenanceMap.entities || typeof provenanceMap.entities !== 'object' || Array.isArray(provenanceMap.entities)) fail('phase8-render-provenance-map-invalid');
  if (!Array.isArray(provenanceMap.ledger)) fail('phase8-render-provenance-map-invalid');

  const reasons = new Set(provenanceMap.reasons ?? []);
  if (typeof shouldAbort === 'function' && shouldAbort() === true) reasons.add('cancelled');
  if (snapshotId != null) {
    if (provenanceMap.snapshotId == null) reasons.add('missing-snapshot');
    else if (provenanceMap.snapshotId !== snapshotId) reasons.add('stale-snapshot');
  }
  let validationCancelled = reasons.has('cancelled');
  if (!validationCancelled) {
    for (const record of provenanceMap.ledger) {
      if (typeof shouldAbort === 'function' && shouldAbort() === true) {
        reasons.add('cancelled'); validationCancelled = true; break;
      }
      if (record?.kind === 'display-suppression' || record?.suppressedRender) {
        const omission = record.suppressedRender;
        if (record.kind !== 'display-suppression' || record.proof !== 'observed-display-event-not-semantic-equivalence'
            || !['omit-mechanical-stack-spill', 'omit-runtime-noise-call'].includes(record.rule)
            || omission?.scope !== 'initial-semantic-render' || omission.operation !== 'omit'
            || typeof omission.reason !== 'string' || !omission.reason
            || record.originHistory || record.renderedRemoval
            || !Array.isArray(record.producedRefs) || record.producedRefs.length
            || !Array.isArray(record.removedRefs) || record.removedRefs.length) reasons.add('invalid-semantic-suppression-history');
      }
      if (record?.kind === 'public-state-normalization' || record?.publicStateTransition) {
        const transition = record.publicStateTransition;
        const slot = record.rule === 'reorder-public-state-slot';
        const identityKeys = ['reg', 'stateKey', 'version', 'compatPublicIdentity', 'compatDerived'];
        const validIdentity = identity => identity && typeof identity === 'object' && !Array.isArray(identity)
          && Object.keys(identity).length === identityKeys.length && identityKeys.every(key => Object.hasOwn(identity, key)
            && (identity[key] === null || (key === 'version' ? Number.isSafeInteger(identity[key]) && identity[key] >= 0 : typeof identity[key] === 'string')));
        const validValueId = value => Number.isSafeInteger(value) && value >= 0 || typeof value === 'string' && value.length > 0;
        if (record.kind !== 'public-state-normalization' || record.proof !== 'observed-public-state-normalization-not-equivalence'
            || !PUBLIC_STATE_RULES.includes(record.rule) || transition?.scope !== 'compatibility-public-state'
            || transition.canonicalValuesRetained !== true || !Number.isSafeInteger(transition.ordinal) || transition.ordinal < 0
            || !['complete', 'incomplete'].includes(transition.completeness)
            || ['consumedRefs', 'producedRefs'].some(key => !Array.isArray(transition[key]) || !transition[key].length
              || transition[key].some(ref => typeof ref !== 'string' || !/^ssa:def:.+/.test(ref))
              || new Set(transition[key]).size !== transition[key].length)
            || transition.producedRefs.length !== 1 || !transition.consumedRefs.includes(transition.producedRefs[0])
            || (slot ? !Number.isSafeInteger(transition.slot) || transition.slot < 0
              || !validValueId(transition.before) || !validValueId(transition.after) || transition.before === transition.after
              : transition.slot !== null || !validIdentity(transition.before) || !validIdentity(transition.after))
            || (!slot && record.rule === 'renumber-public-state-version' && (transition.before.version === transition.after.version
              || identityKeys.filter(key => key !== 'version').some(key => transition.before[key] !== transition.after[key])))
            || (record.rule === 'suppress-unused-entry-state' && (typeof transition.before.reg !== 'string' || !transition.before.reg
              || transition.after.reg !== null || transition.after.stateKey !== null || transition.after.version !== 0
              || transition.after.compatDerived !== 'unused-entry-state-shadow'))
            || record.originHistory || record.renderedRemoval || record.suppressedRender
            || !Array.isArray(record.producedRefs) || record.producedRefs.length
            || !Array.isArray(record.removedRefs) || record.removedRefs.length) reasons.add('invalid-public-state-history');
      }
      const history = record?.originHistory;
      if (!history) continue;
      const removal = record.renderedRemoval;
      if (removal) {
        const valid = removal.scope === 'pre-transform-render' && ['remove', 'suppress'].includes(removal.operation)
          && Number.isSafeInteger(removal.lineIndex) && removal.lineIndex >= 0
          && typeof removal.kind === 'string' && removal.kind.length > 0 && removal.kind.length <= 128;
        const expected = valid && record.renderedBinding === 'producer-bound'
          ? [`before:${provenanceMap.ledger.indexOf(record)}:L${removal.lineIndex}:${removal.kind}`] : [];
        if (!valid || !Array.isArray(record.removedRefs) || record.removedRefs.length !== expected.length
            || expected.some((ref, index) => record.removedRefs[index] !== ref || Object.hasOwn(provenanceMap.entities, ref))) {
          reasons.add('invalid-render-removal');
        }
      } else if (record.removedRefs?.length) reasons.add('invalid-render-removal');
      const fields = ['consumedRefs', 'producedRefs', 'elidedRefs'];
      if (history.scope !== 'replacement-expression-source'
          || !['complete', 'incomplete'].includes(history.completeness)
          || !['unresolved', 'producer-bound'].includes(record.renderedBinding)
          || fields.some(field => !Array.isArray(history[field])
            || history[field].some(ref => typeof ref !== 'string' || !/^(row|addr|ir|ssa):.+/.test(ref))
            || new Set(history[field]).size !== history[field].length)) {
        reasons.add('invalid-expression-history');
        continue;
      }
      if (history.completeness !== 'complete') reasons.add('incomplete-expression-history');
      if (!Array.isArray(record.producedRefs)
          || (record.renderedBinding === 'producer-bound') !== (record.producedRefs.length > 0)
          || record.producedRefs.some(ref => !provenanceMap.entities[ref]?.recordRefs?.includes(provenanceMap.ledger.indexOf(record)))) {
        reasons.add('inconsistent-expression-binding');
      }
      const expected = history.completeness === 'complete'
        ? history.consumedRefs.filter(ref => !history.producedRefs.includes(ref)) : [];
      if (expected.length !== history.elidedRefs.length || expected.some(ref => !history.elidedRefs.includes(ref))) {
        reasons.add('inconsistent-expression-history');
      }
    }
  }
  if (!validationCancelled) {
    for (const entity of Object.values(provenanceMap.entities)) {
      if (typeof shouldAbort === 'function' && shouldAbort() === true) {
        reasons.add('cancelled');
        validationCancelled = true;
        break;
      }
      if (entity?.complete === false) {
        reasons.add('provenance-loss');
        for (const reason of entity.reasons ?? []) reasons.add(reason);
      }
    }
  }
  if (provenanceMap.budget?.truncated === true) reasons.add('truncated');

  const entityEntries = Object.values(provenanceMap.entities);
  const entityStates = validationCancelled ? [] : entityEntries.slice(0, VALIDATION_ENTITY_STATES_LIMIT).map((entity) => Object.freeze({
    entityKey:entity.entityKey,
    complete:entity.complete === true,
    reasons:Object.freeze([...(entity.reasons ?? [])]),
  }));

  return Object.freeze({
    state:reasons.size === 0 ? 'complete' : 'incomplete',
    entityStates:Object.freeze(entityStates),
    entityStatesTruncated:validationCancelled ? entityEntries.length : Math.max(entityEntries.length - entityStates.length, 0),
    reasons:Object.freeze([...reasons]),
    counts:Object.freeze({
      entities:entityEntries.length,
      transformRecords:Array.isArray(provenanceMap.ledger) ? provenanceMap.ledger.length : 0,
      provenanceLoss:provenanceMap.counts?.provenanceLoss
        ?? entityEntries.filter((entity) => entity?.complete === false).length,
      ...(provenanceMap.counts ?? {}),
    }),
  });
}
