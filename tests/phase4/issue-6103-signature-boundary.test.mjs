import assert from 'node:assert/strict';
import { recognizeLibraries } from '../../js/signature/index.js';

const signatures = [{
  name: 'Fixture',
  classification: 'LIBRARY',
  kind: 'library',
  libraries: [/Foo/g],
  symbols: [/^bar$/],
  strings: [/baz/],
}];

for (const input of [
  { symbols: {} },
  { imports: {} },
  { libraries: {} },
  { strings: {} },
  { symbols: 'bar' },
]) {
  assert.doesNotThrow(() => recognizeLibraries(input, signatures));
  assert.deepEqual(recognizeLibraries(input, signatures), []);
}

assert.equal(recognizeLibraries({ libraries: ['Foo'], symbols: ['bar'], strings: ['baz'] }, signatures).length, 1);
assert.equal(recognizeLibraries({ libraries: new Set(['Foo']), symbols: new Set(['bar']) }, signatures).length, 1);
assert.equal(recognizeLibraries({ libraries: ['Foo'] }, signatures).length, 1);

const leafSignatures = [{
  name: 'SQLite',
  classification: 'LIBRARY',
  kind: 'library',
  libraries: [/sqlite3/i],
  symbols: [/^_?sqlite3_/],
  strings: [],
}];
for (const input of [
  { libraries: [{ name: ['sqlite3'] }] },
  { symbols: [{ text: ['sqlite3_open'] }] },
  { strings: [{ library: { toString: () => 'sqlite3' } }] },
  { libraries: [{ name: true }] },
]) {
  assert.deepEqual(recognizeLibraries(input, leafSignatures), []);
}
assert.equal(recognizeLibraries({
  libraries: [{ name: 'sqlite3' }],
  symbols: [{ text: 'sqlite3_open' }],
}, leafSignatures).length, 1);

console.log('issue-6103-signature-boundary: ok');
