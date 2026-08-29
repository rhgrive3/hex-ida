import fs from 'node:fs';
import assert from 'node:assert/strict';

const workflow = fs.readFileSync('.github/workflows/cross-binary-accuracy.yml', 'utf8');

assert.ok(
  workflow.includes("--only='sections,funcs,funcs-guess,disasm,kinds,calls,refs,imports,objc,selstub,pinpoint'"),
  'core/pinpoint lane must retain its exact feature set',
);
assert.ok(
  workflow.includes("--only='strings,xrefs,funcname,selffield,role'"),
  'first heavy non-pseudocode shard must retain strings/xrefs/name/role coverage',
);
assert.ok(
  workflow.includes("--only='apimeaning,summary,expr,formula,pinpoint-partial'"),
  'second heavy non-pseudocode shard must retain semantic/pinpoint-partial coverage',
);
assert.ok(
  workflow.includes('const rows = [0, 1, 2].flatMap'),
  'result merge must include all three non-pseudocode shards',
);

for (const line of workflow.split('\n')) {
  if (!line.includes('tests/accuracy.mjs')) continue;
  assert.ok(!line.trimEnd().endsWith('&'), 'accuracy.mjs shards must not be backgrounded concurrently');
}

assert.ok(
  workflow.includes("node tests/issue-2484-cross-binary-memory-envelope.mjs"),
  'workflow must execute the memory-envelope regression',
);

console.log('issue-2484 cross-binary memory envelope: ok');
