import { isCanonicalCppMemberEvidence, isCanonicalCppReceiverEvidence } from './object-evidence.js';

export const CXX_MEMBER_INDEX_SCHEMA = 'cxx-member-index/v1';
const indexes = new WeakSet();
const classes = new WeakSet();
const fields = new WeakSet();
const EMPTY = Object.freeze([]);
const MAX_PROVENANCE = 64;

export const isCxxMemberIndex = (value) => indexes.has(value);
export const isCxxMemberField = (value, cls) => fields.has(value)
  && (cls == null || (classes.has(cls) && cls.ownerKey === value.ownerKey));

function ownerKeyFor(receiver) {
  const identity = receiver.classIdentity;
  if (!identity || identity.offsetToTop !== 0n) return null;
  if (identity.kind === 'named') return JSON.stringify([receiver.snapshotId, 'named', identity.className]);
  if (identity.vtableAddress != null) return JSON.stringify([receiver.snapshotId, 'vtable', String(identity.vtableAddress)]);
  if (identity.typeinfoAddress != null) return JSON.stringify([receiver.snapshotId, 'typeinfo', String(identity.typeinfoAddress)]);
  return null;
}

function typeFor(member) {
  const bytes = member.sizeBytes;
  let kind = 'unknown';
  if (member.typeProven) {
    if (['float', 'double'].includes(member.category)) kind = 'float';
    else if (member.category === 'pointer') kind = 'pointer';
    else if (member.category === 'bool-like') kind = 'int';
    else if (/^int(?:8|16|32|64)$/.test(member.category)
      && !member.categoryCandidates.some((c) => /pointer/.test(c))) kind = 'int';
  }
  const signed = member.signedness === 'true' ? true : member.signedness === 'false' ? false : null;
  return Object.freeze({ kind, bytes, ...(kind === 'int' && signed != null ? { signed } : {}) });
}

function eligible(member, receiver) {
  return isCanonicalCppMemberEvidence(member) && member.accessProven === true
    && member.receiverDigest === receiver.digest && member.functionId === receiver.functionId
    && member.snapshotId === receiver.snapshotId && member.readCount + member.writeCount > 0
    && !member.mixedWidths && !member.indexed
    && typeof member.offsetBytes === 'bigint' && member.offsetBytes >= 0n
    && member.offsetBytes <= BigInt(Number.MAX_SAFE_INTEGER)
    && Number.isSafeInteger(member.sizeBytes) && member.sizeBytes > 0;
}

function publishedField(record) {
  const provenance = Object.freeze([...record.sources.values()].sort((a, b) =>
    a.member.functionId.localeCompare(b.member.functionId) || a.member.digest.localeCompare(b.member.digest)));
  const names = [...record.names].sort();
  const member = provenance[0].member;
  const iv = Object.freeze({
    source: 'cxx', key: record.key, ownerKey: record.ownerKey,
    classIdentity: provenance[0].receiver.classIdentity,
    name: names.length === 1 ? names[0] : `member_0x${record.offset.toString(16)}`,
    memberNames: Object.freeze(names), anonymous: names.length !== 1,
    memberNamesTruncated: record.namesTruncated,
    offset: record.offset, size: member.sizeBytes, type: typeFor(member),
    recoveredType: Object.freeze({ category: member.category, label: member.typeLabel,
      signedness: member.signedness, candidates: member.categoryCandidates,
      proven: member.typeProven, rule: member.rule, reason: member.reason, widthOnly: member.widthOnly }),
    typeProven: member.typeProven, category: member.category, typeLabel: member.typeLabel,
    readCount: record.reads, writeCount: record.writes,
    provenanceCount: record.sourceKeys.size,
    provenanceTruncated: record.sourceKeys.size > MAX_PROVENANCE,
    conflict: record.conflict || names.length > 1, provenance,
  });
  fields.add(iv);
  return iv;
}

// This index only publishes objects issued by the canonical producer. It has
// no reader, decoder, recovery pass, or intent-specific candidate universe.
export class CxxMemberIndex {
  #classes = new Map();
  #states = new Map();
  #names = new Map();
  #count = 0;
  #revision = 0;
  #snapshotId = null;

  constructor() { indexes.add(this); }
  get schema() { return CXX_MEMBER_INDEX_SCHEMA; }
  get classes() { return this.#classes; }
  get classCount() { return this.#classes.size; }
  get fieldCount() { return this.#count; }
  get revision() { return this.#revision; }
  get snapshotId() { return this.#snapshotId; }
  classInfo(name) { return this.#names.get(name) || null; }

  publish(projection) {
    const receiver = projection?.receiver;
    if (!isCanonicalCppReceiverEvidence(receiver)) return false;
    const ownerKey = ownerKeyFor(receiver);
    if (!ownerKey || (this.#snapshotId != null && this.#snapshotId !== receiver.snapshotId)) return false;
    let state = this.#states.get(ownerKey);
    let changed = false;
    for (const member of Array.isArray(projection.members) ? projection.members : []) {
      if (!eligible(member, receiver)) continue;
      const offset = Number(member.offsetBytes);
      // ObjC keys always contain raw '#' separators. Keep the C++ namespace
      // disjoint even when an untrusted binary name contains those characters.
      const key = `cxx:${JSON.stringify([ownerKey, offset, member.sizeBytes,
        member.category, member.typeLabel, member.signedness, member.categoryCandidates, member.widthOnly]).replaceAll('#', '\\u0023')}`;
      if (!state) {
        const identity = receiver.classIdentity;
        const name = identity.className || `anonymous@${identity.vtableAddress != null ? 'vtable' : 'typeinfo'}:0x${(identity.vtableAddress ?? identity.typeinfoAddress).toString(16)}`;
        const cls = Object.freeze({ name, ownerKey, classIdentity: identity, source: 'cxx',
          ivars: [], methods: EMPTY, properties: EMPTY, byOffset: new Map() });
        classes.add(cls);
        state = { cls, records: new Map(), locations: new Map() };
        this.#states.set(ownerKey, state);
        this.#classes.set(ownerKey, cls);
        this.#names.set(name, this.#names.has(name) ? null : cls);
        this.#snapshotId = receiver.snapshotId;
      }
      let record = state.records.get(key);
      const sourceKey = `${receiver.digest}:${member.digest}`;
      if (record?.sourceKeys.has(sourceKey)) continue;
      if (!record) {
        record = { key, ownerKey, offset, index: state.cls.ivars.length, sources: new Map(),
          sourceKeys: new Set(), names: new Set(), namesTruncated: false,
          counts: new Map(), reads: 0, writes: 0, conflict: false };
        const peers = state.locations.get(offset) || new Set();
        if (peers.size) {
          record.conflict = true;
          for (const peer of peers) {
            peer.conflict = true;
            state.cls.ivars[peer.index] = publishedField(peer);
          }
        }
        peers.add(record);
        state.locations.set(offset, peers);
        state.records.set(key, record);
        this.#count++;
      }
      record.sourceKeys.add(sourceKey);
      if (member.memberName) {
        record.names.add(member.memberName);
        if (record.names.size > MAX_PROVENANCE) {
          record.names.delete([...record.names].sort().at(-1));
          record.namesTruncated = true;
        }
      }
      const counts = record.counts.get(member.functionId) || { reads: 0, writes: 0 };
      record.reads += Math.max(counts.reads, member.readCount) - counts.reads;
      record.writes += Math.max(counts.writes, member.writeCount) - counts.writes;
      record.counts.set(member.functionId, {
        reads: Math.max(counts.reads, member.readCount), writes: Math.max(counts.writes, member.writeCount),
      });
      // Keep a bounded deterministic sample of exact source objects. Counts
      // and dedupe cover every source; no query copies an unbounded history.
      if (record.sources.size < MAX_PROVENANCE) {
        record.sources.set(sourceKey, Object.freeze({ receiver, member }));
      } else {
        const last = [...record.sources.keys()].sort().at(-1);
        if (sourceKey < last) {
          record.sources.delete(last);
          record.sources.set(sourceKey, Object.freeze({ receiver, member }));
        }
      }
      const iv = publishedField(record);
      state.cls.ivars[record.index] = iv;
      state.cls.byOffset.set(offset, state.locations.get(offset).size === 1 ? iv : null);
      changed = true;
    }
    if (changed) this.#revision++;
    return changed;
  }

  clear() {
    if (this.#count || this.#snapshotId != null) this.#revision++;
    this.#classes.clear();
    this.#states.clear();
    this.#names.clear();
    this.#count = 0;
    this.#snapshotId = null;
  }
}
