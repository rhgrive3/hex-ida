import assert from 'node:assert/strict';
import test from 'node:test';

import { buildSemanticModel } from '../js/blocks.js';
import { buildIR, OP } from '../js/ir.js';
import { semanticFacts, FACT } from '../js/semantic.js';

const BASE = 0x100000000n;

function build(lines) {
  const rows = lines.map((line, i) => {
    const s = String(line).trim();
    const sp = s.indexOf(' ');
    return {
      row: i, address: BASE + BigInt(i) * 4n,
      mn: sp < 0 ? s : s.slice(0, sp), ops: sp < 0 ? '' : s.slice(sp + 1).trim(),
    };
  });
  const rowOfAddress = (addr) => {
    const rel = BigInt(addr) - BASE;
    if (rel < 0n || rel >= BigInt(rows.length) * 4n) return null;
    return Number(rel / 4n);
  };
  const model = buildSemanticModel(rows, { startRow: 0, endRow: rows.length - 1, rowOfAddress });
  return semanticFacts(buildIR(model, { rowOfAddress }));
}

function transfers(facts, disp) {
  return facts.filter((f) => f.kind === FACT.TRANSFER
    && f.sink && f.sink.disp === disp);
}

const SEL_ARMS = [
  'cmp w1, #0',
  'ldr w9, [x0, #0x10]',
  'ldr w10, [x0, #0x20]',
  'csel w8, w9, w10, gt',
  'str w8, [x0, #0x30]',
  'ret',
];

test('#3831 straight-line field→compute→field stays a deterministic transfer', () => {
  const list = transfers(build([
    'ldr w8, [x0, #0x10]',
    'add w8, w8, #5',
    'str w8, [x0, #0x30]',
    'ret',
  ]), 0x30n);
  assert.equal(list.length, 1);
  assert.equal(list[0].confidence, 1);
  assert.equal(list[0].branchDependent, undefined);
  assert.equal(list[0].source.location.disp, 0x10n);
});

test('#3831 branch-selected loads are not flattened into independent certain transfers', () => {
  const list = transfers(build(SEL_ARMS), 0x30n);
  assert.equal(list.length, 1, 'one branch-dependent transfer, not one fact per arm');
  const [fact] = list;
  assert.ok(fact.confidence < 1, 'branch-dependent confidence must not be certain');
  assert.equal(fact.branchDependent, true);
  assert.equal(fact.source.kind, 'branch-alternatives');
  assert.deepEqual(fact.alternatives.map((a) => a.location.disp), [0x10n, 0x20n]);
  assert.deepEqual(fact.alternatives.map((a) => a.kind), ['field', 'field']);
  assert.ok(fact.evidence.some((e) => e.relation === 'branch-source-read'));
});

test('#3831 arms reading the same location converge to one certain transfer', () => {
  const list = transfers(build([
    'cmp w1, #0',
    'ldr w9, [x0, #0x10]',
    'ldr w10, [x0, #0x10]',
    'csel w8, w9, w10, gt',
    'str w8, [x0, #0x30]',
    'ret',
  ]), 0x30n);
  assert.equal(list.length, 1);
  assert.equal(list[0].confidence, 1);
  assert.equal(list[0].source.location.disp, 0x10n);
  assert.equal(list[0].alternatives, undefined);
});

test('#3831 nested selects keep every alternative distinct', () => {
  const list = transfers(build([
    'cmp w1, #0',
    'ldr w9, [x0, #0x10]',
    'ldr w10, [x0, #0x20]',
    'csel w11, w9, w10, gt',
    'ldr w12, [x0, #0x40]',
    'csel w8, w11, w12, ls',
    'str w8, [x0, #0x30]',
    'ret',
  ]), 0x30n);
  assert.equal(list.length, 1);
  assert.equal(list[0].branchDependent, true);
  assert.deepEqual(list[0].alternatives.map((a) => a.location.disp), [0x10n, 0x20n, 0x40n]);
  assert.equal(new Set(list[0].alternatives.map((a) => a.instructionId)).size, 3);
});

test('#3831 deterministic sources survive beside branch-dependent ones', () => {
  const list = transfers(build([
    'ldr w9, [x0, #0x40]',
    'cmp w1, #0',
    'ldr w10, [x0, #0x10]',
    'ldr w11, [x0, #0x20]',
    'csel w8, w10, w11, gt',
    'add w8, w8, w9',
    'str w8, [x0, #0x30]',
    'ret',
  ]), 0x30n);
  assert.equal(list.length, 2);
  const certain = list.filter((f) => !f.branchDependent);
  const branch = list.filter((f) => f.branchDependent);
  assert.equal(certain.length, 1);
  assert.equal(certain[0].confidence, 1);
  assert.equal(certain[0].source.location.disp, 0x40n);
  assert.equal(branch.length, 1);
  assert.ok(branch[0].confidence < 1);
  assert.deepEqual(branch[0].alternatives.map((a) => a.location.disp), [0x10n, 0x20n]);
});

test('#3831 transfer facts stay attached to the destination store row', () => {
  const facts = build(SEL_ARMS);
  const store = facts.find((f) => f.kind === FACT.WRITE && f.location && f.location.disp === 0x30n);
  const branch = transfers(facts, 0x30n)[0];
  assert.ok(store, 'destination write fact exists');
  assert.equal(branch.row, store.row);
  assert.equal(branch.address, store.address);
});
