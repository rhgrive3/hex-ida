// Evaluation boundary only. No oracle is imported by candidate representation.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export const CASE_HASH = '05def989cdf8df4728bbdee5201f069e37a4e2a0c0d8bd6a91055cd10895df9a';
export const ARMS = ['current', 'B', 'C', 'D'];
export const PICK_INSTRUCTION = 'Pick the existing field most likely to be the remembered target of the user phrase. This is a forced ranking preference, not proof. Use only listed candidate IDs.';
export const UNIQUE_INSTRUCTION = 'Does the user phrase uniquely identify one of these candidates without additional context?';
export const evidenceJSON = value => JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? String(item) : item, 2);

export function persistentWrite(file, value) {
  const dir = path.dirname(path.resolve(file));
  let ancestor = dir;
  while (!fs.existsSync(ancestor)) ancestor = path.dirname(ancestor);
  if (!fs.realpathSync(ancestor).startsWith('/mnt/workspace/')) throw new Error('persistent storage required');
  fs.mkdirSync(dir, { recursive: true });
  if (!fs.realpathSync(dir).startsWith('/mnt/workspace/')) throw new Error('persistent storage required');
  const pending = `${file}.pending-${process.pid}`;
  fs.writeFileSync(pending, typeof value === 'string' ? value : `${evidenceJSON(value)}\n`, { flag: 'wx' });
  fs.renameSync(pending, file);
}

export function verifyCases(bytes) {
  if (sha256(bytes) !== CASE_HASH) throw new Error('holdout hash mismatch');
  const cases = JSON.parse(bytes);
  if (cases.length !== 70 || new Set(cases.map(c => c.id)).size !== 70) throw new Error('case inventory mismatch');
  return cases;
}

export function snapshotCandidate(c, symbols, binarySha256) {
  // Whitelist facts from the live canonical lattice. Gold labels and arbitrary
  // descriptions cannot flow through this boundary.
  const f = c.field ?? {};
  const functionContexts = (c.provenance ?? f.provenance ?? []).slice(0, 64).map(({ receiver, member }) => ({
    address: String(receiver.functionAddress),
    name: symbols?.nameAt(receiver.functionAddress) ?? null,
    receiverProven: receiver.receiverRole === 'this',
    receiverDigest: receiver.digest,
    memberDigest: member.digest,
    readCount: member.readCount,
    writeCount: member.writeCount,
    rule: member.rule,
  }));
  return {
    key: c.key, source: c.source ?? 'objc', binarySha256,
    className: c.className, classIdentity: c.classIdentity ?? null,
    fieldName: c.anonymous ? null : (c.fieldName ?? f.name ?? null),
    anonymous: c.anonymous === true, syntheticName: c.syntheticName ?? null,
    offset: Number(c.offset), size: c.size ?? f.size ?? null,
    recoveredType: c.recoveredType ?? null,
    type: c.type ?? f.type ?? null,
    readCount: f.readCount ?? null, writeCount: f.writeCount ?? null,
    conflict: f.conflict === true,
    functionContexts,
    score: c.fusion?.logOdds ?? c.score ?? 0,
    fusion: { logOdds: c.fusion?.logOdds ?? c.score ?? 0 },
    askedByName: c.askedByName === true,
    recallLane: c.recallLane === true,
  };
}

const label = c => c.fieldName ?? c.syntheticName ?? `member_0x${c.offset.toString(16)}`;
const bounded = s => String(s).slice(0, 240);
export function describeCandidate(c, arm) {
  if (arm === 'current') return String(c.fieldName || c.name || c.key || 'unnamed field');
  if (arm === 'B') return `${bounded(c.className)}.${bounded(label(c))}`;
  const description = [`class: ${bounded(c.className)}`, `member: ${c.fieldName ? bounded(c.fieldName) : `offset 0x${c.offset.toString(16)}`}`,
    `size: ${Number.isSafeInteger(c.size) && c.size > 0 ? c.size : 'unknown'}`,
    `recovered category: ${bounded(c.recoveredType?.category ?? c.type?.kind ?? 'unknown')}`,
    `type proven: ${c.recoveredType?.proven === true}`];
  if (arm === 'D') {
    description.push(`reads: ${c.readCount ?? 'unknown'}`, `writes: ${c.writeCount ?? 'unknown'}`);
    // Eight deterministic contexts, no new analysis or generated role claims.
    for (const ctx of (c.functionContexts ?? []).slice().sort((a, b) => a.address.localeCompare(b.address)).slice(0, 8)) {
      description.push(`access function: ${bounded(ctx.name ?? `0x${BigInt(ctx.address).toString(16)}`)}; proven receiver: ${ctx.receiverProven === true}; reads: ${ctx.readCount}; writes: ${ctx.writeCount}; rule: ${bounded(ctx.rule ?? 'unknown')}`);
    }
  }
  if (!['C', 'D'].includes(arm)) throw new Error('unknown representation');
  return description.join(' | ');
}

export function requestBody(query, candidates, arm) {
  if (!Array.isArray(candidates) || candidates.length < 2 || candidates.length > 255) throw new Error('shortlist must be 2..255');
  const criteria = Object.fromEntries(candidates.map((c, i) => [`c${i}`, describeCandidate(c, arm)]));
  return { model: 'openjev', state: { userPhrase: query, queryKind: 'partial', candidateDescriptionsAreBinaryDerived: true },
    questions: {
      pick: { type: 'choice', instructions: PICK_INSTRUCTION, criteria },
      unique: { type: 'noul', instructions: UNIQUE_INSTRUCTION, criteria: { true: 'The phrase distinguishes one field', false: 'Several fields plausibly fit' } },
    } };
}

export function structuralMatch(candidate, gold) {
  if (!candidate || gold?.status !== 'verified' || candidate.conflict) return false;
  return (gold.identities ?? []).some(identity => {
    if (candidate.binarySha256 !== identity.binarySha256 || candidate.className !== identity.className
      || candidate.offset !== identity.offset || candidate.size !== identity.size) return false;
    const recovered = candidate.recoveredType;
    if (recovered?.proven === true && identity.allowedCategories?.length
      && !identity.allowedCategories.includes(recovered.category)) return false;
    return true;
  });
}

export function funnel(row, gold) {
  const verified = gold?.status === 'verified';
  const recovered = verified && row.recovered.some(c => structuralMatch(c, gold));
  const lattice = verified && row.candidates.some(c => structuralMatch(c, gold));
  const shortlist = verified && row.shortlist.some(c => structuralMatch(c, gold));
  return { verified, recovered, lattice, shortlist,
    unreachableBecauseNotRecovered: verified && !recovered,
    recoveredButNotPublished: recovered && !lattice,
    publishedButOutsideShortlist: lattice && !shortlist };
}

export function percentiles(values) {
  const sorted = values.filter(Number.isFinite).sort((a,b) => a-b);
  const p = n => sorted.length ? sorted[Math.max(0, Math.ceil(sorted.length*n)-1)] : null;
  return { count: sorted.length, p50: p(.5), p95: p(.95), p99: p(.99) };
}
