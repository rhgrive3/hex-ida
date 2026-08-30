import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const url = new URL('../../../js/worker-legacy.js', import.meta.url);

test('legacy block cache single-flights same-file same-epoch misses', async () => {
  const source = await readFile(url, 'utf8');
  assert.match(source, /const blockInflight = new Map\(\)/);
  assert.match(source, /pending\.epoch === epoch && pending\.file === sourceFile/);
  assert.match(source, /sourceFile\.slice\(start, end\)\.arrayBuffer\(\)/);
  assert.match(source, /currentEpoch === epoch && file === sourceFile/);
  assert.match(source, /blockInflight\.get\(bi\) === entry/);
  assert.match(source, /blocks\.clear\(\);\s*blockInflight\.clear\(\)/);
});
