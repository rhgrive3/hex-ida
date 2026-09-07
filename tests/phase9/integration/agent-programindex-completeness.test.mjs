import assert from 'node:assert/strict';
import test from 'node:test';

import { createAgentTools } from '../../../js/agent/tools.js';

function annotated(rows, metadata) {
  for (const [key, value] of Object.entries(metadata || {})) {
    Object.defineProperty(rows, key, { value, enumerable: false, configurable: true });
  }
  return rows;
}

test('agent call/xref tools preserve ProgramIndex incompleteness metadata without changing paging', async () => {
  let callersMode = 'capped';
  let xrefMode = 'query-limit';
  const program = {
    functionRange() { return null; },
    callersOf() {
      if (callersMode === 'capped') {
        return annotated([{ addr: 0x1100n }], {
          complete: false,
          capped: true,
          incompleteReason: 'calls-source-capped',
        });
      }
      if (callersMode === 'analysis-incomplete') {
        return annotated([{ addr: 0x1200n }], {
          complete: false,
          incompleteReason: 'program-analysis-incomplete',
        });
      }
      if (callersMode === 'complete-short') {
        return annotated([{ addr: 0x1300n }], { complete: true });
      }
      return [
        { addr: 0x1400n },
        { addr: 0x1500n },
        { addr: 0x1600n },
      ];
    },
    calleesOf() {
      return annotated([{ addr: 0x2100n }], { complete: false, capped: true });
    },
    refSitesTo() {
      if (xrefMode === 'query-limit') {
        return annotated([{ from: 0x3100n, to: 0x3000n }], {
          complete: false,
          queryLimited: true,
        });
      }
      return annotated([{ from: 0x3200n, to: 0x3000n }], { complete: true });
    },
    functionsReferencing() {
      return annotated([{ addr: 0x3300n }], { complete: true });
    },
  };
  const tools = createAgentTools({ program });

  const cappedCallers = await tools.get_callers(0x1000n, { limit: 10 });
  assert.equal(cappedCallers.returned, 1);
  assert.equal(cappedCallers.complete, false);
  assert.equal(cappedCallers.truncated, true);
  assert.equal(cappedCallers.reason, 'calls-source-capped');
  assert.equal(cappedCallers.total, null);

  const cappedCallees = await tools.get_callees(0x2000n, { limit: 10 });
  assert.equal(cappedCallees.complete, false);
  assert.equal(cappedCallees.reason, 'calls-source-capped');
  assert.equal(cappedCallees.total, null);

  const queryLimitedXrefs = await tools.get_xrefs(0x3000n, { limit: 10 });
  assert.equal(queryLimitedXrefs.complete, false);
  assert.equal(queryLimitedXrefs.reason, 'query-limit');
  assert.equal(queryLimitedXrefs.totals.sites, null);

  callersMode = 'analysis-incomplete';
  const analysisIncomplete = await tools.get_callers(0x1000n, { limit: 10 });
  assert.equal(analysisIncomplete.complete, false);
  assert.equal(analysisIncomplete.reason, 'program-analysis-incomplete');

  callersMode = 'complete-short';
  const completeShort = await tools.get_callers(0x1000n, { limit: 10 });
  assert.equal(completeShort.complete, true);
  assert.equal(completeShort.truncated, false);
  assert.equal(completeShort.reason, null);
  assert.equal(completeShort.total, 1);

  callersMode = 'paged';
  const firstPage = await tools.get_callers(0x1000n, { limit: 2, offset: 0 });
  assert.deepEqual(firstPage.results.map((row) => row.addr), [0x1400n, 0x1500n]);
  assert.equal(firstPage.offset, 0);
  assert.equal(firstPage.complete, false);
  assert.equal(firstPage.reason, 'result-limit');

  const secondPage = await tools.get_callers(0x1000n, { limit: 2, offset: 1 });
  assert.deepEqual(secondPage.results.map((row) => row.addr), [0x1500n, 0x1600n]);
  assert.equal(secondPage.offset, 1);
  assert.equal(secondPage.complete, true);

  xrefMode = 'complete';
  const completeXrefs = await tools.get_xrefs(0x3000n, { limit: 10 });
  assert.equal(completeXrefs.complete, true);
  assert.equal(completeXrefs.reason, null);
});
