import assert from 'node:assert/strict';
import test from 'node:test';
import { createHexToolRegistry } from '../../../js/ai/tools/registry.js';

function instructionRows(total) {
  return Array.from({ length: total }, (_, i) => ({
    id: i,
    row: i,
    address: `0x${(0x1000 + i * 4).toString(16)}`,
    mnemonic: 'mov',
    operands: `x0, x1 ; #${i}`,
  }));
}

function queryContext(rows) {
  return {
    analysisAuthority: 'AnalysisQueryAPI',
    binaryId: 'query-anchor-fixture',
    analysisRevision: 'rev-1',
    addressExists: () => true,
    getInstructions: async (functionAddress, options = {}) => {
      const offset = typeof options.offset === 'number' && Number.isSafeInteger(options.offset) && options.offset >= 0 ? options.offset : 0;
      const limit = Math.max(1, Math.min(500, typeof options.limit === 'number' ? options.limit : 160));
      const slice = rows.slice(offset, offset + limit);
      return {
        results: slice,
        offset,
        returned: slice.length,
        total: rows.length,
        complete: offset + slice.length >= rows.length,
        truncated: offset + slice.length < rows.length,
        reason: null,
      };
    },
  };
}

async function pageFor(registry, args) {
  const page = await registry.execute('inspect_function_region', { view: 'assembly', ...args }, { scope: 'function' });
  return page.result ?? page;
}

test('Issue #5671: AnalysisQueryAPI assembly page anchors on aroundInstructionId instead of the first page', async () => {
  const registry = createHexToolRegistry(queryContext(instructionRows(1000)));
  const result = await pageFor(registry, {
    functionAddress: '0x1000',
    aroundInstructionId: 500,
    radius: 10,
    count: 21,
  });
  assert.equal(result.offset, 490, 'window must start radius rows before the requested instruction');
  assert.equal(result.results[0]?.id, 490);
  assert.equal(result.results.at(-1)?.id, 510, 'window must contain the requested instruction plus radius');
  assert.ok(result.results.some((row) => row.id === 500), 'the requested instruction must be inside the page');
});

test('Issue #5671: the anchor scan reaches targets beyond the first upstream window (multi-page scan)', async () => {
  const registry = createHexToolRegistry(queryContext(instructionRows(600)));
  const result = await pageFor(registry, {
    functionAddress: '0x1000',
    aroundInstructionId: 550,
    radius: 5,
    count: 11,
  });
  assert.equal(result.offset, 545);
  assert.equal(result.results[0]?.id, 545);
});

test('Issue #5671: an unknown aroundInstructionId keeps the explicit start page (no forgery, no crash)', async () => {
  const registry = createHexToolRegistry(queryContext(instructionRows(1000)));
  const result = await pageFor(registry, {
    functionAddress: '0x1000',
    start: 40,
    aroundInstructionId: 99999,
    radius: 10,
    count: 5,
  });
  assert.equal(result.offset, 40, 'unmatched ids must leave the requested offset untouched');
  assert.equal(result.results[0]?.id, 40);
});

test('Issue #5671: cursor continuation from an anchored window resumes at the anchored offset', async () => {
  const registry = createHexToolRegistry(queryContext(instructionRows(1000)));
  const anchored = await pageFor(registry, {
    functionAddress: '0x1000',
    aroundInstructionId: 500,
    radius: 10,
    count: 21,
  });
  assert.equal(anchored.offset, 490);
  const cursor = anchored.continuation?.cursor;
  assert.ok(cursor, 'incomplete page must offer a continuation');
  const next = await pageFor(registry, {
    functionAddress: '0x1000',
    aroundInstructionId: 500,
    radius: 10,
    count: 21,
    cursor,
  });
  assert.equal(next.offset, 511, 'cursor pages continue after the anchored window, not from 0');
  assert.equal(next.results[0]?.id, 511);
});

test('Issue #5671: without aroundInstructionId the first page contract is unchanged', async () => {
  const registry = createHexToolRegistry(queryContext(instructionRows(1000)));
  const result = await pageFor(registry, { functionAddress: '0x1000', count: 5 });
  assert.equal(result.offset, 0);
  assert.equal(result.results[0]?.id, 0);
});
