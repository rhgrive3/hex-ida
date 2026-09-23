import { constants as fsConstants } from 'node:fs';
import { open, realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';

function pathIsWithin(rootPath, targetPath) {
  const rel = relative(rootPath, targetPath);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
}

function sameFileIdentity(left, right) {
  return left && right
    && left.dev != null && left.ino != null
    && right.dev != null && right.ino != null
    && String(left.dev) === String(right.dev)
    && String(left.ino) === String(right.ino);
}

export async function resolveRepositorySource(path, {
  rootDir,
  normalizePath = (value) => String(value),
  realpathImpl = realpath,
  statImpl = stat,
  sourceLabel = 'Repository source',
} = {}) {
  if (!rootDir) throw new TypeError('rootDir is required');
  const normalized = normalizePath(path);
  const lexical = resolve(rootDir, normalized);
  const [realRoot, realSource] = await Promise.all([realpathImpl(rootDir), realpathImpl(lexical)]);
  if (!pathIsWithin(realRoot, realSource)) {
    throw new Error(`${sourceLabel} escapes repository: ${normalized}`);
  }
  const sourceStat = await statImpl(realSource);
  if (!sourceStat.isFile()) throw new Error(`${sourceLabel} is not a regular file: ${normalized}`);
  return { normalized, realSource, sourceStat };
}

export async function readResolvedRepositorySource({ normalized, realSource, sourceStat }, {
  openImpl = open,
  readHandleImpl = null,
  encoding = null,
  sourceLabel = 'Repository source',
} = {}) {
  const flags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0);
  let handle;
  try {
    handle = await openImpl(realSource, flags);
  } catch (error) {
    throw new Error(`${sourceLabel} identity could not be established: ${normalized}`, { cause: error });
  }
  try {
    const openedStat = await handle.stat();
    if (!openedStat.isFile() || !sameFileIdentity(sourceStat, openedStat)) {
      throw new Error(`${sourceLabel} identity changed before read: ${normalized}`);
    }
    if (readHandleImpl) return await readHandleImpl(handle, normalized);
    return encoding == null ? await handle.readFile() : await handle.readFile({ encoding });
  } finally {
    await handle.close();
  }
}

export async function readStableRepositoryFile(path, options = {}) {
  const resolved = await resolveRepositorySource(path, options);
  return readResolvedRepositorySource(resolved, options);
}
