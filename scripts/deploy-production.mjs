import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseJsonc } from './validate-auth-config.mjs';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const validatorPath = resolve(repoRoot, 'scripts/validate-auth-config.mjs');
const wranglerPath = resolve(repoRoot, 'node_modules/wrangler/bin/wrangler.js');
const productionConfigPath = resolve(repoRoot, 'wrangler.jsonc');
const HANDOFF_CONFIG_NAME = 'wrangler.jsonc';

export class SubprocessSignalError extends Error {
  constructor(label, signal) {
    super(`${label} terminated by signal ${signal}`);
    this.name = 'SubprocessSignalError';
    this.signal = signal;
  }
}

export function subprocessStatus(result, label) {
  if (result?.error) throw result.error;
  if (result?.signal) throw new SubprocessSignalError(label, result.signal);
  if (!Number.isInteger(result?.status)) throw new Error(`${label} returned no exit status`);
  return result.status;
}

function sameIdentity(left, right) {
  return left && right && left.dev === right.dev && left.ino === right.ino;
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
  fchmodSync = fs.fchmodSync,
  mkdirSync = fs.mkdirSync,
  linkSync = fs.linkSync,
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
  if (process.platform !== 'linux') {
    throw new Error('Production deploy requires Linux /proc file-descriptor handoff support.');
  }

  const approvedBytes = Buffer.from(readFileSync(configPath));
  const approvedConfig = parseJsonc(approvedBytes.toString('utf8'));
  const token = randomUUIDImpl();
  const snapshotPath = resolve(snapshotDirectory, `.wrangler.production-snapshot-${process.pid}-${token}.jsonc`);
  const handoffDirectoryPath = resolve(snapshotDirectory, `.wrangler.production-handoff-${process.pid}-${token}`);
  const handoffConfigPath = resolve(handoffDirectoryPath, HANDOFF_CONFIG_NAME);

  let ownsSnapshot = false;
  let snapshotIdentity = null;
  let ownsHandoffDirectory = false;
  let handoffDirectoryFd = null;
  let handoffDirectoryIdentity = null;
  let ownsHandoffConfig = false;
  let parentStableConfigPath = null;
  let primaryError = null;
  let status = null;
  let deploymentAttempted = false;

  try {
    const writeFd = openSync(snapshotPath, 'wx', 0o400);
    ownsSnapshot = true;
    try {
      writeFileSync(writeFd, approvedBytes);
    } finally {
      closeSync(writeFd);
    }

    const snapshotEntry = lstatSync(snapshotPath);
    if (snapshotEntry.isSymbolicLink() || !snapshotEntry.isFile()) throw new Error('Production config snapshot is not a regular file.');
    snapshotIdentity = { dev: snapshotEntry.dev, ino: snapshotEntry.ino };

    mkdirSync(handoffDirectoryPath, { mode: 0o700 });
    ownsHandoffDirectory = true;
    const handoffDirectoryEntry = lstatSync(handoffDirectoryPath);
    if (handoffDirectoryEntry.isSymbolicLink() || !handoffDirectoryEntry.isDirectory()) {
      throw new Error('Production config handoff path is not a real directory.');
    }

    const directoryFlags = fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW;
    handoffDirectoryFd = openSync(handoffDirectoryPath, directoryFlags);
    const openedDirectory = fstatSync(handoffDirectoryFd);
    if (!openedDirectory.isDirectory() || !sameIdentity(openedDirectory, handoffDirectoryEntry)) {
      throw new Error('Production config handoff directory identity changed before lock.');
    }
    handoffDirectoryIdentity = { dev: openedDirectory.dev, ino: openedDirectory.ino };
    parentStableConfigPath = `/proc/self/fd/${handoffDirectoryFd}/${HANDOFF_CONFIG_NAME}`;

    // Publish the approved inode through the already-open directory rather than
    // resolving the handoff directory pathname again. If the source snapshot
    // races, the inode comparison below fails closed before validation.
    linkSync(snapshotPath, parentStableConfigPath);
    ownsHandoffConfig = true;
    const handoffEntry = lstatSync(parentStableConfigPath);
    if (handoffEntry.isSymbolicLink() || !handoffEntry.isFile() || !sameIdentity(handoffEntry, snapshotEntry)) {
      throw new Error('Production config handoff file is not the approved snapshot inode.');
    }

    // Once locked, ordinary processes with workspace write access cannot swap
    // the config entry. The child receives the directory descriptor directly,
    // so replacing/renaming any ancestor pathname cannot redirect its lookup.
    fchmodSync(handoffDirectoryFd, 0o500);
    const lockedDirectory = fstatSync(handoffDirectoryFd);
    if ((lockedDirectory.mode & 0o222) !== 0 || !sameIdentity(lockedDirectory, handoffDirectoryEntry)) {
      throw new Error('Production config handoff directory could not be write-locked.');
    }
    const lockedBytes = Buffer.from(readSnapshotSync(parentStableConfigPath));
    if (!lockedBytes.equals(approvedBytes)) throw new Error('Production config handoff changed before validation.');

    // Remove the original writable-workspace pathname only if it still names
    // our inode. A replacement belongs to another actor and must never be
    // removed by cleanup or publication logic.
    let currentSnapshot = null;
    try {
      currentSnapshot = lstatSync(snapshotPath);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    if (currentSnapshot && sameIdentity(currentSnapshot, snapshotIdentity)) unlinkSync(snapshotPath);
    ownsSnapshot = false;

    const inheritedDirectoryFd = 3;
    const stableConfigPath = `/proc/self/fd/${inheritedDirectoryFd}/${HANDOFF_CONFIG_NAME}`;
    const childOptions = { cwd: repoRoot, stdio: ['inherit', 'inherit', 'inherit', handoffDirectoryFd] };
    const validation = run(process.execPath, [validatorPath, `--config=${stableConfigPath}`], childOptions);
    const validationStatus = subprocessStatus(validation, 'Production auth validator');
    if (validationStatus !== 0) {
      status = validationStatus;
    } else {
      const beforeDeploy = Buffer.from(readSnapshotSync(parentStableConfigPath));
      if (!beforeDeploy.equals(approvedBytes)) throw new Error('Production config snapshot changed after validation.');

      // Wrangler resolves path-like fields relative to the config location. The
      // stable config lives under /proc, so preserve the approved project-root
      // semantics explicitly for the path-bearing deploy inputs used here.
      const configRoot = dirname(resolve(configPath));
      const mainPath = typeof approvedConfig?.main === 'string' ? resolve(configRoot, approvedConfig.main) : null;
      if (!mainPath) throw new Error('Validated production config has no worker entrypoint.');
      const deploymentArgs = [wranglerPath, 'deploy', mainPath, '--config', stableConfigPath];
      if (typeof approvedConfig?.assets?.directory === 'string') {
        deploymentArgs.push('--assets', resolve(configRoot, approvedConfig.assets.directory));
      }

      deploymentAttempted = true;
      const deployment = run(process.execPath, deploymentArgs, childOptions);
      status = subprocessStatus(deployment, 'Wrangler deployment');
    }
  } catch (error) {
    primaryError = error;
  }

  const cleanupErrors = [];
  const recordCleanup = (fn) => {
    try { fn(); } catch (error) { cleanupErrors.push(error); }
  };

  if (handoffDirectoryFd !== null) {
    // Re-enable owner writes on the exact opened directory so cleanup itself
    // does not depend on a potentially replaced pathname.
    recordCleanup(() => fchmodSync(handoffDirectoryFd, 0o700));
    if (ownsHandoffConfig && parentStableConfigPath) {
      recordCleanup(() => rmSync(parentStableConfigPath, { force: true }));
      ownsHandoffConfig = false;
    }

    // If removing the stable config failed, leave the directory in place rather
    // than stacking a second derivative cleanup error on the same root cause.
    if (cleanupErrors.length === 0 && ownsHandoffDirectory && handoffDirectoryIdentity) {
      recordCleanup(() => {
        let current = null;
        try { current = lstatSync(handoffDirectoryPath); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
        if (current && sameIdentity(current, handoffDirectoryIdentity)) rmSync(handoffDirectoryPath, { recursive: true, force: true });
      });
      ownsHandoffDirectory = false;
    }
    recordCleanup(() => closeSync(handoffDirectoryFd));
    handoffDirectoryFd = null;
  } else if (ownsHandoffDirectory) {
    recordCleanup(() => rmSync(handoffDirectoryPath, { recursive: true, force: true }));
    ownsHandoffDirectory = false;
  }

  if (ownsSnapshot) {
    recordCleanup(() => {
      let current = null;
      try { current = lstatSync(snapshotPath); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
      if (current && snapshotIdentity && sameIdentity(current, snapshotIdentity)) rmSync(snapshotPath, { force: true });
      else if (current && !snapshotIdentity) rmSync(snapshotPath, { force: true });
    });
  }

  const cleanupError = cleanupErrors.length === 0
    ? null
    : cleanupErrors.length === 1
      ? cleanupErrors[0]
      : new AggregateError(cleanupErrors, 'Multiple production deploy snapshot cleanup operations failed.');

  if (primaryError) {
    if (cleanupError) {
      const errors = cleanupError instanceof AggregateError ? cleanupError.errors : [cleanupError];
      throw new AggregateError([primaryError, ...errors], 'Production deploy failed and snapshot cleanup also failed.');
    }
    throw primaryError;
  }
  if (cleanupError) {
    onCleanupError?.(cleanupError, {
      snapshotPath,
      handoffDirectoryPath,
      status,
      deploymentAttempted,
      deploymentCommitted: deploymentAttempted && status === 0,
    });
  }
  return status;
}

export function main(args = process.argv.slice(2), { run = spawnSync, reportError = console.error } = {}) {
  try {
    return runProductionDeploy({ args, run });
  } catch (error) {
    reportError(error instanceof Error ? error.message : 'Production deploy failed.');
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main();
}
