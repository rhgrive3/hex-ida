import assert from 'node:assert/strict';
import test from 'node:test';
import { FieldIndex } from '../js/fields.js';

function fieldIndex() {
  return new FieldIndex({ classes: [{
    name: 'C', instanceSize: 0x40,
    ivars: [{ name: '_v', offset: 0x10, size: 8, offsetVar: 0x2000n }],
  }] });
}

test('#9496 explicit self=false vetoes x0/x19/x20 heuristic field recovery', () => {
  const fields = fieldIndex();
  for (const base of ['x0', 'x19', 'x20']) {
    assert.equal(fields.resolveAccess({ base, disp: 0x10n, self: false }, 'C'), null);
  }
});

test('#9496 explicit self=false also vetoes offset-variable recovery', () => {
  const fields = fieldIndex();
  assert.equal(fields.resolveAccess({ base: 'x8', indexAddr: 0x2000n, self: false }, 'C'), null);
  assert.equal(fields.resolveAccess({ base: 'x0', disp: 0x10n, self: null }, 'C')?.name, '_v');
});
