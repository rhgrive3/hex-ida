import test from 'node:test';
import assert from 'node:assert/strict';

import { parseDebugInfo } from '../../../js/analysis/debug/dwarf.js';

const stringAbbrev = Uint8Array.from([
  0x01, 0x11, 0x00,
  0x03, 0x08,
  0x00, 0x00,
  0x00,
]);

const unit = (bytes) => Uint8Array.from([bytes.length & 0xff, 0, 0, 0, ...bytes]);

test('issue 2681: inline DW_FORM_string cannot read into the following compilation unit', () => {
  const debugInfo = Uint8Array.from([
    0x09, 0x00, 0x00, 0x00,
    0x04, 0x00,
    0x00, 0x00, 0x00, 0x00,
    0x08,
    0x01,
    0x41,
    0x08, 0x00, 0x00, 0x00,
    0x04, 0x00,
    0x00, 0x00, 0x00, 0x00,
    0x08,
    0x00,
  ]);

  const result = parseDebugInfo({ debug_info: debugInfo, debug_abbrev: stringAbbrev });
  assert.equal(result.complete, false);
  assert.equal(result.dies.has(11), false, 'the malformed DIE must not be published');
  assert.ok(result.diagnostics.some((d) => /read past unit boundary/.test(d)));
  assert.equal(result.units.length, 2, 'the following unit remains independently discoverable');
});

test('issue 2681: an inline string terminated inside its own unit remains complete', () => {
  const info = unit([0x04, 0x00, 0, 0, 0, 0, 0x08, 0x01, 0x41, 0x00]);
  const result = parseDebugInfo({ debug_info: info, debug_abbrev: stringAbbrev });
  assert.equal(result.complete, true);
  assert.equal(result.dies.get(11)?.attributes.get(0x03)?.value, 'A');
});

test('issue 2682: every non-empty short trailing CU header fragment fails closed', () => {
  const emptyAbbrev = Uint8Array.from([0x01, 0x11, 0x00, 0x00, 0x00, 0x00]);
  const valid = unit([0x04, 0x00, 0, 0, 0, 0, 0x08, 0x01]);
  for (let trailing = 1; trailing <= 10; trailing += 1) {
    const info = Uint8Array.from([...valid, ...new Array(trailing).fill(0x7f)]);
    const result = parseDebugInfo({ debug_info: info, debug_abbrev: emptyAbbrev });
    assert.equal(result.complete, false, `trailing length ${trailing} must be incomplete`);
    assert.ok(result.diagnostics.some((d) => /truncated compilation unit/.test(d)));
  }
});

test('issue 2682: a fully consumed valid debug_info section stays complete', () => {
  const emptyAbbrev = Uint8Array.from([0x01, 0x11, 0x00, 0x00, 0x00, 0x00]);
  const info = unit([0x04, 0x00, 0, 0, 0, 0, 0x08, 0x01]);
  const result = parseDebugInfo({ debug_info: info, debug_abbrev: emptyAbbrev });
  assert.equal(result.complete, true);
  assert.equal(result.diagnostics.length, 0);
});
