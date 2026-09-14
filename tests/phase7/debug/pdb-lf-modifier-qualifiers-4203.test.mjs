import test from 'node:test';
import assert from 'node:assert/strict';
import { describeTypeIndex } from '../../../js/analysis/debug/pdb.js';

function describeModifier(modifiers) {
  const types = new Map([
    [0x1000, { kind: 'modifier', underlying: 0x0074, modifiers }],
  ]);
  return describeTypeIndex(0x1000, types);
}

test('issue #4203: LF_MODIFIER renders each supported qualifier', () => {
  for (const [modifiers, name] of [
    [0x0001, 'const int'],
    [0x0002, 'volatile int'],
    [0x0004, 'unaligned int'],
  ]) {
    const described = describeModifier(modifiers);
    assert.equal(described.name, name, `modifier 0x${modifiers.toString(16)}`);
    assert.equal(described.complete, true, `${name} must remain complete`);
    assert.equal(described.widthBits, 32, `${name} must preserve target machine facts`);
    assert.equal(described.class, 'integer', `${name} must preserve target machine facts`);
  }
});

test('issue #4203: LF_MODIFIER preserves all supported qualifier combinations', () => {
  for (const [modifiers, name] of [
    [0x0003, 'const volatile int'],
    [0x0005, 'const unaligned int'],
    [0x0006, 'volatile unaligned int'],
    [0x0007, 'const volatile unaligned int'],
  ]) {
    const described = describeModifier(modifiers);
    assert.equal(described.name, name, `modifier 0x${modifiers.toString(16)}`);
    assert.equal(described.complete, true, `${name} must remain complete`);
  }
});

test('issue #4203: unknown LF_MODIFIER bits stay incomplete instead of becoming exact', () => {
  const unknown = describeModifier(0x0008);
  assert.equal(unknown.name, 'int', 'unknown-only bits must not invent a qualifier name');
  assert.equal(unknown.complete, false, 'unknown bits must not silently publish complete metadata');

  const knownAndUnknown = describeModifier(0x0009);
  assert.equal(knownAndUnknown.name, 'const int', 'known qualifiers remain visible alongside unknown bits');
  assert.equal(knownAndUnknown.complete, false, 'known plus unknown bits must remain incomplete');
});
