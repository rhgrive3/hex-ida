import assert from 'node:assert/strict';
import test from 'node:test';
import { createHexToolRegistry } from '../../../js/ai/tools/registry.js';

function queryContext(overrides = {}) {
  return {
    analysisAuthority: 'AnalysisQueryAPI',
    binaryId: 'query-boundary-fixture',
    analysisRevision: 'rev-1',
    addressExists: () => true,
    ...overrides,
  };
}

function nextOffset(registry, cursor) {
  return registry.observationStore.cursorCodec.decode(cursor, {
    bindingKey: registry.observationStore.binding().key,
    kind: 'tool-page',
  }).offset;
}

test('Issue #6157: malformed paging metadata cannot control continuation offsets', async () => {
  const malformed = [
    ['numeric array', ['100']],
    ['numeric string', '100'],
    ['boolean', true],
    ['object', { valueOf: () => 100 }],
    ['negative integer', -100],
    ['fractional number', 1.5],
  ];

  for (const [label, returned] of malformed) {
    const registry = createHexToolRegistry(queryContext({
      getCallers: async () => ({
        results: [{ address: '0x2000' }],
        offset: ['50'],
        returned,
        complete: false,
      }),
    }));
    const page = await registry.execute('get_callers', { address: '0x2000', limit: 1 }, { scope: 'function' });

    assert.equal(page.result.offset, 0, `${label} offset must fall back to the requested page offset`);
    assert.equal(page.result.returned, 1, `${label} returned count must match actual rows`);
    assert.equal(nextOffset(registry, page.continuation.cursor), 1, `${label} must advance by actual rows`);
  }

  const registry = createHexToolRegistry(queryContext({
    getCallers: async () => ({
      results: [{ address: '0x2000' }],
      offset: 0,
      returned: 1,
      complete: false,
    }),
  }));
  const first = await registry.execute('get_callers', { address: '0x2000', limit: 1 }, { scope: 'function' });
  const payload = registry.observationStore.cursorCodec.decode(first.continuation.cursor, {
    bindingKey: registry.observationStore.binding().key,
    kind: 'tool-page',
  });
  const malformedCursor = registry.observationStore.cursorCodec.encode({ ...payload, offset: ['50'] });
  await assert.rejects(
    () => registry.execute('get_callers', { address: '0x2000', limit: 1, cursor: malformedCursor }, { scope: 'function' }),
    (error) => error.type === 'invalid_tool_call',
    'structured cursor offsets must not be coerced into paging authority',
  );
});

test('Issue #6158: structured instruction addresses remain invalid in AI projections', async () => {
  const cases = [
    ['bigint', 16n, '0x10'],
    ['safe number', 16, '0x10'],
    ['decimal string', '16', '0x10'],
    ['hex string', '0x10', '0x10'],
    ['numeric array', ['16'], null],
    ['boolean', true, null],
    ['object', { valueOf: () => 16 }, null],
    ['fractional number', 1.5, null],
    ['negative number', -1, null],
    ['blank string', '  ', null],
  ];
  const rows = new Map(cases.map(([label, address], index) => [`0x${(0x3000 + index).toString(16)}`, { label, address }]));
  const registry = createHexToolRegistry(queryContext({
    getInstructions: async (functionAddress) => {
      const row = rows.get(functionAddress);
      return { results: [{ id: row.label, address: row.address, mnemonic: 'ret', operands: '' }], complete: true };
    },
  }));

  for (const [index, [label, , expected]] of cases.entries()) {
    const functionAddress = `0x${(0x3000 + index).toString(16)}`;
    const page = await registry.execute('inspect_function_region', {
      functionAddress,
      view: 'assembly',
      count: 1,
    }, { scope: 'function' });
    assert.equal(page.result.results[0].address, expected, `${label} must not be coerced into a canonical address`);
  }
});

