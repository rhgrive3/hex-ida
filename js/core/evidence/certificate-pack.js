/** Lossless, bounded transport over canonical certificate data.
 * Repeated keys, strings and subtrees are shared. The codec adds NO proof rule,
 * store, semantic cache or persistent authority. Replay still uses certificate.js.
 */
import { snapshotContractData, recordFields, exactInteger, sha256Text, contractFail } from '../identity/structured.js';
import { assertWorldScope, assertAssumptionSet } from '../identity/world.js';
import { deepFreeze, stableStringify } from '../identity/index.js';
import { assertScopedAnalysisWork } from '../budgets/scoped-work.js';

export const CERTIFICATE_PACK_SCHEMA = 'evidence-certificate-shared-dag/v1';
export const CERTIFICATE_PACK_LIMITS = Object.freeze({ bytes: 8 * 1024 * 1024, nodes: 100000, strings: 65536, depth: 32, certificates: 32 });
const UTF8 = new TextEncoder();
const size = value => UTF8.encode(JSON.stringify(value)).length;
async function hash(value, work) {
  if (!globalThis.crypto?.subtle) contractFail('certificate-pack-sha256-unavailable');
  const bytes = UTF8.encode(stableStringify(value));
  if (bytes.length > CERTIFICATE_PACK_LIMITS.bytes) contractFail('certificate-pack-wire-budget');
  work.charge('residentBytes', bytes.length); work.charge('workUnits');
  const result = await work.await(() => crypto.subtle.digest('SHA-256', bytes), { chargeCall: false });
  return [...new Uint8Array(result)].map(x => x.toString(16).padStart(2, '0')).join('');
}
function certificateBindings(certificates, world, assumptions) {
  if (!Array.isArray(certificates) || !certificates.length || certificates.length > CERTIFICATE_PACK_LIMITS.certificates) contractFail('certificate-pack-root-count');
  for (const certificate of certificates) {
    if (certificate?.schema !== 'evidence-certificate-slice/v1' || certificate.worldId !== world.id
      || certificate.assumptionsId !== assumptions.id) contractFail('certificate-pack-certificate-binding');
    // Only syntax: the canonical replay must verify both identifiers again.
    sha256Text(certificate.contentSha256);
  }
}

export async function packEvidenceCertificates(raw, { world, assumptions, work } = {}) {
  assertWorldScope(world); assertAssumptionSet(assumptions, world); assertScopedAnalysisWork(work); work.checkpoint();
  const certificates = snapshotContractData(raw, { maxBytes: CERTIFICATE_PACK_LIMITS.bytes, maxNodes: CERTIFICATE_PACK_LIMITS.nodes });
  certificateBindings(certificates, world, assumptions);
  const strings = [], entries = [], stringIds = new Map(), entryIds = new Map();
  let expandedNodes = 1; // the decoded outer certificate array is a node too
  const intern = text => {
    if (stringIds.has(text)) return stringIds.get(text);
    if (strings.length >= CERTIFICATE_PACK_LIMITS.strings) contractFail('certificate-pack-string-count');
    const id = strings.length; strings.push(text); stringIds.set(text, id); return id;
  };
  function encode(value, depth = 0) {
    work.charge('workUnits');
    if (++expandedNodes > CERTIFICATE_PACK_LIMITS.nodes || depth + 1 > CERTIFICATE_PACK_LIMITS.depth) contractFail('certificate-pack-expanded-budget');
    if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
    if (typeof value === 'string') return ['s', intern(value)];
    const entry = Array.isArray(value) ? ['a', value.map(item => encode(item, depth + 1))]
      : ['o', Object.keys(value).sort().map(key => [intern(key), encode(value[key], depth + 1)])];
    // Encoding children first guarantees a topological table. Identity is the
    // exact encoded value, not a hash whose collision could alias a subtree.
    const key = JSON.stringify(entry);
    let id = entryIds.get(key);
    if (id === undefined) {
      if (entries.length >= CERTIFICATE_PACK_LIMITS.nodes) contractFail('certificate-pack-entry-count');
      work.charge('residentBytes', key.length * 2 + 64);
      id = entries.length; entries.push(entry); entryIds.set(key, id);
    }
    return ['r', id];
  }
  const roots = certificates.map(certificate => encode(certificate));
  const body = { schema: CERTIFICATE_PACK_SCHEMA, worldId: world.id, assumptionsId: assumptions.id,
    strings, entries, roots, expandedUtf8Bytes: size(certificates), proofAuthority: false };
  const contentSha256 = await hash(body, work); work.checkpoint();
  return deepFreeze({ ...body, contentSha256 });
}

/** All references and EXPANDED sizes are checked before allocating a decoded
 * subtree. A tiny hostile DAG cannot turn into an exponential JSON allocation.
 */
export async function unpackEvidenceCertificates(raw, { world, assumptions, work } = {}) {
  assertWorldScope(world); assertAssumptionSet(assumptions, world); assertScopedAnalysisWork(work); work.checkpoint();
  const pack = snapshotContractData(raw, { maxBytes: CERTIFICATE_PACK_LIMITS.bytes, maxNodes: 600000, maxProperties: 1200000 });
  recordFields(pack, ['schema', 'worldId', 'assumptionsId', 'strings', 'entries', 'roots', 'expandedUtf8Bytes', 'proofAuthority', 'contentSha256'], 'certificate-pack-fields');
  if (pack.schema !== CERTIFICATE_PACK_SCHEMA || pack.worldId !== world.id || pack.assumptionsId !== assumptions.id
    || pack.proofAuthority !== false) contractFail('certificate-pack-binding');
  if (!Array.isArray(pack.strings) || pack.strings.length > CERTIFICATE_PACK_LIMITS.strings
    || !Array.isArray(pack.entries) || pack.entries.length > CERTIFICATE_PACK_LIMITS.nodes
    || !Array.isArray(pack.roots) || !pack.roots.length || pack.roots.length > CERTIFICATE_PACK_LIMITS.certificates) contractFail('certificate-pack-table-budget');
  sha256Text(pack.contentSha256); exactInteger(pack.expandedUtf8Bytes, 'certificate-pack-expanded-size', { max: CERTIFICATE_PACK_LIMITS.bytes });
  const { contentSha256, ...body } = pack;
  if (await hash(body, work) !== contentSha256) contractFail('certificate-pack-content-mismatch');
  const stringSizes = [], stringSet = new Set();
  for (const text of pack.strings) {
    work.charge('workUnits');
    if (typeof text !== 'string' || stringSet.has(text)) contractFail('certificate-pack-string-table');
    stringSet.add(text); stringSizes.push(size(text));
  }
  const metrics = [], usedStrings = new Set(), usedEntries = new Set();
  const checkSize = metric => {
    if (metric.bytes > CERTIFICATE_PACK_LIMITS.bytes || metric.nodes > CERTIFICATE_PACK_LIMITS.nodes
      || metric.depth > CERTIFICATE_PACK_LIMITS.depth) contractFail('certificate-pack-expanded-budget');
    return metric;
  };
  function tokenMetric(token, before) {
    work.charge('workUnits');
    if (token === null || typeof token === 'boolean' || typeof token === 'number') return { bytes: size(token), nodes: 1, depth: 0 };
    if (!Array.isArray(token) || token.length !== 2 || !['s', 'r'].includes(token[0])) contractFail('certificate-pack-token');
    const id = exactInteger(token[1], 'certificate-pack-reference');
    if (token[0] === 's') {
      if (id >= pack.strings.length) contractFail('certificate-pack-string-reference');
      usedStrings.add(id); return { bytes: stringSizes[id], nodes: 1, depth: 0 };
    }
    if (id >= before) contractFail('certificate-pack-nontopological-reference');
    usedEntries.add(id); return metrics[id];
  }
  for (let i = 0; i < pack.entries.length; i++) {
    const entry = pack.entries[i]; work.charge('workUnits');
    if (!Array.isArray(entry) || entry.length !== 2 || !['a', 'o'].includes(entry[0]) || !Array.isArray(entry[1])) contractFail('certificate-pack-entry');
    const metric = { bytes: 2 + Math.max(0, entry[1].length - 1), nodes: 1, depth: 0 };
    let previous = null;
    for (const part of entry[1]) {
      let token = part;
      if (entry[0] === 'o') {
        if (!Array.isArray(part) || part.length !== 2) contractFail('certificate-pack-member');
        const key = exactInteger(part[0], 'certificate-pack-key');
        if (key >= pack.strings.length || previous !== null && previous >= pack.strings[key]) contractFail('certificate-pack-key-order');
        usedStrings.add(key); previous = pack.strings[key];
        metric.bytes += stringSizes[key] + 1; token = part[1];
      }
      const child = tokenMetric(token, i);
      metric.bytes += child.bytes; metric.nodes += child.nodes; metric.depth = Math.max(metric.depth, child.depth + 1);
      checkSize(metric);
    }
    metrics.push(checkSize(metric)); await work.yieldIfNeeded();
  }
  const total = { bytes: 2 + pack.roots.length - 1, nodes: 1, depth: 0 };
  for (const root of pack.roots) {
    if (!Array.isArray(root) || root[0] !== 'r') contractFail('certificate-pack-root-reference');
    const child = tokenMetric(root, metrics.length);
    total.bytes += child.bytes; total.nodes += child.nodes; total.depth = Math.max(total.depth, child.depth + 1); checkSize(total);
  }
  if (total.bytes !== pack.expandedUtf8Bytes) contractFail('certificate-pack-expanded-size-mismatch');
  // This wire format has no external cuts: every referenced node is carried,
  // including contradictions, unresolved frontiers and original graph edges.
  if (usedStrings.size !== pack.strings.length || usedEntries.size !== pack.entries.length) contractFail('certificate-pack-unused-table-entry');
  work.charge('residentBytes', total.bytes * 2); work.charge('nodes', total.nodes);
  function decode(token) {
    work.charge('workUnits');
    if (!Array.isArray(token)) return token;
    if (token[0] === 's') return pack.strings[token[1]];
    const [kind, children] = pack.entries[token[1]];
    if (kind === 'a') return children.map(decode);
    const result = Object.create(null);
    for (const [key, value] of children) Object.defineProperty(result, pack.strings[key], { value: decode(value), enumerable: true, writable: true, configurable: true });
    return result;
  }
  const certificates = pack.roots.map(decode);
  certificateBindings(certificates, world, assumptions); work.checkpoint();
  return deepFreeze({ certificates, integrity: 'transport-only', semantic: 'unknown', proofAuthority: false,
    statistics: { wireUtf8Bytes: size(pack), expandedUtf8Bytes: total.bytes, expandedNodes: total.nodes,
      sharedEntryCount: pack.entries.length, stringCount: pack.strings.length } });
}
