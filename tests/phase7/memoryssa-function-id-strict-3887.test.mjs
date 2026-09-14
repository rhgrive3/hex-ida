import assert from 'node:assert/strict';
import test from 'node:test';

import { createSemanticCfg } from '../../js/semantics/cfg/index.js';
import { createSemanticIrFunction } from '../../js/semantics/ir/function.js';
import { buildMemorySsa } from '../../js/semantics/memoryssa/build.js';

function canonicalPair(functionId = 'f') {
  const origin = { instructionIds: ['i'] };
  const ir = createSemanticIrFunction({
    functionId,
    entryBlockId: 'entry',
    blocks: [{ id: 'entry', nodeIds: [], origin }],
    values: [],
    nodes: [],
    completeness: 'complete',
    unknowns: [],
    origin,
  });
  const cfg = createSemanticCfg({
    functionId,
    entryBlockId: 'entry',
    blocks: [{ id: 'entry', successors: [] }],
  });
  return { ir, cfg };
}

function expectFunctionMismatch(ir, cfg) {
  assert.throws(
    () => buildMemorySsa(ir, cfg),
    (error) => error instanceof TypeError && error.message === 'memory-ssa-build-function-mismatch',
  );
}

test('#3887 MemorySSA rejects coercible or non-canonical IR function identity', () => {
  const { ir, cfg } = canonicalPair();
  for (const malformed of [['f'], 1, true, '', '   ']) {
    expectFunctionMismatch({ ...ir, functionId: malformed }, cfg);
  }

  let coercions = 0;
  const coercible = { toString() { coercions++; return 'f'; } };
  expectFunctionMismatch({ ...ir, functionId: coercible }, cfg);
  assert.equal(coercions, 0, 'identity validation must not invoke user coercion');
});

test('#3887 MemorySSA rejects coercible or non-canonical CFG function identity', () => {
  const { ir, cfg } = canonicalPair();
  for (const malformed of [['f'], 1, false, '', '   ']) {
    expectFunctionMismatch(ir, { ...cfg, functionId: malformed });
  }

  let coercions = 0;
  const coercible = { toString() { coercions++; return 'f'; } };
  expectFunctionMismatch(ir, { ...cfg, functionId: coercible });
  assert.equal(coercions, 0, 'identity validation must not invoke user coercion');
});

test('#3887 MemorySSA requires strict canonical function identity equality', () => {
  const { ir, cfg } = canonicalPair('f');
  const artifact = buildMemorySsa(ir, cfg);
  assert.equal(artifact.functionId, 'f');

  expectFunctionMismatch(ir, { ...cfg, functionId: 'g' });
  expectFunctionMismatch({ ...ir, functionId: ' f ' }, cfg);
});
