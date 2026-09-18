import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// #5895: the graft helper's candidate order baked a machine-specific global
// install ahead of the checkout's own dependency, so the hook version a
// checkout executed depended on host state instead of repository state.
// Precedence must be: explicit GRAFT_CLAUDE_DIR override, then the
// project-local @nanonets/graft, then global resolution, then the baked
// historical path last. graft-hooks.cjs and graft-statusline.cjs share it.

const hooksHelper = fileURLToPath(new URL('../.claude/helpers/graft-hooks.cjs', import.meta.url));
const statuslineHelper = fileURLToPath(new URL('../.claude/helpers/graft-statusline.cjs', import.meta.url));

function makeProject({ marker, writeHooks = true, writeStatusline = false }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'graft-5895-'));
  // A resolvable project-local @nanonets/graft whose dist/claude module
  // records which copy of the helper contract actually executed.
  const pkgDir = path.join(dir, 'node_modules', '@nanonets', 'graft');
  const dist = path.join(pkgDir, 'dist', 'claude');
  fs.mkdirSync(dist, { recursive: true });
  fs.writeFileSync(path.join(pkgDir, 'package.json'), '{"name":"@nanonets/graft","version":"0.0.0-fixture"}\n');
  if (writeHooks) {
    fs.writeFileSync(path.join(dist, 'hooks.js'), `import fs from 'node:fs';\nexport async function main() { fs.writeFileSync(process.env.GRAFT_MARKER, ${JSON.stringify(marker)}); }\n`);
  }
  if (writeStatusline) {
    fs.writeFileSync(path.join(dist, 'statusline.js'), `import fs from 'node:fs';\nexport async function main() { fs.writeFileSync(process.env.GRAFT_MARKER, ${JSON.stringify(marker)}); }\n`);
  }
  return dir;
}

test('#5895 project-local graft outranks any global/baked candidate for hooks', () => {
  const dir = makeProject({ marker: 'project-local' });
  const marker = path.join(dir, 'marker');
  const result = spawnSync(process.execPath, [hooksHelper, 'post-edit'], {
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_PROJECT_DIR: dir, GRAFT_MARKER: marker, NODE_PATH: '' },
  });
  assert.equal(result.status, 0, `local hook main() should run: ${result.stderr}`);
  assert.equal(fs.readFileSync(marker, 'utf8'), 'project-local',
    'the checkout\'s own graft must execute, not a host-global shadow');
});

test('#5895 GRAFT_CLAUDE_DIR override outranks the project-local candidate', () => {
  const dir = makeProject({ marker: 'project-local' });
  const override = makeProject({ marker: 'override' });
  const marker = path.join(dir, 'marker');
  const result = spawnSync(process.execPath, [hooksHelper, 'post-edit'], {
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_PROJECT_DIR: dir, GRAFT_MARKER: marker, GRAFT_CLAUDE_DIR: path.join(override, 'node_modules', '@nanonets', 'graft', 'dist', 'claude') },
  });
  assert.equal(result.status, 0, `override hook main() should run: ${result.stderr}`);
  assert.equal(fs.readFileSync(marker, 'utf8'), 'override',
    'an explicit override is the only authority allowed above the checkout');
});

test('#5895 statusline resolution shares the local-first precedence', () => {
  const dir = makeProject({ marker: 'statusline-local', writeStatusline: true });
  const marker = path.join(dir, 'marker');
  const result = spawnSync(process.execPath, [statuslineHelper], {
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_PROJECT_DIR: dir, GRAFT_MARKER: marker, NODE_PATH: '' },
  });
  assert.equal(result.status, 0, `statusline helper should run: ${result.stderr}`);
  assert.equal(fs.readFileSync(marker, 'utf8'), 'statusline-local',
    'the statusline resolver must also prefer the checkout\'s own graft');
});
