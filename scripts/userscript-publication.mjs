import * as fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';

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
export async function publishUserscriptFiles(entries, { io = fs } = {}) {
  if (!Array.isArray(entries) || entries.length !== 2) throw new Error('userscript-publication-pair-required');
  const paths = entries.map(entry => resolve(entry.path));
  const directory = dirname(paths[0]);
  if (new Set(paths).size !== 2 || paths.some(file => dirname(file) !== directory)
      || entries.some(entry => !Buffer.isBuffer(entry.expected))) throw new Error('userscript-publication-identity-required');
  const lockPath = resolve(directory, '.userscript-publication.lock');
  const lock = await io.open(lockPath, 'wx');
  const records = [];
  let retainRecovery = false;
  try {
    for (const [index, entry] of entries.entries()) {
      const file = paths[index];
      if (!(await io.readFile(file)).equals(entry.expected)) throw new Error(`userscript-publication-stale-input:${file}`);
      const record = { file, backup:`${file}.${randomUUID()}.backup`, temporary:null, backedUp:false, published:false };
      records.push(record);
      record.temporary = await stageFile(file, entry.content, io);
      // Hard links preserve the originals without requiring another data write
      // during rollback, when quota exhaustion may make even one byte fail.
      await io.link(file, record.backup); record.backedUp = true;
    }
    await syncDirectory(directory, io);
    for (const [index, record] of records.entries()) {
      if (!(await io.readFile(record.file)).equals(entries[index].expected)) throw new Error(`userscript-publication-stale-input:${record.file}`);
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
      throw new AggregateError([error, ...rollbackErrors], `userscript-publication-recovery-required:${lockPath}`);
    }
    throw error;
  } finally {
    await lock.close();
    if (!retainRecovery) {
      for (const record of records) {
        if (record.temporary) await io.unlink(record.temporary).catch(() => {});
        if (record.backedUp) await io.unlink(record.backup).catch(() => {});
      }
      await io.unlink(lockPath);
    }
  }
}
