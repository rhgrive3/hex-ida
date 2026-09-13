// Regression for #5365: constantComparisons() drops unscoped propagated
// comparisons when the surrounding context proves more than one candidate
// memory location, but the ambiguity gate measured distinctness with the legacy
// display key only (`x19@32` = physical register + displacement). Two different
// SSA objects reached through a reused physical register therefore counted as
// one location and the propagated comparison survived by default. Distinctness
// is now canonical Memory-SSA identity (location.irKey), with the display key
// kept only as a fallback for sources that cannot provide the canonical key.
import assert from 'node:assert/strict';

import { buildSemanticModel } from '../js/blocks.js';
import { candidateLocationIdentity, constantComparisons, distinctCandidateLocations } from '../js/dataflow.js';

// 1. Same physical-register spelling, different canonical SSA object: two
//    distinct candidate locations.
{
  const u1 = { location: { base: 'x19', disp: 0x20n, key: 'x19@32', irKey: 'field:entity:Player:32' } };
  const u2 = { location: { base: 'x19', disp: 0x20n, key: 'x19@32', irKey: 'field:entity:Enemy:32' } };
  assert.equal(distinctCandidateLocations([u1, u2]), 2,
    'canonical SSA identity must keep two objects through one physical register distinct');
  assert.notEqual(candidateLocationIdentity(u1.location), candidateLocationIdentity(u2.location));
}

// 2. The same canonical object remains one candidate location, even when the
//    display key differs (so the gate does not become a blanket drop).
{
  const a = { location: { base: 'x19', disp: 0x20n, key: 'x19@32', irKey: 'field:entity:Same:32' } };
  const b = { location: { base: 'x19', disp: 0x20n, key: 'x19@64', irKey: 'field:entity:Same:32' } };
  assert.equal(distinctCandidateLocations([a, b]), 1);
}

// 3. Legacy/unknown sources without irKey still use the display key, and
//    locations with no identity at all are skipped.
{
  assert.equal(distinctCandidateLocations([
    { location: { key: 'x19@32' } },
    { location: { key: 'x19@64' } },
  ]), 2);
  assert.equal(distinctCandidateLocations([
    { location: { key: 'x19@32' } },
    { location: { key: 'x19@32' } },
  ]), 1);
  assert.equal(distinctCandidateLocations([
    { location: {} },
    { location: { key: null, irKey: null } },
  ]), 0);
  // Stack locations are not candidate objects for this gate.
  assert.equal(distinctCandidateLocations([
    { location: { stack: true, key: 'sp@0', irKey: 'field:stack:0' } },
    { location: { stack: true, key: 'sp@8', irKey: 'field:stack:8' } },
  ]), 0);
}

// 4. Real IR model integration: two proven locations still drop the unscoped
//    propagated comparison, and one location still keeps it.
{
  const BASE = 0x100000000n;
  const modelOf = (lines) => {
    const rows = lines.map((line, row) => {
      const split = line.indexOf(' ');
      return { row, address: BASE + BigInt(row * 4), mn: split < 0 ? line : line.slice(0, split), ops: split < 0 ? '' : line.slice(split + 1) };
    });
    const rowOfAddress = (address) => {
      const delta = address - BASE;
      return delta < 0n || delta >= BigInt(rows.length * 4) ? null : Number(delta / 4n);
    };
    return buildSemanticModel(rows, { startRow: 0, endRow: rows.length - 1, rowOfAddress });
  };

  const multi = modelOf([
    'ldr w8, [x19, #0x20]', 'add w8, w8, #1', 'str w8, [x19, #0x20]',
    'ldr w10, [x19, #0x40]', 'add w10, w10, #1', 'str w10, [x19, #0x40]',
    'mov w9, #100', 'cmp w8, w9', 'ret',
  ]);
  assert.equal(constantComparisons(multi).filter((c) => c.propagated).length, 0,
    'two distinct canonical locations must still drop the unscoped propagated comparison');
  assert.equal(constantComparisons(multi, { allowUnscopedPropagated: true }).filter((c) => c.propagated).length, 1);

  const single = modelOf([
    'ldr w8, [x19, #0x20]', 'add w8, w8, #1', 'str w8, [x19, #0x20]',
    'mov w9, #100', 'cmp w8, w9', 'ret',
  ]);
  assert.equal(constantComparisons(single).filter((c) => c.propagated).length, 1,
    'one location keeps the propagated comparison available by default');
}

console.log('issue #5365 dataflow candidate location identity regression passed');
