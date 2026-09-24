import assert from 'node:assert/strict';
import { demangleCxx, demangleSwift, readableName } from '../js/rtti.js';

assert.equal(demangleCxx('__ZSt9terminatev'), 'std::terminate()');
assert.equal(demangleCxx('_ZN3FooIiEC1Ev'), 'Foo<int>::Foo()');
assert.equal(demangleCxx('_ZN3FooIiED1Ev'), 'Foo<int>::~Foo()');

const swift = '$s4main3addyS2i_SitF';
const demangled = demangleSwift(swift);
assert.ok(demangled);
assert.match(demangled, /^main\.add/);
assert.doesNotMatch(demangled, /(?:^|\.)i_(?:\.|\s|$)/, 'type/substitution digits must not synthesize an i_ identifier');
assert.equal(readableName(swift), demangled);
console.log('issues #9626/#9627/#9628 RTTI demangle regressions: PASS');
