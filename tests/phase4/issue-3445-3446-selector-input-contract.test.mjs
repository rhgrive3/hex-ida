import assert from 'node:assert/strict';
import { buildSelectorIndex, resolveSelectorStub } from '../../js/apple/selector-stubs.js';
for (const malformed of [{ selectorRefs: {} }, { stubs: true }, { fixups: 1 }]) {
  const index = buildSelectorIndex(malformed);
  assert.equal(index.count, 0);
  assert.equal(index.byAddress.size, 0);
  assert.equal(index.bySelector.size, 0);
}
const validIndex = buildSelectorIndex({
  selectorRefs: [{ addr: 16, selector: 'indexed:' }],
  stubs: [{ addr: 32, selector: 'stubbed:' }],
  fixups: [{ addr: 48, selector: 'fixed:' }],
});
assert.equal(validIndex.count, 3);
assert.equal(resolveSelectorStub({ address: 16, selectorIndex: validIndex }).selector, 'indexed:');
assert.equal(resolveSelectorStub({ address: 32, selectorIndex: validIndex }).selector, 'stubbed:');
assert.equal(resolveSelectorStub({ address: 48, selectorIndex: validIndex }).selector, 'fixed:');
const fallback = resolveSelectorStub({ address: 16, symbolFor: true, selectorFor: {}, selectorIndex: validIndex });
assert.equal(fallback.selector, 'indexed:');
assert.equal(fallback.ambiguous, false);
let symbolCalls = 0;
const symbolHook = resolveSelectorStub({ address: 64, symbolFor(address) { symbolCalls++; assert.equal(address, 64); return '_objc_msgSend$symbolHook:'; } });
assert.equal(symbolCalls, 1);
assert.equal(symbolHook.selector, 'symbolHook:');
let selectorCalls = 0;
const selectorHook = resolveSelectorStub({ address: 80, selectorFor(address) { selectorCalls++; assert.equal(address, 80); return 'selectorHook:'; } });
assert.equal(selectorCalls, 1);
assert.equal(selectorHook.selector, 'selectorHook:');
