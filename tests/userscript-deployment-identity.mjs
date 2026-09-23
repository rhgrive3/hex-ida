import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cp, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const script = resolve(root, 'scripts/write-deployment-identity.mjs');
const temp = await mkdtemp(resolve(tmpdir(), 'hex-deployment-identity-'));
const external = await mkdtemp(resolve(tmpdir(), 'hex-deployment-identity-external-'));

try {
  await mkdir(resolve(temp, 'scripts'), { recursive: true });
  await mkdir(resolve(temp, 'js/userscript'), { recursive: true });
  await cp(script, resolve(temp, 'scripts/write-deployment-identity.mjs'));
  await writeFile(resolve(temp, 'source.js'), 'export const value = 1;\n');
  await writeFile(resolve(temp, 'js/userscript/deployment-identity.generated.js'), '// generated placeholder\n');

  git('init', '-q');
  git('config', 'user.name', 'Hex Test');
  git('config', 'user.email', 'hex-test@example.invalid');
  git('add', '.');
  git('commit', '-qm', 'fixture');
  const head = git('rev-parse', 'HEAD').trim();

  assert.equal(await generate({}), head, 'clean manual deploy must use the exact checkout HEAD');
  assert.equal(await generate({}), head, 'the script-owned generated identity must not make a repeat build dirty');

  await writeFile(resolve(temp, 'source.js'), 'export const value = 2;\n');
  assert.equal(await generate({}), null, 'unstaged tracked source changes must disable commit attestation');

  git('add', 'source.js');
  assert.equal(await generate({}), null, 'staged source changes must disable commit attestation');

  git('reset', '--hard', '-q', 'HEAD');
  const untracked = resolve(temp, 'untracked-source.js');
  await writeFile(untracked, 'export const extra = true;\n');
  assert.equal(await generate({}), null, 'untracked deployable source must disable commit attestation');
  await rm(untracked, { force: true });

  assert.equal(
    await generate({ WORKERS_CI_COMMIT_SHA: head }),
    head,
    'Workers CI commit is accepted only when it matches the clean checked-out HEAD',
  );
  const workersCommit = '0123456789abcdef0123456789abcdef01234567';
  assert.equal(
    await generate({ WORKERS_CI_COMMIT_SHA: workersCommit }),
    null,
    'mismatched Workers CI commit must not override checked-out HEAD provenance',
  );

  if (process.platform !== 'win32') {
    const output = resolve(temp, 'js/userscript/deployment-identity.generated.js');
    for (const kind of ['absolute', 'relative', 'multihop']) {
      const victim = resolve(external, `victim-${kind}.js`);
      await writeFile(victim, 'KEEP\n');
      await rm(output, { force: true });

      if (kind === 'absolute') {
        await symlink(victim, output);
      } else if (kind === 'relative') {
        await symlink(relative(dirname(output), victim), output);
      } else {
        const hop = resolve(external, 'deployment-hop.js');
        await rm(hop, { force: true });
        await symlink(victim, hop);
        await symlink(relative(dirname(output), hop), output);
      }

      assert.equal(await generate({}), head);
      assert.equal(await readFile(victim, 'utf8'), 'KEEP\n', `${kind} output symlink target must remain untouched`);
      const outputEntry = await lstat(output);
      assert.equal(outputEntry.isSymbolicLink(), false, 'successful publication must replace the symlink leaf itself');
      assert.equal(outputEntry.isFile(), true);
      assert.match(await readFile(output, 'utf8'), new RegExp(`DEPLOYMENT_COMMIT="${head}"`));
    }
  }

  console.log('userscript deployment identity: ok');
} finally {
  await rm(temp, { recursive: true, force: true });
  await rm(external, { recursive: true, force: true });
}

function git(...args) {
  return execFileSync('git', args, { cwd: temp, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

async function generate(extraEnv) {
  execFileSync(process.execPath, ['scripts/write-deployment-identity.mjs'], {
    cwd: temp,
    env: { ...process.env, WORKERS_CI_COMMIT_SHA: '', ...extraEnv },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const source = await readFile(resolve(temp, 'js/userscript/deployment-identity.generated.js'), 'utf8');
  const match = source.match(/DEPLOYMENT_COMMIT=(null|"([0-9a-f]{40})")/);
  assert.ok(match, 'generated deployment identity must have the expected shape');
  return match[1] === 'null' ? null : match[2];
}
