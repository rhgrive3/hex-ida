import assert from 'node:assert/strict';
import { planAnalysisGoal } from '../../js/query/planner.js';

const QUERY = {
  action: 'read',
  entity: { terms: ['target'] },
  context: { terms: [] },
  event: { terms: [] },
  expect: { calls: [] },
  confident: true,
};

function complete(results = []) {
  return { results, total:results.length, returned:results.length, complete:true, coverage:1 };
}

async function run({ functionRows = [], stringRows = [], candidateFunctions = [], callerRows = [], calleeRows = [], maxExpansions = 0 } = {}) {
  const analyzed = [];
  const xrefTargets = [];
  const tools = {
    async search_functions() { return complete(functionRows); },
    async search_strings() { return complete(stringRows); },
    async get_xrefs(address) {
      xrefTargets.push(address);
      return { functions:[], total:0, returned:0, complete:true, coverage:1 };
    },
    async get_callers() { return complete(callerRows); },
    async get_callees() { return complete(calleeRows); },
    async get_function(address) {
      analyzed.push(address);
      return {
        address,
        name:'target',
        instructions:1,
        summary:{ calls:[] },
        cost:{ functions:1, disassembly:1 },
      };
    },
    async get_semantic_facts() { return complete([]); },
    async verify_field_update() { return { verified:false, evidence:[] }; },
    async find_thresholds() { return complete([]); },
  };
  const result = await planAnalysisGoal(
    QUERY,
    { candidateFunctions },
    { tools, maxFunctions:8, maxDisassembly:100, maxSearchResults:8, maxExpansions, timeoutMs:2000 },
  );
  return { result, analyzed, xrefTargets };
}

for (const value of [4096n, 4096, '4096', '0x1000']) {
  const { analyzed, result } = await run({ functionRows:[{ name:'target', address:value }] });
  assert.deepEqual(analyzed, [4096n], `canonical scalar address should be accepted: ${String(value)}`);
  assert.equal(result.candidates[0]?.address, 4096n);
}

for (const value of [
  ['4096'],
  { valueOf() { return 4096; } },
  { [Symbol.toPrimitive]() { return '4096'; } },
  () => 4096,
  true,
  false,
  -1n,
  -1,
  '-1',
  Number.MAX_SAFE_INTEGER + 1,
  new Number(4096),
]) {
  const { analyzed, result } = await run({ functionRows:[{ name:'target', address:value }] });
  assert.deepEqual(analyzed, [], `non-canonical address must not reach function analysis: ${Object.prototype.toString.call(value)}`);
  assert.deepEqual(result.candidates, []);
}

// Reject structured metadata without invoking user-defined coercion hooks.
{
  let coercions = 0;
  const address = { [Symbol.toPrimitive]() { coercions++; return '4096'; } };
  const { analyzed } = await run({ functionRows:[{ address }] });
  assert.deepEqual(analyzed, []);
  assert.equal(coercions, 0);
}

// A malformed higher-priority field must not suppress a later canonical scalar.
{
  const { analyzed } = await run({ functionRows:[{ function:['4096'], address:'0x2000' }] });
  assert.deepEqual(analyzed, [0x2000n]);
}

// Structured values cannot become xref lookup authorities through the string path.
{
  const { xrefTargets } = await run({ stringRows:[{ stringAddress:['4096'] }] });
  assert.deepEqual(xrefTargets, []);
}


// Graph expansion rows cannot launder structured addresses either.
{
  const { analyzed } = await run({
    functionRows:[{ address:0x1000n }],
    callerRows:[{ addr:['16384'] }],
    maxExpansions:1,
  });
  assert.deepEqual(analyzed, [0x1000n]);
}
{
  const { analyzed } = await run({
    functionRows:[{ address:0x1000n }],
    callerRows:[{ addr:'0x4000' }],
    maxExpansions:1,
  });
  assert.ok(analyzed.includes(0x1000n));
  assert.ok(analyzed.includes(0x4000n));
}

// Recognition priors share the same candidate identity boundary.
{
  const { analyzed, result } = await run({ candidateFunctions:[{ addr:['4096'], source:'recognition', score:1 }] });
  assert.deepEqual(analyzed, []);
  assert.deepEqual(result.candidates, []);
}

// Nested producer objects remain supported when their address field itself is canonical.
{
  const { analyzed } = await run({ stringRows:[{ function:{ address:'0x3000' } }] });
  assert.deepEqual(analyzed, [0x3000n]);
}

console.log('issue-4357-strict-candidate-address: PASS');
