import assert from 'node:assert/strict';
import { parseDex } from '../js/managed/dex/parser.js';
import { buildMinimalDex } from './phase11/dex/dex-parser.test.mjs';

console.log('[issue-5051] running DEX header size/off presence-invariant regression...');

// AOSP DEX integrity constraint G7: for each fixed-width section pair, size and
// offset must be both zero (valid empty section) or both non-zero. validateTable
// runs before validateDexMap, so a violated pair must surface as the section's
// own header error code.
const SECTIONS = [
  { name: 'string_ids', sizeAt: 56, offAt: 60, code: 'dex-truncated-string-ids' },
  { name: 'type_ids', sizeAt: 64, offAt: 68, code: 'dex-invalid-type-ids-range' },
  { name: 'proto_ids', sizeAt: 72, offAt: 76, code: 'dex-invalid-proto-ids-range' },
  { name: 'field_ids', sizeAt: 80, offAt: 84, code: 'dex-invalid-field-ids-range' },
  { name: 'method_ids', sizeAt: 88, offAt: 92, code: 'dex-invalid-method-ids-range' },
  { name: 'class_defs', sizeAt: 96, offAt: 100, code: 'dex-invalid-class-defs-range' },
];

function headerDex(sizeAt, size, offAt, off) {
  const bytes = buildMinimalDex();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  view.setUint32(sizeAt, size, true);
  view.setUint32(offAt, off, true);
  return bytes;
}

function expectHeaderCode(bytes, code) {
  assert.throws(() => parseDex(bytes), (error) => error instanceof TypeError && error.message === code);
}

// size=0, off>0 => reject with the section's own header code for every pair.
for (const section of SECTIONS) {
  expectHeaderCode(headerDex(section.sizeAt, 0, section.offAt, 0x100), section.code);
}

// size>0, off=0 => reject (symmetric half of the invariant).
for (const section of SECTIONS) {
  expectHeaderCode(headerDex(section.sizeAt, 1, section.offAt, 0), section.code);
}

// size=0, off=0 => valid empty section must be preserved (field_ids is empty in
// the otherwise-valid minimal image, so parseDex must succeed).
{
  const bytes = headerDex(80, 0, 84, 0);
  assert.doesNotThrow(() => parseDex(bytes));
}

// #5031 non-empty fixed-width range validation must remain intact.
expectHeaderCode(headerDex(96, 0x400, 100, 0xb0), 'dex-invalid-class-defs-range');

console.log('  ok issue-5051 DEX header size/off presence invariant passed');
