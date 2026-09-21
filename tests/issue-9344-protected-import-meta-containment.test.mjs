import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { protectedImportMetaPlugin } from '../scripts/build-userscript.mjs';

function loaderFor(rootDir, sources) {
  let loader = null;
  const reads = [];
  protectedImportMetaPlugin({
    rootDir,
    async readFileImpl(file) {
      reads.push(file);
      return sources.get(file);
    },
  }).setup({ onLoad(_opts, callback) { loader = callback; } });
  return { load:(file) => loader({ path:file }), reads };
}

test('#9344 sibling-prefix paths are not classified as repository sources', async () => {
  const rootDir = path.resolve('/tmp/hex-ida');
  for (const sibling of ['/tmp/hex-ida-evil/outside.js', '/tmp/hex-ida2/outside.js']) {
    const full = path.resolve(sibling);
    const { load, reads } = loaderFor(rootDir, new Map([[full, 'console.log(import.meta.url);']]));
    assert.equal(await load(full), null);
    assert.deepEqual(reads, []);
  }
});

test('#9344 genuine descendants still receive a contained logical import.meta URL', async () => {
  const rootDir = path.resolve('/tmp/hex-ida');
  const inside = path.resolve(rootDir, 'js/inside.js');
  const { load } = loaderFor(rootDir, new Map([[inside, 'console.log(import.meta.url);']]));
  const result = await load(inside);
  assert.match(result.contents, /https:\/\/hex\.invalid\/js\/inside\.js/);
  assert.doesNotMatch(result.contents, /\.\.\//);
});
