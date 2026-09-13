#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const argv = process.argv.slice(2);

function getOption(names, fallback = null) {
  const values = [];
  for (let index = 0; index < argv.length; index += 1) {
    if (!names.includes(argv[index])) continue;
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new Error(names.join('/') + ' requires a value');
    }
    values.push(value);
  }
  if (values.length > 1) throw new Error(names.join('/') + ' may be supplied only once');
  return values[0] ?? fallback;
}

async function assertRealDirectory(directory, label) {
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(label + ' must be a real directory: ' + directory);
  }
  if (await fs.realpath(directory) !== directory) {
    throw new Error(label + ' resolves outside its expected path: ' + directory);
  }
}

async function assertAbsent(target) {
  try {
    await fs.lstat(target);
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  throw new Error('refusing to overwrite existing output: ' + target);
}

const sourceArgument = getOption(['--source']);
const source = sourceArgument || process.env.HEX_PUBLIC_BENCH_SOURCE || null;
const suite = getOption(['--suite'], 'codefuse-arm64');
const outputArgument = getOption(['--output', '--out']);
if (!source) throw new Error('prepare requires --source <CodeFuse-DeBench checkout/extraction>');
if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(suite) || suite === '.' || suite === '..') {
  throw new Error('suite must be a simple directory name');
}

const repositoryRoot = await fs.realpath(process.cwd());
const benchmarksRoot = path.join(repositoryRoot, 'benchmarks');
const publicRoot = path.join(benchmarksRoot, 'public');
await assertRealDirectory(benchmarksRoot, 'benchmarks');
await assertRealDirectory(publicRoot, 'benchmarks/public');

const outputDirectory = path.join(publicRoot, suite);
const manifestPath = path.join(outputDirectory, 'manifest.json');
if (outputArgument !== null) {
  const requestedPath = path.resolve(repositoryRoot, outputArgument);
  if (requestedPath !== manifestPath) {
    throw new Error('--output/--out must target ' + path.relative(repositoryRoot, manifestPath));
  }
}

const lockPath = path.join(publicRoot, '.' + suite + '.prepare.lock');
let lockHandle;
try {
  lockHandle = await fs.open(lockPath, 'wx', 0o600);
} catch (error) {
  if (error.code === 'EEXIST') {
    throw new Error('another preparation is active, or a stale lock exists: ' + lockPath);
  }
  throw error;
}

const stageDirectory = path.join(
  publicRoot,
  '.' + suite + '.stage-' + process.pid + '-' + crypto.randomBytes(8).toString('hex'),
);
let stageOwned = false;
try {
  await assertAbsent(outputDirectory);
  await fs.mkdir(stageDirectory, { mode: 0o700 });
  stageOwned = true;

  const root = await fs.realpath(source);
  const build = path.join(root, 'build', 'arm64');
  const ida = path.join(root, 'decompiled', 'ida_out', 'arm64');
  const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
  const files = [];

  async function walk(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const currentPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(currentPath);
      } else if (entry.isFile()) {
        files.push(currentPath);
      } else {
        throw new Error('unsupported non-file input: ' + currentPath);
      }
    }
  }

  await walk(build);
  const cases = [];
  for (const binary of files.sort()) {
    const relativePath = path.relative(build, binary);
    const referencePath = path.join(ida, relativePath + '.c');
    try {
      const [binaryBytes, referenceBytes] = await Promise.all([
        fs.readFile(binary),
        fs.readFile(referencePath),
      ]);
      const referenceText = referenceBytes.toString('utf8');
      if (!/Decompiled by IDA Pro 9\.1 with Hex-Rays/.test(referenceText.slice(0, 1024))) {
        throw new Error('IDA identity mismatch: ' + relativePath);
      }
      const binarySha = sha(binaryBytes);
      const referenceSha = sha(referenceBytes);
      const opaqueBinary = 'inputs/' + binarySha + '.bin';
      const frozenReference = 'reference/' + relativePath.split(path.sep).join('/') + '.c';
      const binaryOutput = path.join(stageDirectory, opaqueBinary);
      const referenceOutput = path.join(stageDirectory, frozenReference);
      await fs.mkdir(path.dirname(binaryOutput), { recursive: true });
      await fs.writeFile(binaryOutput, binaryBytes);
      await fs.mkdir(path.dirname(referenceOutput), { recursive: true });
      await fs.writeFile(referenceOutput, referenceBytes, { flag: 'wx' });

      const baseName = path.basename(relativePath);
      const compilerMatch = baseName.match(/_(clang|gcc)_(O0|O1|O2|O3|Os)_(g|no_g)$/);
      cases.push({
        id: relativePath.split(path.sep).join('/'),
        binary: opaqueBinary,
        binarySha256: binarySha,
        reference: {
          path: frozenReference,
          sha256: referenceSha,
          product: 'IDA Pro',
          version: '9.1',
          engine: 'Hex-Rays',
        },
        architecture: 'arm64',
        compiler: compilerMatch?.[1] ?? null,
        optimization: compilerMatch?.[2] ?? null,
        debug: compilerMatch ? compilerMatch[3] === 'g' : null,
      });
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }

  cases.sort((left, right) => left.id.localeCompare(right.id));
  if (!cases.length) throw new Error('no matched ARM64 binary/IDA pairs');

  const manifest = {
    schema: 'hex-public-benchmark-manifest/v1',
    suite,
    reference: {
      product: 'IDA Pro',
      version: '9.1',
      engine: 'Hex-Rays',
      scope: 'CodeFuse-DeBench published artifact',
    },
    denominatorFrozen: true,
    frozenAt: new Date().toISOString(),
    cases,
  };
  await fs.writeFile(
    path.join(stageDirectory, 'manifest.json'),
    JSON.stringify(manifest, null, 2) + '\n',
    { flag: 'wx' },
  );

  await assertAbsent(outputDirectory);
  await fs.rename(stageDirectory, outputDirectory);
  stageOwned = false;
  console.log('prepared ' + cases.length + ' frozen cases -> ' + manifestPath);
} finally {
  try {
    if (stageOwned) await fs.rm(stageDirectory, { recursive: true, force: true });
  } finally {
    await lockHandle.close();
    try {
      await fs.unlink(lockPath);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
}
