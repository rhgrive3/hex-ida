import assert from 'node:assert/strict';
import test from 'node:test';

import { classifyLanguageRuntimeCall } from '../js/metadata/index.js';
import { classifyRuntimeCall, runtimeOriginForSymbol } from '../js/apple/runtime.js';

// Issue #6199: `^std::` alone was treated as Rust evidence, but `std::` is also
// the C++ standard library namespace. Demangled C++ symbols like
// `std::vector<int>::size()` were pinned as `runtime: 'rust'` by
// classifyLanguageRuntimeCall, classifyRuntimeCall, and
// runtimeOriginForSymbol alike.

test('issue-6199: a demangled C++ std:: symbol is not classified as rust', () => {
  for (const symbol of [
    'std::vector<int>::size()',
    'std::basic_string<char>::size()',
    'std::unique_ptr<Foo>::get()',
  ]) {
    assert.notEqual(classifyLanguageRuntimeCall(symbol)?.runtime, 'rust',
      `classifyLanguageRuntimeCall pinned ${symbol} as rust`);
    assert.notEqual(runtimeOriginForSymbol(symbol), 'rust',
      `runtimeOriginForSymbol pinned ${symbol} as rust`);
    assert.notEqual(classifyRuntimeCall(symbol).runtime, 'rust',
      `classifyRuntimeCall pinned ${symbol} as rust`);
  }
});

test('issue-6199: an ambiguous std:: symbol without further evidence is not rust', () => {
  // Ambiguity policy: without mangling provenance the classifier must not
  // resolve std:: to either ecosystem, so it degrades to the non-committal
  // verdicts rather than fabricating Rust provenance.
  assert.equal(runtimeOriginForSymbol('std::vector<int>::size()'), 'c');
  assert.equal(classifyLanguageRuntimeCall('std::vector<int>::size()'), null);
});

test('issue-6199: existing rust detection is preserved', () => {
  // v0 mangled, legacy mangled with symbol-name hash, runtime symbols, and
  // core::/alloc:: demangled paths all remain rust.
  assert.equal(runtimeOriginForSymbol('_RC6my_app'), 'rust');
  assert.equal(runtimeOriginForSymbol('_ZN10GameObject6update17haabbccddeeff0011E'), 'rust');
  assert.equal(runtimeOriginForSymbol('_rust_alloc'), 'rust');
  assert.equal(runtimeOriginForSymbol('core::slice::len'), 'rust');
  assert.equal(runtimeOriginForSymbol('alloc::raw_vec'), 'rust');
  assert.equal(classifyLanguageRuntimeCall('core::fmt::write')?.runtime, 'rust');
  assert.equal(classifyLanguageRuntimeCall('_rust_dealloc')?.noise, true);
});

test('issue-6199: a rust legacy symbol demangling to std:: with its hash stays rust', () => {
  // _ZN3std2io12$LT$impl$GT$17h1122334455667788E demangles to
  // `std::io::<impl>` plus the 17h<16 hex>E symbol-name hash, which is exactly
  // the provenance that keeps std:: resolvable to Rust. The hash also survives
  // in toolchain-style `::h<16 hex>` form.
  assert.equal(runtimeOriginForSymbol('std::io::<impl>17h1122334455667788E'), 'rust');
  assert.equal(runtimeOriginForSymbol('std::io::<impl>h1122334455667788E'), 'rust');
  assert.equal(runtimeOriginForSymbol('std::io::read::h1122334455667788'), 'rust');
  assert.equal(classifyLanguageRuntimeCall('std::io::read::h1122334455667788')?.runtime, 'rust');
});

test('issue-6199: C++ Itanium mangled symbols remain cpp', () => {
  assert.equal(runtimeOriginForSymbol('_ZN10GameObject6updateEv'), 'cpp');
  assert.equal(runtimeOriginForSymbol('__ZN10GameObject6updateEv'), 'cpp');
});

test('issue-6199: both classifiers share the same std:: ambiguity policy', () => {
  // The apple lane defers to classifyLanguageRuntimeCall before falling back
  // to runtimeOriginForSymbol, so a policy divergence would resurrect the
  // misclassification through classifyRuntimeCall.
  for (const symbol of ['std::vector<int>::size()', 'std::map<int, int>::find()']) {
    const language = classifyLanguageRuntimeCall(symbol);
    const call = classifyRuntimeCall(symbol);
    assert.notEqual(call.runtime, 'rust');
    assert.equal(call.runtime, language?.runtime ?? runtimeOriginForSymbol(symbol),
      'classifyRuntimeCall must agree with the unified ambiguity policy');
  }
});
