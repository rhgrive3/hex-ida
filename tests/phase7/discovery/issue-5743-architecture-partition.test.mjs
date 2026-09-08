import assert from 'node:assert/strict';
import test from 'node:test';

import { createDiscoveryEvidence } from '../../../js/analysis/discovery/candidates.js';
import { fuseFunctionCandidates } from '../../../js/analysis/discovery/fusion.js';

// #5743: fuseFunctionCandidates() bucketed evidence by start address only and
// counted corroborating producer ids across the whole bucket, so two
// producers corroborating DIFFERENT architectures at the same numeric address
// fused into one candidate upgraded to `probable` — and the mixed bucket's
// architecture fact collapsed to whichever architecture appeared first.

test('cross-architecture evidence never corroborates into one candidate (#5743)', () => {
  const evidence = [
    createDiscoveryEvidence({ kind:'direct-call-target', producerId:'arm-ref', architectureId:'arm64', start:0x1000n }),
    createDiscoveryEvidence({ kind:'relocation-target', producerId:'x86-reloc', architectureId:'x86_64', start:0x1000n }),
  ];
  const result = fuseFunctionCandidates(evidence);
  assert.equal(result.candidates.length, 2, 'each architecture keeps its own candidate');
  assert.deepEqual(result.candidates.map((c) => c.startState).sort(), ['heuristic', 'heuristic'],
    'a single corroborating producer per architecture stays heuristic — no cross-architecture upgrade');
  assert.deepEqual(result.candidates.map((c) => c.architectureId).sort(), ['arm64', 'x86_64'],
    'each candidate carries its own architecture identity');
});

test('generic evidence still supports its architecture, same-architecture corroboration still upgrades (#5743)', () => {
  // Null-architecture (generic) evidence plus one specific architecture:
  // existing single-architecture behavior is preserved.
  const evidence = [
    createDiscoveryEvidence({ kind:'direct-call-target', producerId:'arm-ref', architectureId:'arm64', start:0x2000n }),
    createDiscoveryEvidence({ kind:'relocation-target', producerId:'arm-reloc', architectureId:'arm64', start:0x2000n }),
  ];
  const result = fuseFunctionCandidates(evidence);
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].startState, 'probable', 'two same-architecture corroborating producers still corroborate');
  assert.equal(result.candidates[0].architectureId, 'arm64');
});

test('generic null-architecture evidence supports each architecture hypothesis without cross-upgrading (#5743)', () => {
  const evidence = [
    createDiscoveryEvidence({ kind:'direct-call-target', producerId:'arm-ref', architectureId:'arm64', start:0x3000n }),
    createDiscoveryEvidence({ kind:'relocation-target', producerId:'x86-reloc', architectureId:'x86_64', start:0x3000n }),
    // A corroborating producer with no architecture claim genuinely
    // corroborates each hypothesis independently — but only within that
    // architecture's own partition.
    createDiscoveryEvidence({ kind:'vtable-entry', producerId:'cfg-scan', architectureId:null, start:0x3000n }),
  ];
  const result = fuseFunctionCandidates(evidence);
  assert.equal(result.candidates.length, 2, 'two architecture hypotheses remain separate candidates');
  const byArchitecture = Object.fromEntries(result.candidates.map((c) => [c.architectureId, c]));
  assert.deepEqual(byArchitecture['arm64'].startEvidence.map((e) => e.producerId).sort(), ['arm-ref', 'cfg-scan'],
    'the arm64 partition must not contain x86_64-only producers');
  assert.deepEqual(byArchitecture['x86_64'].startEvidence.map((e) => e.producerId).sort(), ['cfg-scan', 'x86-reloc'],
    'the x86_64 partition must not contain arm64-only producers');
});
