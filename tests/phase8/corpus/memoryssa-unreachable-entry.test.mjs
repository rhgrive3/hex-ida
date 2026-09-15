import assert from 'node:assert/strict';
import test from 'node:test';
import { loadCorpus } from '../../../tools/validation/phase8/build-corpus.mjs';
import { decompileEntry } from '../../../tools/validation/phase8/decompile-corpus.mjs';

test('native nested loop retains IR with initial memory on an unreachable predecessor', () => {
  const corpus = loadCorpus();
  const index = corpus.functions.findIndex(entry => entry.id === 'x86_64.quality.loop_nested.O2');
  assert.ok(index >= 0, 'the real compiler corpus entry must be present');
  const outcome = decompileEntry(corpus.functions[index], {
    index, decompilerTimeBudgetMs: 20000, toolchain: corpus.toolchain ?? null,
  });
  assert.equal(outcome.failure ?? null, null);
  assert.ok(outcome.result?.ir, 'MemorySSA validation must not discard the native function');
});
