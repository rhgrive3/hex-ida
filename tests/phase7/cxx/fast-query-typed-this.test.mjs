import test from 'node:test';
import assert from 'node:assert/strict';
import { openProduct } from '../../../tools/validation/public-benchmark/product-host.mjs';

const holdoutBinary = '/mnt/workspace/.dev-state/agent-work/evidence/hex-completion-20260924/cxx-dwarf-holdout/holdout.stripped.elf';

test('default fast query route yields typed this on the dwarf holdout binary', async () => {
  const product = await openProduct(holdoutBinary);
  try {
    assert.equal(!product.unsupported, true, 'holdout product must open successfully');
    const snapshot = await product.query.snapshot();
    const symbols = product.app.symbols;
    const updateIndex = symbols.names.indexOf('_ZNK5Thing6updateEi');
    assert.ok(updateIndex >= 0, '_ZNK5Thing6updateEi must exist in symbols');
    const address = symbols.addrs[updateIndex];

    const result = await product.query.decompile(snapshot, address, { profile: 'fast' });
    assert.ok(result?.value?.pseudocode, 'fast decompile must produce pseudocode');
    assert.match(
      result.value.pseudocode,
      /\bThing\s*\*\s*this\b/,
      'pseudocode must include typed "Thing * this"'
    );
  } finally {
    await product.close();
  }
});
