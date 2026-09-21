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
    if (handoffEntry.isSymbolicLink() || !handoY¹ÑÉä¹¥Í¥± ¤ñðÍµ%¹Ñ¥Ñä¡¡¹½¹ÑÉä°Í¹ÁÍ¡½Ñ¹ÑÉä¤¤ì(Ñ¡É½Ü¹ÜÉÉ½È AÉ½ÕÑ¥½¸½¹¥¡¹½¥±¥Ì¹½ÐÑ¡ÁÁÉ½ÙÍ¹ÁÍ¡½Ð¥¹½¸¤ì(ô((¼¼=¹±½­°½É¥¹ÉäÁÉ½ÍÍÌÝ¥Ñ Ý½É­ÍÁÝÉ¥ÑÍÌ¹¹½ÐÍÝÀ(¼¼Ñ¡½¹¥¹ÑÉä¸Q¡¡¥±É¥ÙÌÑ¡¥ÉÑ½ÉäÍÉ¥ÁÑ½È¥ÉÑ±ä°(¼¼Í¼ÉÁ±¥¹½É¹µ¥¹¹ä¹ÍÑ½ÈÁÑ¡¹µ¹¹½ÐÉ¥ÉÐ¥ÑÌ±½½­ÕÀ¸(¡µ½Må¹¡¡¹½¥ÉÑ½Éå°Á¼ÔÀÀ¤ì(½¹ÍÐ±½­¥ÉÑ½ÉäôÍÑÑMå¹¡¡¹½¥ÉÑ½Éå¤ì(¥ ¡±½­¥ÉÑ½Éä¹µ½Á¼ÈÈÈ¤ôôÀñðÍµ%¹Ñ¥Ñä¡±½­¥ÉÑ½Éä°¡¹½¥ÉÑ½Éå¹ÑÉä¤¤ì(Ñ¡É½Ü¹ÜÉÉ½È AÉ½ÕÑ¥½¸½¹¥¡¹½¥ÉÑ½Éä½Õ±¹½ÐÝÉ¥Ñµ±½­¸¤ì(ô(½¹ÍÐ±½­	åÑÌô	ÕÈ¹É½´¡ÉM¹ÁÍ¡½ÑMå¹¡ÁÉ¹ÑMÑ±½¹¥AÑ ¤¤ì(¥ ±½­	åÑÌ¹ÅÕ±Ì¡ÁÁÉ½Ù	åÑÌ¤¤Ñ¡É½Ü¹ÜÉÉ½È AÉ½ÕÑ¥½¸½¹¥¡¹½¡¹½ÉÙ±¥Ñ¥½¸¸¤ì((¼¼Iµ½ÙÑ¡½É¥¥¹°ÝÉ¥Ñ±µÝ½É­ÍÁÁÑ¡¹µ½¹±ä¥¥ÐÍÑ¥±°¹µÌ(¼¼½ÕÈ¥¹½¸ÉÁ±µ¹Ð±½¹ÌÑ¼¹½Ñ¡ÈÑ½È¹µÕÍÐ¹ÙÈ(¼¼Éµ½Ùä±¹ÕÀ½ÈÁÕ±¥Ñ¥½¸±½¥¸(±ÐÕÉÉ¹ÑM¹ÁÍ¡½Ðô¹Õ±°ì(ÑÉäì(ÕÉÉ¹ÑM¹ÁÍ¡½Ðô±ÍÑÑMå¹¡Í¹ÁÍ¡½ÑAÑ ¤ì(ôÑ ¡ÉÉ½È¤ì(¥¡ÉÉ½Èü¹½ôô9=9P¤Ñ¡É½ÜÉÉ½Èì(ô(¥¡ÕÉÉ¹ÑM¹ÁÍ¡½ÐÍµ%¹Ñ¥Ñä¡ÕÉÉ¹ÑM¹ÁÍ¡½Ð°Í¹ÁÍ¡½Ñ%¹Ñ¥Ñä¤¤Õ¹±¥¹­Må¹¡Í¹ÁÍ¡½ÑAÑ ¤ì(½Ý¹ÍM¹ÁÍ¡½Ðô±Íì((½¹ÍÐ¥¹¡É¥Ñ¥ÉÑ½ÉåôÌì(½¹ÍÐÍÑ±½¹¥AÑ ô½ÁÉ½½Í±½¼í¥¹¡É¥Ñ¥ÉÑ½Éåô¼í!9=}=9%}95õì(½¹ÍÐ¡¥±=ÁÑ¥½¹ÌôìÝèÉÁ½I½½Ð°ÍÑ¥¼èl¥¹¡É¥Ð°¥¹¡É¥Ð°¥¹¡É¥Ð°¡¹½¥ÉÑ½Éåtôì(½¹ÍÐÙ±¥Ñ¥½¸ôÉÕ¸¡ÁÉ½ÍÌ¹áAÑ °mÙ±¥Ñ½ÉAÑ °´µ½¹¥ôíÍÑ±½¹¥AÑ¡õt°¡¥±=ÁÑ¥½¹Ì¤ì(½¹ÍÐÙ±¥Ñ¥½¹MÑÑÕÌôÍÕÁÉ½ÍÍMÑÑÕÌ¡Ù±¥Ñ¥½¸°AÉ½ÕÑ¥½¸ÕÑ Ù±¥Ñ½È¤ì(¥¡Ù±¥Ñ¥½¹MÑÑÕÌôôÀ¤ì(ÍÑÑÕÌôÙ±¥Ñ¥½¹MÑÑÕÌì(ô±Íì(½¹ÍÐ½ÉÁ±½äô	ÕÈ¹É½´¡ÉM¹ÁÍ¡½ÑMå¹¡ÁÉ¹ÑMÑ±½¹¥AÑ ¤¤ì(¥ ½ÉÁ±½ä¹ÅÕ±Ì¡ÁÁÉ½Ù	åÑÌ¤¤Ñ¡É½Ü¹ÜÉÉ½È AÉ½ÕÑ¥½¸½¹¥Í¹ÁÍ¡½Ð¡¹ÑÈÙ±¥Ñ¥½¸¸¤ì((¼¼]É¹±ÈÉÍ½±ÙÌÁÑ µ±¥­¥±ÌÉ±Ñ¥ÙÑ¼Ñ¡½¹¥±½Ñ¥½¸¸Q¡(¼¼ÍÑ±½¹¥±¥ÙÌÕ¹È½ÁÉ½°Í¼ÁÉÍÉÙÑ¡ÁÁÉ½ÙÁÉ½©ÐµÉ½½Ð(¼¼Íµ¹Ñ¥ÌáÁ±¥¥Ñ±ä½ÈÑ¡ÁÑ µÉ¥¹Á±½ä¥¹ÁÕÑÌÕÍ¡É¸(½¹ÍÐ½¹¥I½½Ðô¥É¹µ¡ÉÍ½±Ù¡½¹¥AÑ ¤¤ì(½¹ÍÐµ¥¹AÑ ôÑåÁ½ÁÁÉ½Ù½¹¥ü¹µ¥¸ôôôÍÑÉ¥¹üÉÍ½±Ù¡½¹¥I½½Ð°ÁÁÉ½Ù½¹¥¹µ¥¸¤è¹Õ±°ì(¥ µ¥¹AÑ ¤Ñ¡É½Ü¹ÜÉÉ½È Y±¥ÑÁÉ½ÕÑ¥½¸½¹¥¡Ì¹¼Ý½É­È¹ÑÉåÁ½¥¹Ð¸¤ì(½¹ÍÐÁ±½åµ¹ÑÉÌômÝÉ¹±ÉAÑ °Á±½ä°µ¥¹AÑ °´µ½¹¥°ÍÑ±½¹¥AÑ¡tì(¥¡ÑåÁ½ÁÁÉ½Ù½¹¥ü¹ÍÍÑÌü¹¥ÉÑ½ÉäôôôÍÑÉ¥¹¤ì(Á±½åµ¹ÑÉÌ¹ÁÕÍ  ´µÍÍÑÌ°ÉÍ½±Ù¡½¹¥I½½Ð°ÁÁÉ½Ù½¹¥¹ÍÍÑÌ¹¥ÉÑ½Éä¤¤ì(ô((Á±½åµ¹ÑÑÑµÁÑôÑÉÕì(½¹ÍÐÁ±½åµ¹ÐôÉÕ¸¡ÁÉ½ÍÌ¹áAÑ °Á±½åµ¹ÑÉÌ°¡¥±=ÁÑ¥½¹Ì¤ì(ÍÑÑÕÌôÍÕÁÉ½ÍÍMÑÑÕÌ¡Á±½åµ¹Ð°]É¹±ÈÁ±½åµ¹Ð¤ì(ô(ôÑ ¡ÉÉ½È¤ì(ÁÉ¥µÉåÉÉ½ÈôÉÉ½Èì(ô((½¹ÍÐ±¹ÕÁÉÉ½ÉÌômtì(½¹ÍÐÉ½É±¹ÕÀô¡¸¤ôøì(ÑÉäì¸ ¤ìôÑ ¡ÉÉ½È¤ì±¹ÕÁÉÉ½ÉÌ¹ÁÕÍ ¡ÉÉ½È¤ìô(ôì((¥¡¡¹½¥ÉÑ½Éåôô¹Õ±°¤ì(¼¼Iµ¹±½Ý¹ÈÝÉ¥ÑÌ½¸Ñ¡áÐ½Á¹¥ÉÑ½ÉäÍ¼±¹ÕÀ¥ÑÍ±(¼¼½Ì¹½ÐÁ¹½¸Á½Ñ¹Ñ¥±±äÉÁ±ÁÑ¡¹µ¸(É½É±¹ÕÀ  ¤ôø¡µ½Må¹¡¡¹½¥ÉÑ½Éå°Á¼ÜÀÀ¤¤ì(¥¡½Ý¹Í!¹½½¹¥ÁÉ¹ÑMÑ±½¹¥AÑ ¤ì(É½É±¹ÕÀ  ¤ôøÉµMå¹¡ÁÉ¹ÑMÑ±½¹¥AÑ °ì½ÉèÑÉÕô¤¤ì(½Ý¹Í!¹½½¹¥ô±Íì(ô((¼¼%Éµ½Ù¥¹Ñ¡ÍÑ±½¹¥¥±°±ÙÑ¡¥ÉÑ½Éä¥¸Á±ÉÑ¡È(¼¼Ñ¡¸ÍÑ­¥¹Í½¹É¥ÙÑ¥Ù±¹ÕÀÉÉ½È½¸Ñ¡ÍµÉ½½ÐÕÍ¸(¥¡±¹ÕÁÉÉ½ÉÌ¹±¹Ñ ôôôÀ½Ý¹Í!¹½¥ÉÑ½Éä¡¹½¥ÉÑ½Éå%¹Ñ¥Ñä¤ì(É½É±¹ÕÀ  ¤ôøì(±ÐÕÉÉ¹Ðô¹Õ±°ì(ÑÉäìÕÉÉ¹Ðô±ÍÑÑMå¹¡¡¹½¥ÉÑ½ÉåAÑ ¤ìôÑ ¡ÉÉ½È¤ì¥¡ÉÉ½Èü¹½ôô9=9P¤Ñ¡É½ÜÉÉ½Èìô(¥¡ÕÉÉ¹ÐÍµ%¹Ñ¥Ñä¡ÕÉÉ¹Ð°¡¹½¥ÉÑ½Éå%¹Ñ¥Ñä¤¤ÉµMå¹¡¡¹½¥ÉÑ½ÉåAÑ °ìÉÕÉÍ¥ÙèÑÉÕ°½ÉèÑÉÕô¤ì(ô¤ì(½Ý¹Í!¹½¥ÉÑ½Éäô±Íì(ô(É½É±¹ÕÀ  ¤ôø±½ÍMå¹¡¡¹½¥ÉÑ½Éå¤¤ì(¡¹½¥ÉÑ½Éåô¹Õ±°ì(ô±Í¥¡½Ý¹Í!¹½¥ÉÑ½Éä¤ì(É½É±¹ÕÀ  ¤ôøÉµMå¹¡¡¹½¥ÉÑ½ÉåAÑ °ìÉÕÉÍ¥ÙèÑÉÕ°½ÉèÑÉÕô¤¤ì(½Ý¹Í!¹½¥ÉÑ½Éäô±Íì(ô((¥¡½Ý¹ÍM¹ÁÍ¡½Ð¤ì(É½É±¹ÕÀ  ¤ôøì(±ÐÕÉÉ¹Ðô¹Õ±°ì(ÑÉäìÕÉÉ¹Ðô±ÍÑÑMå¹¡Í¹ÁÍ¡½ÑAÑ ¤ìôÑ ¡ÉÉ½È¤ì¥¡ÉÉ½Èü¹½ôô9=9P¤Ñ¡É½ÜÉÉ½Èìô(¥¡ÕÉÉ¹ÐÍ¹ÁÍ¡½Ñ%¹Ñ¥ÑäÍµ%¹Ñ¥Ñä¡ÕÉÉ¹Ð°Í¹ÁÍ¡½Ñ%¹Ñ¥Ñä¤¤ÉµMå¹¡Í¹ÁÍ¡½ÑAÑ °ì½ÉèÑÉÕô¤ì(±Í¥¡ÕÉÉ¹ÐÍ¹ÁÍ¡½Ñ%¹Ñ¥Ñä¤ÉµMå¹¡Í¹ÁÍ¡½ÑAÑ °ì½ÉèÑÉÕô¤ì(ô¤ì(ô((½¹ÍÐ±¹ÕÁÉÉ½Èô±¹ÕÁÉÉ½ÉÌ¹±¹Ñ ôôôÀ(ü¹Õ±°(è±¹ÕÁÉÉ½ÉÌ¹±¹Ñ ôôôÄ(ü±¹ÕÁÉÉ½ÉÍlÁt(è¹ÜÉÑÉÉ½È¡±¹ÕÁÉÉ½ÉÌ°5Õ±Ñ¥Á±ÁÉ½ÕÑ¥½¸Á±½äÍ¹ÁÍ¡½Ð±¹ÕÀ½ÁÉÑ¥½¹Ì¥±¸¤ì((¥¡ÁÉ¥µÉåÉÉ½È¤ì(¥¡±¹ÕÁÉÉ½È¤ì(½¹ÍÐÉÉ½ÉÌô±¹ÕÁÉÉ½È¥¹ÍÑ¹½ÉÑÉÉ½Èü±¹ÕÁÉÉ½È¹ÉÉ½ÉÌèm±¹ÕÁÉÉ½Étì(Ñ¡É½Ü¹ÜÉÑÉÉ½È¡mÁÉ¥µÉåÉÉ½È°¸¸¹ÉÉ½ÉÍt°AÉ½ÕÑ¥½¸Á±½ä¥±¹Í¹ÁÍ¡½Ð±¹ÕÀ±Í¼¥±¸¤ì(ô(Ñ¡É½ÜÁÉ¥µÉåÉÉ½Èì(ô(¥¡±¹ÕÁÉÉ½È¤ì(½¹±¹ÕÁÉÉ½Èü¸¡±¹ÕÁÉÉ½È°ì(Í¹ÁÍ¡½ÑAÑ °(¡¹½¥ÉÑ½ÉåAÑ °(ÍÑÑÕÌ°(Á±½åµ¹ÑÑÑµÁÑ°(Á±½åµ¹Ñ½µµ¥ÑÑèÁ±½åµ¹ÑÑÑµÁÑÍÑÑÕÌôôôÀ°(ô¤ì(ô(ÉÑÕÉ¸ÍÑÑÕÌì)ô()áÁ½ÉÐÕ¹Ñ¥½¸µ¥¸¡ÉÌôÁÉ½ÍÌ¹ÉØ¹Í±¥ È¤°ìÉÕ¸ôÍÁÝ¹Må¹°ÉÁ½ÉÑÉÉ½Èô½¹Í½±¹ÉÉ½Èôôíô¤ì(ÑÉäì(ÉÑÕÉ¸ÉÕ¹AÉ½ÕÑ¥½¹Á±½ä¡ìÉÌ°ÉÕ¸ô¤ì(ôÑ ¡ÉÉ½È¤ì(ÉÁ½ÉÑÉÉ½È¡ÉÉ½È¥¹ÍÑ¹½ÉÉ½ÈüÉÉ½È¹µÍÍèAÉ½ÕÑ¥½¸Á±½ä¥±¸¤ì(ÉÑÕÉ¸Äì(ô)ô()¥¡ÁÉ½ÍÌ¹ÉÙlÅt¥µÁ½ÉÐ¹µÑ¹ÕÉ°ôôôÁÑ¡Q½¥±UI0¡ÁÉ½ÍÌ¹ÉÙlÅt¤¹¡É¤ì(ÁÉ½ÍÌ¹á¥Ñ½ôµ¥¸ ¤ì)ôeIdentity(handoffEntry, snapshotEntry)) {
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
