import assert from 'node:assert/strict';
import { buildSemanticModel } from '../js/blocks.js';
import { createHexToolRegistry } from '../js/ai/tools/index.js';

const LEFT = 0x1000n;
const RIGHT_SAME = 0x2000n;
const RIGHT_DIFFERENT = 0x3000n;

function modelFor(lines, base) {
  const rows = lines.map((line, row) => {
    const space = line.indexOf(' ');
    return {
      row,
      address: base + BigInt(row * 4),
      mn: space < 0 ? line : line.slice(0, space),
      ops: space < 0 ? '' : line.slice(space + 1),
    };
  });
  const rowOfAddress = (address) => {
    const offset = address - base;
    return offset < 0n || offset >= BigInt(rows.length * 4) ? null : Number(offset / 4n);
  };
  return buildSemanticModel(rows, { startRow: 0, endRow: rows.length - 1, rowOfAddress });
}

const models = new Map([
  [LEFT, modelFor(['mov x0, x0', 'ret'], LEFT)],
  [RIGHT_SAME, modelFor(['mov x1, x1', 'ret'], RIGHT_SAME)],
  [RIGHT_DIFFERENT, modelFor(['mov x0, x0', 'mov x1, x1', 'ret'], RIGHT_DIFFERENT)],
]);
const context = {
  addressExists: () => true,
  analyze: async (address) => models.get(BigInt(address)) || null,
  program: {
    functionRange(address) {
      const model = models.get(BigInt(address));
      return model ? { start: BigInt(address), end: BigInt(address) + BigInt(model.instructions.length * 4) } : null;
    },
  },
};
const registry = createHexToolRegistry(context, { maxFunctions: 4, maxDisassembly: 32 });

const equalCount = await registry.execute('compare_functions', {
  leftAddress: '0x1000', rightAddress: '0x2000',
}, { scope: 'binary' });
assert.equal(equalCount.result.sameInstructionCount, true);
assert.equal(equalCount.result.instructionSimilarity, null, 'equal counts are not instruction similarity evidence');
assert.equal(equalCount.modelData.instructionSimilarity, null);
assert.equal(equalCount.modelData.similarity, null);

const unequalCount = await registry.execute('compare_functions', {
  leftAddress: '0x1000', rightAddress: '0x3000',
}, { scope: 'binary' });
assert.equal(unequalCount.result.sameInstructionCount, false);
assert.equal(unequalCount.result.instructionSimilarity, null);

const delegated = createHexToolRegistry({
  addressExists: () => true,
  compareFunctions: async () => ({
    left: { address: '0x1000' }, right: { address: '0x2000' },
    sameInstructionCount: true, instructionSimilarity: 0.73,
    semanticDifferences: [],
  }),
});
const delegatedResult = await delegated.execute('compare_functions', {
  leftAddress: '0x1000', rightAddress: '0x2000',
}, { scope: 'binary' });
assert.equal(delegatedResult.modelData.instructionSimilarity, 0.73, 'host-provided similarity remains authoritative');

console.log('issue-6266-compare-functions-fallback: PASS');
