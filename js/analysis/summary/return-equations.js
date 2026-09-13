/** Serializable return transfers, consumed by the existing summary SCC solver.
 * Adapted from df98376ae, not a second solver. Version 2 retains source/return
 * site coverage and the current producer's SSA alternatives instead of picking
 * one terminal. Unknown remains a member of every incomplete union.
 */
import { stableDigest } from '../../core/identity/index.js';

export const RETURN_EQUATION_LIMIT = 4096;
export const RETURN_ARGUMENT_LIMIT = 256;
export const RETURN_FACT_LIMIT = 512;
export const RETURN_EQUATION_WORK_LIMIT = 65536;
export const RETURN_EQUATION_VERSION = 2;
const fail = () => { throw new TypeError('function-summary-invalid-return-equations'); };
const record = value => {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail();
};
const fields = (value, names) => {
  record(value);
  if (Object.keys(value).some(key => !names.includes(key))) fail();
};
const id = value => { if (typeof value !== 'string' || !value.trim()) fail(); return value.trim(); };
const index = value => { if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) fail(); return value; };
const dense = (value, limit) => {
  if (!Array.isArray(value) || value.length > limit) fail();
  for (let i = 0; i < value.length; i++) if (!Object.hasOwn(value, i)) fail();
  return value;
};
const integer = value => {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return BigInt(value).toString();
  if (typeof value === 'bigint') return value.toString();
  if (typeof value !== 'string' || !/^[+-]?[0-9]+$/.test(value)) fail();
  return BigInt(value).toString();
};
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const siteKey = row => JSON.stringify([row.siteId, row.returnIndex]);

// null is the no-transfer state, NOT an empty exact return universe. Each
// declared return site/value has all of its alternatives, including unknown.
export function canonicalReturnEquations(value, summary, normalizeFact) {
  if (value == null) return null;
  fields(value, ['version', 'source', 'sites', 'rows']);
  if (value.version !== RETURN_EQUATION_VERSION) fail();
  fields(value.source, ['functionId', 'snapshotId', 'digest']);
  const source = { functionId:id(value.source.functionId), snapshotId:id(value.source.snapshotId), digest:id(value.source.digest) };
  // A stale envelope is representable (for transport/diagnostics), but its
  // source binding is checked on EVERY admission, including branded objects.
  let work = 0;
  const charge = () => { if (++work > RETURN_EQUATION_WORK_LIMIT) fail(); };
  const sites = new Map(), covered = new Set(), callSites = new Map();
  for (const call of [...(summary.directCalls ?? []), ...(summary.indirectCallSets ?? [])]) {
    callSites.set(call.callSiteId, (callSites.get(call.callSiteId) ?? 0) + 1);
  }
  const fact = raw => {
    charge();
    fields(raw, ['kind', 'argIndex', 'returnIndex', 'offset', 'rootEntityId', 'allocationSiteId', 'addressSpace']);
    if (!['arg', 'root', 'allocation', 'unknown'].includes(raw.kind)) fail();
    if (raw.kind === 'arg') index(raw.argIndex);
    if (raw.kind === 'root' || raw.kind === 'allocation') {
      id(raw.rootEntityId ?? raw.allocationSiteId); id(raw.addressSpace);
    }
    if (raw.returnIndex != null) index(raw.returnIndex);
    if (raw.offset != null) integer(raw.offset);
    return normalizeFact(raw);
  };
  const declared = dense(value.sites, RETURN_EQUATION_LIMIT).map(raw => {
    charge();
    fields(raw, ['siteId', 'valueId', 'returnIndex', 'alternativeCount']);
    const site = { siteId:id(raw.siteId), valueId:id(raw.valueId), returnIndex:index(raw.returnIndex),
      alternativeCount:index(raw.alternativeCount) };
    if (!site.alternativeCount || site.alternativeCount > RETURN_EQUATION_LIMIT || sites.has(siteKey(site))) fail();
    sites.set(siteKey(site), { site, alternatives:new Set() }); covered.add(site.valueId);
    return site;
  });
  const rows = dense(value.rows, RETURN_EQUATION_LIMIT).map(raw => {
    charge();
    record(raw);
    const common = ['siteId', 'valueId', 'returnIndex', 'alternativeIndex', 'kind'];
    const extra = raw.kind === 'fact' ? ['fact'] : ['callSiteId', 'callReturnIndex', 'offset', 'arguments'];
    fields(raw, [...common, ...extra]);
    const row = { siteId:id(raw.siteId), valueId:id(raw.valueId), returnIndex:index(raw.returnIndex),
      alternativeIndex:index(raw.alternativeIndex), kind:raw.kind };
    const declaredSite = sites.get(siteKey(row));
    if (!declaredSite || declaredSite.site.valueId !== row.valueId
      || row.alternativeIndex >= declaredSite.site.alternativeCount
      || declaredSite.alternatives.has(row.alternativeIndex)) fail();
    declaredSite.alternatives.add(row.alternativeIndex);
    if (row.kind === 'fact') {
      row.fact = fact(raw.fact);
      if ((row.fact.returnIndex ?? 0) !== row.returnIndex) fail();
    } else if (row.kind === 'call') {
      row.callSiteId = id(raw.callSiteId);
      if (callSites.get(row.callSiteId) !== 1) fail();
      row.callReturnIndex = index(raw.callReturnIndex);
      row.offset = integer(raw.offset);
      row.arguments = dense(raw.arguments, RETURN_ARGUMENT_LIMIT).map(values => {
        charge();
        const alternatives = dense(values, RETURN_FACT_LIMIT).map(fact);
        if (!alternatives.length) fail();
        const canonical = new Map(alternatives.map(item => [JSON.stringify(item), item]));
        return [...canonical].sort(([a], [b]) => compare(a, b)).map(([, item]) => item);
      });
    } else fail();
    return row;
  });
  for (const { site, alternatives } of sites.values()) if (alternatives.size !== site.alternativeCount) fail();
  const expected = new Set(summary.returnValues ?? []);
  if (expected.size !== covered.size || [...expected].some(valueId => !covered.has(valueId))) fail();
  const order = (a, b) => compare(a.siteId, b.siteId) || a.returnIndex - b.returnIndex;
  declared.sort(order);
  rows.sort((a, b) => order(a, b) || a.alternativeIndex - b.alternativeIndex);
  return { version:RETURN_EQUATION_VERSION, source, sites:declared, rows };
}

/** The same substitution is used by local wrappers and recursive solving. */
export function substituteReturnFact(provenance, args, returnIndex, outerOffset = '0') {
  const unknown = { kind:'unknown', returnIndex };
  try {
    let source = provenance;
    let offset = BigInt(outerOffset) + BigInt(provenance.offset ?? 0);
    if (provenance.kind === 'arg') {
      source = args[provenance.argIndex];
      if (!source) return unknown;
      offset += BigInt(source.offset ?? 0);
    }
    if (source.kind === 'arg') return { kind:'arg', argIndex:source.argIndex, returnIndex, offset:offset.toString() };
    if (source.kind !== 'root' && source.kind !== 'allocation') return unknown;
    const rootEntityId = source.rootEntityId ?? source.allocationSiteId;
    if (!rootEntityId || !source.addressSpace) return unknown;
    return { kind:source.kind, rootEntityId, addressSpace:source.addressSpace, returnIndex, offset:offset.toString(),
      ...(source.allocationSiteId != null ? { allocationSiteId:source.allocationSiteId } : {}) };
  } catch { return unknown; }
}

/** Distribute only over the actual argument referenced by this return fact. */
export function substituteReturnAlternatives(provenance, args, returnIndex, offset = '0', checkpoint = () => {}) {
  if (provenance.kind !== 'arg') {
    checkpoint();
    return [substituteReturnFact(provenance, [], returnIndex, offset)];
  }
  const values = args[provenance.argIndex];
  if (!values?.length) return [{ kind:'unknown', returnIndex }];
  return values.map(value => {
    checkpoint();
    return substituteReturnFact(provenance, { [provenance.argIndex]:value }, returnIndex, offset);
  });
}

/** Construction validates shape; consumers additionally require source identity. */
export function returnEquationSourceMatches(summary) {
  const source = summary.returnEquations?.source;
  return summary.returnEquations == null || (source?.functionId === summary.functionId
    && source?.snapshotId === summary.status?.snapshotId
    && typeof summary.returnSourceDigest === 'string' && summary.returnSourceDigest.length > 0
    && source?.digest === summary.returnSourceDigest);
}

/** Bind transfers to the producer input, independently of their local facts.
 * Node/value/block tables and finite target sets are unordered; node inputs,
 * call arguments and block instruction sequences are not. Do not sort those.
 * This source identity is retained separately by the canonical summary, so
 * transplanting equations from an older same-snapshot producer is rejected.
 */
export function returnEquationSourceDigest(ir) {
  const byId = (a, b) => compare(a.id, b.id);
  return stableDigest({ kind:'return-equation-source-v1', ir:{ ...ir,
    nodes:[...(ir.nodes ?? [])].map(node => node.call == null ? node : { ...node, call:{ ...node.call,
      targetEntityIds:[...(node.call.targetEntityIds ?? [])].sort(compare),
    } }).sort(byId),
    values:[...(ir.values ?? [])].sort(byId),
    blocks:[...(ir.blocks ?? [])].sort(byId),
  } });
}
