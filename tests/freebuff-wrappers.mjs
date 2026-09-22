// Regression guard for ./freebuff-N wrappers.
//
// Failure mode being prevented: the wrappers used to be untracked files
// pointing at HOME dirs outside the workspace (/mnt/workspace/.freebuff-homes,
// /tmp). Untracked files inside the repo are wiped by repo sync/clean, so the
// commands broke with no machine-readable signal — twice, the second time
// taking even the staged restoration with it.
//
// Enforced contract:
//   1. freebuff-1..DEFAULT_COUNT exist at the repo root, are executable, set an
//      isolated HOME under /mnt/workspace/.dev-state, and cd to the repo root
//      at launch. HOME must be outside both the repo (git clean/reset reach)
//      and the launch cwd: freebuff shows its "Select project directory"
//      picker on startup iff HOME is inside cwd — never /tmp, never the repo.
//   2. Every wrapper delegates HOME preparation to scripts/freebuff-setup.mjs
//      (single source of truth — `npm run freebuff:setup` restores them, with
//      an off-repo mirror at /mnt/workspace/.dev-state/freebuff-restore/).
//   3. The data dir lives outside git; the wrappers themselves must be
//      tracked (so cleanup cannot silently drop them).
//   4. Instance numbers are generalized: any positive integer is a valid
//      --ensure selector; full setup accepts --count N and discovers existing
//      freebuff-N wrappers/HOMEs beyond the default floor.
//   5. Wrapper launches must not spawn `freebuff --version` across every HOME
//      (sidecar + version probe cache keep --ensure off that path).
//   6. The checked instance set is DISCOVERED (wrappers + HOMEs), never only the
//      1..DEFAULT_COUNT floor: a live instance whose wrapper is missing or
//      untracked must fail, not silently disappear.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const setup = await import('../scripts/freebuff-setup.mjs');
const { DATA_ROOT, LEGACY_ROOT, copyIfMissing, ensureMetadata, parseArgs, resolveNums, binaryVersionCached, readSharedSidecarVersion, DEFAULT_COUNT, ensureWrappers, wrapperScript } = setup;
const NUMS = Array.from({ length: DEFAULT_COUNT }, (_, i) => String(i + 1));
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
  check(text.includes('.tools/bin'), `${name}: must prepend repo .tools/bin (xdg-open shim) to PATH`);
  check(text.includes('DISPLAY'), `${name}: must set a fallback DISPLAY so freebuff attempts browser open`);
  check(text.includes('.tools/bin:$PATH') || text.includes('.tools/bin:$PATH'), `${name}: must put xdg-open shim on PATH`);
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
// Recurrence guard (2026-09-22): freebuff-9..12 were live (their HOMEs existed
// and instance 10 was running) while every check above was hardcoded to
// 1..DEFAULT_COUNT, and the generalized generator itself was uncommitted WIP.
// A rebase/reset reverted the generator to the 1..8 version and the untracked
// wrappers 9..12 vanished with no signal at all: the commands stopped existing
// and this guard still passed because its denominator was a constant.
// The instance set is DISCOVERED from the same paths the generator uses, so a
// live HOME without a wrapper (or an untracked wrapper) now fails loudly.
const discovered = resolveNums({ count: DEFAULT_COUNT, root, dataRoot: DATA_ROOT, legacyRoot: LEGACY_ROOT });
check(
  discovered.length >= NUMS.length,
  `discovered instance set (${discovered.length}) must cover the 1..${DEFAULT_COUNT} floor`,
);
for (const n of discovered) {
  const name = `freebuff-${n}`;
  const p = path.join(root, name);
  let stat = null;
  try {
    stat = fs.lstatSync(p);
  } catch {}
  check(
    Boolean(stat?.isFile()),
    `${name}: discovered live instance has no wrapper at the repo root (run npm run freebuff:setup, then commit the wrapper)`,
  );
  if (stat?.isFile()) {
    check((stat.mode & 0o111) !== 0, `${name}: discovered wrapper is not executable`);
    check(
      fs.readFileSync(p, 'utf8') === wrapperScript(n),
      `${name}: discovered wrapper drifted from the generator (rebuild it, never hand-edit)`,
    );
  }
  try {
    const tracked = execFileSync('git', ['ls-files', '--', name], { cwd: root, encoding: 'utf8' }).trim();
    check(tracked === name, `${name}: discovered wrapper must be git-tracked (untracked wrappers are lost by repo cleanup)`);
  } catch (error) {
    check(false, `git ls-files failed for ${name}: ${error.message}`);
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
check(setupSrc.includes('rescanHomes: false'), 'wrapper --ensure path must skip cross-HOME binary rescans');
check(setupSrc.includes('VERSION_CACHE'), 'setup must cache binary version probes across launches');
check(setupSrc.includes('ensureXdgOpenShim'), 'setup must ensure the xdg-open $BROWSER shim');
check(setupSrc.includes('XDG_OPEN_SHIM'), 'setup must define the xdg-open shim source');

// #9200 / generalization: freebuff-setup CLI argument grammar and validation
assert.deepEqual(parseArgs([]), { mode: 'full' });
assert.deepEqual(parseArgs(['--ensure', '1']), { mode: 'ensure', num: '1' });
assert.deepEqual(parseArgs(['--ensure', '8']), { mode: 'ensure', num: '8' });
assert.deepEqual(parseArgs(['--ensure', '9']), { mode: 'ensure', num: '9' });
assert.deepEqual(parseArgs(['--ensure', '42']), { mode: 'ensure', num: '42' });
assert.deepEqual(parseArgs(['--ensure', '1024']), { mode: 'ensure', num: '1024' });
assert.deepEqual(parseArgs(['--count', '16']), { mode: 'full', count: '16' });

assert.throws(() => parseArgs(['--ensure', '0']), /invalid --ensure selector '0'/);
assert.throws(() => parseArgs(['--ensure', '-1']), /invalid --ensure selector '-1'/);
assert.throws(() => parseArgs(['--ensure', '1.5']), /invalid --ensure selector '1.5'/);
assert.throws(() => parseArgs(['--ensure', 'abc']), /invalid --ensure selector 'abc'/);
assert.throws(() => parseArgs(['--ensure']), /invalid --ensure selector '<missing>'/);
assert.throws(() => parseArgs(['--ensure', '1', '--typo']), /invalid --ensure selector/);
assert.throws(() => parseArgs(['--count', '0']), /invalid --count selector '0'/);
assert.throws(() => parseArgs(['--count']), /invalid --count selector '<missing>'/);
assert.throws(() => parseArgs(['--unknown']), /unrecognized argument/);
assert.throws(() => parseArgs(['garbage']), /unrecognized argument/);

// resolveNums: default floor + discovery of wrappers/HOMEs beyond the floor
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hex-freebuff-nums-'));
  try {
    fs.writeFileSync(path.join(tmp, 'freebuff-12'), wrapperScript('12'));
    fs.mkdirSync(path.join(tmp, 'data', '9', 'home'), { recursive: true });
    const nums = resolveNums({ count: 3, root: tmp, dataRoot: path.join(tmp, 'data') });
    assert.deepEqual(nums, ['1', '2', '3', '9', '12']);
    assert.throws(() => resolveNums({ count: 0 }), /invalid instance count '0'/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// Version probe cache: one spawn-equivalent probe, then identity-keyed hits.
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hex-freebuff-vercache-'));
  try {
    const bin = path.join(tmp, 'freebuff');
    const cachePath = path.join(tmp, 'cache.json');
    fs.writeFileSync(bin, 'binary-v1');
    let probes = 0;
    const probe = () => {
      probes += 1;
      return '1.2.3';
    };
    assert.equal(binaryVersionCached(bin, { versionProbe: probe, cachePath }), '1.2.3');
    assert.equal(binaryVersionCached(bin, { versionProbe: probe, cachePath }), '1.2.3');
    assert.equal(probes, 1, 'warm cache must not re-probe an unchanged binary');
    fs.writeFileSync(bin, 'binary-v2-longer');
    assert.equal(binaryVersionCached(bin, { versionProbe: () => {
      probes += 1;
      return '1.2.4';
    }, cachePath }), '1.2.4');
    assert.equal(probes, 2, 'changed binary identity must re-probe');

    const sidecar = path.join(tmp, 'freebuff.version');
    fs.writeFileSync(sidecar, '9.9.9\n');
    assert.equal(readSharedSidecarVersion(sidecar), '9.9.9');
    fs.writeFileSync(sidecar, 'not-a-version\n');
    assert.equal(readSharedSidecarVersion(sidecar), null);
    assert.equal(readSharedSidecarVersion(path.join(tmp, 'missing.version')), null);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// ensureWrappers still materializes the default floor and repairs symlinks.
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hex-freebuff-ensure-wrappers-'));
  try {
    assert.equal(ensureWrappers(tmp), DEFAULT_COUNT);
    assert.equal(ensureWrappers(tmp), 0);
    assert.equal(fs.readFileSync(path.join(tmp, `freebuff-${DEFAULT_COUNT}`), 'utf8'), wrapperScript(String(DEFAULT_COUNT)));
    fs.writeFileSync(path.join(tmp, 'freebuff-11'), wrapperScript('11'), { mode: 0o755 });
    assert.equal(ensureWrappers(tmp), 0, 'discovered freebuff-11 must stay idempotent');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

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
const badEnsure0 = spawnSync(process.execPath, [setupScript, '--ensure', '0'], { cwd: root, encoding: 'utf8' });
check(badEnsure0.status !== 0, '--ensure 0 must exit non-zero');
check(badEnsure0.stderr.includes("invalid --ensure selector '0'"), '--ensure 0 error must report invalid selector 0');

const badEnsureFoo = spawnSync(process.execPath, [setupScript, '--ensure', 'foo'], { cwd: root, encoding: 'utf8' });
check(badEnsureFoo.status !== 0, '--ensure foo must exit non-zero');
check(badEnsureFoo.stderr.includes("invalid --ensure selector 'foo'"), '--ensure foo error must report invalid selector foo');

const badBareEnsure = spawnSync(process.execPath, [setupScript, '--ensure'], { cwd: root, encoding: 'utf8' });
check(badBareEnsure.status !== 0, 'bare --ensure must exit non-zero');

const badCount0 = spawnSync(process.execPath, [setupScript, '--count', '0'], { cwd: root, encoding: 'utf8' });
check(badCount0.status !== 0, '--count 0 must exit non-zero');
check(badCount0.stderr.includes("invalid --count selector '0'"), '--count 0 error must report invalid selector 0');

const badUnknown = spawnSync(process.execPath, [setupScript, '--unknown'], { cwd: root, encoding: 'utf8' });
check(badUnknown.status !== 0, '--unknown must exit non-zero');

const badTrailing = spawnSync(process.execPath, [setupScript, '--ensure', '1', '--typo'], { cwd: root, encoding: 'utf8' });
check(badTrailing.status !== 0, '--ensure 1 --typo must exit non-zero');

if (failures.length) {
  for (const f of failures) process.stderr.write(`FAIL: ${f}\n`);
  process.exit(1);
}
process.stdout.write(`freebuff wrappers: ${discovered.length} instances ok (floor 1..${DEFAULT_COUNT}, discovered from disk, generalized)\n`);
