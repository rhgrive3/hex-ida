import test from 'node:test';
import assert from 'node:assert/strict';
import {
  demangleRustLegacy,
  demangleRustSymbol,
  stripLegacyRustPrefix,
  isRustCandidateSymbol,
} from '../../../js/metadata/rust.js';
import { parseUnifiedLanguageMetadata } from '../../../js/metadata/index.js';

test('issue 6276: accepts canonical macOS legacy Rust prefix without over-stripping', async () => {
  for (const [symbol, expected] of [
    ['_ZN3fooE', 'foo'],
    ['ZN3fooE', 'foo'],
    ['__ZN3fooE', 'foo'],
  ]) {
    assert.equal(demangleRustLegacy(symbol).demangled, expected);
    assert.equal(demangleRustSymbol(symbol).demangled, expected);
  }

  assert.equal(demangleRustSymbol('__RC3foo').demangled, 'foo');
  assert.equal(stripLegacyRustPrefix('___ZN3fooE'), null);
  assert.equal(isRustCandidateSymbol('___ZN3fooE'), false);
  assert.equal(demangleRustSymbol('___ZN3fooE').parsed, false);
  assert.equal(isRustCandidateSymbol('_Z1fv'), false);
  assert.equal(isRustCandidateSymbol('_malloc'), false);

  const result = await parseUnifiedLanguageMetadata({
    symbols: [{ name: '__ZN3fooE', address: 0x1000n }],
    sections: [],
  });
  assert.ok(result.ecosystems.includes('rust'));
  const rust = result.results.find((entry) => entry.ecosystem === 'rust');
  assert.equal(rust.provider.cachedParsed.rustSymbols[0].name, 'foo');
});

// Current-main repairs must survive reconciliation of this older owner branch.
test('issue 6276: preserve malformed-prefix and metadata-shape boundaries', async () => {
  for (const name of ['___ZN3fooE', '___RC3foo', '__ZN3foo', '_ZN3foo']) {
    assert.equal(demangleRustSymbol(name).parsed, false, name);
  }
  for (const value of [null, undefined, false, 1, ['__ZN3fooE'], { toString() { throw new Error('coercion'); } }]) {
    assert.equal(isRustCandidateSymbol(value), false);
    assert.equal(stripLegacyRustPrefix(value), null);
  }
  for (const symbols of [null, {}, true, 'not-a-symbol-list']) {
    const result = await parseUnifiedLanguageMetadata({ symbols, sections: [] });
    assert.equal(result.ecosystems.includes('rust'), false);
  }
  const result = await parseUnifiedLanguageMetadata({
    symbols: [{ symbol: '__ZN3fooE', address: 0x1000n }],
    sections: [],
  });
  assert.equal(result.ecosystems.includes('rust'), true);
});
