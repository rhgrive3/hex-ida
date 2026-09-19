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
export const DEFAULT_FIXTURE_DOWNLOAD_TIMEOUT_MS = 120_000;

export class FixtureDownloadTimeoutError extends Error {
  constructor(name, timeoutMs) {
    super(`${name}: fixture download timed out after ${timeoutMs}ms`);
    this.name = 'FixtureDownloadTimeoutError';
  }
}

function createDownloadDeadline(name, timeoutMs) {
  const ms = Number(timeoutMs);
  if (!Number.isFinite(ms) || ms <= 0) throw new TypeError('fixture download timeout must be a positive finite number');
  const controller = new AbortController();
  const reason = new FixtureDownloadTimeoutError(name, ms);
  const timer = setTimeout(() => controller.abort(reason), ms);
  return Object.freeze({
    controller,
    reason,
    clear() { clearTimeout(timer); },
  });
}

function abortReason(signal, fallback) {
  if (signal?.aborted && signal.reason instanceof FixtureDownloadTimeoutError) return signal.reason;
  return fallback;
}

function raceWithAbort(value, signal) {
  if (!signal) return Promise.resolve(value);
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(value).then(
      (result) => {
        signal.removeEventListener('abort', onAbort);
        resolve(result);
      },
      (error) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

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

export async function fetchWithHttpsRedirects(initialUrl, maxRedirects = 10, {
  fetchImpl = globalThis.fetch,
  signal = null,
  timeoutMs = DEFAULT_FIXTURE_DOWNLOAD_TIMEOUT_MS,
} = {}) {
  const ownedDeadline = signal ? null : createDownloadDeadline('fixture request', timeoutMs);
  const activeSignal = signal || ownedDeadline.controller.signal;
  let currentUrl = initialUrl;
  let redirects = 0;
  try {
    while (true) {
      if (!/^https:\/\//i.test(currentUrl)) {
        throw new Error(`Insecure redirect URL or downgrade forbidden: ${currentUrl}`);
      }
      const response = await raceWithAbort(
        fetchImpl(currentUrl, { redirect: 'manual', signal: activeSignal }),
        activeSignal,
      );
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        redirects++;
        if (redirects > maxRedirects) {
          await raceWithAbort(releaseBody(response), activeSignal);
          throw new Error('Too many HTTP redirects');
        }
        const location = response.headers?.get?.('location') ?? response.headers?.location;
        if (!location) {
          await raceWithAbort(releaseBody(response), activeSignal);
          throw new Error('Redirect missing Location header');
        }
        try {
          currentUrl = new URL(location, currentUrl).href;
        } catch (err) {
          await raceWithAbort(releaseBody(response), activeSignal);
          throw err;
        }
        await raceWithAbort(releaseBody(response), activeSignal);
        continue;
      }
      return response;
    }
  } catch (error) {
    throw abortReason(activeSignal, error);
  } finally {
    ownedDeadline?.clear();
  }
}

export async function fetchFixture(name, spec, {
  verifyImpl = verify,
  fetchImpl = fetchWithHttpsRedirects,
  timeoutMs = DEFAULT_FIXTURE_DOWNLOAD_TIMEOUT_MS,
} = {}) {
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
  const deadline = createDownloadDeadline(name, timeoutMs);
  const { signal } = deadline.controller;
  let response = null;
  let output = null;
  let streamError = null;

  try {
    response = await raceWithAbort(
      fetchImpl(url, 10, { signal, timeoutMs }),
      signal,
    );
    if (!response.ok || !response.body) {
      await raceWithAbort(releaseBody(response), signal);
      const status = response.status;
      response = null;
      throw new Error(`${name}: download failed with HTTP ${status}`);
    }

    const hash = createHash('sha256');
    output = fs.createWriteStream(temp, { flags:'wx', mode:0o600 });
    output.on('error', (err) => { streamError = streamError || err; });
    let size = 0;
    async function* validateAndHash(source) {
      for await (const chunk of source) {
        const bytes = Buffer.from(chunk);
        size += bytes.length;
        if (size > spec.size) throw new Error(`${name}: download exceeded pinned size`);
        hash.update(bytes);
        yield bytes;
      }
    }
    await raceWithAbort(pipeline(validateAndHash(response.body), output, { signal }), signal);
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
    if (output && !output.closed) {
      const outputClosed = new Promise((resolve) => output.once('close', resolve));
      output.destroy();
      await outputClosed;
    } else {
      output?.destroy();
    }
    if (signal.aborted && response?.body) {
      // pipeline abort normally destroys the body; this is a best-effort final
      // release for custom response bodies without waiting beyond the deadline.
      try { response.body.destroy?.(); } catch {}
      try { void response.body.cancel?.(); } catch {}
    }
    await rm(temp, { force:true });
    throw abortReason(signal, streamError || error);
  } finally {
    deadline.clear();
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
