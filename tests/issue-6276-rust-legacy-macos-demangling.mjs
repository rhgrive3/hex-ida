// Issue #6276: Rust metadata support for macOS legacy __ZN... symbols
import assert from 'node:assert/strict';
import {
  demangleRustLegacy,
  demangleRustSymbol,
  stripLegacyRustPrefix,
  isRustCandidateSymbol,
  RustMetadataProvider,
} from '../js/metadata/rust.js';
import { parseUnifiedLanguageMetadata } from '../js/metadata/index.js';

// 1. _ZN3fooE -> 従来どおり foo
{
  const res = demangleRustLegacy('_ZN3fooE');
  assert.equal(res.parsed, true);
  assert.equal(res.demangled, 'foo');
  const sym = demangleRustSymbol('_ZN3fooE');
  assert.equal(sym.parsed, true);
  assert.equal(sym.demangled, 'foo');
}

// 2. ZN3fooE -> 従来どおり foo
{
  const res = demangleRustLegacy('ZN3fooE');
  assert.equal(res.parsed, true);
  assert.equal(res.demangled, 'foo');
  const sym = demangleRustSymbol('ZN3fooE');
  assert.equal(sym.parsed, true);
  assert.equal(sym.demangled, 'foo');
}

// 3. __ZN3fooE -> foo (macOS Mach-O legacy prefix)
{
  const res = demangleRustLegacy('__ZN3fooE');
  assert.equal(res.parsed, true);
  assert.equal(res.demangled, 'foo');
  assert.equal(res.generation, 'legacy');
  const sym = demangleRustSymbol('__ZN3fooE');
  assert.equal(sym.parsed, true);
  assert.equal(sym.demangled, 'foo');
}

// 4. __ZN... のみの symbol context でも unified Rust provider が起動する
{
  const context = {
    symbols: [{ name: '__ZN3fooE', address: 0x1000n }],
    sections: [],
  };
  const result = await parseUnifiedLanguageMetadata(context);
  assert.ok(result.ecosystems.includes('rust'), 'expected rust ecosystem in unified metadata');
  const rustEntry = result.results.find((r) => r.ecosystem === 'rust');
  assert.ok(rustEntry, 'expected rust provider result');
  const symbols = rustEntry.provider.cachedParsed.rustSymbols;
  assert.equal(symbols.length, 1);
  assert.equal(symbols[0].name, 'foo');
  assert.equal(symbols[0].original, '__ZN3fooE');
}

// 5. __R... v0 の既存 Mach-O 対応を維持する
{
  const res = demangleRustSymbol('__RC3foo');
  assert.equal(res.parsed, true);
  assert.equal(res.demangled, 'foo');
  assert.equal(res.generation, 'v0');
}

// 6. _R... / _ZN... / ZN... の regression を維持する
{
  const v0 = demangleRustSymbol('_RC3bar');
  assert.equal(v0.parsed, true);
  assert.equal(v0.demangled, 'bar');

  const legacyWithHash = demangleRustSymbol('__ZN3foo3bar17h1234567890abcdefE');
  assert.equal(legacyWithHash.parsed, true);
  assert.equal(legacyWithHash.demangled, 'foo::bar');
  assert.equal(legacyWithHash.hash, '1234567890abcdef');
}

// 7. ___ZN... 等、根拠のない追加 underscore を無制限に strip しない
{
  assert.equal(stripLegacyRustPrefix('___ZN3fooE'), null);
  assert.equal(isRustCandidateSymbol('___ZN3fooE'), false);
  const res = demangleRustLegacy('___ZN3fooE');
  assert.equal(res.parsed, false);
  const sym = demangleRustSymbol('___ZN3fooE');
  assert.equal(sym.parsed, false);
}

// 8. 非 Rust C++/ObjC symbol を Rust として誤認しない
{
  const cpp1 = demangleRustSymbol('_Z1fv');
  assert.equal(cpp1.parsed, false);
  assert.equal(isRustCandidateSymbol('_Z1fv'), false);

  const cSym = demangleRustSymbol('_malloc');
  assert.equal(cSym.parsed, false);
  assert.equal(isRustCandidateSymbol('_malloc'), false);

  const objcSym = demangleRustSymbol('-[MyClass myMethod]');
  assert.equal(objcSym.parsed, false);
  assert.equal(isRustCandidateSymbol('-[MyClass myMethod]'), false);
}

console.log('issue #6276 rust legacy macOS demangling regressions: PASS');
