import assert from 'node:assert/strict';
import test from 'node:test';
import { createHexToolRegistry } from '../../../js/ai/tools/registry.js';

function queryContext() {
  return {
    analysisAuthority:'AnalysisQueryAPI',
    binaryId:'issue-4153-query',
    analysisRevision:'rev-1',
    addressExists:() => true,
    async getCallers(_address, options = {}) {
      const offset = options.offset ?? 0;
      if (offset === 0) {
        return {
          results:[{ address:'0x2000' }, { address:'0x3000' }],
          offset:0,
          returned:2,
          total:3,
          complete:false,
          truncated:true,
          reason:'query-limit',
        };
      }
      return {
        results:[{ address:'0x4000' }],
        offset,
        returned:1,
        total:3,
        complete:true,
        truncated:false,
        reason:null,
      };
    },
    async getCallees() {
      return {
        results:[{ address:'0x5000' }],
        offset:0,
        returned:1,
        total:1,
        complete:true,
        truncated:false,
        reason:null,
      };
    },
  };
}

test('Issue #4153: QueryAPI related-functions exposes per-side completeness and actionable continuation', async () => {
  const registry = createHexToolRegistry(queryContext());
  const first = await registry.execute('get_related_functions', {
    functionAddress:'0x1000',
    limit:2,
  }, { scope:'neighborhood' });

  assert.equal(first.result.complete, false);
  assert.equal(first.result.truncated, true);
  assert.deepEqual(first.result.callers.map((row) => row.address), ['0x2000', '0x3000']);
  assert.deepEqual(first.result.callees.map((row) => row.address), ['0x5000']);
  assert.deepEqual(first.result.callersPage, {
    offset:0,
    returned:2,
    total:3,
    complete:false,
    truncated:true,
    reason:'query-limit',
  });
  assert.deepEqual(first.result.calleesPage, {
    offset:0,
    returned:1,
    total:1,
    complete:true,
    truncated:false,
    reason:null,
  });

  const next = first.result.continuations?.callers;
  assert.equal(next?.tool, 'get_callers');
  assert.equal(next?.arguments?.address, '0x1000');
  assert.equal(next?.arguments?.limit, 2);
  assert.equal(typeof next?.arguments?.cursor, 'string');
  assert.equal(first.result.continuations?.callees, undefined);

  // The hint must be directly executable by the actual first-party registry;
  // this proves its opaque cursor uses the get_callers producer contract.
  const continued = await registry.execute(next.tool, next.arguments, { scope:'neighborhood' });
  assert.equal(continued.result.offset, 2);
  assert.deepEqual(continued.result.results.map((row) => row.address), ['0x4000']);
  assert.equal(continued.result.complete, true);
  await assert.rejects(
    () => registry.execute(next.tool, { ...next.arguments, address:'0x1001' }, { scope:'neighborhood' }),
    (error) => error?.type === 'invalid_tool_call',
    'the caller continuation must stay bound to the original function address',
  );
  await assert.rejects(
    () => registry.execute('get_callees', { address:'0x1000', limit:2, cursor:next.arguments.cursor }, { scope:'neighborhood' }),
    (error) => error?.type === 'invalid_tool_call',
    'a caller continuation must not be reusable as a callee cursor',
  );

  // Model-visible graph projection must not hide the only path to the rest of
  // the caller set.
  assert.equal(first.modelData.callersPage.complete, false);
  assert.equal(first.modelData.callersPage.total, 3);
  assert.equal(first.modelData.continuations.callers.tool, 'get_callers');
  assert.equal(typeof first.modelData.continuations.callers.arguments.cursor, 'string');
});

test('Issue #4153: a partial callee side gets its own executable get_callees continuation', async () => {
  const registry = createHexToolRegistry({
    ...queryContext(),
    binaryId:'issue-4153-callee',
    async getCallers() {
      return { results:[{ address:'0x2000' }], returned:1, total:1, complete:true, truncated:false, reason:null };
    },
    async getCallees(_address, options = {}) {
      const offset = options.offset ?? 0;
      return offset === 0
        ? { results:[{ address:'0x5000' }], returned:1, total:2, complete:false, truncated:true, reason:'query-limit' }
        : { results:[{ address:'0x6000' }], offset, returned:1, total:2, complete:true, truncated:false, reason:null };
    },
  });
  const first = await registry.execute('get_related_functions', {
    functionAddress:'0x1000', limit:1,
  }, { scope:'neighborhood' });
  assert.equal(first.result.callersPage.complete, true);
  assert.equal(first.result.calleesPage.complete, false);
  assert.equal(first.result.continuations?.callers, undefined);
  const next = first.result.continuations?.callees;
  assert.equal(next?.tool, 'get_callees');
  const continued = await registry.execute(next.tool, next.arguments, { scope:'neighborhood' });
  assert.equal(continued.result.offset, 1);
  assert.deepEqual(continued.result.results.map((row) => row.address), ['0x6000']);
});

test('Issue #4153: legacy related-functions does not launder a capped caller set as complete', async () => {
  const callers = [
    { addr:0x2000n },
    { addr:0x3000n },
    { addr:0x4000n },
  ];
  callers.queryLimited = true;
  callers.reason = 'query-limit';
  const callees = [{ addr:0x5000n }];

  const registry = createHexToolRegistry({
    binaryId:'issue-4153-legacy',
    analysisRevision:'rev-1',
    addressExists:() => true,
    program:{
      callersOf() { return callers; },
      functionRange(address) { return { start:address, end:address + 4n }; },
      calleesOf() { return callees; },
    },
  });

  const out = await registry.execute('get_related_functions', {
    functionAddress:'0x1000',
    limit:2,
  }, { scope:'neighborhood' });

  assert.equal(out.result.callers.length, 2);
  assert.equal(out.result.callersPage.complete, false);
  assert.equal(out.result.callersPage.truncated, true);
  assert.equal(out.result.callersPage.reason, 'query-limit');
  assert.equal(out.result.calleesPage.complete, true);
  assert.equal(out.result.complete, false);
  assert.equal(out.result.truncated, true);
  assert.equal(out.result.continuations?.callers?.tool, 'get_callers');
  assert.equal(typeof out.result.continuations?.callers?.arguments?.cursor, 'string');
  assert.equal(out.modelData.callersPage.complete, false);
  assert.equal(out.modelData.continuations.callers.tool, 'get_callers');
});

test('Issue #4153: unknown or malformed per-side totals are never coerced into exact totals', async () => {
  for (const total of [null, '3', ['3'], { value:3 }, true]) {
    const registry = createHexToolRegistry({
      ...queryContext(),
      binaryId:`issue-4153-total-${typeof total}`,
      async getCallers() {
        return {
          results:[{ address:'0x2000' }],
          returned:1,
          total,
          complete:false,
          truncated:true,
          reason:'producer-incomplete',
        };
      },
    });
    const out = await registry.execute('get_related_functions', {
      functionAddress:'0x1000', limit:1,
    }, { scope:'neighborhood' });
    assert.equal(out.result.callersPage.total, null);
    assert.equal(out.result.callersPage.complete, false);
  }
});

test('Issue #4153: contradictory per-side completeness fails closed and cannot forge an exact total', async () => {
  const registry = createHexToolRegistry({
    ...queryContext(),
    binaryId:'issue-4153-malformed',
    async getCallers() {
      return {
        results:[{ address:'0x2000' }, { address:'0x3000' }],
        offset:0,
        returned:'2',
        total:1,
        complete:true,
        truncated:false,
        reason:null,
      };
    },
  });
  const out = await registry.execute('get_related_functions', {
    functionAddress:'0x1000', limit:2,
  }, { scope:'neighborhood' });
  assert.equal(out.result.callersPage.total, null);
  assert.equal(out.result.callersPage.complete, false);
  assert.equal(out.result.callersPage.truncated, true);
  assert.equal(out.result.callersPage.reason, 'malformed-completeness');
  assert.equal(out.result.complete, false);
  assert.equal(out.result.continuations.callers.tool, 'get_callers');
});
