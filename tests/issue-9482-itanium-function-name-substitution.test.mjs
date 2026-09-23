// Regression test for Issue #9482:
// demangleCxx must not register non-template function names into the substitution table.
import assert from 'node:assert/strict';
import { demangleCxx, readableName } from '../js/rtti.js';

// Counterexample 1: _Z4funcPiS_ (void func(int*, int*))
// Previously registered 'func' as subs[0], producing 'func(int *, func)'.
assert.equal(demangleCxx('_Z4funcPiS_'), 'func(int *, int *)');

// Counterexample 2: _Z3foo1AS_ (void foo(A, A))
// Previously registered 'foo' as subs[0], producing 'foo(A, foo)'.
assert.equal(demangleCxx('_Z3foo1AS_'), 'foo(A, A)');

// Counterexample 3: _ZN1N1fENS_1AES0_ (void N::f(N::A, N::A))
// Previously registered 'f' into subs, breaking S0_ resolution.
assert.equal(demangleCxx('_ZN1N1fENS_1AES0_'), 'N::f(N::A, N::A)');
assert.equal(demangleCxx('_ZN1N1fENS_1AES_'), 'N::f(N::A, N)');

// Nested function name with multiple prefixes and substitutions
assert.equal(demangleCxx('_ZN1A1B1cENS_1D1EES_'), 'A::B::c(A::D::E, A)');
assert.equal(demangleCxx('_ZN1A1B1cENS_1D1EES0_'), 'A::B::c(A::D::E, A::B)');
assert.equal(demangleCxx('_ZN1A1B1cENS_1D1EES1_'), 'A::B::c(A::D::E, A::D)');
assert.equal(demangleCxx('_ZN1A1B1cENS_1D1EES2_'), 'A::B::c(A::D::E, A::D::E)');
assert.equal(demangleCxx('_ZN1A1B1cENS_1D1EES3_'), null);

// Unscoped function taking multiple user-defined types and pointers
assert.equal(demangleCxx('_Z4func1A1BS_S0_'), 'func(A, B, A, B)');
assert.equal(demangleCxx('_Z4funcPPiS_S0_'), 'func(int * *, int *, int * *)');

// readableName wrapper behavior
assert.equal(readableName('_Z4funcPiS_'), 'func(int *, int *)');
assert.equal(readableName('_Z3foo1AS_'), 'foo(A, A)');

console.log('issue #9482 regression passed');
