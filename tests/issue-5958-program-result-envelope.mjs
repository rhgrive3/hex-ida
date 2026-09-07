// Regression for #5958: get_callers / get_callees / get_xrefs read
// `q.results` but dropped the structured envelope when the program backend
// answered with `{ results, complete, truncated, reason }` — rows became []
// and programResultCompleteness() received the empty array instead of the
// envelope, publishing empty complete:true results. The rows and the
// incompleteness evidence now both flow through.
import assert from 'node:assert/strict';
import { createAgentTools } from '../js/agent/tools.js';

{
  const tools = createAgentTools({
    program: {
      callersOf() { return { results: [{ addr: 0x2000n }], complete: false, truncated: true, reason: 'budget-exhausted' }; },
    },
  });
  const out = await tools.get_callers(0x1000n);
  assert.equal(out.results.length, 1, 'structured result rows must survive');
  assert.equal(out.results[0].addr, 0x2000n);
  assert.equal(out.complete, false, 'upstream incompleteness must survive');
  assert.equal(out.truncated, true);
  assert.equal(out.reason, 'budget-exhausted');
}

{
  // The public callees surface requires a proven function range (main's
  // fail-closed boundary) before the core query runs.
  const tools = createAgentTools({
    program: {
      functionRange() { return { start: 0x1000n, end: 0x2000n }; },
      calleesOf() { return { results: [{ addr: 0x3000n }], complete: false, reason: 'source-capped' }; },
    },
  });
  const out = await tools.get_callees(0x1000n);
  assert.equal(out.results.length, 1);
  assert.equal(out.complete, false);
  assert.equal(out.reason, 'source-capped');
}

{
  const tools = createAgentTools({
    program: {
      refSitesTo() { return { results: [{ addr: 0x4000n }], complete: false, reason: 'refs-capped' }; },
      functionsReferencing() { return { results: [{ addr: 0x2000n }], complete: true }; },
    },
  });
  const out = await tools.get_xrefs(0x1000n);
  assert.equal(out.sites.length, 1, 'structured ref-site rows must survive');
  assert.equal(out.functions.length, 1);
  assert.equal(out.complete, false, 'either half incomplete keeps the whole result incomplete');
  assert.equal(out.reason, 'refs-capped');
}

{
  // Plain array answers keep working unchanged, including honest completeness.
  const tools = createAgentTools({
    program: {
      callersOf() { return [{ addr: 0x2000n }]; },
    },
  });
  const out = await tools.get_callers(0x1000n);
  assert.equal(out.results.length, 1);
  assert.equal(out.complete, true);
}

{
  // A structured result without a results array fails closed instead of
  // publishing an empty complete result.
  const tools = createAgentTools({
    program: {
      callersOf() { return { complete: false, reason: 'no-rows-field' }; },
    },
  });
  const out = await tools.get_callers(0x1000n);
  assert.equal(out.results.length, 0);
  assert.equal(out.complete, false);
  assert.equal(out.reason, 'no-rows-field');
}
