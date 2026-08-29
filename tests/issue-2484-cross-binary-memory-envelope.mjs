import fs from 'node:fs';
import assert from 'node:assert/strict';

const workflow = fs.readFileSync('.github/workflows/cross-binary-accuracy.yml', 'utf8');

assert.ok(
  workflow.includes("--only='sections,funcs,funcs-guess,disasm,kinds,calls,refs,imports,objc,selstub,pinpoint'"),
  'core/pinpoint lane must retain its exact feature set',
);
assert.ok(
  workflow.includes("--only='strings,xrefs'"),
  'strings/xrefs shard must retain its exact feature set',
);
for (const feature of ['funcname', 'selffield', 'role']) {
  assert.ok(
    workflow.includes(`--only='${feature}'`),
    `${feature} must run in its own bounded shard`,
  );
}
assert.ok(
  workflow.includes("--only='apimeaning,summary,expr,formula,pinpoint-partial'"),
  'semantic/pinpoint-partial shard must retain its exact feature set',
);
assert.ok(
  workflow.includes('const rows = [0, 1, 2, 3, 4, 5].flatMap'),
  'result merge must include all six non-pseudocode shards',
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
