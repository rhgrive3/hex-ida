import { sourceOf } from '../ast/nodes.js';
import { renderProvenanceRecord } from './contract.js';

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

function recordFeedsEntity(record, entityOriginKeys) {
  // A rewrite's consumed/remaining sources do not establish which C line
  // uses its result. In particular, a shared input is not a replacement edge.
  // Keep these records queryable without inventing a rendered consumer.
  if (record.originHistory) return false;
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
  const before = canonicalOrigins(record.originHistory.before);
  const after = canonicalOrigins(record.originHistory.after);
  const truncated = record.originHistory.truncated === true || originsTotalSize(before) > cap || originsTotalSize(after) > cap;
  const consumed = [...originKeySet(truncateOrigins(before, cap))];
  const produced = [...originKeySet(truncateOrigins(after, cap))];
  const producedSet = new Set(produced);
  return renderProvenanceRecord({
    kind:'expression-rewrite',
    proof:nonEmptyString(typeof record.evidence === 'string' ? record.evidence : record.evidence?.kind,
      'phase8-expression-proof-kind-required'),
    rule:nonEmptyString(record.rule, 'phase8-expression-rule-required'),
    phase:record.phase,
    before:record.before,
    after:record.after,
    valueId:record.valueId ?? null,
    targets:consumed,
    // This is a transform history, not evidence for an inferred rendered line.
    origin:{},
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

export function buildRenderProvenance({ result, snapshotId = null, budget = null, shouldAbort = null } = {}) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) fail('phase8-render-provenance-result-required');
  if (!Array.isArray(result.lines)) fail('phase8-render-provenance-result-required');
  if (snapshotId != null && (typeof snapshotId !== 'string' || snapshotId.length === 0)) fail('phase8-render-provenance-snapshot-required');
  const resolvedBudget = validateBudget(budget);
  if (typeof shouldAbort === 'function' && shouldAbort() === true) return cancelledMap(resolvedBudget);

  const reasons = new Set();
  const truncatedScopes = [];
  let entitiesTruncated = 0;
  let ledgerTruncated = 0;

  const expressionRecords = Array.isArray(result.rewriteProof) ? result.rewriteProof : [];
  const rawRecords = Array.isArray(result.phase8Projection?.transforms) ? result.phase8Projection.transforms : [];
  const rawRecordCount = expressionRecords.length + rawRecords.length;
  const ledgerRecords = [];
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
    if (normalized.originHistory.completeness !== 'complete') {
      truncatedScopes.push('expression-history-origins');
      reasons.add('truncated');
    }
  }
  if (unavailableExpressionHistory) reasons.add('missing-expression-history');
  for (const record of rawRecords.slice(0, Math.max(0, resolvedBudget.maxTransformRecords - ledgerRecords.length))) {
    ledgerRecords.push(renderProvenanceRecord(record));
  }
  if (rawRecordCount > ledgerRecords.length + unavailableExpressionHistory) {
    ledgerTruncated = rawRecordCount - ledgerRecords.length - unavailableExpressionHistory;
    truncatedScopes.push('ledger');
    reasons.add('truncated');
  }

  const entities = {};
  const reverse = new Map();
  const entityRefsByRecord = ledgerRecords.map(() => new Set());
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
    const raw = sourceOf(line.source);
    let origins = canonicalOrigins(raw);
    let entityOriginKeys = originKeySet(origins);

    const recordRefs = [];
    for (let recordIndex = 0; recordIndex < ledgerRecords.length; recordIndex += 1) {
      const record = ledgerRecords[recordIndex];
      if (!recordFeedsEntity(record, entityOriginKeys)) continue;
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
    origin:Object.freeze({
      addresses:Object.freeze(canonicalList(record.origin.addresses, false)),
      rows:Object.freeze(canonicalList(record.origin.rows, true)),
      ir:Object.freeze(canonicalList(record.origin.ir, false)),
      ssaDefs:Object.freeze(canonicalList(record.origin.ssaDefs, false)),
      ssaUses:Object.freeze(canonicalList(record.origin.ssaUses, false)),
    }),
    producedRefs:Object.freeze([...entityRefsByRecord[recordIndex]].sort((left, right) => left.localeCompare(right, 'en'))),
    removedRefs:Object.freeze([]),
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
      const history = record?.originHistory;
      if (!history) continue;
      const fields = ['consumedRefs', 'producedRefs', 'elidedRefs'];
      if (history.scope !== 'replacement-expression-source'
          || !['complete', 'incomplete'].includes(history.completeness)
          || record.renderedBinding !== 'unresolved'
          || fields.some(field => !Array.isArray(history[field])
            || history[field].some(ref => typeof ref !== 'string' || !/^(row|addr|ir|ssa):.+/.test(ref))
            || new Set(history[field]).size !== history[field].length)) {
        reasons.add('invalid-expression-history');
        continue;
      }
      if (history.completeness !== 'complete') reasons.add('incomplete-expression-history');
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
