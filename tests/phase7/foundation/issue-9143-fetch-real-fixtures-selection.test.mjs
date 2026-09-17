import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../../../scripts/fetch-real-fixtures.mjs', import.meta.url));
const run = spawnSync(process.execPath, [script, '--check', 'all', 'definitely-not-a-fixture'], { encoding:'utf8' });
assert.notEqual(run.status, 0);
assert.match(run.stderr, /unknown fixture: definitely-not-a-fixture/);
assert.doesNotMatch(run.stderr, /fixture is missing/, 'unknown explicit names must be rejected before widening to all fixtures');
console.log('issue-9143 fetch-real-fixtures selection: PASS');
