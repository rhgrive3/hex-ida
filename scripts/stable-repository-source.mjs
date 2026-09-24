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

function sameFileMetadata(left, right) {
  if (!sameFileIdentity(left, right)) return false;
  if (left.size != null && right.size != null && String(left.size) !== String(right.size)) {
    return false;
  }
  if (left.mtimeNs != null && right.mtimeNs != null) {
    if (String(left.mtimeNs) !== String(right.mtimeNs)) return false;
  } else if (left.mtimeMs != null && right.mtimeMs != null) {
    if (Number(left.mtimeMs) !== Number(right.mtimeMs)) return false;
  }
  if (left.ctimeNs != null && right.ctimeNs != null) {
    if (String(left.ctimeNs) !== String(right.ctimeNs)) return false;
  } else if (left.ctimeMs != null && right.ctimeMs != null) {
    if (Number(left.ctimeMs) !== Number(right.ctimeMs)) return false;
  }
  return true;
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

async function statHandle(handle) {
  try {
    return await handle.stat({ bigint: true });
  } catch {
    return await handle.stat();
  }
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
  let primaryError = null;
  try {
    const openedStat = await statHandle(handle);
    if (!openedStat.isFile() || !sameFileIdentity(sourceStat, openedStat)) {
      throw new Error(`${sourceLabel} identity changed before read: ${normalized}`);
    }
    const result = readHandleImpl
      ? await readHandleImpl(handle, normalized)
      : (encoding == null ? await handle.readFile() : await handle.readFile({ encoding }));
    const finalStat = await statHandle(handle);
    if (!finalStat.isFile() || !sameFileMetadata(openedStat, finalStat)) {
      throw new Error(`${sourceLabel} changed during read: ${normalized}`);
    }
    return result;
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    try {
      await handle.close();
    } catch (closeError) {
      if (primaryError === null) throw closeError;
    }
  }
}

export async function readStableRepositoryFile(path, options = {}) {
  const resolved = await resolveRepositorySource(path, options);
  return readResolvedRepositorySource(resolved, options);
}
