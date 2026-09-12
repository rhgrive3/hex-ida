import assert from 'node:assert/strict';
import { compilePattern, evaluatePattern } from '../../../js/pattern/index.js';

function trackingSource(handler) {
  const reads = [];
  return {
    reads,
    source: {
      snapshotId: 'issue-5100',
      size: null,
      read(offset, length, { space } = {}) {
        const at = BigInt(offset);
        reads.push({ offset: at, length, space });
        return handler({ offset: at, length, space });
      },
    },
  };
}

// A compiled pattern's targetAddressSpace is part of patternId identity and
// must therefore be the authority for the root evaluation space.
{
  const compiled = compilePattern('struct Root { x: u8; }', {
    snapshotId: 'issue-5100',
    targetAddressSpace: 'vm',
  });
  const { reads, source } = trackingSource(({ space }) => {
    assert.equal(space, 'vm');
    return Uint8Array.of(0x2a);
  });

  const result = evaluatePattern(compiled, source);
  assert.equal(result.status, 'complete');
  assert.equal(result.value.fields.x.value, 0x2a);
  assert.equal(result.value.fields.x.provenance.space, 'vm');
  assert.deepEqual(reads.map(({ space }) => space), ['vm']);

  const rehydrated = structuredClone(compiled);
  const clonedSource = trackingSource(({ space }) => {
    assert.equal(space, 'vm');
    return Uint8Array.of(0x2b);
  });
  const clonedResult = evaluatePattern(rehydrated, clonedSource.source);
  assert.equal(clonedResult.patternId, compiled.patternId);
  assert.equal(clonedResult.value.fields.x.value, 0x2b);
  assert.equal(clonedResult.value.fields.x.provenance.space, 'vm');
}

// evaluatePattern(source, ...) compiles first; targetAddressSpace must bind that
// freshly-created identity and evaluation semantics in the same call.
{
  const { source } = trackingSource(({ space }) => {
    assert.equal(space, 'vm');
    return Uint8Array.of(0x31);
  });
  const result = evaluatePattern('struct Root { x: u8; }', source, {
    snapshotId: 'issue-5100',
    targetAddressSpace: 'vm',
  });
  assert.equal(result.value.fields.x.value, 0x31);
  assert.equal(result.value.fields.x.provenance.space, 'vm');
}

// The historical default remains file when no compile-time target is given.
{
  const compiled = compilePattern('struct Root { x: u8; }', {
    snapshotId: 'issue-5100',
  });
  const { source } = trackingSource(({ space }) => {
    assert.equal(space, 'file');
    return Uint8Array.of(7);
  });
  const result = evaluatePattern(compiled, source);
  assert.equal(result.value.fields.x.provenance.space, 'file');
}

// A runtime-only addressSpace must not silently change the meaning of an
// already-identified compiled pattern. Matching redundancy is harmless;
// conflicting override is rejected before any source read.
{
  const compiled = compilePattern('struct Root { x: u8; }', {
    snapshotId: 'issue-5100',
    targetAddressSpace: 'vm',
  });
  const matching = trackingSource(() => Uint8Array.of(9));
  const result = evaluatePattern(compiled, matching.source, { addressSpace: 'vm' });
  assert.equal(result.value.fields.x.provenance.space, 'vm');

  const conflicting = trackingSource(() => {
    throw new Error('conflicting override must be rejected before reads');
  });
  assert.throws(
    () => evaluatePattern(compiled, conflicting.source, { addressSpace: 'file' }),
    /pattern-address-space-override-mismatch/,
  );
  assert.equal(conflicting.reads.length, 0);
}

// Pointer/offset types retain their own target-space semantics: root bytes are
// read from the compiled vm space, while dereference follows type.space=file.
{
  const compiled = compilePattern({
    kind: 'struct',
    name: 'Root',
    fields: [{
      name: 'ptr',
      type: {
        kind: 'pointer',
        space: 'file',
        target: { kind: 'primitive', name: 'u8' },
      },
    }],
  }, {
    snapshotId: 'issue-5100',
    targetAddressSpace: 'vm',
  });
  const pointerBytes = new Uint8Array(8);
  new DataView(pointerBytes.buffer).setBigUint64(0, 16n, true);
  const { reads, source } = trackingSource(({ offset, length, space }) => {
    if (space === 'vm' && offset === 0n && length === 8) return pointerBytes;
    if (space === 'file' && offset === 16n && length === 1) return Uint8Array.of(0x41);
    throw new Error(`unexpected read ${space}:${offset}:${length}`);
  });

  const result = evaluatePattern(compiled, source);
  const ptr = result.value.fields.ptr;
  assert.equal(ptr.provenance.space, 'vm');
  assert.equal(ptr.targetSpace, 'file');
  const target = ptr.dereference();
  assert.equal(target.value, 0x41);
  assert.equal(target.provenance.space, 'file');
  assert.deepEqual(reads.map(({ space }) => space), ['vm', 'file']);
}

console.log('[phase12] issue #5100 target address-space authority regressions passed');
