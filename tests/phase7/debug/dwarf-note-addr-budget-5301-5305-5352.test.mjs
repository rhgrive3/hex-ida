import assert from 'node:assert/strict';
import test from 'node:test';

import { parseDebugInfo, readBuildId } from '../../../js/analysis/debug/dwarf.js';

/**
 * DWARF boundary hardening: note names stay inside their declared namesz,
 * DW_FORM_addr honors the CU address size, and a malformed record budget
 * falls back to the default cap instead of disabling it
 * (#5301, #5305, #5352).
 */

test('#5301 build-id names ignore padding past namesz', () => {
  // namesz=3 "GNU" without NUL, padding NUL, descriptor deadbeef.
  const unterminated = Uint8Array.from([
    0x03, 0x00, 0x00, 0x00, 0x04, 0x00, 0x00, 0x00, 0x03, 0x00, 0x00, 0x00,
    0x47, 0x4e, 0x55, 0x00, 0xde, 0xad, 0xbe, 0xef,
  ]);
  assert.equal(readBuildId(unterminated), null);
  const good = Uint8Array.from([
    0x04, 0x00, 0x00, 0x00, 0x04, 0x00, 0x00, 0x00, 0x03, 0x00, 0x00, 0x00,
    0x47, 0x4e, 0x55, 0x00, 0xde, 0xad, 0xbe, 0xef,
  ]);
  assert.equal(readBuildId(good), 'deadbeef');
});

function unitWithDies(die, abbrev) {
  const unitLen = 2 + 4 + 1 + die.length;
  const info = new Uint8Array(4 + unitLen);
  const view = new DataView(info.buffer);
  view.setUint32(0, unitLen, true);
  view.setUint16(4, 4, true);
  view.setUint32(6, 0, true);
  return { info, abbrev };
}

test('#5305 DW_FORM_addr consumes the CU address size', () => {
  // abbrev 1: subprogram, no children, low_pc/addr + external/flag.
  const abbrev = Uint8Array.from([0x01, 0x2e, 0x00, 0x11, 0x01, 0x3f, 0x0c, 0x00, 0x00]);
  // DIE: code 1, 2-byte addr 0x1234, flag 1, null DIE.
  const die = Uint8Array.from([0x01, 0x34, 0x12, 0x01, 0x00]);
  const { info } = unitWithDies(die, abbrev);
  info[10] = 2; // address_size = 2
  info.set(die, 11);
  const parsed = parseDebugInfo({ debug_info: info, debug_abbrev: abbrev });
  assert.equal(parsed.complete, true);
  const first = [...parsed.dies.values()][0];
  assert.equal(first?.attributes?.get?.(0x11)?.value, 0x1234n);
  assert.equal(first?.attributes?.get?.(0x3f)?.value, 1n);
});

test('#5352 malformed record budgets fall back to the default cap', () => {
  const abbrev = Uint8Array.from([0x01, 0x2e, 0x00, 0x00, 0x00]);
  const die = new Uint8Array(200005).fill(0x01);
  const { info } = unitWithDies(die, abbrev);
  info[10] = 4;
  info.set(die, 11);
  const sections = { debug_info: info, debug_abbrev: abbrev };
  for (const budget of [{}, { maxRecords: NaN }, { maxRecords: 'many' }, undefined]) {
    const parsed = parseDebugInfo(sections, budget);
    assert.equal(parsed.dies.size, 200000, `budget ${String(JSON.stringify(budget))} must cap at the default`);
    assert.equal(parsed.complete, false);
    assert.ok(parsed.diagnostics.includes('record budget exhausted'));
  }
  const capped = parseDebugInfo(sections, { maxRecords: 5 });
  assert.equal(capped.dies.size, 5);
  assert.equal(capped.complete, false);
});
