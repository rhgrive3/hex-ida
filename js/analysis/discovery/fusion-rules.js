/**
 * Shared, architecture-neutral FunctionCandidate derivation rules.
 *
 * Both fusion and the publishable artifact boundary call this module. That
 * keeps candidate name/extent/conflict validation on the same authority path
 * without creating an artifact/fusion import cycle.
 */

import { createFunctionCandidate } from './candidates.js';
import { canonicalTypedString } from './canonical-value.js';

function authorityRank(authority) {
  return authority === 'authoritative' ? 2 : authority === 'corroborating' ? 1 : 0;
}

function regionSignature(item) {
  return (item.regions ?? []).map((region) => `${region.start}-${region.end}-${region.ownership ?? ''}`).join(',');
}

export function compareDiscoveryEvidence(left, right) {
  return authorityRank(right.authority) - authorityRank(left.authority)
    || canonicalTypedString(left).localeCompare(canonicalTypedString(right));
}

function fuseStartState(evidence) {
  if (evidence.some((item) => item.authority === 'authoritative')) return 'exact';
  const corroborating = new Set(evidence
    .filter((item) => item.authority === 'corroborating')
    .map((item) => item.producerId));
  return corroborating.size >= 2 ? 'probable' : 'heuristic';
}

function compareRegion(left, right) {
  const a = BigInt(left.start);
  const b = BigInt(right.start);
  if (a !== b) return a < b ? -1 : 1;
  const c = BigInt(left.end);
  const d = BigInt(right.end);
  return c !== d ? (c < d ? -1 : 1) : left.ownership.localeCompare(right.ownership);
}

function fuseExtent(evidence) {
  const withRegions = evidence.filter((item) => item.regions.length > 0);
  if (withRegions.length === 0) return { regions: [], state: 'unknown', conflicts: [] };

  const authoritative = withRegions.filter((item) => item.authority === 'authoritative');
  const pool = authoritative.length > 0 ? authoritative : withRegions;
  const partial = pool.filter((item) => item.extentRole === 'partial');
  const complete = pool.filter((item) => item.extentRole !== 'partial');
  if (complete.length === 0 && partial.length > 0) {
    const merged = new Map();
    const ownershipByRange = new Map();
    for (const item of partial) {
      for (const region of item.regions) {
        const rangeKey = `${region.start}-${region.end}`;
        const priorOwnership = ownershipByRange.get(rangeKey);
        if (priorOwnership != null && priorOwnership !== region.ownership) {
          return {
            regions: [],
            state: 'unknown',
            conflicts: [{
              kind: 'extent',
              detail: 'partial extent ownership evidence disagrees',
              alternatives: [...new Set([priorOwnership, region.ownership])].sort(),
            }],
          };
        }
        ownershipByRange.set(rangeKey, region.ownership);
        merged.set(`${rangeKey}-${region.ownership}`, region);
      }
    }
    return {
      regions: [...merged.values()].sort(compareRegion),
      // Partial ranges are exact observations of those ranges, never proof that
      // the assembled set is the complete function extent unless the producer
      // separately attests complete coverage of the range group.
      state: authoritative.length > 0 && partial.some((item) => item.extentCoverageComplete)
        ? 'exact' : 'heuristic',
      conflicts: [],
    };
  }
  const considered = complete.length > 0 ? complete : pool;
  const signatures = new Map();
  for (const item of considered) {
    const signature = regionSignature(item);
    if (!signatures.has(signature)) signatures.set(signature, { regions: item.regions, sources: [] });
    signatures.get(signature).sources.push(item.producerId);
  }
  if (signatures.size === 1) {
    const only = [...signatures.values()][0];
    return {
      regions: only.regions,
      state: authoritative.length > 0 ? 'exact' : considered.length > 1 ? 'probable' : 'heuristic',
      conflicts: [],
    };
  }
  return {
    regions: [],
    state: 'unknown',
    conflicts: [{
      kind: 'extent',
      detail: 'extent evidence disagrees',
      alternatives: [...signatures.entries()].map(([signature, entry]) => ({ signature, sources: entry.sources })),
    }],
  };
}

function compareStart(left, right) {
  const a = BigInt(left);
  const b = BigInt(right);
  return a < b ? -1 : a > b ? 1 : 0;
}

export function reconcileCandidateOverlaps(candidates, { signal = null } = {}) {
  const n = candidates.length;
  if (n <= 1) return candidates;
  const swallowed = Array.from({ length: n }, () => []);
  const overlapping = Array.from({ length: n }, () => []);
  const regions = candidates.flatMap((candidate, candidateIndex) => candidate.regions.map((region) => ({
    candidateIndex,
    start: BigInt(region.start),
    end: BigInt(region.end),
  })));
  const starts = candidates.map((candidate, candidateIndex) => ({ candidateIndex, start: BigInt(candidate.start) }))
    .sort((left, right) => (left.start < right.start ? -1 : left.start > right.start ? 1 : 0));

  for (const region of regions) {
    if (signal?.aborted) break;
    let left = 0;
    let right = starts.length;
    while (left < right) {
      const middle = (left + right) >> 1;
      if (starts[middle].start <= region.start) left = middle + 1;
      else right = middle;
    }
    for (let index = left; index < starts.length && starts[index].start < region.end; index += 1) {
      const other = starts[index].candidateIndex;
      if (other !== region.candidateIndex) swallowed[region.candidateIndex].push(candidates[other].start);
    }
  }

  const events = regions.flatMap((region) => [
    { point: region.start, type: 'start', region },
    { point: region.end, type: 'end', region },
  ]).sort((left, right) => {
    if (left.point !== right.point) return left.point < right.point ? -1 : 1;
    if (left.type === right.type) return 0;
    return left.type === 'end' ? -1 : 1;
  });
  const active = new Set();
  for (const event of events) {
    if (signal?.aborted) break;
    if (event.type === 'end') {
      active.delete(event.region);
      continue;
    }
    for (const item of active) {
      if (item.candidateIndex === event.region.candidateIndex) continue;
      overlapping[event.region.candidateIndex].push(candidates[item.candidateIndex].start);
      overlapping[item.candidateIndex].push(candidates[event.region.candidateIndex].start);
    }
    active.add(event.region);
  }

  return candidates.map((candidate, index) => {
    const swallowedStarts = [...new Set(swallowed[index])].sort(compareStart);
    const overlapStarts = [...new Set(overlapping[index])].sort(compareStart);
    if (swallowedStarts.length === 0 && overlapStarts.length === 0) return candidate;
    const conflicts = [...candidate.conflicts];
    if (swallowedStarts.length) {
      conflicts.push({ kind: 'extent', detail: 'claimed extent contains another function start', alternatives: swallowedStarts });
    }
    if (overlapStarts.length) {
      conflicts.push({ kind: 'extent', detail: 'claimed extent overlaps another candidate', alternatives: overlapStarts });
    }
    return createFunctionCandidate({
      ...candidate,
      regions: [],
      extentState: 'unknown',
      conflicts,
    });
  });
}

export function deriveFunctionCandidates(evidence, {
  architectureId = null,
  maxEvidencePerCandidate = Number.MAX_SAFE_INTEGER,
  signal = null,
} = {}) {
  const byStart = new Map();
  for (const item of [...evidence].sort(compareDiscoveryEvidence)) {
    if (item.start == null) continue;
    if (!byStart.has(item.start)) byStart.set(item.start, { items: [], overflow: false });
    const entry = byStart.get(item.start);
    if (entry.items.length < maxEvidencePerCandidate) entry.items.push(item);
    else entry.overflow = true;
  }
  const candidates = [];
  let evidenceOverflow = false;
  for (const start of [...byStart.keys()].sort(compareStart)) {
    const entry = byStart.get(start);
    const bucket = entry.items;
    evidenceOverflow ||= entry.overflow;
    let extent = fuseExtent(bucket);
    const names = [...new Set(bucket.map((item) => item.name).filter(Boolean))];
    const conflicts = [...extent.conflicts];
    if (entry.overflow) {
      extent = { regions: [], state: 'unknown', conflicts: extent.conflicts };
      conflicts.push({
        kind: 'evidence-budget',
        detail: 'candidate evidence exceeded maxEvidencePerCandidate',
        alternatives: [{ retained: bucket.length, omitted: 'one-or-more' }],
      });
    }
    const authoritativeNames = [...new Set(bucket
      .filter((item) => item.authority === 'authoritative' && item.name)
      .map((item) => item.name))];
    if (authoritativeNames.length > 1) {
      conflicts.push({
        kind: 'name',
        detail: 'authoritative sources disagree about the name',
        alternatives: authoritativeNames,
      });
    }
    candidates.push(createFunctionCandidate({
      start,
      name: entry.overflow ? null : (names[0] ?? null),
      regions: extent.regions,
      startEvidence: bucket,
      extentEvidence: bucket.filter((item) => item.regions.length > 0),
      startState: fuseStartState(bucket),
      extentState: extent.state,
      conflicts,
      architectureId: bucket.find((item) => item.architectureId)?.architectureId ?? architectureId,
    }));
  }
  return {
    candidates: reconcileCandidateOverlaps(candidates, { signal }),
    candidateCount: byStart.size,
    evidenceOverflow,
  };
}
