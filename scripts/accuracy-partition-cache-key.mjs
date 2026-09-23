#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const PARTITIONS = Object.freeze(JSON.parse(fs.readFileSync(path.join(ROOT, 'tests/accuracy-partitions.json'), 'utf8')));
const GLOBAL_EXCLUDED_PREFIXES = ['js/ai/', 'js/ui/', 'js/managed/', 'js/userscript/'];
const PINPOINT_ONLY_FILES = new Set(['js/pinpoint.js', 'js/pinpoint-legacy.js']);
const PSEUDOC_ONLY_PREFIXES = ['js/decompiler/'];
const COMMON_FILES = [
  'package.json', 'tests/accuracy.mjs', 'tests/accuracy-base.mjs', 'tests/accuracy-short-selector.mjs',
  'tests/harness.mjs', 'tests/fixtures/real-binaries.json', 'tests/oracle.py',
  'tests/oracle-cfg-normalize.py', 'tests/oracle-requirements.txt', 'tests/accuracy-partitions.json',
  'scripts/accuracy-partition-cache-key.mjs',
];
const PSEUDOC_FILES = [
  'tests/accuracy-pseudoc-parallel.mjs', 'tests/accuracy-pseudoc-worker.mjs',
  'tests/accuracy-pseudoc-eval.mjs', 'tests/accuracy-pseudoc-shard-oracle.mjs',
  'tests/accuracy-pseudoc-shard-merge.mjs',
];
const slash = (value) => value.split(path.sep).join('/');
const pathIsWithin = (root, target) => {
  const relative = path.relative(root, target);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
};

function walk(dir, root, out, visitedDirs = new Set(), allowedRealRoot = null) {
  let realDir;
  try {
    realDir = fs.realpathSync(dir);
    if (allowedRealRoot && !pathIsWithin(allowedRealRoot, realDir)) return;
    if (visitedDirs.has(realDir)) return;
    visitedDirs.add(realDir);
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return;
    throw new Error(`accuracy cache key: cannot establish directory identity: ${dir}`, { cause: error });
  }

  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const absolute = path.join(dir, entry.name);

    if (entry.isSymbolicLink()) {
      out.push(slash(path.relative(root, absolute)));
      try {
        const stat = fs.statSync(absolute);
        if (stat.isDirectory()) {
          const realTarget = fs.realpathSync(absolute);
          if (!allowedRealRoot || pathIsWithin(allowedRealRoot, realTarget)) {
            walk(absolute, root, out, visitedDirs, allowedRealRoot);
          }
        }
      } catch (error) {
        // Broken symlink targets are an explicitly represented state. Other
        // filesystem failures mean traversal became incomplete and must fail closed.
        if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') {
          throw new Error(`accuracy cache key: cannot establish symlink target identity: ${absolute}`, { cause: error });
        }
      }
      continue;
    }

    if (entry.isDirectory()) {
      walk(absolute, root, out, visitedDirs, allowedRealRoot);
    } else if (entry.isFile()) {
      out.push(slash(path.relative(root, absolute)));
    }
  }
}

export function partitionFiles(root = ROOT, partition) {
  if (!Object.hasOwn(PARTITIONS, partition)) throw new Error(`unknown accuracy partition: ${partition}`);
  const files=[];
  const jsRoot = path.join(root, 'js');
  const allowedRealRoot = fs.realpathSync(root);
  let jsEntry;
  try {
    jsEntry = fs.lstatSync(jsRoot);
  } catch (error) {
    throw new Error(`accuracy cache key: required js root is unavailable: ${jsRoot}`, { cause: error });
  }
  if (jsEntry.isSymbolicLink() || !jsEntry.isDirectory()) {
    throw new Error(`accuracy cache key: required js root must be a real directory: ${jsRoot}`);
  }
  const realJsRoot = fs.realpathSync(jsRoot);
  if (!pathIsWithin(allowedRealRoot, realJsRoot)) {
    throw new Error(`accuracy cache key: required js root escapes repository: ${jsRoot}`);
  }
  walk(jsRoot, root, files, new Set(), allowedRealRoot);
  const semanticFamily = partition.startsWith('pseudoc-') ? 'pseudoc' : partition;
  const selected=files.filter((relative)=>{
    if (GLOBAL_EXCLUDED_PREFIXES.some((prefix)=>relative.startsWith(prefix))) return false;
    if ((semanticFamily === 'core' || semanticFamily === 'pseudoc') && PINPOINT_ONLY_FILES.has(relative)) return false;
    if (semanticFamily === 'pinpoint' && PSEUDOC_ONLY_PREFIXES.some((prefix)=>relative.startsWith(prefix))) return false;
    return true;
  });
  for (const relative of [...COMMON_FILES, ...(partition.startsWith('pseudoc-') ? PSEUDOC_FILES : [])]) {
    const fullPath = path.join(root, relative);
    let entry;
    try {
      entry = fs.lstatSync(fullPath);
    } catch (error) {
      if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') continue;
      throw error;
    }
    if (entry.isSymbolicLink()) {
      const realTarget = fs.realpathSync(fullPath);
      if (!pathIsWithin(allowedRealRoot, realTarget)) {
        throw new Error(`accuracy cache key: selected input escapes repository: ${relative}`);
      }
      if (!fs.statSync(fullPath).isFile()) {
        throw new Error(`accuracy cache key: selected input is not a file: ${relative}`);
      }
    } else if (!entry.isFile()) {
      throw new Error(`accuracy cache key: selected input is not a file: ${relative}`);
    }
    selected.push(relative);
  }
  return [...new Set(selected)].sort();
}


function sameFileIdentity(left, right) {
  return left && right
    && left.dev != null && left.ino != null
    && right.dev != null && right.ino != null
    && String(left.dev) === String(right.dev)
    && String(left.ino) === String(right.ino);
}

function readBoundRegularFile(fullPath, expected, allowedRealRoot, fsImpl) {
  const realPath = fsImpl.realpathSync(fullPath);
  if (!pathIsWithin(allowedRealRoot, realPath)) {
    throw new Error(`accuracy cache key: selected input escapes repository while hashing: ${fullPath}`);
  }
  const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0);
  const fd = fsImpl.openSync(realPath, flags);
  try {
    const opened = fsImpl.fstatSync(fd);
    if (!opened.isFile() || !sameFileIdentity(opened, expected)) {
      throw new Error(`accuracy cache key: selected input identity changed before hashing: ${fullPath}`);
    }
    const bytes = fsImpl.readFileSync(fd);
    const finalOpened = fsImpl.fstatSync(fd);
    if (!sameFileIdentity(opened, finalOpened) || finalOpened.size !== opened.size) {
      throw new Error(`accuracy cache key: selected input identity changed during hashing: ${fullPath}`);
    }
    return bytes;
  } finally {
    fsImpl.closeSync(fd);
  }
}

export function partitionDigest(root = ROOT, partition, {
  fsImpl = fs,
  partitionFilesImpl = partitionFiles,
} = {}) {
  if (!Object.hasOwn(PARTITIONS, partition)) throw new Error(`unknown accuracy partition: ${partition}`);
  const rootIdentityBefore = fsImpl.realpathSync(root);
  const selectedFiles = partitionFilesImpl(root, partition);
  const allowedRealRoot = fsImpl.realpathSync(root);
  if (allowedRealRoot !== rootIdentityBefore) {
    throw new Error('accuracy cache key: repository identity changed before hashing');
  }
  const hash=crypto.createHash('sha256');
  const pseudoc=partition.startsWith('pseudoc-');
  const contract=pseudoc
    ? `kind=pseudoc;features=pseudoc;heap=2600;workers=2;shard=${partition.slice('pseudoc-'.length)}/4`
    : `kind=nonpseudoc;features=${PARTITIONS[partition].join(',')};heap=4096`;
  hash.update(`accuracy-result-v8\0${partition}\0${contract}\0`);
  for (const relative of selectedFiles) {
    const fullPath = path.join(root, relative);
    hash.update(relative);
    hash.update('\0');

    // Once traversal selected an input, hashing must either account for its
    // identity/bytes or fail closed. Do not turn EACCES/EIO/races into an
    // apparently valid digest with an empty payload.
    const lstat = fsImpl.lstatSync(fullPath);
    if (lstat.isSymbolicLink()) {
      const linkText = fsImpl.readlinkSync(fullPath);
      const afterReadlink = fsImpl.lstatSync(fullPath);
      if (!afterReadlink.isSymbolicLink() || !sameFileIdentity(lstat, afterReadlink)) {
        throw new Error(`accuracy cache key: selected symlink identity changed before hashing: ${relative}`);
      }
      hash.update('symlink:');
      hash.update(linkText);
      hash.update('\0');
      let realTarget;
      try {
        realTarget = fsImpl.realpathSync(fullPath);
      } catch (error) {
        // A target that is already broken at the byte-consumption boundary is
        // an intentional, represented symlink state (#9199).
        if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') {
          hash.update('\0');
          continue;
        }
        throw error;
      }
      if (!pathIsWithin(allowedRealRoot, realTarget)) {
        throw new Error(`accuracy cache key: selected input escapes repository while hashing: ${relative}`);
      }
      const targetStat = fsImpl.statSync(fullPath);
      if (targetStat.isFile()) {
        hash.update(readBoundRegularFile(realTarget, targetStat, allowedRealRoot, fsImpl));
      }
      const finalLink = fsImpl.lstatSync(fullPath);
      const finalRealTarget = fsImpl.realpathSync(fullPath);
      if (!finalLink.isSymbolicLink()
          || !sameFileIdentity(lstat, finalLink)
          || finalRealTarget !== realTarget) {
        throw new Error(`accuracy cache key: selected symlink identity changed during hashing: ${relative}`);
      }
    } else if (lstat.isFile()) {
      hash.update(readBoundRegularFile(fullPath, lstat, allowedRealRoot, fsImpl));
      const finalEntry = fsImpl.lstatSync(fullPath);
      if (!finalEntry.isFile() || finalEntry.isSymbolicLink() || !sameFileIdentity(lstat, finalEntry)) {
        throw new Error(`accuracy cache key: selected input identity changed during hashing: ${relative}`);
      }
    } else {
      throw new Error(`selected accuracy input is not a file or symlink: ${relative}`);
    }
    hash.update('\0');
  }
  return hash.digest('hex');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3) {
    console.error('Usage: accuracy-partition-cache-key.mjs <partition>');
    process.exit(1);
  }
  process.stdout.write(partitionDigest(ROOT, process.argv[2]) + '\n');
}
