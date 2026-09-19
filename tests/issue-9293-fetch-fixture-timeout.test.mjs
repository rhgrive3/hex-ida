import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { fetchFixture, fetchWithHttpsRedirects } from '../scripts/fetch-real-fixtures.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'tests/.real-fixtures');

async function cleanFixtureArtifacts(file) {
  await rm(path.join(OUT, file), { force: true });
  if (!fs.existsSync(OUT)) return;
  for (const name of fs.readdirSync(OUT)) {
    if (name.startsWith(`${file}.partial-`)) await rm(path.join(OUT, name), { force: true });
  }
}

function repairableMissing() {
  const error = new Error('missing');
  error.repairable = true;
  throw error;
}

function abortAwareNever(signal) {
  return new Promise((_, reject) => {
    if (signal.aborted) return reject(signal.reason);
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
}

test('#9293 request/header acquisition has a finite deadline', async () => {
  await assert.rejects(
    () => fetchWithHttpsRedirects('https://fixtures.test/stall', 10, {
      timeoutMs: 20,
      fetchImpl: async (_url, { signal }) => abortAwareNever(signal),
    }),
    /fixture download timed out after 20ms/,
  );
});

test('#9293 redirect traversal shares the finite deadline and releases prior bodies', async () => {
  let hop = 0;
  let cancelled = 0;
  await assert.rejects(
    () => fetchWithHttpsRedirects('https://fixtures.test/start', 10, {
      timeoutMs: 20,
      fetchImpl: async (_url, { signal }) => {
        hop += 1;
        if (hop === 1) {
          return {
            status: 302,
            headers: new Headers({ location: 'https://fixtures.test/stall' }),
            body: { cancel: async () => { cancelled += 1; } },
          };
        }
        return abortAwareNever(signal);
      },
    }),
    /fixture download timed out after 20ms/,
  );
  assert.equal(cancelled, 1);
});

test('#9293 stalled final body is aborted and partial output is removed', async () => {
  const envKey = 'HEX_ISSUE_9293_STALL_URL';
  const file = 'issue-9293-stall.bin';
  const target = path.join(OUT, file);
  process.env[envKey] = 'https://fixtures.test/stall-body';
  await cleanFixtureArtifacts(file);
  try {
    let pushed = false;
    const body = new Readable({
      read() {
        if (!pushed) {
          pushed = true;
          this.push(Buffer.from('prefix'));
        }
      },
    });
    await assert.rejects(
      () => fetchFixture('issue-9293-stall', {
        file,
        size: 32,
        sha256: '0'.repeat(64),
        urlEnv: envKey,
      }, {
        verifyImpl: async () => repairableMissing(),
        timeoutMs: 25,
        fetchImpl: async () => ({ ok: true, status: 200, body }),
      }),
      /issue-9293-stall: fixture download timed out after 25ms/,
    );
    assert.equal(fs.existsSync(target), false);
    const leftovers = fs.existsSync(OUT) ? fs.readdirSync(OUT).filter((name) => name.startsWith(`${file}.partial-`)) : [];
    assert.deepEqual(leftovers, []);
  } finally {
    delete process.env[envKey];
    await cleanFixtureArtifacts(file);
  }
});

test('#9293 complete body before deadline still verifies and publishes', async () => {
  const envKey = 'HEX_ISSUE_9293_VALID_URL';
  const file = 'issue-9293-valid.bin';
  const target = path.join(OUT, file);
  const bytes = Buffer.from('complete-before-deadline');
  process.env[envKey] = 'https://fixtures.test/valid';
  await cleanFixtureArtifacts(file);
  try {
    await fetchFixture('issue-9293-valid', {
      file,
      size: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      urlEnv: envKey,
    }, {
      verifyImpl: async () => repairableMissing(),
      timeoutMs: 500,
      fetchImpl: async () => ({ ok: true, status: 200, body: Readable.from([bytes]) }),
    });
    assert.deepEqual(fs.readFileSync(target), bytes);
  } finally {
    delete process.env[envKey];
    await cleanFixtureArtifacts(file);
  }
});

test('#9293 already-valid cache does not start a network deadline', async () => {
  let fetched = false;
  await fetchFixture('issue-9293-cached', {
    file: 'issue-9293-cached.bin',
    size: 1,
    sha256: '0'.repeat(64),
    urlEnv: 'HEX_ISSUE_9293_UNUSED_URL',
  }, {
    verifyImpl: async () => ({ size: 1, sha256: '0'.repeat(64) }),
    timeoutMs: 1,
    fetchImpl: async () => { fetched = true; throw new Error('must not fetch'); },
  });
  assert.equal(fetched, false);
});
