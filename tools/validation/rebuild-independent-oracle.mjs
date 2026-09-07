import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { stableDigest } from '../../js/core/identity/index.js';
import { INDEPENDENT_ORACLE_RESULT_SCHEMA, registerCanonicalIndependentOracleProvider } from '../../js/rebuild/transaction-v2.js';

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
  '--all',
  '--coff-imports',
  '--coff-exports',
  '--coff-basereloc',
  '--macho-version-min',
  '--macho-dysymtab',
  '--macho-indirect-symbols',
  '--macho-linker-options',
]);
const F6_PRESERVATION_UNITS = Object.freeze([
  'layout-and-structure', 'relocations-and-bindings', 'branch-ranges',
  'unwind-and-debug', 'imports-and-exports', 'signature-consequence',
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
    const paths = candidate.includes(path.sep)
      ? [candidate]
      : String(process.env.PATH || '').split(path.delimiter).filter(Boolean).map((directory) => path.join(directory, candidate));
    for (const requested of paths) {
      try {
        const stat = fs.statSync(requested);
        if (stat.isFile() && (process.platform === 'win32' || (stat.mode & 0o111))) return fs.realpathSync(requested);
      } catch {}
    }
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

function readElfSections(output) {
  const number = (block, label) => {
    const value = block.match(new RegExp(`^\\s*${label}:\\s+(0x[0-9A-Fa-f]+|\\d+)`, 'm'))?.[1];
    return value == null ? null : Number(value);
  };
  return [...output.matchAll(/^\s*Section \{\n([\s\S]*?)^\s*\}/gm)].map((match) => {
    const block = match[1];
    return Object.freeze({
      index: number(block, 'Index'),
      name: block.match(/^\s*Name:\s+([^\s(]+)\s+/m)?.[1] || '',
      type: block.match(/^\s*Type:\s+([^\s(]+)\s+/m)?.[1] || '',
      flags: Number(block.match(/^\s*Flags \[ \((0x[0-9A-Fa-f]+)\)/m)?.[1] ?? Number.NaN),
      address: number(block, 'Address'),
      offset: number(block, 'Offset'),
      size: number(block, 'Size'),
      link: number(block, 'Link'),
      info: number(block, 'Info'),
      alignment: number(block, 'AddressAlignment'),
      entrySize: number(block, 'EntrySize'),
    });
  });
}

function readElfLayoutEvidence(output, sourceOutput, transaction) {
  const expected = transaction?.expectedOriginalState?.formatSafe;
  if (expected?.kind !== 'elf-add-nobits-section') return null;
  const sectionCount = Number(output.match(/^\s*SectionHeaderCount:\s*(\d+)\s*$/m)?.[1]);
  const sourceSectionCount = Number(sourceOutput.match(/^\s*SectionHeaderCount:\s*(\d+)\s*$/m)?.[1]);
  const sectionTableOffset = output.match(/^\s*SectionHeaderOffset:\s*(0x[0-9A-Fa-f]+|\d+)\s*$/m)?.[1];
  const sourceSectionTableOffset = sourceOutput.match(/^\s*SectionHeaderOffset:\s*(0x[0-9A-Fa-f]+|\d+)\s*$/m)?.[1];
  const stringTableIndex = Number(output.match(/^\s*StringTableSectionIndex:\s*(\d+)\s*$/m)?.[1]);
  const sourceStringTableIndex = Number(sourceOutput.match(/^\s*StringTableSectionIndex:\s*(\d+)\s*$/m)?.[1]);
  const sections = readElfSections(output);
  const sourceSections = readElfSections(sourceOutput);
  const section = sections.find((item) => item.name === expected.section);
  if (!Number.isSafeInteger(sectionCount) || !Number.isSafeInteger(sourceSectionCount)
    || sectionCount !== expected.outputSectionCount || sourceSectionCount !== expected.sourceSectionCount
    || sections.length !== sectionCount || sourceSections.length !== sourceSectionCount) {
    throw new TypeError('independent-oracle-elf-section-count-mismatch');
  }
  if (sectionTableOffset !== sourceSectionTableOffset || stringTableIndex !== sourceStringTableIndex
    || stringTableIndex !== expected.sourceSectionCount - 1) throw new TypeError('independent-oracle-elf-header-layout-mismatch');
  for (let index = 0; index < sourceSections.length; index++) {
    const before = sourceSections[index];
    const after = sections[index];
    if (!after || before.name !== after.name) throw new TypeError('independent-oracle-elf-existing-section-mismatch');
    const expectedAfter = index === stringTableIndex ? { ...before, size: before.size + expected.section.length + 1 } : before;
    if (JSON.stringify(expectedAfter) !== JSON.stringify(after)) throw new TypeError('independent-oracle-elf-existing-section-mismatch');
  }
  if (!section || section.type !== expected.type || section.size !== expected.size || section.alignment !== expected.alignment) {
    throw new TypeError('independent-oracle-elf-layout-mismatch');
  }
  if (section.index !== sourceSectionCount || section.flags !== 0 || section.address !== 0) throw new TypeError('independent-oracle-elf-layout-mismatch');
  const programHeaders = output.match(/^ProgramHeaders \[\n([\s\S]*?)^\]/m)?.[1] || '';
  const sourceProgramHeaders = sourceOutput.match(/^ProgramHeaders \[\n([\s\S]*?)^\]/m)?.[1] || '';
  if (!programHeaders || programHeaders !== sourceProgramHeaders) throw new TypeError('independent-oracle-elf-program-headers-changed');
  return Object.freeze({ sectionCount, section: Object.freeze({ name: section.name, type: section.type, size: section.size, alignment: section.alignment }) });
}

function readPeSections(output) {
  const number = (block, label) => {
    const value = block.match(new RegExp(`^\\s*${label}:\\s+(0x[0-9A-Fa-f]+|\\d+)`, 'm'))?.[1];
    return value == null ? null : Number(value);
  };
  return [...output.matchAll(/^\s*Section \{\n([\s\S]*?)^\s*\}/gm)].map((match, index) => {
    const block = match[1];
    return Object.freeze({
      index,
      name: block.match(/^\s*Name:\s+([^\s(]+)\s+/m)?.[1] || '',
      virtualSize: number(block, 'VirtualSize'),
      virtualAddress: number(block, 'VirtualAddress'),
      rawSize: number(block, 'RawDataSize'),
    });
  });
}

function readPeLayoutEvidence(output, sourceOutput, transaction) {
  const expected = transaction?.expectedOriginalState?.formatSafe;
  if (expected?.kind !== 'pe-section-virtual-size') return null;
  const sectionCount = Number(output.match(/^\s*SectionCount:\s*(\d+)\s*$/m)?.[1]);
  const sourceSectionCount = Number(sourceOutput.match(/^\s*SectionCount:\s*(\d+)\s*$/m)?.[1]);
  const sectionAlignment = Number(output.match(/^\s*SectionAlignment:\s*(0x[0-9A-Fa-f]+|\d+)\s*$/m)?.[1]);
  const sourceSectionAlignment = Number(sourceOutput.match(/^\s*SectionAlignment:\s*(0x[0-9A-Fa-f]+|\d+)\s*$/m)?.[1]);
  const sizeOfImage = Number(output.match(/^\s*SizeOfImage:\s*(0x[0-9A-Fa-f]+|\d+)\s*$/m)?.[1]);
  const sourceSizeOfImage = Number(sourceOutput.match(/^\s*SizeOfImage:\s*(0x[0-9A-Fa-f]+|\d+)\s*$/m)?.[1]);
  const sections = readPeSections(output);
  const sourceSections = readPeSections(sourceOutput);
  if (!Number.isSafeInteger(sectionCount) || !Number.isSafeInteger(sourceSectionCount)
    || sectionCount !== expected.outputSectionCount || sourceSectionCount !== expected.sourceSectionCount
    || sections.length !== sectionCount || sourceSections.length !== sourceSectionCount
    || sectionAlignment !== expected.sectionAlignment || sourceSectionAlignment !== expected.sectionAlignment
    || sizeOfImage !== expected.outputSizeOfImage || sourceSizeOfImage !== expected.originalSizeOfImage) {
    throw new TypeError('independent-oracle-pe-layout-header-mismatch');
  }
  for (let index = 0; index < sourceSections.length; index++) {
    const before = sourceSections[index];
    const after = sections[index];
    if (!after || before.name !== after.name || before.virtualAddress !== after.virtualAddress || before.rawSize !== after.rawSize
      || (index !== expected.sectionIndex && before.virtualSize !== after.virtualSize)) throw new TypeError('independent-oracle-pe-existing-section-mismatch');
  }
  const section = sections[expected.sectionIndex];
  const sourceSection = sourceSections[expected.sectionIndex];
  if (!section || !sourceSection || section.name !== expected.section || sourceSection.name !== expected.section
    || section.virtualAddress !== expected.virtualAddress || section.rawSize !== expected.rawSize
    || sourceSection.virtualSize !== expected.originalVirtualSize || section.virtualSize !== expected.virtualSize) {
    throw new TypeError('independent-oracle-pe-layout-mismatch');
  }
  return Object.freeze({ sectionCount, section: Object.freeze({
    index: section.index,
    name: section.name,
    virtualAddress: section.virtualAddress,
    rawSize: section.rawSize,
    originalVirtualSize: sourceSection.virtualSize,
    virtualSize: section.virtualSize,
    sectionAlignment,
    sizeOfImage,
  }) });
}

function normalizedPreservationReport(output, kind) {
  let value = String(output || '').replace(/^File:\s*.*$/m, 'File: <canonical>');
  if (kind === 'pe-timestamp') value = value.replace(/^(\s*TimeDateStamp:)\s*.*$/m, '$1 <intentional-target>');
  if (kind === 'macho-min-version') value = value.replace(/^(\s*Version:)\s*.*$/m, '$1 <intentional-target>');
  return value;
}

function readPreservationEvidence(output, sourceOutput, transaction) {
  const expected = transaction?.expectedOriginalState?.formatSafe;
  if (!['elf-comment', 'pe-timestamp', 'macho-min-version'].includes(expected?.kind)) return null;
  if (expected.signaturePolicy !== 'unsigned-input-required') throw new TypeError('independent-oracle-signature-policy-missing');
  const sourceReport = normalizedPreservationReport(sourceOutput, expected.kind);
  const outputReport = normalizedPreservationReport(output, expected.kind);
  if (!sourceReport || sourceReport !== outputReport) throw new TypeError('independent-oracle-preservation-report-mismatch');
  const reportDigest = sha256(sourceReport);
  return Object.freeze({
    complete:true,
    signaturePolicy:'unsigned-input-required',
    sourceReportDigest:reportDigest,
    outputReportDigest:reportDigest,
    units:F6_PRESERVATION_UNITS,
  });
}

function readMachoSections(output) {
  const number = (block, label) => {
    const value = block.match(new RegExp(`^\\s*${label}:\\s+(0x[0-9A-Fa-f]+|\\d+)`, 'm'))?.[1];
    return value == null ? null : Number(value);
  };
  return [...output.matchAll(/^\s*Section \{\n([\s\S]*?)^\s*\}/gm)].map((match, index) => {
    const block = match[1];
    return Object.freeze({
      index,
      name: block.match(/^\s*Name:\s+([^\s(]+)\s+/m)?.[1] || '',
      segment: block.match(/^\s*Segment:\s+([^\s(]+)\s+/m)?.[1] || '',
      address: number(block, 'Address'),
      size: number(block, 'Size'),
      offset: number(block, 'Offset'),
      alignment: number(block, 'Alignment'),
      relocationOffset: number(block, 'RelocationOffset'),
      relocationCount: number(block, 'RelocationCount'),
    });
  });
}

function readMachoLayoutEvidence(output, sourceOutput, transaction) {
  const expected = transaction?.expectedOriginalState?.formatSafe;
  if (expected?.kind !== 'macho-section-size') return null;
  const sections = readMachoSections(output);
  const sourceSections = readMachoSections(sourceOutput);
  if (sections.length !== expected.outputSectionCount || sourceSections.length !== expected.sourceSectionCount) throw new TypeError('independent-oracle-macho-section-count-mismatch');
  for (let index = 0; index < sourceSections.length; index++) {
    const before = sourceSections[index];
    const after = sections[index];
    if (!after || before.name !== after.name || before.segment !== after.segment || before.address !== after.address
      || before.offset !== after.offset || before.alignment !== after.alignment || before.relocationOffset !== after.relocationOffset
      || before.relocationCount !== after.relocationCount || (index !== expected.sectionIndex && before.size !== after.size)) {
      throw new TypeError('independent-oracle-macho-existing-section-mismatch');
    }
  }
  const section = sections[expected.sectionIndex];
  const sourceSection = sourceSections[expected.sectionIndex];
  if (!section || !sourceSection || section.segment !== expected.segment || section.name !== expected.section
    || section.offset !== expected.sectionOffset || sourceSection.size !== expected.originalSize || section.size !== expected.size) {
    throw new TypeError('independent-oracle-macho-layout-mismatch');
  }
  return Object.freeze({ sectionCount: sections.length, segment: Object.freeze({ commandIndex: expected.segmentCommandIndex, name: expected.segment, fileOffset: expected.segmentFileOffset, fileSize: expected.segmentFileSize, sectionCount: expected.outputSectionCount }), section: Object.freeze({ index: section.index, segment: section.segment, name: section.name, offset: section.offset, originalSize: sourceSection.size, size: section.size, nextSectionOffset: expected.nextSectionOffset }) });
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
  const executableDigest = sha256(fs.readFileSync(executable));
  const versionMatches = !expectedVersion || (!!version && version.includes(String(expectedVersion)));
  return Object.freeze({
    available: versionMatches,
    identity: LLVM_READOBJ_IDENTITY,
    executable,
    executableDigest,
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
  const oracleSource = tool.executable ? `${tool.executable}@${tool.executableDigest} ${READOBJ_FLAGS.join(' ')}` : 'llvm-readobj';

  const independentOracle = async function independentOracle(context = {}) {
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
      oracleExecutableDigest:tool.executableDigest || '',
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
    const sourcePath = path.join(directory, 'source.bin');
    try {
      fs.writeFileSync(inputPath, output, { mode: 0o600 });
      fs.writeFileSync(sourcePath, original, { mode: 0o600 });
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
      const sourceResult = spawnSync(tool.executable, [...READOBJ_FLAGS, sourcePath], {
        encoding: 'utf8', timeout: boundedTimeout, maxBuffer: boundedOutput, windowsHide: true,
      });
      const sourceStdout = String(sourceResult.stdout || '');
      if (sourceResult.error || sourceResult.signal || sourceResult.status !== 0) {
        return failed('independent-oracle-rejected-source', String(sourceResult.stderr || sourceResult.error?.message || sourceResult.signal || `exit:${sourceResult.status}`), { ...base, oracleOutputDigest: sha256(stdout) });
      }
      if (Buffer.byteLength(stdout, 'utf8') > boundedOutput) return failed('independent-oracle-output-budget-exceeded', null, base);
      const header = readHeader(stdout);
      if (!header.format) return failed('independent-oracle-format-unrecognized', null, { ...base, oracleOutputDigest: sha256(stdout) });
      if (!header.architecture) return failed('independent-oracle-architecture-unrecognized', null, { ...base, ...header, oracleOutputDigest: sha256(stdout) });
      if (header.format !== String(transaction.format || '').toLowerCase()) return failed('independent-oracle-format-mismatch', null, { ...base, ...header, oracleOutputDigest: sha256(stdout) });
      if (header.architecture !== String(transaction.architecture || '').toLowerCase()) return failed('independent-oracle-architecture-mismatch', null, { ...base, ...header, oracleOutputDigest: sha256(stdout) });
      let layoutEvidence = null;
      let preservationEvidence = null;
      try {
        const kind = transaction?.expectedOriginalState?.formatSafe?.kind;
        layoutEvidence = kind === 'elf-add-nobits-section'
          ? readElfLayoutEvidence(stdout, sourceStdout, transaction)
          : kind === 'pe-section-virtual-size'
            ? readPeLayoutEvidence(stdout, sourceStdout, transaction)
            : kind === 'macho-section-size'
              ? readMachoLayoutEvidence(stdout, sourceStdout, transaction)
              : null;
        preservationEvidence = readPreservationEvidence(stdout, sourceStdout, transaction);
      } catch (error) {
        return failed(error?.message || 'independent-oracle-layout-mismatch', null, { ...base, ...header, oracleOutputDigest: sha256(stdout) });
      }
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
        ...(layoutEvidence ? { layoutEvidence } : {}),
        ...(preservationEvidence ? { preservationEvidence } : {}),
      });
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  };
  return registerCanonicalIndependentOracleProvider(independentOracle);
}
