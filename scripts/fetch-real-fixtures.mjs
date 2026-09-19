#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import path, { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const manifest = JSON.parse(await (await import('node:fs/promises')).readFile(join(root, 'tests/fixtures/real-binaries.json'), 'utf8'));
const outputDir = join(root, 'tests/.real-fixtures');
const args = process.argv.slice(2);
const checkOnly = args.includes('--check');
const requested = args.filter((arg) => arg !== '--check');

export function fixture(name) {
  const spec = manifest.fixtures[name];
  if (!spec) throw new Error(`unknown fixture: ${name}`);
  return spec;
}

export function selectedFixtureNames() {
  // `all` widens the selected set, but it must not erase explicit selectors.
  // Validate every explicit fixture name first so `all typo` cannot silently
  // turn a misspelled targeted command into a successful all-fixture run (#9143).
  for (const name of requested) {
    if (name !== 'all') fixture(name);
  }
  return requested.length && !requested.includes('all') ? requested : Object.keys(manifest.fixtures);
}

export async function digestFile(path) {
  const hash = createHash('sha256');
  let size = 0;
  for await (const chunk of fs.createReadStream(path)) {
    size += chunk.length;
    hash.update(chunk);
  }
  return { size, sha256: hash.digest('hex') };
}

class FixtureVerificationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'FixtureVerificationError';
    this.repairable = true;
  }
}

function invalidFixture(message) {
  return new FixtureVerificationError(message);
}

export async function verify(name, path, spec, { statImpl = stat, digestFileImpl = digestFile } = {}) {
  let info;
  try {
    info = await statImpl(path);
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') {
      throw invalidFixture(`${name}: fixture is missing at ${path}`);
    }
    throw error;
  }
  if (!info.isFile()) throw invalidFixture(`${name}: fixture path is not a file`);
  if (info.size !== spec.size) throw invalidFixture(`${name}: size mismatch (${info.size} != ${spec.size})`);
  const digest = await digestFileImpl(path);
  if (digest.sha256 !== spec.sha256) throw invalidFixture(`${name}: SHA-256 mismatch`);
  return digest;
}

export async function releaseBody(response) {
  try {
    if (typeof response?.body?.cancel === 'function') {
      await response.body.cancel();
    } else if (typeof response?.body?.destroy === 'function') {
      response.body.destroy();
    }
  } catch {}
}

export async function fetchWithHttpsRedirects(initialUrl, maxRedirects = 10) {
  let currentUrl = initialUrl;
  let redirects = 0;
  while (true) {
    if (!/^https:\/\//i.test(currentUrl)) {
      throw new Error(`Insecure redirect URL or downgrade forbidden: ${currentUrl}`);
    }
    const response = await fetch(currentUrl, { redirect: 'manual' });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      redirects++;
      if (redirects > maxRedirects) {
        await releaseBody(response);
        throw new Error('Too many HTTP redirects');
      }
      const location = response.headers?.get?.('location') ?? response.headers?.location;
      if (!location) {
        await releaseBody(response);
        throw new Error('Redirect missing Location header');
      }
      try {
        currentUrl = new URL(location, currentUrl).href;
      } catch (err) {
        await releaseBody(response);
        throw err;
      }
      await releaseBody(response);
      continue;
    }
    return response;
  }
}

export async function fetchFixture(name, spec, { verifyImpl = verify, fetchImpl = fetchWithHttpsRedirects } = {}) {
  const target = join(outputDir, spec.file);
  try {
    await verifyImpl(name, target, spec);
    console.log(`${name}: verified existing fixture`);
    return;
  } catch (error) {
    if (checkOnly || error?.repairable !== true) throw error;
  }

  const url = process.env[spec.urlEnv];
  if (!url) throw new Error(`${name}: set ${spec.urlEnv} to the fixture download URL`);
  if (!/^https:\/\//i.test(url)) throw new Error(`${name}: fixture URL must use HTTPS`);

  await mkdir(dirname(target), { recursive:true });
  const temp = `${target}.partial-${process.pid}-${randomUUID()}`;
  const response = await fetchImpl(url);
  if (!response.ok || !response.body) {
    await releaseBody(response);
    throw new Error(`${name}: download failed with HTTP ${response.status}`);
  }

  const hash = createHash('sha256');
  const output = fs.createWriteStream(temp, { flags:'wx', mode:0o600 });
  let streamError = null;
  output.on('error', (err) => { streamError = streamError || err; });
  let size = 0;
  try {
    async function* validateAndHash(source) {
      for await (const chunk of source) {
        const bytes = Buffer.from(chunk);
        size += bytes.length;
        if (size > spec.size) throw new Error(`${name}: download exceeded pinned size`);
        hash.update(bytes);
        yield bytes;
      }
    }
    await pipeline(validateAndHash(response.body), output);
    const sha256 = hash.digest('hex');
    if (size !== spec.size) throw new Error(`${name}: size mismatch (${size} != ${spec.size})`);
    if (sha256 !== spec.sha256) throw new Error(`${name}: SHA-256 mismatch`);
    try {
      await verifyImpl(name, target, spec);
      await rm(temp, { force: true });
      console.log(`${name}: downloaded and verified`);
      return;
    } catch {}
    try {
      await rename(temp, target);
    } catch (renameErr) {
      if (renameErr.code === 'EEXIST' || renameErr.code === 'EPERM' || process.platform === 'win32') {
        await rm(target, { force: true });
        await rename(temp, target);
      } else {
        throw renameErr;
      }
    }
    console.log(`${name}: downloaded and verified`);
  } catch (error) {
    output.destroy();
    await rm(temp, { force:true });
    throw streamError || error;
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    for (const name of selectedFixtureNames()) await fetchFixture(name, fixture(name));
  } catch (error) {
    console.error(error && error.message ? error.message : String(error));
    process.exitCode = 1;
  }
}
