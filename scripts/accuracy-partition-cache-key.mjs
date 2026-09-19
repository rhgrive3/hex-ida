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

function walk(dir, root, out, visitedDirs = new Set()) {
  if (!fs.existsSync(dir)) return;
  try {
    const realDir = fs.realpathSync(dir);
    if (visitedDirs.has(realDir)) return;
    visitedDirs.add(realDir);
  } catch {
    return;
  }

  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const absolute = path.join(dir, entry.name);

    if (entry.isSymbolicLink()) {
      out.push(slash(path.relative(root, absolute)));
      try {
        const stat = fs.statSync(absolute);
        if (stat.isDirectory()) {
          walk(absolute, root, out, visitedDirs);
        }
      } catch {
        // Broken symlink target cannot be resolved; entry was recorded above
      }
      continue;
    }

    if (entry.isDirectory()) {
      walk(absolute, root, out, visitedDirs);
    } else if (entry.isFile()) {
      out.push(slash(path.relative(root, absolute)));
    }
  }
}

export function partitionFiles(root = ROOT, partition) {
  if (!Object.hasOwn(PARTITIONS, partition)) throw new Error(`unknown accuracy partition: ${partition}`);
  const files=[];
  walk(path.join(root, 'js'), root, files);
  const semanticFamily = partition.startsWith('pseudoc-') ? 'pseudoc' : partition;
  const selected=files.filter((relative)=>{
    if (GLOBAL_EXCLUDED_PREFIXES.some((prefix)=>relative.startsWith(prefix))) return false;
    if ((semanticFamily === 'core' || semanticFamily === 'pseudoc') && PINPOINT_ONLY_FILES.has(relative)) return false;
    if (semanticFamily === 'pinpoint' && PSEUDOC_ONLY_PREFIXES.some((prefix)=>relative.startsWith(prefix))) return false;
    return true;
  });
  for (const relative of [...COMMON_FILES, ...(partition.startsWith('pseudoc-') ? PSEUDOC_FILES : [])]) {
    if (fs.existsSync(path.join(root, relative))) selected.push(relative);
  }
  return [...new Set(selected)].sort();
}

export function partitionDigest(root = ROOT, partition, {
  fsImpl = fs,
  partitionFilesImpl = partitionFiles,
} = {}) {
  if (!Object.hasOwn(PARTITIONS, partition)) throw new Error(`unknown accuracy partition: ${partition}`);
  const hash=crypto.createHash('sha256');
  const pseudoc=partition.startsWith('pseudoc-');
  const contract=pseudoc
    ? `kind=pseudoc;features=pseudoc;heap=2600;workers=2;shard=${partition.slice('pseudoc-'.length)}/4`
    : `kind=nonpseudoc;features=${PARTITIONS[partition].join(',')};heap=4096`;
  hash.update(`accuracy-result-v8\0${partition}\0${contract}\0`);
  for (const relative of partitionFilesImpl(root, partition)) {
    const fullPath = path.join(root, relative);
    hash.update(relative);
    hash.update('\0');

    // Once traversal selected an input, hashing must either account for its
    // identity/bytes or fail closed. Do not turn EACCES/EIO/races into an
    // apparently valid digest with an empty payload.
    const lstat = fsImpl.lstatSync(fullPath);
    if (lstat.isSymbolicLink()) {
      hash.update('symlink:');
      hash.update(fsImpl.readlinkSync(fullPath));
      hash.update('\0');
      try {
        const stat = fsImpl.statSync(fullPath);
        if (stat.isFile()) hash.update(fsImpl.readFileSync(fullPath));
      } catch (error) {
        // A broken target is an intentional, already-represented symlink state
        // (#9199). Other failures mean the selected input could not be hashed.
        if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') throw error;
      }
    } else if (lstat.isFile()) {
      hash.update(fsImpl.readFileSync(fullPath));
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
