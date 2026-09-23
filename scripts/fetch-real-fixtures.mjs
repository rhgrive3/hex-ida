#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { lstat, mkdir, open, rename, rm, stat } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import path, { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const manifest = JSON.parse(await (await import('node:fs/promises')).readFile(join(root, 'tests/fixtures/real-binaries.json'), 'utf8'));
const testsRoot = join(root, 'tests');
const outputDir = join(testsRoot, '.real-fixtures');
const args = process.argv.slice(2);
const checkOnly = args.includes('--check');
const requested = args.filter((arg) => arg !== '--check');
export const DEFAULT_FIXTURE_DOWNLOAD_TIMEOUT_MS = 120_000;

export class FixtureDownloadTimeoutError extends Error {
  constructor(name, timeoutMs) {
    super(`${name}: fixture download timed out after ${timeoutMs}ms`);
    this.name = 'FixtureDownloadTimeoutError';
  }
}

function createDownloadDeadline(name, timeoutMs) {
  const ms = Number(timeoutMs);
  if (!Number.isFinite(ms) || ms <= 0) throw new TypeError('fixture download timeout must be a positive finite number');
  const controller = new AbortController();
  const reason = new FixtureDownloadTimeoutError(name, ms);
  const timer = setTimeout(() => controller.abort(reason), ms);
  return Object.freeze({
    controller,
    reason,
    clear() { clearTimeout(timer); },
  });
}

function abortReason(signal, fallback) {
  if (signal?.aborted && signal.reason instanceof FixtureDownloadTimeoutError) return signal.reason;
  return fallback;
}

function raceWithAbort(value, signal) {
  if (!signal) return Promise.resolve(value);
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(value).then(
      (result) => {
        signal.removeEventListener('abort', onAbort);
        resolve(result);
      },
      (error) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

function pathIsWithin(rootPath, targetPath) {
  const relative = path.relative(rootPath, targetPath);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

export async function ensureFixtureCacheDirectory(cacheDir = outputDir, {
  containmentRoot = testsRoot,
  create = false,
  lstatImpl = lstat,
  mkdirImpl = mkdir,
} = {}) {
  const base = path.resolve(containmentRoot);
  const target = path.resolve(cacheDir);
  if (!pathIsWithin(base, target) || target === base) {
    throw new Error('fixture cache must be a child directory of the repository tests tree');
  }

  const baseEntry = await lstatImpl(base);
  if (baseEntry.isSymbolicLink() || !baseEntry.isDirectory()) {
    throw new Error('fixture cache containment root must be a real directory');
  }

  const parts = path.relative(base, target).split(path.sep).filter(Boolean);
  let current = base;
  for (const part of parts) {
    current = path.join(current, part);
    let entry;
    try {
      entry = await lstatImpl(current);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      if (!create) return false;
      try {
        await mkdirImpl(current, { mode: 0o700 });
      } catch (mkdirError) {
        if (mkdirError?.code !== 'EEXIST') throw mkdirError;
      }
      entry = await lstatImpl(current);
    }
    if (entry.isSymbolicLink() || !entry.isDirectory()) {
      throw new Error(`fixture cache path component is not a real directory: ${current}`);
    }
  }
  return true;
}

function directoryIdentity(entry) {
  return Object.freeze({ dev:String(entry.dev), ino:String(entry.ino) });
}

function sameDirectoryIdentity(entry, expected) {
  return !entry.isSymbolicLink() && entry.isDirectory()
    && String(entry.dev) === expected.dev && String(entry.ino) === expected.ino;
}

export async function captureFixtureCacheDirectoryIdentity(cacheDir = outputDir, {
  containmentRoot = testsRoot,
  lstatImpl = lstat,
} = {}) {
  const base = path.resolve(containmentRoot);
  const target = path.resolve(cacheDir);
  if (!pathIsWithin(base, target) || target === base) {
    throw new Error('fixture cache must be a child directory of the repository tests tree');
  }
  const componentPaths = [base];
  let current = base;
  for (const part of path.relative(base, target).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    componentPaths.push(current);
  }
  const components = [];
  for (const componentPath of componentPaths) {
    const entry = await lstatImpl(componentPath);
    if (entry.isSymbolicLink() || !entry.isDirectory()) {
      throw new Error(`fixture cache path component is not a real directory: ${componentPath}`);
    }
    components.push(Object.freeze({ path:componentPath, ...directoryIdentity(entry) }));
  }
  return Object.freeze({ base, target, components:Object.freeze(components) });
}

export async function assertFixtureCacheDirectoryIdentity(snapshot, { lstatImpl = lstat } = {}) {
  for (const expected of snapshot.components) {
    let entry;
    try {
      entry = await lstatImpl(expected.path);
    } catch (error) {
      const changed = new Error(`fixture cache directory identity changed: ${expected.path}`);
      changed.code = 'FIXTURE_CACHE_IDENTITY_CHANGED';
      changed.cause = error;
      throw changed;
    }
    if (!sameDirectoryIdentity(entry, expected)) {
      const changed = new Error(`fixture cache directory identity changed: ${expected.path}`);
      changed.code = 'FIXTURE_CACHE_IDENTITY_CHANGED';
      throw changed;
    }
  }
  return true;
}

export function fixture(name) {
  const spec = manifest.fixtures[name];
  if (!spec) throw new Error(`unknown fixture: ${name}`);
  return spec;
}

export function selectedFixtureNames() {
  // `all` widens the selected set, but it must not erase explicit selectors.
  // Validate every explicit fixture name first so `all typo` cannot silently
  // turn a misspelled targeted command into a successful all-fixture run (#9143).
  for (const name of requested) {
    if (name !== 'all') fixture(name);
  }
  return requested.length && !requested.includes('all') ? requested : Object.keys(manifest.fixtures);
}

export async function digestFile(path) {
  const hash = createHash('sha256');
  let size = 0;
  for await (const chunk of fs.createReadStream(path)) {
    size += chunk.length;
    hash.update(chunk);
  }
  return { size, sha256: hash.digest('hex') };
}

export async function digestFixtureHandle(handle) {
  const hash = createHash('sha256');
  let size = 0;
  const stream = handle.createReadStream({ autoClose: false });
  for await (const chunk of stream) {
    size += chunk.length;
    hash.update(chunk);
  }
  return { size, sha256: hash.digest('hex') };
}

function sameFileIdentity(left, right) {
  return String(left?.dev) === String(right?.dev)
    && String(left?.ino) === String(right?.ino);
}

class FixtureVerificationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'FixtureVerificationError';
    this.repairable = true;
  }
}

function invalidFixture(message) {
  return new FixtureVerificationError(message);
}

export async function verify(name, path, spec, {
  statImpl = lstat,
  openImpl = open,
  digestHandleImpl = digestFixtureHandle,
} = {}) {
  let info;
  try {
    // Verification owns the cache directory entry, not merely whichever target
    // pathname resolution reaches. lstat rejects a symlink leaf before hashing.
    info = await statImpl(path);
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') {
      throw invalidFixture(`${name}: fixture is missing at ${path}`);
    }
    throw error;
  }
  if (info.isSymbolicLink?.()) throw invalidFixture(`${name}: fixture path must not be a symbolic link`);
  if (!info.isFile()) throw invalidFixture(`${name}: fixture path is not a file`);
  if (info.size !== spec.size) throw invalidFixture(`${name}: size mismatch (${info.size} != ${spec.size})`);

  const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0);
  let handle;
  try {
    handle = await openImpl(path, flags);
  } catch (error) {
    if (error?.code === 'ELOOP' || error?.code === 'ENOENT' || error?.code === 'ENOTDIR') {
      throw invalidFixture(`${name}: fixture identity changed before hashing`);
    }
    throw error;
  }

  let digest = null;
  let primaryError = null;
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || !sameFileIdentity(info, opened) || opened.size !== info.size) {
      throw invalidFixture(`${name}: fixture identity changed before hashing`);
    }
    digest = await digestHandleImpl(handle);
    if (digest.size !== spec.size) throw invalidFixture(`${name}: size mismatch (${digest.size} != ${spec.size})`);
    if (digest.sha256 !== spec.sha256) throw invalidFixture(`${name}: SHA-256 mismatch`);

    let current;
    try {
      current = await statImpl(path);
    } catch (error) {
      if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') {
        throw invalidFixture(`${name}: fixture identity changed during hashing`);
      }
      throw error;
    }
    if (current.isSymbolicLink?.() || !current.isFile() || !sameFileIdentity(opened, current)) {
      throw invalidFixture(`${name}: fixture identity changed during hashing`);
    }
  } catch (error) {
    primaryError = error;
  }

  let closeError = null;
  try {
    await handle.close();
  } catch (error) {
    closeError = error;
  }

  if (primaryError) {
    if (closeError) {
      primaryError.cleanupError = closeError;
      if (primaryError.cause == null) primaryError.cause = closeError;
    }
    throw primaryError;
  }
  if (closeError) throw closeError;
  return digest;
}

export async function releaseBody(response) {
  try {
    if (typeof response?.body?.cancel === 'function') {
      await response.body.cancel();
    } else if (typeof response?.body?.destroy === 'function') {
      response.body.destroy();
    }
  } catch {}
}

export async function fetchWithHttpsRedirects(initialUrl, maxRedirects = 10, {
  fetchImpl = globalThis.fetch,
  signal = null,
  timeoutMs = DEFAULT_FIXTURE_DOWNLOAD_TIMEOUT_MS,
} = {}) {
  const ownedDeadline = signal ? null : createDownloadDeadline('fixture request', timeoutMs);
  const activeSignal = signal || ownedDeadline.controller.signal;
  let currentUrl = initialUrl;
  let redirects = 0;
  try {
    while (true) {
      if (!/^https:\/\//i.test(currentUrl)) {
        throw new Error(`Insecure redirect URL or downgrade forbidden: ${currentUrl}`);
      }
      const response = await raceWithAbort(
        fetchImpl(currentUrl, { redirect: 'manual', signal: activeSignal }),
        activeSignal,
      );
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        redirects++;
        if (redirects > maxRedirects) {
          await raceWithAbort(releaseBody(response), activeSignal);
          throw new Error('Too many HTTP redirects');
        }
        const location = response.headers?.get?.('location') ?? response.headers?.location;
        if (!location) {
          await raceWithAbort(releaseBody(response), activeSignal);
          throw new Error('Redirect missing Location header');
        }
        try {
          currentUrl = new URL(location, currentUrl).href;
        } catch (err) {
          await raceWithAbort(releaseBody(response), activeSignal);
          throw err;
        }
        await raceWithAbort(releaseBody(response), activeSignal);
        continue;
      }
      return response;
    }
  } catch (error) {
    throw abortReason(activeSignal, error);
  } finally {
    ownedDeadline?.clear();
  }
}

export async function publishFixtureFile(temp, target, {
  renameImpl = rename,
  lstatImpl = lstat,
  rmImpl = rm,
  platform = process.platform,
  randomUUIDImpl = randomUUID,
  onCleanupError = (error, details) => console.warn(`${details.target}: published replacement but could not remove backup: ${error?.message || error}`),
  directoryIdentitySnapshot = null,
  assertDirectoryIdentityImpl = assertFixtureCacheDirectoryIdentity,
  expectedSourceIdentity = null,
} = {}) {
  // Pre-publication guard: the cache directory and the validated source leaf
  // must both still be the admitted objects before `temp` is consumed.
  const guardDirectory = async () => {
    if (directoryIdentitySnapshot) await assertDirectoryIdentityImpl(directoryIdentitySnapshot);
  };
  const guardSource = async () => {
    await guardDirectory();
    if (expectedSourceIdentity) {
      let tempEntry;
      try {
        tempEntry = await lstatImpl(temp);
      } catch (error) {
        const changed = new Error(`fixture source identity changed before publication: ${temp}`);
        changed.code = 'FIXTURE_SOURCE_IDENTITY_CHANGED';
        changed.cause = error;
        throw changed;
      }
      if (tempEntry.isSymbolicLink() || !tempEntry.isFile() || !sameFileIdentity(tempEntry, expectedSourceIdentity)) {
        const changed = new Error(`fixture source identity changed before publication: ${temp}`);
        changed.code = 'FIXTURE_SOURCE_IDENTITY_CHANGED';
        throw changed;
      }
    }
  };
  // Post-publication / recovery guard: `temp` has been consumed (or is not
  // being published), so only the directory and the backup object we created
  // remain meaningful invariants.
  const guardBackup = async (backup, backupIdentity) => {
    await guardDirectory();
    const backupEntry = await lstatImpl(backup);
    if (backupEntry.isSymbolicLink() || !backupEntry.isFile() || !sameFileIdentity(backupEntry, backupIdentity)) {
      const changed = new Error(`fixture replacement backup identity changed: ${backup}`);
      changed.code = 'FIXTURE_BACKUP_IDENTITY_CHANGED';
      throw changed;
    }
  };
  try {
    await guardSource();
    await renameImpl(temp, target);
    return;
  } catch (error) {
    const code = error?.code;
    const mayBeDestinationConflict = code === 'EEXIST' || (platform === 'win32' && code === 'EPERM');
    if (!mayBeDestinationConflict) throw error;

    let targetEntry;
    try {
      await guardSource();
      targetEntry = await lstatImpl(target);
    } catch (statError) {
      if (statError?.code === 'ENOENT') throw error;
      throw statError;
    }
    if (targetEntry.isSymbolicLink() || !targetEntry.isFile()) throw error;

    const backup = `${target}.replace-backup-${process.pid}-${randomUUIDImpl()}`;
    await guardSource();
    await renameImpl(target, backup);
    try {
      await guardSource();
      await renameImpl(temp, target);
    } catch (replacementError) {
      try {
        await guardBackup(backup, targetEntry);
        await renameImpl(backup, target);
      } catch (restoreError) {
        throw new AggregateError([replacementError, restoreError], `fixture replacement recovery required: ${target}`);
      }
      throw replacementError;
    }

    try {
      await guardBackup(backup, targetEntry);
      await rmImpl(backup, { force: true });
    } catch (cleanupError) {
      onCleanupError?.(cleanupError, { backup, target });
    }
  }
}

export async function fetchFixture(name, spec, {
  verifyImpl = verify,
  fetchImpl = fetchWithHttpsRedirects,
  timeoutMs = DEFAULT_FIXTURE_DOWNLOAD_TIMEOUT_MS,
  outputDirPath = outputDir,
  cacheContainmentRoot = testsRoot,
  ensureCacheDirImpl = ensureFixtureCacheDirectory,
  publishImpl = publishFixtureFile,
  captureCacheIdentityImpl = captureFixtureCacheDirectoryIdentity,
  assertCacheIdentityImpl = assertFixtureCacheDirectoryIdentity,
} = {}) {
  const target = join(outputDirPath, spec.file);
  await ensureCacheDirImpl(outputDirPath, { containmentRoot: cacheContainmentRoot, create: false });
  try {
    await verifyImpl(name, target, spec);
    console.log(`${name}: verified existing fixture`);
    return;
  } catch (error) {
    if (checkOnly || error?.repairable !== true) throw error;
  }

  const url = process.env[spec.urlEnv];
  if (!url) throw new Error(`${name}: set ${spec.urlEnv} to the fixture download URL`);
  if (!/^https:\/\//i.test(url)) throw new Error(`${name}: fixture URL must use HTTPS`);

  await ensureCacheDirImpl(outputDirPath, { containmentRoot: cacheContainmentRoot, create: true });
  const cacheIdentity = await captureCacheIdentityImpl(outputDirPath, { containmentRoot: cacheContainmentRoot });
  const temp = `${target}.partial-${process.pid}-${randomUUID()}`;
  const deadline = createDownloadDeadline(name, timeoutMs);
  const { signal } = deadline.controller;
  let response = null;
  let output = null;
  let streamError = null;
  let tempIdentity = null;

  try {
    response = await raceWithAbort(
      fetchImpl(url, 10, { signal, timeoutMs }),
      signal,
    );
    if (!response.ok || !response.body) {
      await raceWithAbort(releaseBody(response), signal);
      const status = response.status;
      response = null;
      throw new Error(`${name}: download failed with HTTP ${status}`);
    }

    const hash = createHash('sha256');
    await ensureCacheDirImpl(outputDirPath, { containmentRoot: cacheContainmentRoot, create: false });
    await assertCacheIdentityImpl(cacheIdentity);
    output = fs.createWriteStream(temp, { flags:'wx', mode:0o600 });
    output.on('error', (err) => { streamError = streamError || err; });
    output.once('open', (fd) => {
      try {
        const openedStat = fs.fstatSync(fd);
        tempIdentity = Object.freeze({ dev: String(openedStat.dev), ino: String(openedStat.ino) });
      } catch (e) {
        streamError = streamError || e;
      }
    });
    let size = 0;
    async function* validateAndHash(source) {
      for await (const chunk of source) {
        const bytes = Buffer.from(chunk);
        size += bytes.length;
        if (size > spec.size) throw new Error(`${name}: download exceeded pinned size`);
        hash.update(bytes);
        yield bytes;
      }
    }
    await raceWithAbort(pipeline(validateAndHash(response.body), output, { signal }), signal);
    const sha256 = hash.digest('hex');
    if (size !== spec.size) throw new Error(`${name}: size mismatch (${size} != ${spec.size})`);
    if (sha256 !== spec.sha256) throw new Error(`${name}: SHA-256 mismatch`);
    if (!tempIdentity) {
      const tempStat = await lstat(temp);
      if (tempStat.isSymbolicLink() || !tempStat.isFile()) throw new Error(`${name}: temporary fixture is not a regular file`);
      tempIdentity = Object.freeze({ dev: String(tempStat.dev), ino: String(tempStat.ino) });
    }
    try {
      await verifyImpl(name, target, spec);
      await assertCacheIdentityImpl(cacheIdentity);
      const preCleanupStat = await lstat(temp);
      if (sameFileIdentity(preCleanupStat, tempIdentity)) {
        await rm(temp, { force: true });
      }
      console.log(`${name}: downloaded and verified`);
      return;
    } catch (error) {
      if (error?.repairable !== true) throw error;
    }
    await ensureCacheDirImpl(outputDirPath, { containmentRoot: cacheContainmentRoot, create: false });
    await assertCacheIdentityImpl(cacheIdentity);
    await publishImpl(temp, target, {
      directoryIdentitySnapshot:cacheIdentity,
      assertDirectoryIdentityImpl:assertCacheIdentityImpl,
      expectedSourceIdentity:tempIdentity,
    });
    console.log(`${name}: downloaded and verified`);
  } catch (error) {
    if (output && !output.closed) {
      const outputClosed = new Promise((resolve) => output.once('close', resolve));
      output.destroy();
      await outputClosed;
    } else {
      output?.destroy();
    }
    if (signal.aborted && response?.body) {
      // pipeline abort normally destroys the body; this is a best-effort final
      // release for custom response bodies without waiting beyond the deadline.
      try { response.body.destroy?.(); } catch {}
      try { void response.body.cancel?.(); } catch {}
    }
    try {
      await assertCacheIdentityImpl(cacheIdentity);
      if (tempIdentity) {
        const cleanupStat = await lstat(temp);
        if (sameFileIdentity(cleanupStat, tempIdentity)) {
          await rm(temp, { force:true });
        }
      } else {
        await rm(temp, { force:true });
      }
    } catch (identityError) {
      if (identityError?.code !== 'FIXTURE_CACHE_IDENTITY_CHANGED' && identityError?.code !== 'ENOENT') throw identityError;
    }
    throw abortReason(signal, error || streamError);
  } finally {
    deadline.clear();
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    for (const name of selectedFixtureNames()) await fetchFixture(name, fixture(name));
  } catch (error) {
    console.error(error && error.message ? error.message : String(error));
    process.exitCode = 1;
  }
}
