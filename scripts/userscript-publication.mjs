import * as fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

function pathIsWithin(root, target) {
  const rel = relative(resolve(root), resolve(target));
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
}

export async function assertSafePublicationDirectory(directory, { io = fs, containmentRoot = directory } = {}) {
  const base = resolve(containmentRoot);
  const target = resolve(directory);
  if (!pathIsWithin(base, target)) throw new Error(`userscript-publication-outside-root:${target}`);

  const rootEntry = await io.lstat(base);
  if (rootEntry.isSymbolicLink() || !rootEntry.isDirectory()) {
    throw new Error(`userscript-publication-unsafe-directory:${base}`);
  }

  const rel = relative(base, target);
  let current = base;
  for (const part of rel ? rel.split(sep) : []) {
    current = resolve(current, part);
    const entry = await io.lstat(current);
    if (entry.isSymbolicLink() || !entry.isDirectory()) {
      throw new Error(`userscript-publication-unsafe-directory:${current}`);
    }
  }
  return true;
}

async function stageFile(file, content, io) {
  const temporary = `${file}.${randomUUID()}.stage`;
  const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content);
  let handle;
  try {
    handle = await io.open(temporary, 'wx');
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close(); handle = null;
    if (!(await io.readFile(temporary)).equals(bytes)) throw new Error(`userscript-publication-readback:${file}`);
    return temporary;
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    await io.unlink(temporary).catch(() => {});
    throw error;
  }
}

async function syncDirectory(directory, io) {
  const handle = await io.open(directory, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}

async function assertRegularPublicationInput(file, expected, io) {
  const stat = await io.lstat(file);
  if (!stat.isFile()) throw new Error(`userscript-publication-non-regular-input:${file}`);
  if (!(await io.readFile(file)).equals(expected)) throw new Error(`userscript-publication-stale-input:${file}`);
}

// Never truncate an existing generated file before the replacement has been
// written, synced and read back. A directory-sync failure still fails the build.
export async function writeFileVerified(file, content, { io = fs } = {}) {
  const temporary = await stageFile(file, content, io);
  try {
    await io.rename(temporary, file);
    await syncDirectory(dirname(file), io);
  } finally { await io.unlink(temporary).catch(() => {}); }
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
  await assertSafePublicationDirectory(directory, { io, containmentRoot: containmentRoot ?? directory });
  const lockPath = resolve(directory, '.userscript-publication.lock');
  const lock = await io.open(lockPath, 'wx');
  const records = [];
  let retainRecovery = false;
  let primaryError = null;
  try {
    // Preflight both members before staging or creating backups. readFile()
    // follows symlinks while rename() replaces the directory entry, so a
    // symlink would validate one filesystem object and publish over another.
    for (const [index, entry] of entries.entries()) {
      await assertRegularPublicationInput(paths[index], entry.expected, io);
    }
    await assertSafePublicationDirectory(directory, { io, containmentRoot: containmentRoot ?? directory });
    for (const [index, entry] of entries.entries()) {
      const file = paths[index];
      const record = { file, backup:`${file}.${randomUUID()}.backup`, temporary:null, backedUp:false, published:false };
      records.push(record);
      record.temporary = await stageFile(file, entry.content, io);
      await io.link(file, record.backup); record.backedUp = true;
    }
    await syncDirectory(directory, io);
    await assertSafePublicationDirectory(directory, { io, containmentRoot: containmentRoot ?? directory });
    for (const [index, record] of records.entries()) {
      await assertRegularPublicationInput(record.file, entries[index].expected, io);
      await io.rename(record.temporary, record.file); record.published = true;
    }
    await syncDirectory(directory, io);
  } catch (error) {
    const rollbackErrors = [];
    for (const record of [...records].reverse()) if (record.published) {
      try { await io.rename(record.backup, record.file); record.backedUp = false; }
      catch (rollbackError) { rollbackErrors.push(rollbackError); }
    }
    if (records.some(record => record.published)) {
      try { await syncDirectory(directory, io); } catch (rollbackError) { rollbackErrors.push(rollbackError); }
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

    const lockClosed = await cleanup(() => lock.close());
    if (!lockClosed) retainRecovery = true;
    if (!retainRecovery) {
      let artifactsClean = true;
      for (const record of records) {
        if (record.temporary && !(await cleanup(() => io.unlink(record.temporary)))) artifactsClean = false;
        if (record.backedUp && !(await cleanup(() => io.unlink(record.backup)))) artifactsClean = false;
      }
      if (!artifactsClean) retainRecovery = true;
      if (!retainRecovery) await cleanup(() => io.unlink(lockPath));
    }

    if (primaryError && cleanupErrors.length) {
      throw new AggregateError([primaryError, ...cleanupErrors], `userscript-publication-cleanup-failed:${lockPath}`);
    }
    if (primaryError) throw primaryError;
    if (cleanupErrors.length === 1) throw cleanupErrors[0];
    if (cleanupErrors.length > 1) throw new AggregateError(cleanupErrors, `userscript-publication-cleanup-failed:${lockPath}`);
  }
}
