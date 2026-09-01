import { sourceOf } from '../ast/nodes.js';
import { renderProvenanceRecord } from './contract.js';

export const RENDER_PROVENANCE_VERSION = 1;

const DEFAULT_BUDGET = Object.freeze({
  maxEntities:4096,
  maxOriginsPerEntity:64,
  maxTransformRecords:1024,
});

const VALIDATION_ENTITY_STATES_LIMIT = 32;

const ORIGIN_KINDS = Object.freeze(['addresses', 'rows', 'ir', 'ssaDefs', 'ssaUses']);

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

function recordRows(record) {
  return (record?.origin?.rows ?? []).map((value) => String(value));
}

function recordFeedsEntity(record, entityRowKeys) {
  return recordRows(record).some((row) => entityRowKeys.has(row));
}

export function buildRenderProvenance({ result, snapshotId = null, budget = null, shouldAbort = null } = {}) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) fail('phase8-render-provenance-result-required');
  if (!Array.isArray(result.lines)) fail('phase8-render-provenance-result-required');
  if (snapshotId != null && (typeof snapshotId !== 'string' || snapshotId.length === 0)) fail('phase8-render-provenance-snapshot-required');
  const resolvedBudget = validateBudget(budget);

  const cancelled = typeof shouldAbort === 'function' && shouldAbort() === true;
  const reasons = new Set();
  const truncatedScopes = [];
  let entitiesTruncated = 0;
  let ledgerTruncated = 0;

  const rawRecords = Array.isArray(result.phase8Projection?.transforms) ? result.phase8Projection.transforms : [];
  const validatedRecords = rawRecords.map((record) => renderProvenanceRecord(record));
  const ledgerRecords = validatedRecords.slice(0, resolvedBudget.maxTransformRecords);
  if (validatedRecords.length > ledgerRecords.length) {
    ledgerTruncated = validatedRecords.length - ledgerRecords.length;
    truncatedScopes.push('ledger');
    reasons.add('truncated');
  }

  const entities = {};
  const reverse = new Map();
  const entityRowKeysByRef = new Map();
  const entityRefsByRecord = validatedRecords.map(() => new Set());
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
    const entityRowKeys = new Set(origins.rows.map((value) => String(value)));

    const recordRefs = [];
    for (let recordIndex = 0; recordIndex < ledgerRecords.length; recordIndex += 1) {
      const record = ledgerRecords[recordIndex];
      if (!recordFeedsEntity(record, entityRowKeys)) continue;
      recordRefs.push(recordIndex);
      entityRefsByRecord[recordIndex].add(entityKey);
      const merged = canonicalOrigins({
        addresses:[...origins.addresses, ...(record.origin.addresses ?? [])],
        rows:[...origins.rows, ...(record.origin.rows ?? [])],
        ir:[...origins.ir, ...(record.origin.ir ?? [])],
        ssaDefs:[...(raw.ssaDefs ?? []), ...(record.origin.ssaDefs ?? [])],
        ssaUses:[...(raw.ssaUses ?? []), ...(record.origin.ssaUses ?? [])],
      });
      origins = merged;
    }

    const entityReasons = [];
    let complete = originsTotalSize(origins) > 0;
    if (originsTotalSize(origins) > resolvedBudget.maxOriginsPerEntity) {
      origins = truncateOrigins(origins, resolvedBudget.maxOriginsPerEntity);
      entityReasons.push('truncated');
      truncatedScopes.push('origins');
      reasons.add('truncated');
      complete = false;
    }
    if (!complete) {
      entityReasons.push('provenance-loss');
      reasons.add('provenance-loss');
    }

    entities[entityKey] = Object.freeze({
      entityKey,
      lineIndex:index,
      kind:line.kind ?? null,
      origins:freezeOrigins(origins),
      complete,
      reasons:Object.freeze(entityReasons),
      recordRefs:Object.freeze(recordRefs),
    });
    entityRowKeysByRef.set(entityKey, entityRowKeys);
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

  let completeness = 'complete';
  if (snapshotId == null) {
    reasons.add('missing-snapshot');
  }
  if (reasons.size > 0) completeness = 'incomplete';

  const provenanceLoss = Object.values(entities).filter((entity) => !entity.complete).length;
  return Object.freeze({
    version:RENDER_PROVENANCE_VERSION,
    snapshotId,
    entities:Object.freeze(entities),
    reverse:Object.freeze(reverseObject),
    ledger:Object.freeze(ledger),
    transformCount:validatedRecords.length,
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
      transformRecords:validatedRecords.length,
      ledgerTruncated,
      provenanceLoss,
    }),
  });
}

function cancelledMap(resolvedBudget) {
  return Object.freeze({
    version:RENDER_PROVENANCE_VERSION,
    snapshotId:null,
    entities:Object.freeze({}),
    reverse:Object.freeze({}),
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
  for (const entity of Object.values(provenanceMap.entities)) {
    if (entity?.complete === false) {
      reasons.add('provenance-loss');
      for (const reason of entity.reasons ?? []) reasons.add(reason);
    }
  }
  if (provenanceMap.budget?.truncated === true) reasons.add('truncated');

  const entityEntries = Object.values(provenanceMap.entities);
  const entityStates = entityEntries.slice(0, VALIDATION_ENTITY_STATES_LIMIT).map((entity) => Object.freeze({
    entityKey:entity.entityKey,
    complete:entity.complete === true,
    reasons:Object.freeze([...(entity.reasons ?? [])]),
  }));

  return Object.freeze({
    state:reasons.size === 0 ? 'complete' : 'incomplete',
    entityStates:Object.freeze(entityStates),
    entityStatesTruncated:Math.max(entityEntries.length - entityStates.length, 0),
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
