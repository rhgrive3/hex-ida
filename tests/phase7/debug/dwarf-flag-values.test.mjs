import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
const u=new URL('../../../js/analysis/debug/dwarf.js',import.meta.url);
test('DWARF boolean attributes use flag values, not attribute presence',async()=>{const s=await readFile(u,'utf8');assert.match(s,/function attributeFlag\(die, attribute\)/);assert.match(s,/value != null && value !== 0n && value !== 0 && value !== false/);assert.match(s,/external: attributeFlag\(die, DW_AT\.external\)/);assert.match(s,/!attributeFlag\(die, DW_AT\.declaration\)/);assert.match(s,/case DW_FORM\.flag_present: return \{ value: 1n \}/);});
