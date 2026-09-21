import assert from 'node:assert/strict';
import test from 'node:test';

import { inlineImports, parseImports, resolveImportScriptsSpecifier } from '../scripts/build-userscript.mjs';

test('#9345 root-relative importScripts specifiers fail closed instead of becoming worker-relative', () => {
  assert.throws(() => resolveImportScriptsSpecifier('/helper.js', 'js/worker.js'), /Unsupported non-relative/);
  assert.throws(() => parseImports("importScripts('/helper.js');", 'js/platform/worker.js'), /Unsupported non-relative/);
});

test('#9345 remote and scheme-relative importScripts specifiers also fail closed', () => {
  for (const specifier of ['https://example.test/helper.js', '//example.test/helper.js', 'data:text/javascript,42']) {
    assert.throws(() => resolveImportScriptsSpecifier(specifier, 'js/worker.js'), /Unsupported non-relative/);
  }
});

test('#9345 ordinary relative and contained parent-relative specifiers remain stable', () => {
  assert.equal(resolveImportScriptsSpecifier('./helper.js', 'js/worker.js'), 'js/helper.js');
  assert.equal(resolveImportScriptsSpecifier('../helper.js', 'js/platform/worker.js'), 'js/helper.js');
});

test('#9345 inlineImports never silently binds a root URL to a nested repository source', () => {
  const sources = new Map([
    ['js/worker.js', "importScripts('/helper.js');"],
    ['js/helper.js', "globalThis.SENTINEL='wrong';"],
    ['helper.js', "globalThis.SENTINEL='root';"],
  ]);
  assert.throws(() => inlineImports('js/worker.js', sources), /Unsupported non-relative/);
});
