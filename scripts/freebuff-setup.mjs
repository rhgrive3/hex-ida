#!/usr/bin/env node
// freebuff isolated-HOME setup — idempotent restorer for ./freebuff-N.
//
// Background: ./freebuff-N used to be untracked shell wrappers with isolated
// HOME dirs at /mnt/workspace/.freebuff-homes (outside the repo). Untracked
// files inside the repo are wiped by repo sync/clean, so the commands broke.
// This script is the single source of truth:
//   - isolated HOME root: /mnt/workspace/.dev-state/freebuff-homes/N/home.
//     It MUST stay outside both the repo (git clean/reset can't reach it) and
//     the launch cwd: freebuff >=0.0.175 shows a "Select project directory"
//     picker on startup iff HOME is inside cwd (the showProjectPicker gate:
//     MhA(cwd,homedir): relative(cwd,homedir) has no leading "..").
//   - one shared binary: shared/manicode/freebuff. Each HOME would otherwise
//     download its own ~140MB copy; instead the newest available copy is kept
//     once in shared/ and missing per-HOME binaries become symlinks to it
//     (the launcher treats a symlink as installed; a later background update
//     atomically replaces the link with a per-HOME copy for that HOME only).
//   - tracked wrappers: <repo>/freebuff-N (regenerated here, must be committed).
//     N is any positive integer; full setup materializes 1..count (default 8)
//     plus any freebuff-N already present on disk or as an existing HOME.
//   - launcher: <repo>/.tools/npm/bin/freebuff (reinstalled on demand)
//   - one-time migration of small identity files from the legacy outside path.
//   - off-repo mirror: /mnt/workspace/.dev-state/freebuff-restore/ (survives
//     git clean/reset; auto-heal hook in .persistent-bashrc restores from it).
//
// Startup cost: wrapper launches use --ensure N with rescanHomes=false and a
// sidecar/version probe cache so they do not spawn `freebuff --version` against
// every HOME on every launch (that path used to cost ~25s).
//
// Usage:
//   node scripts/freebuff-setup.mjs             ensure 1..count + launcher + wrappers
//   node scripts/freebuff-setup.mjs --count N   same, with instance count N
//   node scripts/freebuff-setup.mjs --ensure N  fast path for wrappers (any positive N)
//   npm run freebuff:setup                      same as the first form
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Exported so the regression guard discovers instances from the same paths the
// generator materializes them into — a guard with its own private copy of this
// path can drift from the generator and go green while instances are missing.
export const DATA_ROOT = '/mnt/workspace/.dev-state/freebuff-homes';
const SHARED_ROOT = path.join(DATA_ROOT, 'shared');
// Previous data location inside the repo (kept as a migration source only;
// HOME under cwd triggers freebuff's startup project picker, so data must
// not live there).
const REPO_DATA_ROOT = path.join(ROOT, '.freebuff-homes');
export const LEGACY_ROOT = '/mnt/workspace/.freebuff-homes';
const MIRROR_ROOT = '/mnt/workspace/.dev-state/freebuff-restore';
// Default full-setup instance count. Any positive N is valid via --count/--ensure;
// existing freebuff-N wrappers/HOMEs beyond this floor are always discovered.
export const DEFAULT_COUNT = 8;
const POSITIVE_INT = /^[1-9][0-9]*$/;

// Small identity/config files worth migrating. Everything else is either a
// re-downloadable binary (freebuff, ~140MB per HOME) or regenerable cache
// (.graft, chat projects history).
const HOME_FILES = [
  '.config/manicode/analytics-id.json',
  '.config/manicode/credentials.json',
  '.config/manicode/settings.json',
  '.config/manicode/freebuff-metadata.json',
  '.config/manicode/freebuff-instance-owner.json',
  '.local/state/gh/device-id',
];
const SHARED_FILES = [
  'history/message-history.json',
  'manicode/rg',
  'manicode/tree-sitter.wasm',
];
const SHARED_BIN = path.join(SHARED_ROOT, 'manicode', 'freebuff');
const SHARED_BIN_VERSION = path.join(SHARED_ROOT, 'manicode', 'freebuff.version');
// path -> { version, size, mtimeMs } so warm launches skip `freebuff --version`.
const VERSION_CACHE = path.join(SHARED_ROOT, 'manicode', 'freebuff-version-cache.json');
// Source files mirrored off-repo so git clean/reset cannot destroy the
// restorer itself. Wrappers are generated, not mirrored (they embed no state).
const MIRRORED = ['scripts/freebuff-setup.mjs', 'tests/freebuff-wrappers.mjs'];

const XDG_OPEN_SHIM = `#!/usr/bin/env bash
# Route xdg-open through VS Code's $BROWSER helper so freebuff login URLs
# open the VS Code "open external URL" popup in headless/container envs
# where no real display server or system xdg-open exists.
set -euo pipefail
if [[ -n "\${BROWSER:-}" && -x "\${BROWSER}" ]]; then
  exec "\${BROWSER}" "$@"
fi
echo "xdg-open shim: \\$BROWSER is not set or not executable" >&2
exit 1
`;

export function ensureXdgOpenShim(root = ROOT) {
  const p = path.join(root, '.tools', 'bin', 'xdg-open');
  let entry = null;
  try {
    entry = fs.lstatSync(p);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  let healthy = false;
  if (entry?.isFile() && !entry.isSymbolicLink()) {
    healthy = fs.readFileSync(p, 'utf8') === XDG_OPEN_SHIM && (entry.mode & 0o111) !== 0;
  }
  if (healthy) return false;
  fs.mkdirSync(path.dirname(p), { recursive: true });
  publishTextAtomically(p, XDG_OPEN_SHIM, 0o755);
  return true;
}

export function wrapperScript(n) {
  return `#!/usr/bin/env bash
# freebuff-${n} — isolated-HOME wrapper (tracked).
# HOME lives under /mnt/workspace/.dev-state: outside the repo (git
# clean/reset can't wipe it) and outside the launch cwd (otherwise freebuff
# shows its "Select project directory" picker on every startup).
# DO NOT EDIT: regenerated by scripts/freebuff-setup.mjs (npm run freebuff:setup).
set -euo pipefail
N="${n}"
REPO="$(cd "$(dirname "\${BASH_SOURCE[0]:-$0}")" && pwd)"
FB_HOME="/mnt/workspace/.dev-state/freebuff-homes/$N/home"
node "$REPO/scripts/freebuff-setup.mjs" --ensure "$N"
export HOME="$FB_HOME"
# freebuff skips browser open when DISPLAY/WAYLAND_DISPLAY are unset; keep a
# dummy DISPLAY so it attempts open, and route PATH xdg-open to our $BROWSER shim.
: "\${DISPLAY:=:0}"
export DISPLAY
export PATH="$REPO/.tools/bin:$PATH"
# freebuff always starts in the repo root, wherever the wrapper is invoked from.
cd "$REPO"
exec "$REPO/.tools/npm/bin/freebuff" "$@"
`;
}

function pathIsWithin(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

export function ensureSafeDirectory(root, target, { fsImpl = fs } = {}) {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);
  if (!pathIsWithin(resolvedRoot, resolvedTarget)) {
    throw new Error(`freebuff setup: unsafe directory outside containment root: ${resolvedTarget}`);
  }

  let rootEntry = null;
  try {
    rootEntry = fsImpl.lstatSync(resolvedRoot);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    fsImpl.mkdirSync(resolvedRoot, { recursive: true });
    rootEntry = fsImpl.lstatSync(resolvedRoot);
  }
  if (rootEntry.isSymbolicLink() || !rootEntry.isDirectory()) {
    throw new Error(`freebuff setup: unsafe containment root is not a real directory: ${resolvedRoot}`);
  }

  const relative = path.relative(resolvedRoot, resolvedTarget);
  if (!relative) return resolvedTarget;
  let current = resolvedRoot;
  for (const part of relative.split(path.sep)) {
    current = path.join(current, part);
    try {
      const entry = fsImpl.lstatSync(current);
      if (entry.isSymbolicLink() || !entry.isDirectory()) {
        throw new Error(`freebuff setup: unsafe directory ancestor: ${current}`);
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      fsImpl.mkdirSync(current);
      const entry = fsImpl.lstatSync(current);
      if (entry.isSymbolicLink() || !entry.isDirectory()) {
        throw new Error(`freebuff setup: unsafe directory ancestor: ${current}`);
      }
    }
  }
  return resolvedTarget;
}

function sameDirectoryIdentity(a, b) {
  return Boolean(a && b && a.isDirectory() && b.isDirectory() && a.dev === b.dev && a.ino === b.ino);
}

function sameFileIdentity(a, b) {
  return Boolean(a && b && a.isFile() && b.isFile() && a.dev === b.dev && a.ino === b.ino);
}

function openStableMigrationSource(root, source, { fsImpl = fs } = {}) {
  const resolvedRoot = path.resolve(root);
  const resolvedSource = path.resolve(source);
  if (!pathIsWithin(resolvedRoot, resolvedSource) || resolvedSource === resolvedRoot) {
    throw new Error(`freebuff setup: migration source outside source root: ${resolvedSource}`);
  }

  let rootEntry;
  try {
    rootEntry = fsImpl.lstatSync(resolvedRoot);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  if (rootEntry.isSymbolicLink() || !rootEntry.isDirectory()) {
    throw new Error(`freebuff setup: migration source root is not a real directory: ${resolvedRoot}`);
  }

  const parent = path.dirname(resolvedSource);
  let current = resolvedRoot;
  const relativeParent = path.relative(resolvedRoot, parent);
  for (const part of relativeParent ? relativeParent.split(path.sep) : []) {
    current = path.join(current, part);
    let entry;
    try {
      entry = fsImpl.lstatSync(current);
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      throw error;
    }
    if (entry.isSymbolicLink() || !entry.isDirectory()) {
      throw new Error(`freebuff setup: unsafe migration source ancestor: ${current}`);
    }
  }

  const expectedParent = fsImpl.lstatSync(parent);
  const directoryFlags = fs.constants.O_RDONLY
    | (fs.constants.O_DIRECTORY || 0)
    | (fs.constants.O_NOFOLLOW || 0);
  const parentFd = fsImpl.openSync(parent, directoryFlags);
  let fileFd = null;
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    if (fileFd !== null) fsImpl.closeSync(fileFd);
    fsImpl.closeSync(parentFd);
  };
  try {
    const openedParent = fsImpl.fstatSync(parentFd);
    if (!sameDirectoryIdentity(expectedParent, openedParent)) {
      throw new Error(`freebuff setup: migration source directory identity changed: ${parent}`);
    }
    const stableParent = `/proc/self/fd/${parentFd}`;
    const viaParentHandle = fsImpl.statSync(stableParent);
    if (!sameDirectoryIdentity(openedParent, viaParentHandle)) {
      throw new Error(`freebuff setup: stable migration source directory unavailable: ${parent}`);
    }

    const leaf = path.join(stableParent, path.basename(resolvedSource));
    let expectedFile;
    try {
      expectedFile = fsImpl.lstatSync(leaf);
    } catch (error) {
      if (error?.code === 'ENOENT') {
        close();
        return null;
      }
      throw error;
    }
    if (expectedFile.isSymbolicLink() || !expectedFile.isFile()) {
      throw new Error(`freebuff setup: migration source is not a real file: ${resolvedSource}`);
    }

    const fileFlags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0);
    fileFd = fsImpl.openSync(leaf, fileFlags);
    const openedFile = fsImpl.fstatSync(fileFd);
    if (!sameFileIdentity(expectedFile, openedFile)) {
      throw new Error(`freebuff setup: migration source identity changed before copy: ${resolvedSource}`);
    }
    const stableFile = `/proc/self/fd/${fileFd}`;
    const viaFileHandle = fsImpl.statSync(stableFile);
    if (!sameFileIdentity(openedFile, viaFileHandle)) {
      throw new Error(`freebuff setup: stable migration source handle unavailable: ${resolvedSource}`);
    }
    return { path: stableFile, close };
  } catch (error) {
    try { close(); } catch {}
    throw error;
  }
}

export function openStableDirectory(root, target, { fsImpl = fs } = {}) {
  const resolvedTarget = ensureSafeDirectory(root, target, { fsImpl });
  const expected = fsImpl.lstatSync(resolvedTarget);
  const flags = fs.constants.O_RDONLY
    | (fs.constants.O_DIRECTORY || 0)
    | (fs.constants.O_NOFOLLOW || 0);
  const fd = fsImpl.openSync(resolvedTarget, flags);
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    fsImpl.closeSync(fd);
  };
  try {
    const opened = fsImpl.fstatSync(fd);
    if (!sameDirectoryIdentity(expected, opened)) {
      throw new Error(`freebuff setup: directory identity changed before mutation: ${resolvedTarget}`);
    }
    const stablePath = `/proc/self/fd/${fd}`;
    const viaHandle = fsImpl.statSync(stablePath);
    if (!sameDirectoryIdentity(opened, viaHandle)) {
      throw new Error(`freebuff setup: stable directory handle unavailable: ${resolvedTarget}`);
    }
    return { fd, path: stablePath, originalPath: resolvedTarget, close };
  } catch (error) {
    try { close(); } catch {}
    throw error;
  }
}

export function copyIfMissing(src, dst, executable = false, containmentRoot = null, {
  fsImpl = fs,
  sourceRoot = null,
} = {}) {
  let stable = null;
  let stableSource = null;
  let actualDst = dst;
  try {
    if (containmentRoot) {
      stable = openStableDirectory(containmentRoot, path.dirname(dst), { fsImpl });
      actualDst = path.join(stable.path, path.basename(dst));
    } else {
      fsImpl.mkdirSync(path.dirname(dst), { recursive: true });
    }
    try {
      fsImpl.lstatSync(actualDst);
      return false;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    let actualSrc = src;
    if (sourceRoot) {
      stableSource = openStableMigrationSource(sourceRoot, src, { fsImpl });
      if (!stableSource) return false;
      actualSrc = stableSource.path;
    } else {
      let sourceEntry;
      try {
        sourceEntry = fsImpl.lstatSync(src);
      } catch (error) {
        if (error?.code === 'ENOENT') return false;
        throw error;
      }
      if (sourceEntry.isSymbolicLink() || !sourceEntry.isFile()) {
        throw new Error(`freebuff setup: migration source is not a real file: ${src}`);
      }
    }
    try {
      fsImpl.copyFileSync(actualSrc, actualDst, fs.constants.COPYFILE_EXCL);
    } catch (error) {
      if (error?.code === 'EEXIST') return false;
      throw error;
    }
    if (executable) fsImpl.chmodSync(actualDst, 0o755);
    else if (dst.endsWith('.json')) {
      try { fsImpl.chmodSync(actualDst, 0o600); } catch {}
    }
    return true;
  } finally {
    try { stableSource?.close(); } catch {}
    try { stable?.close(); } catch {}
  }
}

// Legacy homes use absolute symlinks into the legacy shared dir; recreate
// them as repo-relative links into the repo-local shared dir.
export function replaceWithSymlinkAtomically(linkPath, target, { fsImpl = fs, containmentRoot = path.dirname(linkPath), stableParentPath = null } = {}) {
  const dir = path.dirname(linkPath);
  const ownedStable = stableParentPath ? null : openStableDirectory(containmentRoot, dir, { fsImpl });
  const parentPath = stableParentPath || ownedStable.path;
  const actualLinkPath = path.join(parentPath, path.basename(linkPath));
  const base = path.basename(linkPath);
  const token = `${process.pid}-${randomUUID()}`;
  const staged = path.join(parentPath, `.${base}.link-${token}`);
  const backup = path.join(parentPath, `.${base}.backup-${token}`);
  let backedUp = false;
  let published = false;
  try {
    fsImpl.symlinkSync(target, staged);
    try {
      fsImpl.lstatSync(actualLinkPath);
      fsImpl.renameSync(actualLinkPath, backup);
      backedUp = true;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    try {
      fsImpl.renameSync(staged, actualLinkPath);
      published = true;
    } catch (error) {
      if (backedUp) {
        try { fsImpl.renameSync(backup, actualLinkPath); } catch (restoreError) { error.cause = restoreError; }
      }
      throw error;
    }
    if (backedUp) {
      try { fsImpl.rmSync(backup, { recursive: true, force: true }); } catch {}
    }
    return true;
  } finally {
    if (!published) {
      try { fsImpl.rmSync(staged, { force: true }); } catch {}
    }
    if (published && backedUp) {
      try { fsImpl.rmSync(backup, { recursive: true, force: true }); } catch {}
    }
    try { ownedStable?.close(); } catch {}
  }
}

export function cleanupSymlinkBackups(linkPath, { fsImpl = fs, containmentRoot = path.dirname(linkPath), stableParentPath = null } = {}) {
  const dir = path.dirname(linkPath);
  const ownedStable = stableParentPath ? null : openStableDirectory(containmentRoot, dir, { fsImpl });
  const parentPath = stableParentPath || ownedStable.path;
  const prefix = `.${path.basename(linkPath)}.backup-`;
  try {
    let names = [];
    try { names = fsImpl.readdirSync(parentPath); } catch { return false; }
    let clean = true;
    for (const name of names) {
      if (!name.startsWith(prefix)) continue;
      try { fsImpl.rmSync(path.join(parentPath, name), { recursive: true, force: true }); }
      catch { clean = false; }
    }
    return clean;
  } finally {
    try { ownedStable?.close(); } catch {}
  }
}

export function ensureHomeLinks(homeDir, { fsImpl = fs } = {}) {
  const manicode = path.join(homeDir, '.config', 'manicode');
  const stable = openStableDirectory(homeDir, manicode, { fsImpl });
  try {
    const links = {
      'message-history.json': '../../../../shared/history/message-history.json',
      projects: '../../../../shared/history/projects',
      rg: '../../../../shared/manicode/rg',
    };
    for (const [name, target] of Object.entries(links)) {
      const linkPath = path.join(manicode, name);
      const actualLinkPath = path.join(stable.path, name);
      cleanupSymlinkBackups(linkPath, { fsImpl, containmentRoot: homeDir, stableParentPath: stable.path });
      let entry = null;
      try {
        entry = fsImpl.lstatSync(actualLinkPath);
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
      if (entry?.isSymbolicLink() && fsImpl.readlinkSync(actualLinkPath) === target) continue;
      replaceWithSymlinkAtomically(linkPath, target, { fsImpl, containmentRoot: homeDir, stableParentPath: stable.path });
    }
  } finally {
    try { stable.close(); } catch {}
  }
}

export function moveDirectoryIfMissing(src, dst, { containmentRoot = DATA_ROOT, fsImpl = fs } = {}) {
  let dstEntry = null;
  try {
    dstEntry = fsImpl.lstatSync(dst);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  if (dstEntry) return false;

  let srcEntry;
  try {
    srcEntry = fsImpl.lstatSync(src);
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
  if (srcEntry.isSymbolicLink() || !srcEntry.isDirectory()) {
    throw new Error(`freebuff setup: migration source is not a real directory: ${src}`);
  }

  const stable = openStableDirectory(containmentRoot, path.dirname(dst), { fsImpl });
  try {
    const actualDst = path.join(stable.path, path.basename(dst));
    try {
      fsImpl.lstatSync(actualDst);
      return false;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    fsImpl.renameSync(src, actualDst);
    return true;
  } finally {
    try { stable.close(); } catch {}
  }
}

export function moveIfMissing(src, dst, containmentRoot = null, { fsImpl = fs } = {}) {
  try {
    fsImpl.lstatSync(src);
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }

  if (!containmentRoot) {
    fsImpl.mkdirSync(path.dirname(dst), { recursive: true });
    try {
      fsImpl.lstatSync(dst);
      return false;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    fsImpl.renameSync(src, dst);
    return true;
  }

  const stable = openStableDirectory(containmentRoot, path.dirname(dst), { fsImpl });
  try {
    const actualDst = path.join(stable.path, path.basename(dst));
    try {
      fsImpl.lstatSync(actualDst);
      return false;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    fsImpl.renameSync(src, actualDst);
    return true;
  } finally {
    try { stable.close(); } catch {}
  }
}

export function cmpVersions(a, b) {
  const pa = a.split('.').map((part) => BigInt(part));
  const pb = b.split('.').map((part) => BigInt(part));
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  }
  return 0;
}

export function newerVersionCandidate(current, candidate) {
  return !current || cmpVersions(current.version, candidate.version) < 0 ? candidate : current;
}

export function parseEnsureSelector(raw) {
  if (typeof raw !== 'string' || !POSITIVE_INT.test(raw)) {
    throw new Error(`freebuff setup: invalid --ensure selector '${raw}'. Expected a positive integer instance number`);
  }
  return raw;
}

// Instance numbers for full setup / scans: always 1..count, union any freebuff-N
// wrappers under root and any numeric HOME dirs under the given data roots.
export function resolveNums({
  count = DEFAULT_COUNT,
  root = null,
  dataRoot = null,
  legacyRoot = null,
} = {}) {
  const limit = Number(count);
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error(`freebuff setup: invalid instance count '${count}'. Expected a positive integer`);
  }
  const nums = new Set();
  for (let i = 1; i <= limit; i += 1) nums.add(String(i));

  const absorb = (dir, pattern) => {
    if (!dir) return;
    let names = [];
    try {
      names = fs.readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      const match = pattern.exec(name);
      if (match) nums.add(match[1]);
    }
  };

  if (root) absorb(root, /^freebuff-([1-9][0-9]*)$/);
  absorb(dataRoot, /^([1-9][0-9]*)$/);
  absorb(legacyRoot, /^([1-9][0-9]*)$/);
  if (root) absorb(path.join(root, '.freebuff-homes'), /^([1-9][0-9]*)$/);

  return [...nums].sort((a, b) => Number(a) - Number(b));
}

function isSafeExistingPath(root, target) {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);
  if (!pathIsWithin(resolvedRoot, resolvedTarget)) return false;
  try {
    const rootEntry = fs.lstatSync(resolvedRoot);
    if (rootEntry.isSymbolicLink() || !rootEntry.isDirectory()) return false;
    const relative = path.relative(resolvedRoot, resolvedTarget);
    const parts = relative ? relative.split(path.sep) : [];
    let current = resolvedRoot;
    for (let i = 0; i < parts.length; i++) {
      current = path.join(current, parts[i]);
      const entry = fs.lstatSync(current);
      if (entry.isSymbolicLink()) return false;
      if (i < parts.length - 1 && !entry.isDirectory()) return false;
    }
    return true;
  } catch {
    return false;
  }
}

function realBinary(p, containmentRoot = null) {
  try {
    if (containmentRoot && !isSafeExistingPath(containmentRoot, p)) return false;
    return fs.statSync(p).isFile() && !fs.lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

function binaryVersion(bin) {
  try {
    const r = spawnSync(bin, ['--version'], { encoding: 'utf8', timeout: 30000 });
    const v = (r.stdout || '').trim().split('\n')[0].trim();
    return /^\d+\.\d+\.\d+$/.test(v) ? v : null;
  } catch {
    return null;
  }
}

export function binaryVersionCached(bin, { versionProbe = binaryVersion, cachePath = VERSION_CACHE } = {}) {
  let identity = null;
  try {
    const st = fs.statSync(bin);
    if (!st.isFile()) return null;
    identity = { size: st.size, mtimeMs: Math.round(st.mtimeMs) };
  } catch {
    return null;
  }

  let cache = {};
  try {
    const parsed = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) cache = parsed;
  } catch {}

  const hit = cache[bin];
  if (
    hit
    && hit.size === identity.size
    && hit.mtimeMs === identity.mtimeMs
    && typeof hit.version === 'string'
    && /^\d+\.\d+\.\d+$/.test(hit.version)
  ) {
    return hit.version;
  }

  const version = versionProbe(bin);
  if (!version) return null;
  try {
    const after = fs.statSync(bin);
    cache[bin] = {
      version,
      size: after.size,
      mtimeMs: Math.round(after.mtimeMs),
    };
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    const tmp = `${cachePath}.tmp-${process.pid}-${randomUUID()}`;
    fs.writeFileSync(tmp, `${JSON.stringify(cache)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, cachePath);
  } catch {}
  return version;
}

// Sidecar written after a validated shared-binary publish. Trusted over a
// fresh spawn: freebuff only updates per-HOME copies, not the shared file.
export function readSharedSidecarVersion(sidecarPath = SHARED_BIN_VERSION) {
  try {
    const v = fs.readFileSync(sidecarPath, 'utf8').trim();
    return /^\d+\.\d+\.\d+$/.test(v) ? v : null;
  } catch {
    return null;
  }
}

export function publishExecutableAtomically(src, dst, expectedVersion, { versionProbe = binaryVersion, fsImpl = fs, containmentRoot = path.dirname(dst) } = {}) {
  const dir = path.dirname(dst);
  const stable = openStableDirectory(containmentRoot, dir, { fsImpl });
  const actualDst = path.join(stable.path, path.basename(dst));
  const tmp = path.join(stable.path, `.${path.basename(dst)}.tmp-${process.pid}-${randomUUID()}`);
  try {
    fsImpl.copyFileSync(src, tmp, fs.constants.COPYFILE_EXCL);
    fsImpl.chmodSync(tmp, 0o755);
    const stagedVersion = versionProbe(tmp);
    if (expectedVersion && stagedVersion !== expectedVersion) {
      throw new Error(`freebuff setup: staged shared binary version mismatch (${stagedVersion || 'unknown'} != ${expectedVersion})`);
    }
    fsImpl.renameSync(tmp, actualDst);
    return stagedVersion;
  } finally {
    try { fsImpl.rmSync(tmp, { force: true }); } catch {}
    try { stable.close(); } catch {}
  }
}

function publishTextAtomically(dst, content, mode = 0o600, { fsImpl = fs, containmentRoot = path.dirname(dst) } = {}) {
  const dir = path.dirname(dst);
  const stable = openStableDirectory(containmentRoot, dir, { fsImpl });
  const actualDst = path.join(stable.path, path.basename(dst));
  const tmp = path.join(stable.path, `.${path.basename(dst)}.tmp-${process.pid}-${randomUUID()}`);
  try {
    fsImpl.writeFileSync(tmp, content, { flag: 'wx', mode });
    fsImpl.renameSync(tmp, actualDst);
    return true;
  } finally {
    try { fsImpl.rmSync(tmp, { force: true }); } catch {}
    try { stable.close(); } catch {}
  }
}

// Keep one shared binary copy; returns { path, version } or null when no
// usable copy exists anywhere yet (first launch then downloads for its HOME).
// rescanHomes=false (wrapper --ensure path): when a usable shared binary is
// already present, skip the cross-HOME `--version` scan entirely — that scan
// used to dominate startup (~16 spawns × ~1.5s).
export function ensureSharedBinary({ rescanHomes = true, versionProbe = binaryVersion } = {}) {
  ensureSafeDirectory(DATA_ROOT, path.dirname(SHARED_BIN));
  let sharedBest = null;
  if (realBinary(SHARED_BIN, SHARED_ROOT)) {
    const v = readSharedSidecarVersion()
      || binaryVersionCached(SHARED_BIN, { versionProbe, cachePath: VERSION_CACHE });
    if (v) {
      sharedBest = { path: SHARED_BIN, version: v };
    }
  }

  if (sharedBest && !rescanHomes) return sharedBest;

  let best = sharedBest;
  const nums = resolveNums({ count: DEFAULT_COUNT, dataRoot: DATA_ROOT, legacyRoot: LEGACY_ROOT });
  for (const base of [DATA_ROOT, LEGACY_ROOT]) {
    for (const n of nums) {
      const p = path.join(base, n, 'home', '.config', 'manicode', 'freebuff');
      if (!realBinary(p, base)) continue;
      const v = binaryVersionCached(p, { versionProbe, cachePath: VERSION_CACHE });
      if (!v) continue;
      best = newerVersionCandidate(best, { path: p, version: v });
    }
  }
  if (!best) return null;
  if (!sharedBest || best.path !== SHARED_BIN || cmpVersions(sharedBest.version, best.version) < 0) {
    try {
      if (best.path !== SHARED_BIN) {
        // Stage in the shared directory, validate the complete executable, and
        // only then atomically rename over the live path. Existing HOME links
        // therefore observe complete old-or-new bytes, never an in-place copy.
        publishExecutableAtomically(best.path, SHARED_BIN, best.version, {
          containmentRoot: SHARED_ROOT,
          versionProbe,
        });
      }
    } catch {
      return sharedBest;
    }
    try {
      publishTextAtomically(SHARED_BIN_VERSION, `${best.version}\n`, 0o600, { containmentRoot: SHARED_ROOT });
    } catch {
      // The executable itself is authoritative. A later setup can repair the
      // advisory sidecar without downgrading a successfully published binary.
    }
    return { path: SHARED_BIN, version: best.version };
  }
  return sharedBest;
}

export function ensureMetadata(dir, shared, containmentRoot = dir, { fsImpl = fs } = {}) {
  const stable = openStableDirectory(containmentRoot, dir, { fsImpl });
  const metaPath = path.join(stable.path, 'freebuff-metadata.json');
  const expectedTarget = `${process.platform}-${process.arch}`;
  try {
    let currentEntry = null;
    try {
      currentEntry = fsImpl.lstatSync(metaPath);
    } catch (error) {
      if (error?.code !== 'ENOENT') return false;
    }

    if (currentEntry?.isFile()) {
      try {
        const cur = JSON.parse(fsImpl.readFileSync(metaPath, 'utf8'));
        if (cur.version === shared.version && cur.target === expectedTarget) return false;
      } catch {}
    }

    const content = `${JSON.stringify({ version: shared.version, target: expectedTarget }, null, 2)}\n`;
    const tmp = path.join(stable.path, `.freebuff-metadata.json.tmp-${process.pid}-${randomUUID()}`);
    try {
      fsImpl.writeFileSync(tmp, content, { flag: 'wx', mode: 0o600 });
      fsImpl.renameSync(tmp, metaPath);
      return true;
    } catch {
      return false;
    } finally {
      try { fsImpl.rmSync(tmp, { force: true }); } catch {}
    }
  } finally {
    try { stable.close(); } catch {}
  }
}

// Point a HOME without its own binary at the shared copy (+ matching
// metadata so the launcher accepts it without re-downloading). Real binaries
// and their future background updates are left alone.
function linkSharedBinary(home, shared) {
  const dir = path.join(home, '.config', 'manicode');
  const stable = openStableDirectory(home, dir);
  const bin = path.join(stable.path, 'freebuff');
  let linked = false;
  try {
    try {
      const st = fs.lstatSync(bin);
      if (!st.isSymbolicLink()) return false;
      if (fs.readlinkSync(bin) !== shared.path) {
        fs.rmSync(bin, { force: true });
        fs.symlinkSync(shared.path, bin);
        linked = true;
      }
    } catch {
      try {
        fs.symlinkSync(shared.path, bin);
        linked = true;
      } catch {
        return false;
      }
    }
  } finally {
    try { stable.close(); } catch {}
  }
  const metaUpdated = ensureMetadata(dir, shared, home);
  return linked || metaUpdated;
}

function ensureShared() {
  ensureSafeDirectory(DATA_ROOT, SHARED_ROOT);
  let migrated = 0;
  const repoShared = path.join(REPO_DATA_ROOT, 'shared');
  for (const rel of SHARED_FILES) {
    const dst = path.join(SHARED_ROOT, rel);
    ensureSafeDirectory(SHARED_ROOT, path.dirname(dst));
    if (fs.existsSync(dst)) continue;
    if (moveIfMissing(path.join(repoShared, rel), dst, SHARED_ROOT)) {
      migrated++;
      continue;
    }
    const src = path.join(LEGACY_ROOT, 'shared', rel);
    if (copyIfMissing(src, dst, !rel.endsWith('.json'), SHARED_ROOT, { sourceRoot: path.join(LEGACY_ROOT, 'shared') })) migrated++;
  }
  ensureSafeDirectory(SHARED_ROOT, path.join(SHARED_ROOT, 'history', 'projects'));
  return migrated;
}

function ensureHome(n, shared) {
  const home = path.join(DATA_ROOT, n, 'home');
  const repoHome = path.join(REPO_DATA_ROOT, n, 'home');
  const legacy = path.join(LEGACY_ROOT, n, 'home');
  let migrated = 0;

  // Persistent HOME ancestors are untrusted state. Validate each directory
  // entry without following symlinks before any migration or child mutation.
  ensureSafeDirectory(DATA_ROOT, path.dirname(home));
  let homeExists = false;
  try {
    const homeEntry = fs.lstatSync(home);
    if (homeEntry.isSymbolicLink() || !homeEntry.isDirectory()) {
      throw new Error(`freebuff setup: unsafe HOME entry: ${home}`);
    }
    homeExists = true;
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }

  if (!homeExists && moveDirectoryIfMissing(repoHome, home)) {
    migrated++;
  }
  ensureSafeDirectory(DATA_ROOT, home);
  if (fs.existsSync(repoHome)) {
    for (const rel of HOME_FILES) {
      if (copyIfMissing(path.join(repoHome, rel), path.join(home, rel), false, home, { sourceRoot: repoHome })) migrated++;
    }
  }
  const sharedMigrated = ensureShared();
  for (const rel of HOME_FILES) {
    if (copyIfMissing(path.join(legacy, rel), path.join(home, rel), false, home, { sourceRoot: legacy })) migrated++;
  }
  ensureHomeLinks(home);
  if (shared && linkSharedBinary(home, shared)) migrated++;
  // Drop download residue possibly carried over by the move.
  try {
    const dir = path.join(home, '.config', 'manicode');
    const stable = openStableDirectory(home, dir);
    try {
      for (const e of fs.readdirSync(stable.path)) {
        if (e.endsWith('.part') || e === '.freebuff-download-temp') {
          fs.rmSync(path.join(stable.path, e), { recursive: true, force: true });
        }
      }
    } finally {
      stable.close();
    }
  } catch {}
  return { migrated: migrated + sharedMigrated };
}

function cleanupRepoData(nums = resolveNums({ count: DEFAULT_COUNT, dataRoot: DATA_ROOT, legacyRoot: LEGACY_ROOT })) {
  // Remove the old in-repo data root once every number has moved out and
  // no unmigrated HOME_FILES remain in REPO_DATA_ROOT.
  try {
    if (!fs.existsSync(REPO_DATA_ROOT)) return false;
    for (const n of nums) {
      if (!fs.existsSync(path.join(DATA_ROOT, n, 'home', '.config', 'manicode', 'credentials.json'))) return false;
      const repoHome = path.join(REPO_DATA_ROOT, n, 'home');
      if (fs.existsSync(repoHome)) {
        for (const rel of HOME_FILES) {
          const repoFile = path.join(repoHome, rel);
          const dstFile = path.join(DATA_ROOT, n, 'home', rel);
          if (fs.existsSync(repoFile) && !fs.existsSync(dstFile)) return false;
        }
      }
    }
    fs.rmSync(REPO_DATA_ROOT, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

function ensureLauncher() {
  const launcher = path.join(ROOT, '.tools', 'npm', 'bin', 'freebuff');
  try {
    const st = fs.statSync(launcher);
    if (st.isFile()) return false;
    fs.rmSync(launcher, { recursive: true, force: true });
  } catch {}
  fs.mkdirSync(path.join(ROOT, '.tools', 'npm'), { recursive: true });
  const r = spawnSync('npm', ['install', '-g', '--prefix', path.join(ROOT, '.tools', 'npm'), 'freebuff@latest'], {
    cwd: ROOT,
    stdio: 'inherit',
  });
  if (r.status !== 0) {
    console.error('freebuff launcher install failed');
    process.exit(r.status ?? 1);
  }
  return true;
}

export function ensureWrappers(root = ROOT, nums = null) {
  const list = nums ?? resolveNums({ count: DEFAULT_COUNT, root });
  let wrote = 0;
  for (const n of list) {
    const p = path.join(root, `freebuff-${n}`);
    const content = wrapperScript(n);
    let entry = null;
    try {
      entry = fs.lstatSync(p);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }

    let healthy = false;
    if (entry?.isFile() && !entry.isSymbolicLink()) {
      const cur = fs.readFileSync(p, 'utf8');
      healthy = cur === content && (entry.mode & 0o111) !== 0;
    }
    if (healthy) continue;

    // Never write/chmod through the existing wrapper leaf. A same-directory
    // exclusive temp file followed by rename replaces a symlink entry itself,
    // leaving any external target untouched and publishing complete bytes.
    publishTextAtomically(p, content, 0o755);
    wrote++;
  }
  return wrote;
}

function ensureMirror() {
  let wrote = 0;
  try {
    for (const rel of MIRRORED) {
      const src = path.join(ROOT, rel);
      const dst = path.join(MIRROR_ROOT, rel);
      const content = fs.readFileSync(src, 'utf8');
      try {
        const st = fs.lstatSync(dst);
        if (st.isSymbolicLink()) {
          fs.rmSync(dst, { force: true });
        } else if (st.isFile()) {
          const cur = fs.readFileSync(dst, 'utf8');
          if (cur === content) continue;
        }
      } catch {}
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      const tmp = `${dst}.tmp-${process.pid}-${Date.now()}`;
      fs.writeFileSync(tmp, content);
      fs.renameSync(tmp, dst);
      wrote++;
    }
  } catch {}
  return wrote;
}

export function parseArgs(argv = process.argv.slice(2)) {
  if (argv.length === 0) {
    return { mode: 'full' };
  }
  if (argv[0] === '--count') {
    if (argv.length === 2 && POSITIVE_INT.test(argv[1])) {
      return { mode: 'full', count: argv[1] };
    }
    const target = argv.length > 1 ? argv.slice(1).join(' ') : '<missing>';
    throw new Error(`freebuff setup: invalid --count selector '${target}'. Expected a positive integer instance count`);
  }
  if (argv[0] === '--ensure') {
    if (argv.length === 2) {
      return { mode: 'ensure', num: parseEnsureSelector(argv[1]) };
    }
    const target = argv.length > 1 ? argv.slice(1).join(' ') : '<missing>';
    throw new Error(`freebuff setup: invalid --ensure selector '${target}'. Expected a positive integer instance number`);
  }
  throw new Error(`freebuff setup: unrecognized argument(s) '${argv.join(' ')}'. Usage: freebuff-setup.mjs [--ensure N] [--count N]`);
}

export function run(argv = process.argv.slice(2)) {
  const parsed = parseArgs(argv);
  if (parsed.mode === 'ensure') {
    ensureShared();
    // Wrapper hot path: never rescan every HOME for a newer binary — sidecar +
    // probe cache keep this off the critical path (full setup still rescans).
    ensureHome(parsed.num, ensureSharedBinary({ rescanHomes: false }));
    ensureLauncher();
    ensureXdgOpenShim(ROOT);
    ensureWrappers(ROOT, [parsed.num]);
    return { mode: 'ensure', num: parsed.num };
  }

  const nums = resolveNums({
    count: parsed.count ?? DEFAULT_COUNT,
    root: ROOT,
    dataRoot: DATA_ROOT,
    legacyRoot: LEGACY_ROOT,
  });
  const shared = ensureSharedBinary({ rescanHomes: true });
  let totalMigrated = 0;
  for (const n of nums) totalMigrated += ensureHome(n, shared).migrated;
  const repoCleaned = cleanupRepoData(nums);
  const launcherInstalled = ensureLauncher();
  const xdgShim = ensureXdgOpenShim(ROOT);
  const wrappersWrote = ensureWrappers(ROOT, nums);
  const mirrored = ensureMirror();
  const summary = `freebuff setup: migrated=${totalMigrated} repo-data-removed=${repoCleaned} launcher=${launcherInstalled ? 'installed' : 'ok'} xdg-open-shim=${xdgShim ? 'wrote' : 'ok'} wrappers=${wrappersWrote} mirror=${mirrored} (re)wrote instances=${nums.length}`;
  console.log(summary);
  return {
    mode: 'full',
    migrated: totalMigrated,
    repoCleaned,
    launcherInstalled,
    wrappersWrote,
    mirrored,
    nums,
    summary,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    run();
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
