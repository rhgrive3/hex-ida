import test from 'node:test';
import assert from 'node:assert/strict';
import { openProduct } from '../../../tools/validation/public-benchmark/product-host.mjs';
import { fileURLToPath } from 'node:url';

test('FAST decompile route preserves Thing::update body and typed this with binary-backed members', async () => {
  const binary = fileURLToPath(new URL('../../fixtures/cxx-dwarf-holdout/holdout.stripped.elf', import.meta.url));
  const symbol = '_ZNK5Thing6updateEi';
  const product = await openProduct(binary);
  try {
    assert.ok(!product.unsupported, 'holdout product must open');
    const snapshot = await product.query.snapshot();
    const symbols = product.app.symbols;
    const index = symbols.names.indexOf(symbol);
    assert.ok(index >= 0, `symbol ${symbol} must be present`);
    const address = symbols.addrs[index];

    // Decompile via default FAST profile
    const result = await product.query.decompile(snapshot, address, { profile: 'fast' });
    assert.ok(result?.value?.pseudocode, 'must produce pseudocode');
    const code = result.value.pseudocode;

    // Must project typed this in signature: Thing * this
    assert.match(code, /\bThing\s*\*\s*this\b/, 'signature must project Thing * this');

    // Body must NOT be lost (must not be an empty return)
    assert.doesNotMatch(code, /\{\s*return;\s*\}/, 'function body must not be lost');

    // Both field accesses must be projected
    assert.match(code, /this->field_0x0*8\b/, 'must project member at offset 8 (health)');
    assert.match(code, /this->field_0x0*C\b/i, 'must project member at offset 12 (power)');
  } finally {
    await product.close();
  }
});
