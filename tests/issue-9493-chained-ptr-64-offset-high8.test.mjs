import assert from 'node:assert/strict';
import test from 'node:test';
import { sanitizePointer } from '../js/objc-legacy.js';
import { sanitizePointer as sanitizePointerFacade } from '../js/objc.js';

test('Issue #9493: sanitizePointer format 6 (DYLD_CHAINED_PTR_64_OFFSET) preserves high8 bits', () => {
  const base = 0x100000000n;
  const target = 0x123456789n;
  const high8 = 0xABn;
  // dyld_chained_ptr_64_rebase format 6 layout:
  // bit 0-35: target (vm offset)
  // bit 36-43: high8
  // bit 51-62: next
  // bit 63: bind (0 for rebase)
  const next = 2n;
  const raw = target | (high8 << 36n) | (next << 51n);

  const reconstructed = target | (high8 << 56n);
  const expected = base + reconstructed;

  // Verify direct export from objc-legacy.js
  const resolved = sanitizePointer(raw, base, 6);
  assert.equal(resolved, expected, 'format 6 must include high8 in reconstructed offset before adding base');

  // Verify facade re-export from objc.js
  const resolvedFacade = sanitizePointerFacade(raw, base, 6);
  assert.equal(resolvedFacade, expected);

  // When high8 is 0, offset is just target
  const rawZeroHigh8 = target | (next << 51n);
  assert.equal(sanitizePointer(rawZeroHigh8, base, 6), base + target);

  // Without base, format 6 rebase must fail closed and return null
  assert.equal(sanitizePointer(raw, null, 6), null);
  assert.equal(sanitizePointer(raw, undefined, 6), null);

  // Bind bit (bit 63) set must return null
  assert.equal(sanitizePointer(raw | (1n << 63n), base, 6), null);

  // Format 2 (preferred vmaddr) preserves high8 without adding base
  assert.equal(sanitizePointer(raw, base, 2), reconstructed);
});
