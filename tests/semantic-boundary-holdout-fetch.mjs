/*
 * Regression for the pinned real-game holdout fetcher.
 *
 * The holdout is release evidence, so its producer must fail closed: a wrong
 * archive, a wrong member, a moved artifact or a manifest that only *looks*
 * pinned may never publish something a promotion decision can rest on. This
 * test exercises the archive reader, the manifest validator and the identity
 * check without touching the network.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import {
  HoldoutFetchError,
  extractZipMember,
  fetchRealGameHoldout,
  loadHoldoutManifest,
  readZipDirectory,
  sha256,
} from '../scripts/fetch-real-game-holdout.mjs';

function crc32(buffer) {
  let table = crc32.table;
  if (!table) {
    table = crc32.table = new Int32Array(256);
    for (let index = 0; index < 256; index++) {
      let value = index;
      for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xEDB88320 ^ (value >>> 1) : value >>> 1;
      table[index] = value;
    }
  }
  let crc = -1;
  for (const byte of buffer) crc = (crc >>> 8) ^ table[(crc ^ byte) & 0xFF];
  return (crc ^ -1) >>> 0;
}

/** Builds a single-disk ZIP archive with stored/deflate members. */
function buildZip(members) {
  const chunks = [];
  const directory = [];
  let offset = 0;
  for (const member of members) {
    const name = Buffer.from(member.name, 'utf8');
    const raw = Buffer.from(member.data);
    const stored = member.method !== 8;
    const payload = stored ? raw : zlib.deflateRawSync(raw);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(stored ? 0 : 8, 8);
    local.writeUInt32LE(crc32(raw), 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    chunks.push(local, name, payload);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(stored ? 0 : 8, 10);
    entry.writeUInt32LE(crc32(raw), 16);
    entry.writeUInt32LE(payload.length, 20);
    entry.writeUInt32LE(raw.length, 24);
    entry.writeUInt16LE(name.length, 28);
    entry.writeUInt32LE(offset, 42);
    directory.push(entry, name);
    offset += local.length + name.length + payload.length;
  }
  const body = Buffer.concat(chunks);
  const central = Buffer.concat(directory);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(members.length, 8);
  eocd.writeUInt16LE(members.length, 10);
  eocd.writeUInt32LE(central.length, 12);
  eocd.writeUInt32LE(body.length, 16);
  return Buffer.concat([body, central, eocd]);
}

function expectFail(code, fn) {
  assert.throws(fn, (error) => {
    assert.ok(error instanceof HoldoutFetchError, `expected HoldoutFetchError, got ${error}`);
    assert.equal(error.code, code);
    return true;
  });
}

const archive = buildZip([
  { name: 'bundle/', data: Buffer.alloc(0) },
  { name: 'bundle/tool', data: Buffer.from('stored-member-bytes'), method: 0 },
  { name: 'bundle/tool-deflated', data: Buffer.from('deflated-member-bytes'.repeat(64)), method: 8 },
]);

// 1. The archive reader trusts the central directory and verifies local headers.
{
  const entries = readZipDirectory(archive);
  assert.deepEqual(entries.map((entry) => entry.name), ['bundle/', 'bundle/tool', 'bundle/tool-deflated']);
  const stored = entries.find((entry) => entry.name === 'bundle/tool');
  assert.equal(extractZipMember(archive, stored).toString('utf8'), 'stored-member-bytes');
  const deflated = entries.find((entry) => entry.name === 'bundle/tool-deflated');
  assert.equal(extractZipMember(archive, deflated).toString('utf8'), 'deflated-member-bytes'.repeat(64));
  expectFail('holdout-member-unknown', () => extractZipMember(archive, readZipDirectory(archive).find((entry) => entry.name === 'nope')));
  expectFail('holdout-member-name-mismatch', () => extractZipMember(archive, { ...stored, name: 'bundle/other' }));
  expectFail('holdout-member-compression-unsupported', () => extractZipMember(archive, { ...stored, method: 12 }));
  expectFail('holdout-member-header-corrupt', () => extractZipMember(archive, { ...stored, localOffset: archive.length - 1 }));
  expectFail('holdout-archive-not-a-zip', () => readZipDirectory(Buffer.alloc(64, 7)));
}

const PINNED = {
  schema: 'hex-real-game-boundary-holdout/v1',
  kind: 'test-fixture',
  upstream: { repository: 'https://example.invalid/game.git', tag: 'v1', commit: 'a'.repeat(40), license: 'GPL-2.0' },
  artifactPolicy: { checkedIn: false },
  artifacts: [{
    id: 'test-game',
    archive: { url: 'https://example.invalid/game-v1-arm64.zip', name: 'game-v1-arm64.zip', bytes: archive.length, sha256: sha256(archive) },
    binary: { path: 'bundle/tool', file: 'tool', format: 'Mach-O', arch: 'arm64', bytes: 19, sha256: sha256(Buffer.from('stored-member-bytes')) },
  }],
  policies: {
    ambiguity: { schema: 'hex-semantic-boundary-ambiguity/v1', maxD4D5Gap: 0.02, minD4Score: 0 },
    admission: { schema: 'hex-semantic-boundary-admission/v1', minProbability: 0.8, minMargin: 0.2 },
  },
  cases: [{ goal: 'hp', field: 'mobj_t.health', offset: 196, expectedCandidateCount: 8, expectedDeterministicRank: 4, boundaryTruthReachable: true, deterministicTopOffset: 148, deterministicTopIsTruth: false }],
};

const work = await mkdtemp(path.join(os.tmpdir(), 'hex-holdout-fetch-'));
try {
  const manifestPath = path.join(work, 'manifest.json');
  const holdoutDir = path.join(work, 'out');
  await writeFile(manifestPath, JSON.stringify(PINNED, null, 2));
  fs.mkdirSync(holdoutDir, { recursive: true });

  // 2. Manifest validation rejects anything that is not exactly pinned.
  {
    const loaded = loadHoldoutManifest(manifestPath);
    assert.equal(loaded.artifacts[0].binary.arch, 'arm64');
    const variants = [
      [{ schema: 'other' }, 'holdout-manifest-schema'],
      [{ artifacts: [] }, 'holdout-manifest-artifacts'],
      [{ artifacts: [{ ...PINNED.artifacts[0], archive: { ...PINNED.artifacts[0].archive, sha256: 'nope' } }] }, 'invalid-pinned-digest'],
      [{ artifacts: [{ ...PINNED.artifacts[0], archive: { ...PINNED.artifacts[0].archive, bytes: 0 } }] }, 'invalid-pinned-size'],
      [{ artifacts: [{ ...PINNED.artifacts[0], binary: { ...PINNED.artifacts[0].binary, arch: 'x86_64' } }] }, 'holdout-binary-arch'],
      [{ artifacts: [{ ...PINNED.artifacts[0], archive: { ...PINNED.artifacts[0].archive, url: 'http://example.invalid/x.zip' } }] }, 'holdout-artifact-url'],
    ];
    for (const [patch, code] of variants) {
      const broken = path.join(work, `broken-${code}.json`);
      await writeFile(broken, JSON.stringify({ ...PINNED, ...patch }));
      expectFail(code, () => loadHoldoutManifest(broken));
    }
  }

  // 3. `--check` verifies the published artifact against the pinned identity and
  //    fails closed when the bytes or the pin move.
  {
    const artifactFile = path.join(holdoutDir, PINNED.artifacts[0].binary.file);
    await writeFile(artifactFile, Buffer.from('stored-member-bytes'));
    const checked = await fetchRealGameHoldout({ manifestPath, holdoutDir, check: true });
    assert.equal(checked.artifacts[0].sha256, PINNED.artifacts[0].binary.sha256);

    await writeFile(artifactFile, Buffer.from('stored-member-bytez'));
    await assert.rejects(() => fetchRealGameHoldout({ manifestPath, holdoutDir, check: true }),
      (error) => error.code === 'holdout-sha256-mismatch');

    await writeFile(artifactFile, Buffer.from('stored-member-bytes'));
    const repinned = path.join(work, 'repinned.json');
    const moved = JSON.parse(JSON.stringify(PINNED));
    moved.artifacts[0].binary.sha256 = 'f'.repeat(64);
    await writeFile(repinned, JSON.stringify(moved));
    await assert.rejects(() => fetchRealGameHoldout({ manifestPath: repinned, holdoutDir, check: true }),
      (error) => error.code === 'holdout-sha256-mismatch');

    await rm(artifactFile, { force: true });
    await assert.rejects(() => fetchRealGameHoldout({ manifestPath, holdoutDir, check: true }),
      (error) => error.code === 'holdout-artifact-missing');
  }
} finally {
  await rm(work, { recursive: true, force: true });
}

process.stdout.write('  ok  real-game holdout fetch fails closed on identity drift\n');
