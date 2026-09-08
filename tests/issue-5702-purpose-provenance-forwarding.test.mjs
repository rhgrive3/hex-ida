import test from 'node:test';
import assert from 'node:assert/strict';

import { describePurpose } from '../js/purpose.js';
import { findValueUpdates } from '../js/dataflow.js';
import { FieldIndex } from '../js/fields.js';
import { buildSemanticModel } from '../js/blocks.js';

const BASE = 0x100000000n;

function modelOf(lines) {
  const rows = lines.map((line, i) => {
    const s = line.trim();
    const p = s.indexOf(' ');
    return { row: i, address: BASE + BigInt(i * 4), mn: p < 0 ? s : s.slice(0, p), ops: p < 0 ? '' : s.slice(p + 1) };
  });
  const rowOfAddress = (addr) => {
    const d = addr - BASE;
    if (d < 0n || d >= BigInt(lines.length * 4)) return null;
    return Number(d / 4n);
  };
  return buildSemanticModel(rows, { startRow: 0, endRow: rows.length - 1, rowOfAddress });
}

function playerFields() {
  return new FieldIndex({
    classes: [{
      name: 'Player', instanceSize: 0x40,
      ivars: [{ name: '_hp', offset: 0x20, size: 4 }],
      properties: [], methods: [], classMethods: [],
    }],
  });
}

function spyFields(real) {
  const calls = [];
  return {
    calls,
    classCount: 1,
    resolveAccess(access, className) {
      calls.push({ access: { ...access }, className });
      return real.resolveAccess(access, className);
    },
  };
}

test('#5702 describePurpose forwards proven self and indexAddr provenance to resolveAccess', async () => {
  // mov x21, x0 makes x21 a dataflow-proven self register; the store targets
  // [x21, #0x20] = Player._hp.
  const model = modelOf([
    'mov x21, x0',
    'ldr w8, [x21, #0x20]',
    'add w8, w8, #1',
    'str w8, [x21, #0x20]',
    'ret',
  ]);
  const updates = findValueUpdates(model);
  assert.equal(updates.length, 1);
  assert.equal(updates[0].location.self, true, 'fixture: dataflow must prove x21 is self');

  const spy = spyFields(playerFields());
  const purpose = describePurpose({ model, addr: 0n, fields: spy, owner: { className: 'Player' } });

  assert.equal(spy.calls.length, 1, 'the resolver must be consulted once per change');
  const access = spy.calls[0].access;
  assert.equal(access.self, true, 'the proven self flag must reach the resolver');
  assert.ok(Object.hasOwn(access, 'indexAddr'), 'the indexAddr provenance slot must reach the resolver');
  assert.equal(access.indexAddr, null, 'a direct-disp access carries no offset-variable identity');

  assert.ok(purpose.changes[0].field, 'a proven self access must resolve its ivar');
  assert.equal(purpose.changes[0].field.name, '_hp');
  assert.equal(purpose.changes[0].field.certain, true, 'proven self must stay a certain resolution');
});

test('#5702 an unproven base register keeps its heuristic (uncertain) resolution', async () => {
  // No mov from x0: x19 is only a heuristic self candidate, so the access
  // resolves but must not be certain — forwarding must not strengthen guesses.
  const model = modelOf([
    'ldr w8, [x19, #0x20]',
    'add w8, w8, #1',
    'str w8, [x19, #0x20]',
    'ret',
  ]);
  const updates = findValueUpdates(model);
  assert.equal(updates.length, 1);
  assert.equal(updates[0].location.self, false, 'fixture: x19 must stay unproven here');

  const spy = spyFields(playerFields());
  const purpose = describePurpose({ model, addr: 0n, fields: spy, owner: { className: 'Player' } });

  assert.equal(spy.calls[0].access.self, false, 'the unproven self flag must be forwarded as-is');
  assert.ok(purpose.changes[0].field, 'the heuristic register still resolves');
  assert.equal(purpose.changes[0].field.certain, false, 'heuristic resolution stays uncertain');
});
