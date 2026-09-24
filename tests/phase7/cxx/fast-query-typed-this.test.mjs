import test from 'node:test';
import assert from 'node:assert/strict';
import { openProduct } from '../../../tools/validation/public-benchmark/product-host.mjs';
import { buildCxxFixtures } from './fixtures/build.mjs';

const built = buildCxxFixtures();
const fixture = built.available ? built.artifacts['game-rtti-o0'] : null;

test('default fast query route types a non-mangled target from its unique vtable slot', { skip: built.available ? false : `ARM64 C++ fixture unavailable: ${built.reason}` }, async () => {
  const product = await openProduct(fixture.path);
  try {
    assert.equal(!product.unsupported, true, 'fixture product must open successfully');
    let readCount = 0;
    const backend = product.app.backend;
    const readAt = backend.readAt;
    backend.readAt = function (...args) {
      readCount++;
      return readAt.apply(this, args);
    };
    const snapshot = await product.query.snapshot();
    const symbols = product.app.symbols;
    const targetIndex = symbols.names.indexOf('opaque_slot_target');
    assert.ok(targetIndex >= 0, 'the fixture must preserve the method under its opaque assembler name');
    const address = symbols.addrs[targetIndex];

    const result = await product.query.decompile(snapshot, address, { profile: 'fast' });
    assert.ok(result?.value?.pseudocode, 'fast decompile must produce pseudocode');
    assert.match(
      result.value.pseudocode,
      /\bOpaqueSlot\s*\*\s*this\b/,
      'pseudocode must type the receiver from unique vtable membership, without a mangled member name'
    );
    assert.match(
      result.value.pseudocode,
      /this->field_0x0*8\s*\/\*\s*int32_t\|uint32_t\s*\*\//,
      'a proven receiver member must retain its byte offset and binary-backed type'
    );
    assert.equal(Object.hasOwn(result.value, 'cxxEvidence'), false,
      'canonical C++ projection stays inside the query adapter');
    assert.equal(Object.hasOwn(result.value, 'cxxEvidenceProvider'), false,
      'the provider and its index are never published');
    const readsAfterFirstDecompile = readCount;
    assert.ok(readsAfterFirstDecompile > 0, 'the C++ index must use the loaded slice reader');

    const repeated = await product.query.decompile(snapshot, address, { profile: 'fast' });
    assert.match(repeated.value.pseudocode, /\bOpaqueSlot\s*\*\s*this\b/);
    assert.equal(readCount, readsAfterFirstDecompile,
      'the built per-slice C++ index is reused for subsequent function queries');

    const dispatchIndex = symbols.names.indexOf('_ZN10OpaqueSlot13dispatchOtherEi');
    assert.ok(dispatchIndex >= 0, 'the fixture must preserve OpaqueSlot::dispatchOther');
    const readsBeforeDispatch = readCount;
    const dispatch = await product.query.decompile(snapshot, symbols.addrs[dispatchIndex], { profile: 'fast' });
    assert.match(dispatch.value.pseudocode, /virtual_slot_0/,
      'a canonical receiver-to-vptr-to-slot call carries its proven slot index');
    assert.equal(readCount, readsBeforeDispatch,
      'C++ evidence is indexed once and reused across different functions in the same loaded slice');
  } finally {
    await product.close();
  }
});
