import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const validatorPath = resolve(repoRoot, 'scripts/validate-auth-config.mjs');
const wranglerPath = resolve(repoRoot, 'node_modules/wrangler/bin/wrangler.js');
const productionConfigPath = resolve(repoRoot, 'wrangler.jsonc');

export class SubprocessSignalError extends Error {
  constructor(label, signal) { super(`${label} terminated by signal ${signal}`); this.name = 'SubprocessSignalError'; this.signal = signal; }
}

export function subprocessStatus(result, label) {
  if (result?.error) throw result.error;
  if (result?.signal) throw new SubprocessSignalError(label, result.signal);
  if (!Number.isInteger(result?.status)) throw new Error(`${label} returned no exit status`);
  return result.status;
}

export function runProductionDeploy({
  run = spawnSync,
  args = [],
  configPath = productionConfigPath,
  readFileSync = fs.readFileSync,
  openSync = fs.openSync,
  writeFileSync = fs.writeFileSync,
  closeSync = fs.closeSync,
  readSnapshotSync = fs.readFileSync,
  lstatSync = fs.lstatSync,
  fstatSync = fs.fstatSync,
  unlinkSync = fs.unlinkSync,
  rmSync = fs.rmSync,
  randomUUIDImpl = randomUUID,
  snapshotDirectory = repoRoot,
  onCleanupError = (error, details) => console.warn(
    details.deploymentCommitted
      ? `Production deployment succeeded, but snapshot cleanup failed: ${error?.message || error}`
      : `Production deploy snapshot cleanup failed after status ${details.status}: ${error?.message || error}`,
  ),
} = {}) {
  if (args.length) throw new Error('Production deploy does not accept Wrangler config or environment overrides; edit wrangler.jsonc and retry.');
  const approvedBytes = Buffer.from(readFileSync(configPath));
  const snapshotPath = resolve(snapshotDirectory, `.wrangler.production-snapshot-${process.pid}-${randomUUIDImpl()}.jsonc`);
  let ownsSnapshot = false;
  let snapshotIdentity = null;
  let handoffFd = null;
  let primaryError = null;
  let status = null;
  let deploymentAttempted = false;
  const childConfigPath = process.platform === 'linux'
    ? '/proc/self/fd/3'
    : process.platform === 'darwin'
      ? '/dev/fd/3'
      : null;
  try {
    if (!childConfigPath) throw new Error('Production deploy requires descriptor-backed config handoff on this platform.');
    const snapshotFd = openSync(snapshotPath, 'wx', 0o400);
    ownsSnapshot = true;
    try { writeFileSync(snapshotFd, approvedBytes); } finally { closeSync(snapshotFd); }

    const snapshotEntry = lstatSync(snapshotPath);
    if (snapshotEntry.isSymbolicLink() || !snapshotEntry.isFile()) throw new Error('Production config snapshot is not a regular file.');

    // Open once before validation and use the same descriptor for both children.
    // This binds validator and Wrangler to one approved file object.
    handoffFd = openSync(snapshotPath, 'r');
    const openedEntry = fstatSync(handoffFd);
    if (!openedEntry.isFile()) throw new Error('Production config snapshot is not a regular file.');
    snapshotIdentity = { dev: openedEntry.dev, ino: openedEntry.ino };
    const validation = run(process.execPath, [validatorPath, `--config=${childConfigPath}`], {
      cwd: repoRoot,
      stdio: ['inherit', 'inherit', 'inherit', handoffFd],
    });
    const validationStatus = subprocessStatus(validation, 'Production auth validator');
    if (validationStatus !== 0) {
      status = validationStatus;
    } else {
      const validatedBytes = Buffer.from(readSnapshotSync(process.platform === 'linux' ? `/proc/self/fd/${handoffFd}` : `/dev/fd/${handoffFd}`));
      if (!validatedBytes.equals(approvedBytes)) throw new Error('Production config snapshot changed after validation.');
      const currentEntry = lstatSync(snapshotPath);
      if (currentEntry.isSymbolicLink() || !currentEntry.isFile()
        || currentEntry.dev !== snapshotIdentity.dev || currentEntry.ino !== snapshotIdentity.ino) {
        throw new Error('Production config snapshot identity changed before deployment handoff.');
      }
      const currentFdEntry = fstatSync(handoffFd);
      if (!currentFdEntry.isFile() || currentFdEntry.dev !== snapshotIdentity.dev || currentFdEntry.ino !== snapshotIdentity.ino) {
        throw new Error('Production config snapshot identity changed before deployment handoff.');
      }
      unlinkSync(snapshotPath);
      const detachedBytes = Buffer.from(readSnapshotSync(process.platform === 'linux' ? `/proc/self/fd/${handoffFd}` : `/dev/fd/${handoffFd}`));
      if (!detachedBytes.equals(approvedBytes)) throw new Error('Production config snapshot changed before deployment handoff.');
      deploymentAttempted = true;
      const deployment = run(
        process.execPath,
        [wranglerPath, 'deploy', '--config', childConfigPath],
        { cwd: repoRoot, stdio: ['inherit', 'inherit', 'inherit', handoffFd] },
      );
      status = subprocessStatus(deployment, 'Wrangler deployment');
    }
  } catch (error) {
    primaryError = error;
  }

  let cleanupError = null;
  if (handoffFd != null) {
    try { closeSync(handoffFd); } catch (error) { cleanupError = error; }
  }
  if (ownsSnapshot) {
    try { rmSync(snapshotPath, { force: true }); }
    catch (error) {
      cleanupError = cleanupError
        ? new AggregateError([cleanupError, error], 'Production deploy snapshot descriptor and path cleanup both failed.')
        : error;
    }
  }
  if (primaryError) {
    if (cleanupError) throw new AggregateError([primaryError, cleanupError], 'Production deploy failed and snapshot cleanup also failed.');
    throw primaryError;
  }
  if (cleanupError) {
    onCleanupError?.(cleanupError, {
      snapshotPath,
      status,
      deploymentAttempted,
      deploymentCommitted: deploymentAttempted && status === 0,
    });
  }
  return status;
}

export function main(args = process.argv.slice(2), { run = spawnSync, reportError = console.error } = {}) {
  try { return runProductionDeploy({ args, run }); }
  catch (error) { reportError(error instanceof Error ? error.message : 'Production deploy failed.'); return 1; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main();
