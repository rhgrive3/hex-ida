import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
const url=new URL('../../../js/worker-legacy.js',import.meta.url);
test('legacy block cache single-flights same-file same-epoch misses',async()=>{const s=await readFile(url,'utf8');assert.match(s,/const blockInflight = new Map\(\)/);assert.match(s,/pending\.epoch === epoch && pending\.file === sourceFile/);assert.match(s,/sourceFile\.slice\(start, end\)\.arrayBuffer\(\)/);assert.match(s,/currentEpoch === epoch && file === sourceFile/);assert.match(s,/blockInflight\.get\(bi\) === entry/);assert.match(s,/blocks\.clear\(\);\s*blockInflight\.clear\(\)/);});
