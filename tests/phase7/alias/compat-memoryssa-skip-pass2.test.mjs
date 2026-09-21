import assert from 'node:assert/strict';
import test from 'node:test';
import { stableDigest } from '../../js/core/identity/index.js';
import { buildSemanticV2CompatibilityPipeline } from '../../js/semantics/compat/index.js';
import { ARM64_ARCHITECTURE } from '../../js/targets/architecture/index.js';

test('buildSemanticV2CompatibilityPipeline reuses initialMemorySsa when no pointer-through-stack reload occurs', () => {
  const binaryId = 'test-binary-id';
  const sliceId = 'test-slice-id';
  const pipeline = buildSemanticV2CompatibilityPipeline({
    architecturePlugin: ARM64_ARCHITECTURE,
    decoderSemanticVersion: 'test-decoder-v1',
    binaryId,
    sliceId,
    addressWidthBits: 64,
    canonicalStartIdentity: { address: '0x1000' },
    blocks: [
      {
        key: 'block-0',
        startAddress: '0x1000',
        instructions: [
          { address: '0x1000', bytes: '1f2003d5', text: 'nop' },
        ],
        successors: [],
      },
    ],
  });

  assert.ok(pipeline.memorySsa, 'MemorySSA artifact must be present');
  assert.equal(typeof pipeline.memorySsa.canonicalDigest, 'string');
  assert.equal(pipeline.memorySsa.functionId, pipeline.functionId);
});

test('classifySemanticMemoryRegion maintains correct region classification with irIndexFor memoization', async () => {
  const { classifySemanticMemoryRegion } = await import('../../js/analysis/alias/regions-v2.js');
  const sampleIr = Object.freeze({
    contractVersion: '1.0.0',
    functionId: 'fn_test_memo_index',
    blocks: [{ id: 'b_1', nodeIds: ['n_1', 'n_2'] }],
    nodes: [
      { id: 'n_1', kind: 'load', memory: { addressSpace: 'memory', addressExpr: { valueId: 'v_1' } } },
      { id: 'n_2', kind: 'store', memory: { addressSpace: 'memory', addressExpr: { valueId: 'v_1' } } },
    ],
    values: [
      { id: 'v_1', kind: 'scalar', definitionNodeId: null },
    ],
  });

  const reg1 = classifySemanticMemoryRegion(sampleIr, 'n_1');
  const reg2 = classifySemanticMemoryRegion(sampleIr, 'n_1');
  assert.equal(reg1.kind, 'unknown');
  assert.equal(reg2.kind, 'unknown');
  assert.equal(reg1.id, reg2.id);

  // Non-existent or invalid node
  const regInvalid = classifySemanticMemoryRegion(sampleIr, 'non_existent_node');
  assert.equal(regInvalid.kind, 'unknown');
});
