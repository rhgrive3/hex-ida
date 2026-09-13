import assert from 'node:assert/strict';
import test from 'node:test';
import { createHexAIContext } from '../../../js/ai/ui/hex-context.js';
import { createHexToolRegistry } from '../../../js/ai/tools/registry.js';

function appFixture() {
  const callerOffsets = [];
  const state = new Map([['regions', [{ vmAddr:0x1000n, size:0x4000n }]]]);
  const analysisQueries = {
    async snapshot() { return { snapshotId:'issue-4153', binaryId:'fixture-bin' }; },
    async callers(_snapshot, _address, page) {
      callerOffsets.push(page.offset);
      if (page.offset === 0) {
        return {
          value:[],
          page:{ offset:0, limit:page.limit, returned:0, total:9, next:2 },
          completeness:'partial',
          status:{ completeness:'partial', reason:'query-limit' },
        };
      }
      assert.equal(page.offset, 2, 'continuation must execute the producer-provided next offset');
      return {
        value:[{ address:0x2200n }],
        page:{ offset:2, limit:page.limit, returned:1, total:3, next:null },
        completeness:'complete',
        status:{ completeness:'complete' },
      };
    },
    async callees(_snapshot, _address, page) {
      return {
        value:[],
        page:{ offset:page.offset, limit:page.limit, returned:0, total:0, next:null },
        completeness:'complete',
        status:{ completeness:'complete' },
      };
    },
  };
  return {
    callerOffsets,
    app:{
      store:{ get:key => state.get(key) ?? null },
      backend:{ binaryId:'fixture-bin', gen:1 },
      analysisQueries,
      workspace:null,
      activeProject:null,
      notes:null,
      lastGoal:null,
      viewer:null,
    },
  };
}

test('Issue #4153: hidden QueryAPI nextOffset survives related-functions normalization end to end', async () => {
  const { app, callerOffsets } = appFixture();
  const context = createHexAIContext(app);

  const direct = await context.getCallers('0x1000', { limit:2, offset:0 });
  assert.equal(direct.total, null, 'partial QueryAPI totals stay non-authoritative');
  assert.equal(direct.nextOffset, 2, 'context retains the producer next offset internally');
  assert.equal(Object.prototype.propertyIsEnumerable.call(direct, 'nextOffset'), false,
    'internal producer progress must not become model-visible page data');
  callerOffsets.length = 0;

  const registry = createHexToolRegistry(context);
  const related = await registry.execute('get_related_functions', {
    functionAddress:'0x1000',
    limit:2,
  }, { scope:'neighborhood' });

  assert.equal(related.result.callersPage.total, null);
  assert.equal(related.result.callersPage.complete, false);
  assert.ok(related.result.continuations?.callers,
    'zero-row partial QueryAPI side must keep an actionable producer continuation');
  const hint = related.result.continuations.callers;
  assert.equal(hint.tool, 'get_callers');
  assert.equal(hint.arguments.address, '0x1000');

  const resumed = await registry.execute(hint.tool, hint.arguments, { scope:'function' });
  assert.deepEqual(callerOffsets, [0, 2], 'continuation must advance from related-functions to producer offset 2');
  assert.deepEqual(resumed.result.results.map((row) => row.address), ['0x2200']);
  assert.equal(resumed.result.offset, 2);

  await assert.rejects(
    () => registry.execute('get_callers', { ...hint.arguments, address:'0x1001' }, { scope:'function' }),
    (error) => error?.type === 'invalid_tool_call',
    'continuation cursor must stay bound to the original address',
  );
  await assert.rejects(
    () => registry.execute('get_callees', { ...hint.arguments }, { scope:'function' }),
    (error) => error?.type === 'invalid_tool_call',
    'continuation cursor must stay bound to the original tool',
  );
});
