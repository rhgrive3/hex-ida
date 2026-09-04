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

console.log('issue-6103-signature-boundary: ok');
