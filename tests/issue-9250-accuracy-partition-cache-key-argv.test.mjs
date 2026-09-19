import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const valid = spawnSync('node', ['scripts/accuracy-partition-cache-key.mjs', 'core'], { encoding: 'utf8' });
assert.equal(valid.status, 0);
assert.match(valid.stdout.trim(), /^[0-9a-f]{64}$/);

const trailing = spawnSync('node', ['scripts/accuracy-partition-cache-key.mjs', 'core', 'unexpected'], { encoding: 'utf8' });
assert.notEqual(trailing.status, 0);

const typo = spawnSync('node', ['scripts/accuracy-partition-cache-key.mjs', 'core', '--typo'], { encoding: 'utf8' });
assert.notEqual(typo.status, 0);

const missing = spawnSync('node', ['scripts/accuracy-partition-cache-key.mjs'], { encoding: 'utf8' });
assert.notEqual(missing.status, 0);

console.log('issue-9250-accuracy-partition-cache-key-argv: PASS');
