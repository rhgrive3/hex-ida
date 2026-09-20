import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { buildNpmRunArgs } from '../scripts/run-one-check.mjs';

test('#9314 npm option parsing is terminated before a dash-prefixed script name', () => {
  assert.deepEqual(buildNpmRunArgs('--silent', []), ['run', '--', '--silent']);
  assert.deepEqual(buildNpmRunArgs('--silent', ['hello']), ['run', '--', '--silent', '--', 'hello']);
});

test('#9314 returned argv executes the exact dash-prefixed npm script and forwards args', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hex-9314-'));
  try {
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
      private:true,
      scripts:{
        '--silent': `node -e "require('fs').writeFileSync('marker', process.argv.slice(1).join(','))"`,
      },
    }));
    const result = spawnSync('npm', buildNpmRunArgs('--silent', ['hello', 'world']), { cwd:root, encoding:'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.readFileSync(path.join(root, 'marker'), 'utf8'), 'hello,world');
  } finally {
    fs.rmSync(root, { recursive:true, force:true });
  }
});
