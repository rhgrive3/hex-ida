import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { stableDigest } from '../../js/core/identity/index.js';
import { INDEPENDENT_ORACLE_RESULT_SCHEMA } from '../../js/rebuild/transaction-v2.js';

/**
 * The F6 adapter is deliberately a validation tool, not a browser/runtime
 * dependency. llvm-readobj is a separate LLVM process and therefore does not
 * share Hex's parser implementation. It is used only to prove that the
 * temporary bytes are accepted by an independently implemented object reader.
 */
export const LLVM_READOBJ_IDENTITY = 'external:llvm-readobj';
export const LLVM_READOBJ_EXPECTED_VERSION = 'Ubuntu LLVM version 18.1.3';
export const REBUILD_ORACLE_MAX_INPUT_BYTES = 128 * 1024 * 1024;
export const REBUILD_ORACLE_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
export const REBUILD_ORACLE_TIMEOUT_MS = 15_000;

const READOBJ_FLAGS = Object.freeze([
  '--file-header',
  '--program-headers',
  '--section-headers',
]);

function bytes(value) {
  if (value instanceof Uint8Array) return new Uint8Array(value);
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
  if (Array.isArray(value)) return Uint8Array.from(value);
  throw new TypeError('rebuild-independent-oracle-bytes-required');
}

function byteDigest(value) {
  return `bytes:${stableDigest(Array.from(bytes(value)))}`;
}

function sha256(value) {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function boundedPositive(value, fallback, max, code) {
  const number = value == null ? fallback : Number(value);
  if (!Number.isSafeInteger(number) || number < 1 || number > max) throw new TypeError(code);
  return number;
}

function candidateTools(requested) {
  if (requested) return [String(requested)];
  return ['/usr/bin/llvm-readobj-18', '/usr/bin/llvm-readobj', 'llvm-readobj-18', 'llvm-readobj'];
}

function executablePath(candidates) {
  for (const candidate of candidates) {
    if (candidate.includes(path.sep)) {
      try {
        if (fs.statSync(candidate).isFile() && (process.platform === 'win32' || (fs.statSync(candidate).mode & 0o111))) return candidate;
      } catch {}
      continue;
    }
    const probe = spawnSync(candidate, ['--version'], { encoding: 'utf8', timeout: 2_000, maxBuffer: 64 * 1024 });
    if (probe.status === 0) return candidate;
  }
  return null;
}

function normalizeFormat(format) {
  const text = String(format || '').toLowerCase();
  if (text.startsWith('mach-o')) return 'macho';
  if (text.startsWith('elf')) return 'elf';
  if (text.startsWith('coff') || text.startsWith('pe')) return 'pe';
  return null;
}

function normalizeArchitecture(architecture) {
  const text = String(architecture || '').toLowerCase();
  if (text === 'aarch64' || text === 'arm64') return 'arm64';
  if (text === 'x86_64' || text === 'amd64' || text === 'x86-64') return 'x86_64';
  if (text === 'i386' || text === 'i686' || text === 'x86') return 'x86';
  if (text === 'arm') return 'arm';
  if (text === 'riscv64') return 'riscv64';
  return text || null;
}

function readHeader(output) {
  const format = output.match(/^Format:\s*(.+)$/m)?.[1]?.trim() || null;
  const architecture = output.match(/^Arch:\s*(.+)$/m)?.[1]?.trim() || null;
  return { format: normalizeFormat(format), architecture: normalizeArchitecture(architecture), rawFormat: format, rawArchitecture: architecture };
}

function versionOf(executable, timeoutMs, maxOutputBytes) {
  const result = spawnSync(executable, ['--version'], { encoding: 'utf8', timeout: timeoutMs, maxBuffer: maxOutputBytes });
  if (result.status !== 0 || result.error || result.signal) return null;
  return String(result.stdout || '').replace(/\s+/g, ' ').trim() || null;
}

function failed(reason, detail = null, extra = {}) {
  return Object.freeze({
    schemaVersion: INDEPENDENT_ORACLE_RESULT_SCHEMA,
    ok: false,
    status: 'rejected',
    reason,
    ...(detail == null ? {} : { detail: String(detail) }),
    ...extra,
  });
}

/**
 * Probe the external reader without running Hex's parser. The returned record
 * is intentionally small and safe to include in bounded validation evidence.
 */
export function inspectLlvmReadobj({ command = null, timeoutMs = REBUILD_ORACLE_TIMEOUT_MS, maxOutputBytes = REBUILD_ORACLE_MAX_OUTPUT_BYTES, expectedVersion = LLVM_READOBJ_EXPECTED_VERSION } = {}) {
  const boundedTimeout = boundedPositive(timeoutMs, REBUILD_ORACLE_TIMEOUT_MS, 120_000, 'rebuild-independent-oracle-timeout-invalid');
  const boundedOutput = boundedPositive(maxOutputBytes, REBUILD_ORACLE_MAX_OUTPUT_BYTES, REBUILD_ORACLE_MAX_OUTPUT_BYTES, 'rebuild-independent-oracle-output-budget-invalid');
  const executable = executablePath(candidateTools(command));
  if (!executable) return Object.freeze({ available: false, identity: LLVM_READOBJ_IDENTITY, executable: null, version: null, expectedVersion: expectedVersion || null, reason: 'independent-oracle-tool-unavailable' });
  const version = versionOf(executable, boundedTimeout, boundedOutput);
  const versionMatches = !expectedVersion || (!!version && version.includes(String(expectedVersion)));
  return Object.freeze({
    available: versionMatches,
    identity: LLVM_READOBJ_IDENTITY,
    executable,
    version,
    expectedVersion: expectedVersion || null,
    reason: versionMatches ? null : 'independent-oracle-tool-version-mismatch',
  });
}

/**
 * Build a callback suitable for validateRebuildTransaction's
 * `independentOracle` option. Each invocation writes only a bounded temporary
 * file, asks llvm-readobj to parse it, hashes the complete bounded report, and
 * removes the temporary directory before returning.
 */
export function createLlvmReadobjOracle({
  command = null,
  timeoutMs = REBUILD_ORACLE_TIMEOUT_MS,
  maxInputBytes = REBUILD_ORACLE_MAX_INPUT_BYTES,
  maxOutputBytes = REBUILD_ORACLE_MAX_OUTPUT_BYTES,
  expectedVersion = LLVM_READOBJ_EXPECTED_VERSION,
} = {}) {
  const boundedTimeout = boundedPositive(timeoutMs, REBUILD_ORACLE_TIMEOUT_MS, 120_000, 'rebuild-independent-oracle-timeout-invalid');
  const boundedInput = boundedPositive(maxInputBytes, REBUILD_ORACLE_MAX_INPUT_BYTES, REBUILD_ORACLE_MAX_INPUT_BYTES, 'rebuild-independent-oracle-input-budget-invalid');
  const boundedOutput = boundedPositive(maxOutputBytes, REBUILD_ORACLE_MAX_OUTPUT_BYTES, REBUILD_ORACLE_MAX_OUTPUT_BYTES, 'rebuild-independent-oracle-output-budget-invalid');
  const tool = inspectLlvmReadobj({ command, timeoutMs: boundedTimeout, maxOutputBytes: boundedOutput, expectedVersion });
  const oracleSource = tool.executable ? `${tool.executable} ${READOBJ_FLAGS.join(' ')}` : 'llvm-readobj';

  return async function independentOracle(context = {}) {
    const transaction = context.transaction || {};
    let original;
    let output;
    try {
      original = bytes(context.original);
      output = bytes(context.output);
    } catch (error) {
      return failed('independent-oracle-input-invalid', error?.message || error, { oracleIdentity: LLVM_READOBJ_IDENTITY, oracleVersion: tool.version || '', oracleSource });
    }
    const sourceDigest = byteDigest(original);
    const outputDigest = byteDigest(output);
    const base = {
      schemaVersion: INDEPENDENT_ORACLE_RESULT_SCHEMA,
      oracleIdentity: LLVM_READOBJ_IDENTITY,
      oracleVersion: tool.version || '',
      oracleSource,
      sourceDigest,
      outputDigest,
      sourceLength: original.length,
      outputLength: output.length,
      transactionId: transaction.transactionId || null,
    };
    if (!tool.available) return failed(tool.reason, null, base);
    if (original.length > boundedInput || output.length > boundedInput) return failed('independent-oracle-input-budget-exceeded', null, base);

    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hex-f6-oracle-'));
    const inputPath = path.join(directory, 'candidate.bin');
    try {
      fs.writeFileSync(inputPath, output, { mode: 0o600 });
      const result = spawnSync(tool.executable, [...READOBJ_FLAGS, inputPath], {
        encoding: 'utf8',
        timeout: boundedTimeout,
        maxBuffer: boundedOutput,
        windowsHide: true,
      });
      const stdout = String(result.stdout || '');
      const stderr = String(result.stderr || '');
      if (result.error || result.signal || result.status !== 0) {
        return failed('independent-oracle-rejected-output', stderr || result.error?.message || result.signal || `exit:${result.status}`, {
          ...base,
          oracleOutputDigest: sha256(stdout),
        });
      }
      if (Buffer.byteLength(stdout, 'utf8') > boundedOutput) return failed('independent-oracle-output-budget-exceeded', null, base);
      const header = readHeader(stdout);
      if (!header.format) return failed('independent-oracle-format-unrecognized', null, { ...base, oracleOutputDigest: sha256(stdout) });
      if (!header.architecture) return failed('independent-oracle-architecture-unrecognized', null, { ...base, ...header, oracleOutputDigest: sha256(stdout) });
      if (header.format !== String(transaction.format || '').toLowerCase()) return failed('independent-oracle-format-mismatch', null, { ...base, ...header, oracleOutputDigest: sha256(stdout) });
      if (header.architecture !== String(transaction.architecture || '').toLowerCase()) return failed('independent-oracle-architecture-mismatch', null, { ...base, ...header, oracleOutputDigest: sha256(stdout) });
      return Object.freeze({
        ...base,
        ok: true,
        status: 'passed',
        format: header.format,
        architecture: header.architecture,
        rawFormat: header.rawFormat,
        rawArchitecture: header.rawArchitecture,
        oracleOutputDigest: sha256(stdout),
        reportBytes: Buffer.byteLength(stdout, 'utf8'),
      });
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  };
}
