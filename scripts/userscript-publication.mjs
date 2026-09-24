import * as fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

function pathIsWithin(root, target) {
  const rel = relative(resolve(root), resolve(target));
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
}

function entryIdentity(entry) {
  return Object.freeze({ dev:String(entry.dev), ino:String(entry.ino) });
}

function sameEntryIdentity(entry, expected, { directory = false } = {}) {
  if (entry.isSymbolicLink()) return false;
  if (directory ? !entry.isDirectory() : !entry.isFile()) return false;
  return String(entry.dev) === expected.dev && String(entry.ino) === expected.ino;
}

async function pathEntryIdentity(file, io) {
  const entry = await io.lstat(file);
  if (entry.isSymbolicLink() || !entry.isFile()) return null;
  return entryIdentity(entry);
}

async function unlinkIfSame(file, expected, io) {
  if (!expected) return false;
  try {
    const entry = await io.lstat(file);
    if (!sameEntryIdentity(entry, expected)) return false;
    await io.unlink(file);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return true;
    throw error;
  }
}

export async function assertSafePublicationDirectory(directory, { io = fs, containmentRoot = directory } = {}) {
  const base = resolve(containmentRoot);
  const target = resolve(directory);
  if (!pathIsWithin(base, target)) throw new Error(`userscript-publication-outside-root:${target}`);

  const componentPaths = [base];
  const rel = relative(base, target);
  let current = base;
  for (const part of rel ? rel.split(sep) : []) {
    current = resolve(current, part);
    componentPaths.push(current);
  }

  const components = [];
  for (const componentPath of componentPaths) {
    const entry = await io.lstat(componentPath);
    if (entry.isSymbolicLink() || !entry.isDirectory()) {
      throw new Error(`userscript-publication-unsafe-directory:${componentPath}`);
    }
    components.push(Object.freeze({ path:componentPath, ...entryIdentity(entry) }));
  }
  return Object.freeze({ base, target, components:Object.freeze(components) });
}

export async function assertPublicationDirectoryIdentity(snapshot, { io = fs } = {}) {
  for (const expected of snapshot.components) {
    let entry;
    try {
      entry = await io.lstat(expected.path);
    } catch (error) {
      const changed = new Error(`userscript-publication-directory-changed:${expected.path}`);
      changed.code = 'USERSCRIPT_PUBLICATION_DIRECTORY_CHANGED';
      changed.cause = error;
      throw changed;
    }
    if (!sameEntryIdentity(entry, expected, { directory:true })) {
      const changed = new Error(`userscript-publication-directory-changed:${expected.path}`);
      changed.code = 'USERSCRIPT_PUBLICATION_DIRECTORY_CHANGED';
      throw changed;
    }
  }
  return true;
}

async function stageFile(file, content, io, guard = async () => {}) {
  const temporary = `${file}.${randomUUID()}.stage`;
  const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content);
  let handle;
  let temporaryIdentity = null;
  try {
    await guard();
    handle = await io.open(temporary, 'wx');
    temporaryIdentity = handle.stat ? entryIdentity(await handle.stat()) : await pathEntryIdentity(temporary, io);
    await guard();
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close(); handle = null;
    await guard();
    if (!(await io.readFile(temporary)).equals(bytes)) throw new Error(`userscript-publication-readback:${file}`);
    await guard();
    return { path:temporary, identity:temporaryIdentity };
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    if (temporaryIdentity) await unlinkIfSame(temporary, temporaryIdentity, io).catch(() => {});
    throw error;
  }
}

async function syncDirectory(directory, io, guard = async () => {}) {
  await guard();
  const handle = await io.open(directory, 'r');
  try {
    await guard();
    await handle.sync();
  } finally { await handle.close(); }
}

async function assertRegularPublicationInput(file, expected, io, guard = async () => {}) {
  await guard();
  const stat = await io.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`userscript-publication-non-regular-input:${file}`);
  await guard();
  if (!(await io.readFile(file)).equals(expected)) throw new Error(`userscript-publication-stale-input:${file}`);
  await guard();
}

async function assertStageIdentity(stagePath, expectedIdentity, io, guard = async () => {}) {
  await guard();
  const stat = await io.lstat(stagePath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`userscript-publication-non-regular-stage:${stagePath}`);
  const currentIdentity = entryIdentity(stat);
  if (!currentIdentity || String(currentIdentity.dev) !== String(expectedIdentity.dev) || String(currentIdentity.ino) !== String(expectedIdentity.ino)) {
    throw new Error(`userscript-publication-stage-identity-changed:${stagePath}`);
  }
  await guard();
}

async function assertBackupIdentity(backupPath, expectedIdentity, io, guard = async () => {}) {
  await guard();
  let stat;
  try {
    stat = await io.lstat(backupPath);
  } catch (cause) {
    const error = new Error(`userscript-publication-backup-identity-changed:${backupPath}`, { cause });
    error.code = 'USERSCRIPT_PUBLICATION_BACKUP_CHANGED';
    throw error;
  }
  if (!expectedIdentity || !sameEntryIdentity(stat, expectedIdentity)) {
    const error = new Error(`userscript-publication-backup-identity-changed:${backupPath}`);
    error.code = 'USERSCRIPT_PUBLICATION_BACKUP_CHANGED';
    throw error;
  }
  await guard();
}

// Never truncate an existing generated file before the replacement has been
// written, synced and read back. A directory-sync failure still fails the build.
export async function writeFileVerified(file, content, { io = fs, containmentRoot } = {}) {
  if (!containmentRoot) throw new TypeError('userscript-publication-containment-root-required');
  const directory = dirname(resolve(file));
  const directoryIdentity = await assertSafePublicationDirectory(directory, { io, containmentRoot });
  const guard = () => assertPublicationDirectoryIdentity(directoryIdentity, { io });
  const staged = await stageFile(file, content, io, guard);
  try {
    await guard();
    await assertStageIdentity(staged.path, staged.identity, io, guard);
    await io.rename(staged.path, file);
    await guard();
    await syncDirectory(directory, io, guard);
  } finally { await unlinkIfSame(staged.path, staged.identity, io).catch(() => {}); }
}

// Error-rollback publication for the committed loader/release pair. This is
// NOT a crash-atomic multi-file filesystem transaction. A killed publisher
// leaves its lock/backups for inspection; subsequent publication fails closed.
export async function publishUserscriptFiles(entries, { io = fs, containmentRoot = null } = {}) {
  if (!Array.isArray(entries) || entries.length !== 2) throw new Error('userscript-publication-pair-required');
  const paths = entries.map(entry => resolve(entry.path));
  const directory = dirname(paths[0]);
  if (new Set(paths).size !== 2 || paths.some(file => dirname(file) !== directory)
      || entries.some(entry => !Buffer.isBuffer(entry.expected))) throw new Error('userscript-publication-identity-required');

  const directoryIdentity = await assertSafePublicationDirectory(directory, { io, containmentRoot: containmentRoot ?? directory });
  const guard = () => assertPublicationDirectoryIdentity(directoryIdentity, { io });
  const lockPath = resolve(directory, '.userscript-publication.lock');
  let lock = null;
  let lockIdentity = null;
  const records = [];
  let retainRecovery = false;
  let primaryError = null;
  try {
    await guard();
    lock = await io.open(lockPath, 'wx');
    lockIdentity = lock.stat ? entryIdentity(await lock.stat()) : await pathEntryIdentity(lockPath, io);
    await guard();

    for (const [index, entry] of entries.entries()) {
      await assertRegularPublicationInput(paths[index], entry.expected, io, guard);
    }

    for (const [index, entry] of entries.entries()) {
      const file = paths[index];
      const record = {
        file,
        backup:`${file}.${randomUUID()}.backup`,
        backupIdentity:null,
        temporary:null,
        temporaryIdentity:null,
        backedUp:false,
        published:false,
      };
      records.push(record);
      const staged = await stageFile(file, entry.content, io, guard);
      record.temporary = staged.path;
      record.temporaryIdentity = staged.identity;
      await guard();
      await io.link(file, record.backup);
      // The filesystem mutation has happened. Record that fact before the
      // fallible identity lookup so cleanup can never mistake an existing
      // operation-owned backup for "no backup". If identity capture fails,
      // finalization retains the recovery lock rather than unlinking blindly.
      record.backedUp = true;
      record.backupIdentity = await pathEntryIdentity(record.backup, io);
      await guard();
    }
    await syncDirectory(directory, io, guard);

    for (const [index, record] of records.entries()) {
      await assertRegularPublicationInput(record.file, entries[index].expected, io, guard);
      await guard();
      await assertStageIdentity(record.temporary, record.temporaryIdentity, io, guard);
      await io.rename(record.temporary, record.file);
      record.temporary = null;
      record.temporaryIdentity = null;
      record.published = true;
      await guard();
    }
    await syncDirectory(directory, io, guard);
  } catch (error) {
    const rollbackErrors = [];
    for (const record of [...records].reverse()) if (record.published) {
      try {
        await assertBackupIdentity(record.backup, record.backupIdentity, io, guard);
        await io.rename(record.backup, record.file);
        record.backedUp = false;
        record.backupIdentity = null;
        await guard();
      } catch (rollbackError) { rollbackErrors.push(rollbackError); }
    }
    if (records.some(record => record.published)) {
      try { await syncDirectory(directory, io, guard); } catch (rollbackError) { rollbackErrors.push(rollbackError); }
    }
    if (rollbackErrors.length) {
      retainRecovery = true;
      primaryError = new AggregateError([error, ...rollbackErrors], `userscript-publication-recovery-required:${lockPath}`);
    } else primaryError = error;
  } finally {
    const cleanupErrors = [];
    const cleanup = async (operation) => {
      try { await operation(); return true; }
      catch (error) { cleanupErrors.push(error); return false; }
    };

    if (lock) {
      const lockClosed = await cleanup(() => lock.close());
      if (!lockClosed) retainRecovery = true;
    }
    if (!retainRecovery) {
      let artifactsClean = true;
      for (const record of records) {
        if (record.temporary && !(await cleanup(async () => {
          const removed = await unlinkIfSame(record.temporary, record.temporaryIdentity, io);
          if (!removed) throw Object.assign(new Error(`userscript-publication-cleanup-identity-mismatch:${record.temporary}`), { code:'USERSCRIPT_PUBLICATION_DIRECTORY_CHANGED' });
        }))) artifactsClean = false;
        if (record.backedUp && !(await cleanup(async () => {
          const removed = await unlinkIfSame(record.backup, record.backupIdentity, io);
          if (!removed) throw Object.assign(new Error(`userscript-publication-cleanup-identity-mismatch:${record.backup}`), { code:'USERSCRIPT_PUBLICATION_DIRECTORY_CHANGED' });
        }))) artifactsClean = false;
      }
      if (!artifactsClean) retainRecovery = true;
      if (!retainRecovery && lockIdentity) {
        const removed = await cleanup(async () => {
          const didRemove = await unlinkIfSame(lockPath, lockIdentity, io);
          if (!didRemove) throw Object.assign(new Error(`userscript-publication-cleanup-identity-mismatch:${lockPath}`), { code:'USERSCRIPT_PUBLICATION_DIRECTORY_CHANGED' });
        });
        if (!removed) retainRecovery = true;
      }
    }

    if (primaryError && cleanupErrors.length) {
      throw new AggregateError([primaryError, ...cleanupErrors], `userscript-publication-cleanup-failed:${lockPath}`);
    }
    if (primaryError) throw primaryError;
    if (cleanupErrors.length === 1) throw cleanupErrors[0];
    if (cleanupErrors.length > 1) throw new AggregateError(cleanupErrors, `userscript-publication-cleanup-failed:${lockPath}`);
  }
}
