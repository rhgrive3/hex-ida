import assert from 'node:assert/strict';
import test from 'node:test';
import { createAgentTools } from '../../../js/agent/tools.js';

function cappedEmpty() {
  const rows = [];
  rows.capped = true;
  return rows;
}

test('Issue #3727: unsupported caller/callee queries fail closed instead of proving absence', async () => {
  const tools = createAgentTools({}, {});

  for (const name of ['get_callers', 'get_callees']) {
    const result = await tools[name](0x1000n);
    assert.equal(result.supported, false, `${name} must expose unavailable Program authority`);
    assert.deepEqual(result.results, []);
    assert.equal(result.complete, false, `${name} must not prove an empty result without Program authority`);
    assert.equal(result.truncated, true);
    assert.equal(result.reason, 'unsupported-program-query');
    assert.equal(result.total, null, `${name} must not publish a confirmed zero total`);
  }
});

test('Issue #3727: xrefs fail closed when either Program source is unavailable', async () => {
  const unsupported = await createAgentTools({}, {}).get_xrefs(0x1000n);
  assert.deepEqual(unsupported.supported, { sites: false, functions: false });
  assert.equal(unsupported.complete, false);
  assert.equal(unsupported.truncated, true);
  assert.equal(unsupported.reason, 'unsupported-program-query');
  assert.equal(unsupported.total, null);
  assert.deepEqual(unsupported.totals, { sites: null, functions: null });

  const partial = await createAgentTools({
    program: {
      refSitesTo() { return []; },
    },
  }, {}).get_xrefs(0x1000n);
  assert.deepEqual(partial.supported, { sites: true, functions: false });
  assert.equal(partial.complete, false);
  assert.equal(partial.reason, 'unsupported-program-query');
  assert.equal(partial.total, null);
  assert.deepEqual(partial.totals, { sites: 0, functions: null });
});

test('Issue #3727: supported complete-empty queries and upstream incompleteness keep existing semantics', async () => {
  const completeTools = createAgentTools({
    program: {
      callersOf() { return []; },
      calleesOf() { return []; },
      refSitesTo() { return []; },
      functionsReferencing() { return []; },
    },
  }, {});

  for (const name of ['get_callers', 'get_callees']) {
    const result = await completeTools[name](0x1000n);
    assert.equal(result.supported, true);
    assert.equal(result.complete, true);
    assert.equal(result.truncated, false);
    assert.equal(result.reason, null);
    assert.equal(result.total, 0);
  }

  const xrefs = await completeTools.get_xrefs(0x1000n);
  assert.deepEqual(xrefs.supported, { sites: true, functions: true });
  assert.equal(xrefs.complete, true);
  assert.equal(xrefs.truncated, false);
  assert.equal(xrefs.reason, null);
  assert.equal(xrefs.total, 0);
  assert.deepEqual(xrefs.totals, { sites: 0, functions: 0 });

  const capped = await createAgentTools({
    program: {
      callersOf() { return cappedEmpty(); },
    },
  }, {}).get_callers(0x1000n);
  assert.equal(capped.supported, true);
  assert.equal(capped.complete, false);
  assert.equal(capped.truncated, true);
  assert.equal(capped.reason, 'calls-source-capped');
  assert.equal(capped.total, null);
});
