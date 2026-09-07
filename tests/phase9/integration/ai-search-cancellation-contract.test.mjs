import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
const url=new URL('../../../js/ai/tools/registry-base.js',import.meta.url);
test('AI search producer paths receive execution signal',async()=>{const s=await readFile(url,'utf8');assert.equal((s.match(/callOptions = \{\}/g)||[]).length>=2,true);assert.match(s,/async function searchPage\([^)]*options = \{\}\)/);assert.match(s,/const signal = options\?\.signal \|\| null/);assert.match(s,/limit: limit \+ 1, offset, signal/);assert.match(s,/limit: prefixLimit, offset: 0, signal/);assert.match(s,/legacy\[tool\]\(query, \{ limit: .*offset, signal \}\)/);});
