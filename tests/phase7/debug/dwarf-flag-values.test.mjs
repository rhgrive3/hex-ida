import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

const dwarfSource = new URL('../../../js/analysis/debug/dwarf.js', import.meta.url);

test('DWARF boolean attributes use flag values, not attribute presence', async () => {
  const source = await readFile(dwarfSource, 'utf8');
  assert.match(source, /function attributeFlag\(die, attribute\)/);
  assert.match(source, /value != null && value !== 0n && value !== 0 && value !== false/);
  assert.match(source, /external: attributeFlag\(die, DW_AT\.external\)/);
  assert.match(source, /!attributeFlag\(die, DW_AT\.declaration\)/);
  assert.match(source, /case DW_FORM\.flag_present: return \{ value: 1n \}/);
  assert.doesNotMatch(source, /external:\s*die\.attrs\.has\(DW_AT\.external\)/);
  assert.doesNotMatch(source, /!die\.attrs\.has\(DW_AT\.declaration\)/);
});
