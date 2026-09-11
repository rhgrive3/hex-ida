import assert from 'node:assert/strict';
import test from 'node:test';

import { createAppAnalysisQueryAdapter } from '../../../js/analysis/query/app-adapter.js';

function adapterFor(decoded) {
  return createAppAnalysisQueryAdapter({
    store: {
      get(key) {
        if (key === 'architecture') return 'arm64';
        return null;
      },
    },
    backend: {
      async disassembleAt(_address, { length }) {
        const result = typeof decoded === 'function' ? decoded(length) : decoded;
        return { supported:true, found:true, instructions:[], ...result };
      },
    },
  });
}

test('#4075 full requested instruction extent remains complete', async () => {
  const adapter = adapterFor((length) => ({ bytesConsumed:length }));
  const result = await adapter.instructions(null, { start:0x1000n, length:64 });
  assert.equal(result.status.completeness, 'complete');
  assert.equal(result.status.reason ?? null, null);
});

test('#4075 producer short extent cannot be published as complete', async () => {
  const adapter = adapterFor({ bytesConsumed:16 });
  const result = await adapter.instructions(null, { start:0x1000n, length:64 });
  assert.equal(result.status.completeness, 'partial');
  assert.equal(result.status.reason, 'instruction-read-incomplete');
});

test('#4075 an exact region-end extent remains complete', async () => {
  const adapter = adapterFor({ bytesConsumed:16 });
  const result = await adapter.instructions(null, { start:0x1000n, end:0x1010n });
  assert.equal(result.status.completeness, 'complete');
  assert.equal(result.status.reason ?? null, null);
});

test('#4075 malformed producer coverage metadata fails closed', async () => {
  for (const bytesConsumed of [-1, 1.5, Number.NaN, 65, '64', [64]]) {
    const adapter = adapterFor({ bytesConsumed });
    const result = await adapter.instructions(null, { start:0x1000n, length:64 });
    assert.equal(result.status.completeness, 'partial', `coverage ${String(bytesConsumed)} must not prove completeness`);
    assert.equal(result.status.reason, 'instruction-read-coverage-invalid');
  }
});

test('#4075 legacy decoders without coverage metadata keep compatibility', async () => {
  const adapter = adapterFor({});
  const result = await adapter.instructions(null, { start:0x1000n, length:64 });
  assert.equal(result.status.completeness, 'complete');
});

test('#4075 input budget truncation remains stronger than producer coverage', async () => {
  const adapter = adapterFor((length) => ({ bytesConsumed:length }));
  const result = await adapter.instructions(null, { start:0x1000n, length:(1024 * 1024) + 4 });
  assert.equal(result.status.completeness, 'truncated');
  assert.equal(result.status.reason, 'instruction-read-budget');
});
