import test from 'node:test';
import assert from 'node:assert/strict';
import { demangleSwift, readableName } from '../js/rtti.js';

// #5253 — Swift member symbols must classify by their own entity operator,
// not the enclosing nominal type marker. Symbols are the real swiftc output
// from `class Foo { var x: Int { 42 }; init(); func bar(_ y: Int) -> Int }`.
test('#5253 swift member entity kind beats enclosing nominal kind', () => {
  const cases = [
    ['$s4Test3FooC1xSivg', 'getter'],  // Test.Foo.x.getter
    ['$s4Test3FooC3baryS2iF', 'func'], // Test.Foo.bar(_:)
    ['$s4Test3FooCACycfC', 'init'],    // Test.Foo.init() allocating constructor
    ['$s4Test3FooCfD', 'deinit'],      // Test.Foo deallocating destructor
  ];
  for (const [symbol, expected] of cases) {
    const out = demangleSwift(symbol);
    assert.ok(out, `${symbol} must demangle`);
    assert.match(out, new RegExp(`\\[${expected}\\]`), `${symbol} must carry [${expected}] — got ${JSON.stringify(out)}`);
  }

  // setter accessor (`var x { set }`)
  assert.match(demangleSwift('$s4Test3FooC1xSivs'), /\[setter\]/);

  // Context-only symbols keep their nominal kind.
  assert.equal(demangleSwift('$s4Test3FooC'), 'Test.Foo   [class]');
  assert.equal(demangleSwift('$s4Test3FooV'), 'Test.Foo   [struct]');

  // Plain free functions are unchanged.
  assert.match(demangleSwift('$s4main3fooyyF'), /\[func\]/);
  assert.equal(demangleSwift('$s4Test3Foo'), 'Test.Foo');
  assert.equal(demangleSwift('$s4Test3Foo3Bar'), 'Test.Foo.Bar');
  assert.equal(readableName('$s4Test3FooC1xSivg'), 'Test.Foo.x   [getter]');
});
