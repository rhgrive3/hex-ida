#!/usr/bin/env node
/*
 * Pinned real-game holdout fetcher for the OpenJev boundary referee.
 *
 * The holdout artifact is a real, upstream, ARM64 game release binary. Like the
 * existing `tests/.real-fixtures` lane, the bytes stay outside the repository:
 * the upstream build is GPL-licensed (see the manifest `upstream.license`), so
 * only the pinned identity (repository/tag/commit, asset name, byte size and
 * sha256) is committed. The measuring harness reads the extracted artifact from
 * `HEX_SEMANTIC_BOUNDARY_HOLDOUT_ARTIFACT`.
 *
 * Contract:
 * - The manifest is the single source of truth for every pinned identity.
 * - Every downloaded archive and every extracted member is verified against its
 *   pinned size and sha256 before it is used; a mismatch is fatal.
 * - Extraction is deterministic and dependency-free (stored/deflate members
 *   only, bounded sizes) and writes atomically (tmp + rename), so a failed or
 *   partial producer never publishes a holdout artifact (see
 *   docs/ENGINEERING_PROCESS_GUARDRAILS.md EP-015).
 * - `--check` verifies an already-extracted artifact and never downloads.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
export const HOLDOUT_SCHEMA = 'hex-real-game-boundary-holdout/v1';
export const DEFAULT_MANIFEST_PATH = path.join(ROOT, 'tests/fixtures/real-game-boundary-holdout.manifest.json');
export const DEFAULT_HOLDOUT_DIR = path.join(ROOT, 'tests/.real-game-holdout');
export const DEFAULT_DOWNLOAD_TIMEOUT_MS = 300_000;
export const MAX_ARCHIVE_BYTES = 512 * 1024 * 1024;
export const MAX_MEMBER_BYTES = 256 * 1024 * 1024;

export class HoldoutFetchError extends Error {
  constructor(code, detail) {
    super(`${code}${detail ? `: ${detail}` : ''}`);
    this.name = 'HoldoutFetchError';
    this.code = code;
  }
}

function fail(code, detail) {
  throw new HoldoutFetchError(code, detail);
}

export function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function exactDigest(value, label) {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) fail('invalid-pinned-digest', label);
  return value;
}

function exactSize(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) fail('invalid-pinned-size', label);
  return value;
}

function assertIdentity(actual, expected, label) {
  if (actual.bytes !== expected.bytes) {
    fail('holdout-size-mismatch', `${label}: expected ${expected.bytes} got ${actual.bytes}`);
  }
  if (actual.sha256 !== expected.sha256) {
    fail('holdout-sha256-mismatch', `${label}: expected ${expected.sha256} got ${actual.sha256}`);
  }
}

/* ------------------------------------------------------------------ ZIP --- */

function findEndOfCentralDirectory(buffer) {
  const minimum = Math.max(0, buffer.length - 0xFFFF - 22);
  for (let offset = buffer.length - 22; offset >= minimum; offset--) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) return offset;
  }
  fail('holdout-archive-not-a-zip');
}

/**
 * Returns `{ name, method, compressedBytes, uncompressedBytes, localOffset }`
 * for every member of a single-disk ZIP archive. Only the central directory is
 * trusted; the local headers are re-read later and their name must match.
 */
export function readZipDirectory(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 22) fail('holdout-archive-too-small');
  const eocd = findEndOfCentralDirectory(buffer);
  const entryCount = buffer.readUInt16LE(eocd + 10);
  const directoryOffset = buffer.readUInt32LE(eocd + 16);
  if (!entryCount) fail('holdout-archive-empty');
  if (directoryOffset >= buffer.length) fail('holdout-archive-directory-out-of-range');
  const entries = [];
  let cursor = directoryOffset;
  for (let index = 0; index < entryCount; index++) {
    if (cursor + 46 > buffer.length || buffer.readUInt32LE(cursor) !== 0x02014b50) {
      fail('holdout-archive-directory-corrupt', `entry ${index}`);
    }
    const nameBytes = buffer.readUInt16LE(cursor + 28);
    const extraBytes = buffer.readUInt16LE(cursor + 30);
    const commentBytes = buffer.readUInt16LE(cursor + 32);
    const method = buffer.readUInt16LE(cursor + 10);
    const name = buffer.toString('utf8', cursor + 46, cursor + 46 + nameBytes);
    entries.push({
      name,
      method,
      compressedBytes: buffer.readUInt32LE(cursor + 20),
      uncompressedBytes: buffer.readUInt32LE(cursor + 24),
      localOffset: buffer.readUInt32LE(cursor + 42),
    });
    cursor += 46 + nameBytes + extraBytes + commentBytes;
  }
  return entries;
}

export function extractZipMember(buffer, member) {
  if (!member || typeof member.name !== 'string' || !member.name.length) fail('holdout-member-unknown');
  if (member.method !== 0 && member.method !== 8) fail('holdout-member-compression-unsupported', member.name);
  if (member.uncompressedBytes > MAX_MEMBER_BYTES) fail('holdout-member-too-large', member.name);
  const start = member.localOffset;
  if (start + 30 > buffer.length || buffer.readUInt32LE(start) !== 0x04034b50) {
    fail('holdout-member-header-corrupt', member.name);
  }
  const nameBytes = buffer.readUInt16LE(start + 26);
  const extraBytes = buffer.readUInt16LE(start + 28);
  const localName = buffer.toString('utf8', start + 30, start + 30 + nameBytes);
  if (localName !== member.name) fail('holdout-member-name-mismatch', `${member.name} != ${localName}`);
  const dataStart = start + 30 + nameBytes + extraBytes;
  const dataEnd = dataStart + member.compressedBytes;
  if (dataEnd > buffer.length) fail('holdout-member-out-of-range', member.name);
  const raw = buffer.subarray(dataStart, dataEnd);
  let out;
  if (member.method === 0) {
    out = Buffer.from(raw);
  } else {
    try {
      out = zlib.inflateRawSync(raw);
    } catch (error) {
      fail('holdout-member-inflate-failed', `${member.name}: ${error.message}`);
    }
  }
  if (out.length !== member.uncompressedBytes) {
    fail('holdout-member-size-mismatch', `${member.name}: expected ${member.uncompressedBytes} got ${out.length}`);
  }
  return out;
}

/* -------------------------------------------------------------- manifest --- */

export function loadHoldoutManifest(manifestPath) {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (manifest.schema !== HOLDOUT_SCHEMA) fail('holdout-manifest-schema', String(manifest.schema));
  if (!Array.isArray(manifest.artifacts) || !manifest.artifacts.length) fail('holdout-manifest-artifacts');
  for (const entry of manifest.artifacts) {
    if (typeof entry.id !== 'string' || !entry.id) fail('holdout-artifact-id');
    if (!/^https:\/\//.test(String(entry.archive?.url))) fail('holdout-artifact-url', entry.id);
    if (typeof entry.archive?.name !== 'string' || !entry.archive.name) fail('holdout-archive-name', entry.id);
    exactSize(entry.archive?.bytes, `${entry.id}.archive.bytes`);
    exactDigest(entry.archive?.sha256, `${entry.id}.archive.sha256`);
    if (typeof entry.binary?.path !== 'string' || !entry.binary.path) fail('holdout-binary-path', entry.id);
    if (typeof entry.binary?.file !== 'string' || !entry.binary.file) fail('holdout-binary-file', entry.id);
    if (entry.binary?.arch !== 'arm64') fail('holdout-binary-arch', `${entry.id}: ${entry.binary?.arch}`);
    exactSize(entry.binary?.bytes, `${entry.id}.binary.bytes`);
    exactDigest(entry.binary?.sha256, `${entry.id}.binary.sha256`);
  }
  return manifest;
}

export function holdoutArtifactPath(holdoutDir, entry) {
  return path.join(holdoutDir, entry.binary.file);
}

async function describeFile(file) {
  const bytes = await readFile(file);
  return { bytes: bytes.length, sha256: sha256(bytes) };
}

async function downloadPinned(url, expected, label) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new HoldoutFetchError('holdout-download-timeout', label)), DEFAULT_DOWNLOAD_TIMEOUT_MS);
  try {
    const response = await fetch(url, { redirect: 'follow', signal: controller.signal });
    if (!response.ok) fail('holdout-download-failed', `${label}: HTTP ${response.status}`);
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > 0 && declared !== expected.bytes) {
      fail('holdout-download-size-mismatch', `${label}: content-length ${declared} != ${expected.bytes}`);
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > MAX_ARCHIVE_BYTES) fail('holdout-archive-too-large', label);
    assertIdentity({ bytes: buffer.length, sha256: sha256(buffer) }, expected, `${label} archive`);
    return buffer;
  } catch (error) {
    if (error instanceof HoldoutFetchError) throw error;
    if (controller.signal.aborted) fail('holdout-download-timeout', label);
    fail('holdout-download-failed', `${label}: ${error.message}`);
  } finally {
    clearTimeout(timer);
  }
}

async function publishAtomic(file, bytes) {
  const temporary = `${file}.tmp-${process.pid}`;
  try {
    await writeFile(temporary, bytes, { mode: 0o644 });
    const published = await describeFile(temporary);
    await rename(temporary, file);
    return published;
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

/**
 * Fetches, verifies and extracts every pinned artifact. Returns one result row
 * per artifact with the extracted path and the verified identity.
 */
export async function fetchRealGameHoldout({ manifestPath = DEFAULT_MANIFEST_PATH, holdoutDir = DEFAULT_HOLDOUT_DIR, check = false } = {}) {
  const manifest = loadHoldoutManifest(manifestPath);
  await mkdir(holdoutDir, { recursive: true });
  const results = [];
  for (const entry of manifest.artifacts) {
    const file = holdoutArtifactPath(holdoutDir, entry);
    if (check) {
      if (!fs.existsSync(file)) fail('holdout-artifact-missing', `${entry.id}: ${file}`);
      const published = await describeFile(file);
      assertIdentity(published, entry.binary, `${entry.id} ${entry.binary.file}`);
      results.push({ id: entry.id, path: file, ...published, upstream: { repository: manifest.upstream.repository, tag: manifest.upstream.tag, commit: manifest.upstream.commit } });
      continue;
    }
    const archive = await downloadPinned(entry.archive.url, entry.archive, entry.id);
    const member = readZipDirectory(archive).find((candidate) => candidate.name === entry.binary.path);
    if (!member) fail('holdout-binary-not-in-archive', `${entry.id}: ${entry.binary.path}`);
    const bytes = extractZipMember(archive, member);
    assertIdentity({ bytes: bytes.length, sha256: sha256(bytes) }, entry.binary, `${entry.id} ${entry.binary.file}`);
    const published = await publishAtomic(file, bytes);
    assertIdentity(published, entry.binary, `${entry.id} ${entry.binary.file}`);
    results.push({ id: entry.id, path: file, ...published, upstream: { repository: manifest.upstream.repository, tag: manifest.upstream.tag, commit: manifest.upstream.commit } });
  }
  return { manifest: manifestPath, holdoutDir, artifacts: results };
}

function parseArgs(argv) {
  const check = argv.includes('--check');
  const manifestArg = argv.find((arg) => arg.startsWith('--manifest='));
  const dirArg = argv.find((arg) => arg.startsWith('--dir='));
  return {
    check,
    manifestPath: manifestArg ? path.resolve(manifestArg.slice('--manifest='.length)) : DEFAULT_MANIFEST_PATH,
    holdoutDir: dirArg ? path.resolve(dirArg.slice('--dir='.length)) : DEFAULT_HOLDOUT_DIR,
  };
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  try {
    const result = await fetchRealGameHoldout(parseArgs(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    for (const artifact of result.artifacts) {
      process.stdout.write(`HEX_SEMANTIC_BOUNDARY_HOLDOUT_ARTIFACT=${artifact.path}\n`);
    }
  } catch (error) {
    process.stderr.write(`${error instanceof HoldoutFetchError ? error.code : 'holdout-fetch-error'}: ${error.message}\n`);
    process.exit(1);
  }
}
