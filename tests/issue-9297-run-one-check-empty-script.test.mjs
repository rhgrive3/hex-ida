import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('#9297 run-one-check treats an empty-string npm script as an existing script', () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'hex-9297-'));
  try {
    fs.mkdirSync(path.join(fixture, 'scripts'));
    fs.copyFileSync(path.join(ROOT, 'scripts/run-one-check.mjs'), path.join(fixture, 'scripts/run-one-check.mjs'));
    fs.copyFileSync(path.join(ROOT, 'scripts/run-quiet-command.mjs'), path.join(fixture, 'scripts/run-quiet-command.mjs'));
    fs.writeFileSync(path.join(fixture, 'package.json'), JSON.stringify({
      private: true,
      scripts: {
        noop: '',
        nonempty: 'node -e "process.exit(0)"',
      },
    }, null, 2));

    const env = { ...process.env, HEX_TEST_OUTPUT: 'verbose' };
    const noop = spawnSync(process.execPath, ['scripts/run-one-check.mjs', 'noop'], { cwd: fixture, encoding: 'utf8', env });
    assert.equal(noop.status, 0, noop.stderr);
    assert.doesNotMatch(noop.stderr, /unknown npm script/);

    const nonempty = spawnSync(process.execPath, ['scripts/run-one-check.mjs', 'nonempty'], { cwd: fixture, encoding: 'utf8', env });
    assert.equal(nonempty.status, 0, nonempty.stderr);

    const list = spawnSync(process.execPath, ['scripts/run-one-check.mjs', '--list'], { cwd: fixture, encoding: 'utf8', env });
    assert.equal(list.status, 0, list.stderr);
    assert.match(list.stdout, /^noop\s+/m);

    const missing = spawnSync(process.execPath, ['scripts/run-one-check.mjs', 'missing'], { cwd: fixture, encoding: 'utf8', env });
    assert.equal(missing.status, 2);
    assert.match(missing.stderr, /unknown npm script: missing/);
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});
