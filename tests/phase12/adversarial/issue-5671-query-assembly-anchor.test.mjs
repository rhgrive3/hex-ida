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

test('Issue #5671 R0: an >10,000-row function still anchors the requested instruction (scan is not capped below the corpus)', async () => {
  const rows = instructionRows(11000);
  const registry = createHexToolRegistry(queryContext(rows));
  const result = await pageFor(registry, {
    functionAddress: '0x1000',
    aroundInstructionId: 10050,
    radius: 5,
    count: 11,
  });
  assert.equal(result.offset, 10045, 'the >10k target must be anchored, not silently ignored');
  assert.equal(result.results[0]?.id, 10045);
  assert.ok(result.results.some((row) => row.id === 10050), 'the requested instruction must be inside the page');
});

test('Issue #5671 R0: a scan that exhausts its budget without upstream completion is fail-closed, never a first-page answer', async () => {
  // A hostile/incomplete producer: always 500 rows, never complete, target
  // never present. The old code silently returned the first page.
  const registry = createHexToolRegistry({
    analysisAuthority: 'AnalysisQueryAPI',
    binaryId: 'query-anchor-fixture',
    analysisRevision: 'rev-1',
    addressExists: () => true,
    getInstructions: async (functionAddress, options = {}) => {
      const offset = typeof options.offset === 'number' && options.offset >= 0 ? options.offset : 0;
      return {
        results: instructionRows(500).map((row) => ({ ...row, id: row.id + offset })),
        offset,
        returned: 500,
        total: null,
        complete: false,
        truncated: true,
        reason: 'upstream-incomplete',
      };
    },
  });
  const result = await pageFor(registry, {
    functionAddress: '0x1000',
    aroundInstructionId: 99999,
    radius: 5,
    count: 11,
  });
  assert.equal(result.reason, 'anchor-unresolved', 'unresolved anchor without corpus exhaustion must be explicit');
  assert.equal(result.complete, false);
  assert.equal(result.truncated, true);
  assert.deepEqual(result.results, [], 'no rows may be presented as an anchored window');
  assert.equal(result.returned, 0);
});

test('Issue #5671 R0: base-vs-Query anchor parity — the QueryAPI page equals the base implementation window', async () => {
  const rows = instructionRows(1000);
  const baseRegistry = createHexToolRegistry({
    analyze: async () => ({ instructions: rows }),
  });
  const basePage = await baseRegistry.execute('inspect_function_region', {
    functionAddress: '0x1000',
    view: 'assembly',
    aroundInstructionId: 500,
    radius: 10,
    count: 21,
  }, { scope: 'function' });
  const baseResult = basePage.result ?? basePage;

  const queryRegistry = createHexToolRegistry(queryContext(rows));
  const queryResult = await pageFor(queryRegistry, {
    functionAddress: '0x1000',
    aroundInstructionId: 500,
    radius: 10,
    count: 21,
  });

  assert.deepEqual(
    queryResult.results.map((row) => row.id),
    baseResult.results.map((row) => row.id),
    'the QueryAPI route must anchor exactly like the base implementation',
  );
});

test('Issue #5671 R0: semantic-ir view is untouched by the assembly anchor logic (base delegation preserved)', async () => {
  const rows = instructionRows(1000);
  const registry = createHexToolRegistry({
    ...queryContext(rows),
    analyze: async () => ({ instructions: rows }),
  });
  const result = await pageFor(registry, {
    functionAddress: '0x1000',
    view: 'semantic-ir',
    aroundInstructionId: 500,
    radius: 10,
    count: 21,
  });
  assert.equal(result.view, 'semantic-ir', 'semantic-ir must stay on the base implementation path');
  assert.notEqual(result.reason, 'anchor-unresolved', 'the anchor scan must not run for semantic-ir');
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
