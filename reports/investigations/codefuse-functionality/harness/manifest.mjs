// Hex-side inputs for the CodeFuse-DeBench comparison lane.
//
// Two rules from the lane mandate are enforced here:
//   1. No benchmark case id or address is hardcoded. Cases are selected from
//      the frozen manifest by a deterministic coverage rule, and artifacts are
//      joined by the artifact's own `inputSha256`, not by a filename convention.
//   2. `reports/public-benchmark/` and `reports/public-benchmark-parallel/` are
//      read-only inputs. This module never writes into them.

import fs from 'node:fs';
import path from 'node:path';

export function loadHexManifest(file) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (raw?.schema !== 'hex-public-benchmark-manifest/v1') throw new Error('codefuse-manifest-schema');
  if (!Array.isArray(raw.cases) || !raw.cases.length) throw new Error('codefuse-manifest-empty');
  for (const entry of raw.cases) {
    if (typeof entry.id !== 'string' || !entry.id) throw new Error('codefuse-manifest-case-id');
    if (!/^[0-9a-f]{64}$/.test(entry.binarySha256 || '')) throw new Error(`codefuse-manifest-case-sha:${entry.id}`);
  }
  return raw;
}

// Deterministic probe selection with explicit coverage over the axes that exist
// in the manifest. Greedy maximal-coverage over the facets
// `{compiler, debug, optimization}`: repeatedly take the lexicographically-first
// remaining case that adds the most uncovered facets. Cases are always consumed
// in `id` order, so the result is stable for any input ordering.
export function selectProbeCases(cases, count = 5) {
  if (!Array.isArray(cases) || !cases.length) throw new Error('codefuse-select-empty');
  if (!Number.isSafeInteger(count) || count < 1) throw new Error('codefuse-select-count');
  const ordered = [...cases].sort((left, right) => String(left.id).localeCompare(String(right.id)));
  const chosen = [];
  const chosenIds = new Set();
  const covered = new Set();
  const facetsOf = (entry) => [`compiler:${entry.compiler}`, `debug:${entry.debug}`, `optimization:${entry.optimization}`];

  while (chosen.length < count) {
    let best = null;
    let bestScore = 0;
    for (const entry of ordered) {
      if (chosenIds.has(entry.id)) continue;
      const score = facetsOf(entry).filter((facet) => !covered.has(facet)).length;
      if (score > bestScore) {
        bestScore = score;
        best = entry;
      }
    }
    if (!best) break;
    chosenIds.add(best.id);
    chosen.push(best);
    for (const facet of facetsOf(best)) covered.add(facet);
  }

  return Object.freeze({
    cases: Object.freeze(chosen.slice(0, count)),
    coverage: Object.freeze({
      compilers: Object.freeze([...new Set(chosen.map((entry) => entry.compiler))].sort()),
      optimizations: Object.freeze([...new Set(chosen.map((entry) => entry.optimization))].sort()),
      debugValues: Object.freeze([...new Set(chosen.map((entry) => entry.debug))].sort()),
    }),
  });
}

// Index every read-only case artifact by the binary hash it recorded at
// analysis time. The join key is the artifact's own field, so a renamed or
// re-encoded artifact file cannot silently attach to the wrong manifest case.
export function indexArtifactsByInputSha(directory) {
  const index = new Map();
  for (const name of fs.readdirSync(directory)) {
    if (!name.endsWith('.json')) continue;
    const file = path.join(directory, name);
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      continue;
    }
    if (!/^[0-9a-f]{64}$/.test(parsed?.inputSha256 || '')) continue;
    if (!Array.isArray(parsed.functions)) continue;
    if (index.has(parsed.inputSha256) && index.get(parsed.inputSha256).file !== file) {
      throw new Error(`codefuse-artifact-duplicate-input:${parsed.inputSha256}`);
    }
    index.set(parsed.inputSha256, { file, artifact: parsed });
  }
  if (index.size === 0) throw new Error('codefuse-artifact-index-empty');
  return index;
}

export function resolveCaseArtifact(entry, index) {
  const hit = index.get(entry.binarySha256);
  if (!hit) {
    return { available: false, reason: 'artifact-missing', file: null, artifact: null };
  }
  return { available: true, reason: null, file: hit.file, artifact: hit.artifact };
}
