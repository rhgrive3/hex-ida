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

// #4563: the canonical (address, selector, source) entry must be shared by
// both projections. Different sources at the same address and selector, and
// the same selector at another address, remain distinct.
const duplicateIndex = buildSelectorIndex({
  selectorRefs: [
    { addr: 0x200, selector: 'duplicate:' },
    { address: '0x200', sel: 'duplicate:' },
    { addr: 0x200, selector: 'other:' },
  ],
  stubs: [{ addr: 0x200, selector: 'duplicate:' }],
  fixups: [
    { addr: 0x200, selector: 'duplicate:' },
    { addr: 0x204, selector: 'duplicate:' },
  ],
});
assert.equal(duplicateIndex.count, 5);
assert.equal(duplicateIndex.byAddress.get('512').length, 4);
assert.equal(duplicateIndex.byAddress.get('516').length, 1);
assert.equal(duplicateIndex.bySelector.get('duplicate:').length, 4);
assert.equal(duplicateIndex.bySelector.get('other:').length, 1);
const addressedEntries = new Set([...duplicateIndex.byAddress.values()].flat());
for (const entry of duplicateIndex.bySelector.get('duplicate:')) {
  assert.ok(addressedEntries.has(entry), 'bySelector entries must be canonical byAddress entries');
}
const selectorRefEntry = duplicateIndex.byAddress.get('512').find((entry) => entry.source === 'selector-ref');
assert.equal(duplicateIndex.bySelector.get('duplicate:').find((entry) => entry.source === 'selector-ref'), selectorRefEntry);
assert.deepEqual(
  duplicateIndex.byAddress.get('512').map((entry) => entry.source).sort(),
  ['chained-fixup', 'message-stub', 'selector-ref', 'selector-ref'].sort(),
);
const mixedIndex = buildSelectorIndex({
  selectorRefs: {},
  stubs: [{ addr: 96, selector: 'mixedStub:' }],
  fixups: [{ addr: 112, selector: 'mixedFixup:' }],
});
assert.equal(mixedIndex.count, 2);
assert.equal(resolveSelectorStub({ address: 96, selectorIndex: mixedIndex }).selector, 'mixedStub:');
assert.equal(resolveSelectorStub({ address: 112, selectorIndex: mixedIndex }).selector, 'mixedFixup:');
const fallback = resolveSelectorStub({ address: 16, symbolFor: true, selectorFor: {}, selectorIndex: validIndex });
assert.equal(fallback.selector, 'indexed:');
assert.equal(fallback.ambiguous, false);
class InvalidResolverHook {}
assert.equal(resolveSelectorStub({ address: 64, symbolFor: InvalidResolverHook }).selector, null);
assert.equal(resolveSelectorStub({ address: 80, selectorFor: InvalidResolverHook }).selector, null);
let symbolCalls = 0;
const symbolHook = resolveSelectorStub({ address: 64, symbolFor(address) { symbolCalls++; assert.equal(address, 64); return '_objc_msgSend$symbolHook:'; } });
assert.equal(symbolCalls, 1);
assert.equal(symbolHook.selector, 'symbolHook:');
let selectorCalls = 0;
const selectorHook = resolveSelectorStub({ address: 80, selectorFor(address) { selectorCalls++; assert.equal(address, 80); return 'selectorHook:'; } });
assert.equal(selectorCalls, 1);
assert.equal(selectorHook.selector, 'selectorHook:');
