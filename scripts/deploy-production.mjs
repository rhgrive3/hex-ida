import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const validatorPath = resolve(repoRoot, 'scripts/validate-auth-config.mjs');
const wranglerPath = resolve(repoRoot, 'node_modules/wrangler/bin/wrangler.js');
const productionConfigPath = resolve(repoRoot, 'wrangler.jsonc');

export function stableConfigDescriptorPath(platform = process.platform) {
  if (platform === 'linux') return '/proc/self/fd/3';
  if (platform === 'darwin') return '/dev/fd/3';
  throw new Error(`Production deploy requires a stable inherited config descriptor; unsupported platform: ${platform}`);
}

export function runSubprocess(command, args, options, { inheritFd = null } = {}) {
  if (inheritFd == null) return spawnSync(command, args, options);
  return spawnSync(command, args, {
    ...options,
    stdio: ['inherit', 'inherit', 'inherit', inheritFd],
  });
}

function sameSnapshotIdentity(a, b) {
  return String(a.dev) === String(b.dev) && String(a.ino) === String(b.ino);
}

function readDescriptorBytes(fd, length, { fstatSync = fs.fstatSync, readSync = fs.readSync } = {}) {
  const stat = fstatSync(fd);
  if (!stat.isFile() || stat.size !== length) return null;
  const bytes = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const count = readSync(fd, bytes, offset, length - offset, offset);
    if (count <= 0) break;
    offset += count;
  }
  return offset === length ? bytes : null;
}

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

export function runProductionDeploy({
  run = runSubprocess,
  args = [],
  configPath = productionConfigPath,
  readFileSync = fs.readFileSync,
  openSync = fs.openSync,
  writeFileSync = fs.writeFileSync,
  closeSync = fs.closeSync,
  fsyncSync = fs.fsyncSync,
  fstatSync = fs.fstatSync,
  lstatSync = fs.lstatSync,
  unlinkSync = fs.unlinkSync,
  rmSync = fs.rmSync,
  readSync = fs.readSync,
  readSnapshotSync = null,
  randomUUIDImpl = randomUUID,
  snapshotDirectory = repoRoot,
  descriptorPathImpl = stableConfigDescriptorPath,
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
  let snapshotFd = null;
  let primaryError = null;
  let status = null;
  let deploymentAttempted = false;
  try {
    snapshotFd = openSync(snapshotPath, 'wx+', 0o400);
    ownsSnapshot = true;
    writeFileSync(snapshotFd, approvedBytes);
    fsyncSync(snapshotFd);

    const pathEntry = lstatSync(snapshotPath);
    const fdEntry = fstatSync(snapshotFd);
    if (pathEntry.isSymbolicLink() || !pathEntry.isFile() || !fdEntry.isFile()
        || !sameSnapshotIdentity(pathEntry, fdEntry)) {
      throw new Error('Production config snapshot identity changed before handoff.');
    }

    unlinkSync(snapshotPath);
    ownsSnapshot = false;
    const stableConfigPath = descriptorPathImpl();
    const childOptions = { cwd:repoRoot, stdio:'inherit' };
    const inherited = { inheritFd:snapshotFd };

    const beforeValidation = readSnapshotSync
      ? Buffer.from(readSnapshotSync(snapshotFd))
      : readDescriptorBytes(snapshotFd, approvedBytes.length, { fstatSync, readSync });
    if (!beforeValidation?.equals(approvedBytes)) throw new Error('Production config snapshot changed before validation.');

    const validation = run(process.execPath, [validatorPath, `--config=${stableConfigPath}`], childOptions, inherited);
    const validationStatus = subprocessStatus(validation, 'Production auth validator');
    if (validationStatus !== 0) {
      status = validationStatus;
    } else {
      const beforeDeploy = readSnapshotSync
        ? Buffer.from(readSnapshotSync(snapshotFd))
        : readDescriptorBytes(snapshotFd, approvedBytes.length, { fstatSync, readSync });
      if (!beforeDeploy?.equals(approvedBytes)) throw new Error('Production config snapshot changed after validation.');
      deploymentAttempted = true;
      const deployment = run(process.execPath, [wranglerPath, 'deploy', '--config', stableConfigPath], childOptions, inherited);
      status = subprocessStatus(deployment, 'Wrangler deployment');
    }
  } catch (error) {
    primaryError = error;
  }

  const cleanupErrors = [];
  if (snapshotFd != null) {
    try { closeSync(snapshotFd); } catch (error) { cleanupErrors.push(error); }
  }
  if (ownsSnapshot) {
    try { rmSync(snapshotPath, { force:true }); } catch (error) { cleanupErrors.push(error); }
  }

  if (primaryError) {
    if (cleanupErrors.length) {
      throw new AggregateError([primaryError, ...cleanupErrors], 'Production deploy failed and snapshot cleanup also failed.');
    }
    throw primaryError;
  }
  if (cleanupErrors.length) {
    const cleanupError = cleanupErrors.length === 1
      ? cleanupErrors[0]
      : new AggregateError(cleanupErrors, 'Production deploy snapshot cleanup failed.');
    onCleanupError?.(cleanupError, {
      snapshotPath,
      status,
      deploymentAttempted,
      deploymentCommitted: deploymentAttempted && status === 0,
    });
  }
  return status;
}

export function main(args = process.argv.slice(2), { run = runSubprocess, reportError = console.error } = {}) {
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
