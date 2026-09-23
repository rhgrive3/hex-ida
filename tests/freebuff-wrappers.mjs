// Regression guard for ./freebuff-1..12.
//
// Failure mode being prevented: the wrappers used to be untracked files
// pointing at HOME dirs outside the workspace (/mnt/workspace/.freebuff-homes,
// /tmp). Untracked files inside the repo are wiped by repo sync/clean, so the
// commands broke with no machine-readable signal — twice, the second time
// taking even the staged restoration with it.
//
// Enforced contract:
//   1. freebuff-1..12 exist at the repo root, are executable, set an isolated
//      HOME under /mnt/workspace/.dev-state, and cd to the repo root at
//      launch. HOME must be outside both the repo (git clean/reset reach)
//      and the launch cwd: freebuff shows its "Select project directory"
//      picker on startup iff HOME is inside cwd — never /tmp, never the repo.
//   2. Every wrapper delegates HOME preparation to scripts/freebuff-setup.mjs
//      (single source of truth — `npm run freebuff:setup` restores them, with
//      an off-repo mirror at /mnt/workspace/.dev-state/freebuff-restore/).
//   3. The data dir lives outside git; the wrappers themselves must be
//      tracked (so cleanup cannot silently drop them).
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NUMS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12'];
const failures = [];
function check(cond, message) {
  if (!cond) failures.push(message);
}

const gitignore = fs.readFileSync(path.join(root, '.gitignore'), 'utf8');
check(gitignore.includes('/.freebuff-homes/'), '.gitignore must ignore /.freebuff-homes/ (credential data)');
check(
  fs.existsSync(path.join(root, 'scripts', 'freebuff-setup.mjs')),
  'scripts/freebuff-setup.mjs must exist (wrapper source of truth)',
);

for (const n of NUMS) {
  const name = `freebuff-${n}`;
  const p = path.join(root, name);
  let stat = null;
  try {
    stat = fs.lstatSync(p);
  } catch {
    check(false, `${name}: missing at repo root (run npm run freebuff:setup)`);
    continue;
  }
  check(stat.isFile(), `${name}: not a regular file`);
  check((stat.mode & 0o111) !== 0, `${name}: not executable`);
  const text = fs.readFileSync(p, 'utf8');
  check(text.startsWith('#!/usr/bin/env bash'), `${name}: must have bash shebang`);
  check(text.includes(`N="${n}"`), `${name}: must pin N="${n}"`);
  check(
    text.includes('.dev-state/freebuff-homes/$N/home'),
    `${name}: must set HOME to isolated .dev-state/freebuff-homes/$N/home`,
  );
  check(text.includes('export HOME='), `${name}: must export HOME`);
  check(text.includes('cd "$REPO"'), `${name}: must start in the repo root at launch`);
  check(text.includes('scripts/freebuff-setup.mjs'), `${name}: must delegate to scripts/freebuff-setup.mjs`);
  check(text.includes('.tools/npm/bin/freebuff'), `${name}: must exec the repo-local launcher`);
  check(!text.includes('/tmp/'), `${name}: must not reference /tmp (does not survive restart)`);
  check(
    !text.includes('HOME="$REPO') && !text.includes("HOME='$REPO"),
    `${name}: HOME must not live under the repo (git reach + startup picker)`,
  );
}

// Wrappers must be tracked, data must not be: query git directly so a future
// .gitignore/.git/info/exclude edit that hides the wrappers fails loudly.
for (const n of NUMS) {
  try {
    const tracked = execFileSync('git', ['ls-files', '--', `freebuff-${n}`], { cwd: root, encoding: 'utf8' }).trim();
    check(tracked === `freebuff-${n}`, `freebuff-${n} must be git-tracked (untracked wrappers are lost by cleanup)`);
  } catch (error) {
    check(false, `git ls-files failed: ${error.message}`);
  }
}
try {
  // Trailing slash: the data dir may not exist; without it git treats the
  // path as a file and dir-only patterns never match.
  execFileSync('git', ['check-ignore', '-q', '.freebuff-homes/'], { cwd: root, stdio: 'pipe' });
  // exit 0 => ignored, as required
} catch {
  check(false, '.freebuff-homes must be git-ignored (credentials must never be committed)');
}

const setupSrc = fs.readFileSync(path.join(root, 'scripts', 'freebuff-setup.mjs'), 'utf8');
check(setupSrc.includes('LEGACY_ROOT'), 'setup must migrate the legacy outside-workspace path');
check(setupSrc.includes('freebuff@latest'), 'setup must reinstall the launcher when missing');
check(setupSrc.includes('MIRROR_ROOT'), 'setup must maintain the off-repo mirror');
check(setupSrc.includes('showProjectPicker'), 'setup must document the HOME-under-cwd picker gate');
check(setupSrc.includes('SHARED_BIN'), 'setup must share one binary copy across HOMEs');
check(setupSrc.includes('symlinkSync'), 'setup must link (not re-download) missing per-HOME binaries');

// #9200: freebuff-setup CLI argument grammar and validation
const { copyIfMissing, ensureMetadata, parseArgs } = await import('../scripts/freebuff-setup.mjs');
assert.deepEqual(parseArgs([]), { mode: 'full' });
assert.deepEqual(parseArgs(['--ensure', '1']), { mode: 'ensure', num: '1' });
assert.deepEqual(parseArgs(['--ensure', '8']), { mode: 'ensure', num: '8' });
assert.deepEqual(parseArgs(['--ensure', '12']), { mode: 'ensure', num: '12' });

assert.throws(() => parseArgs(['--ensure', '13']), /invalid --ensure selector '13'/);
assert.throws(() => parseArgs(['--ensure', '0']), /invalid --ensure selector '0'/);
assert.throws(() => parseArgs(['--ensure']), /invalid --ensure selector '<missing>'/);
assert.throws(() => parseArgs(['--ensure', '1', '--typo']), /invalid --ensure selector/);
assert.throws(() => parseArgs(['--unknown']), /unrecognized argument/);
assert.throws(() => parseArgs(['garbage']), /unrecognized argument/);

// #9274: migration destinations are untrusted persistent filesystem leaves.
// A dangling destination symlink must count as occupied, and the exclusive
// copy closes the lstat/copy race without changing destination-wins semantics.
const symlinkFixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hex-freebuff-symlink-'));
try {
  const src = path.join(symlinkFixtureRoot, 'legacy', 'settings.json');
  const dst = path.join(symlinkFixtureRoot, 'home', 'settings.json');
  fs.mkdirSync(path.dirname(src), { recursive: true });
  fs.writeFileSync(src, '{"marker":"legacy"}\n');

  assert.equal(copyIfMissing(src, dst), true);
  assert.equal(fs.readFileSync(dst, 'utf8'), '{"marker":"legacy"}\n');

  fs.writeFileSync(src, '{"marker":"new-source"}\n');
  assert.equal(copyIfMissing(src, dst), false);
  assert.equal(fs.readFileSync(dst, 'utf8'), '{"marker":"legacy"}\n');

  const danglingTarget = path.join(symlinkFixtureRoot, 'outside-created.json');
  const danglingDst = path.join(symlinkFixtureRoot, 'home', 'dangling-settings.json');
  fs.symlinkSync(danglingTarget, danglingDst);
  assert.equal(copyIfMissing(src, danglingDst), false);
  assert.equal(fs.existsSync(danglingTarget), false);
  assert.equal(fs.lstatSync(danglingDst).isSymbolicLink(), true);

  const existingTarget = path.join(symlinkFixtureRoot, 'outside-existing.json');
  const existingLink = path.join(symlinkFixtureRoot, 'home', 'existing-target-settings.json');
  fs.writeFileSync(existingTarget, 'KEEP\n');
  fs.symlinkSync(existingTarget, existingLink);
  assert.equal(copyIfMissing(src, existingLink), false);
  assert.equal(fs.readFileSync(existingTarget, 'utf8'), 'KEEP\n');

  // #9272: metadata reconciliation may replace the leaf, but must never
  // write through it. Both existing-target and dangling symlinks are covered.
  const metadataDir = path.join(symlinkFixtureRoot, 'metadata-home');
  const metadataPath = path.join(metadataDir, 'freebuff-metadata.json');
  const shared = { version: '9.9.9' };
  const expectedTarget = `${process.platform}-${process.arch}`;
  fs.mkdirSync(metadataDir, { recursive: true });

  const metadataVictim = path.join(symlinkFixtureRoot, 'metadata-victim.json');
  fs.writeFileSync(metadataVictim, 'KEEP\n');
  fs.symlinkSync(metadataVictim, metadataPath);
  assert.equal(ensureMetadata(metadataDir, shared), true);
  assert.equal(fs.readFileSync(metadataVictim, 'utf8'), 'KEEP\n');
  assert.equal(fs.lstatSync(metadataPath).isFile(), true);
  assert.deepEqual(JSON.parse(fs.readFileSync(metadataPath, 'utf8')), {
    version: shared.version,
    target: expectedTarget,
  });

  fs.rmSync(metadataPath, { force: true });
  const missingMetadataVictim = path.join(symlinkFixtureRoot, 'metadata-missing-victim.json');
  fs.symlinkSync(missingMetadataVictim, metadataPath);
  assert.equal(ensureMetadata(metadataDir, shared), true);
  assert.equal(fs.existsSync(missingMetadataVictim), false);
  assert.equal(fs.lstatSync(metadataPath).isFile(), true);

  assert.equal(ensureMetadata(metadataDir, shared), false);
  fs.writeFileSync(metadataPath, '{"version":"stale","target":"stale"}\n');
  assert.equal(ensureMetadata(metadataDir, shared), true);
  assert.deepEqual(JSON.parse(fs.readFileSync(metadataPath, 'utf8')), {
    version: shared.version,
    target: expectedTarget,
  });
} finally {
  fs.rmSync(symlinkFixtureRoot, { recursive: true, force: true });
}

const setupScript = path.join(root, 'scripts/freebuff-setup.mjs');
const badEnsure13 = spawnSync(process.execPath, [setupScript, '--ensure', '13'], { cwd: root, encoding: 'utf8' });
check(badEnsure13.status !== 0, '--ensure 13 must exit non-zero');
check(badEnsure13.stderr.includes("invalid --ensure selector '13'"), '--ensure 13 error must report invalid selector 13');

const badBareEnsure = spawnSync(process.execPath, [setupScript, '--ensure'], { cwd: root, encoding: 'utf8' });
check(badBareEnsure.status !== 0, 'bare --ensure must exit non-zero');

const badUnknown = spawnSync(process.execPath, [setupScript, '--unknown'], { cwd: root, encoding: 'utf8' });
check(badUnknown.status !== 0, '--unknown must exit non-zero');

const badTrailing = spawnSync(process.execPath, [setupScript, '--ensure', '1', '--typo'], { cwd: root, encoding: 'utf8' });
check(badTrailing.status !== 0, '--ensure 1 --typo must exit non-zero');

if (failures.length) {
  for (const f of failures) process.stderr.write(`FAIL: ${f}\n`);
  process.exit(1);
}
process.stdout.write(`freebuff wrappers: ${NUMS.length} wrappers ok\n`);
