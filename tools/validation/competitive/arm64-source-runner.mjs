/**
 * Measure the complete repository-owned A64 MachineEffects denominator.
 *
 * This runner is deliberately separate from the synchronous repository
 * collector.  Capstone's deployed WebAssembly factory is asynchronous, while
 * the existing collector API is synchronous for the P5/P6/P8 lanes.  The
 * parent source-fixture module invokes this file as a bounded child process,
 * then binds its JSON result to the current source/tree identity.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { parseOperands } from '../../../js/arm64.js';
import { classifyMachineEffectsCoverage } from '../../../js/targets/architecture/coverage.js';
import { ARM64_MACHINE_EFFECTS_SEMANTIC_VERSION } from '../../../js/targets/architecture/arm64/effects/index.js';
import { stableDigest } from '../../../js/core/identity/index.js';
import {
  arm64A64ControlEncodingCases,
  validateArm64A64ControlDenominator,
} from '../../validation/machine-effects/arm64-a64-control-denominator.mjs';
import {
  arm64A64FlagEncodingCases,
  validateArm64A64FlagsDenominator,
} from '../../validation/machine-effects/arm64-a64-flags-denominator.mjs';
import {
  arm64A64FpEncodingCases,
  validateArm64A64FpDenominator,
} from '../../validation/machine-effects/arm64-a64-fp-denominator.mjs';
import {
  arm64A64IntegerEncodingCases,
  validateArm64A64IntegerDenominator,
} from '../../validation/machine-effects/arm64-a64-integer-denominator.mjs';
import {
  arm64A64MemoryEncodingCases,
  arm64A64MemoryCorpusSha256,
  validateArm64A64MemoryDenominator,
} from '../../validation/machine-effects/arm64-a64-memory-denominator.mjs';
import {
  ARM64_A64_DECODER_AUDIT_LOCK,
  ARM64_A64_DECODER_IDENTITY_LOCK,
  ARM64_A64_CANDIDATE_CORPUS_LOCK,
  arm64A64DecoderDenominatorFromLockedAudit,
  buildArm64CapstoneRegistryEvidence,
  validateArm64A64DecoderDependencyProof,
  verifyArm64A64DecoderIdentity,
} from '../../validation/machine-effects/arm64-a64-decoder-denominator.mjs';
import {
  ARM64_A64_SIMD_ASSEMBLY_CASES,
  arm64A64SimdCorpusSha256,
  arm64A64SimdDecoderDependencyProof,
  validateArm64A64SimdDenominator,
} from '../../validation/machine-effects/arm64-a64-simd-denominator.mjs';
import {
  arm64A64SystemEncodingCases,
  validateArm64A64SystemDenominator,
} from '../../validation/machine-effects/arm64-a64-system-denominator.mjs';
import {
  loadA2DenominatorInventory,
  validateA2DenominatorInventory,
} from '../../validation/machine-effects/a2-denominator.mjs';
import { createCapstoneArm64Session } from '../../../tests/machine-effects/helpers/arm64-capstone-session.mjs';
import { resolveLlvmTool18 } from '../../../tests/machine-effects/helpers/llvm-toolchain.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const RUNNER_SCHEMA = 'hex-competitive-arm64-source-runner/v1';
const RAW_FAMILIES = Object.freeze([
  Object.freeze({ family: 'control', cases: arm64A64ControlEncodingCases, validate: validateArm64A64ControlDenominator }),
  Object.freeze({ family: 'flags', cases: arm64A64FlagEncodingCases, validate: validateArm64A64FlagsDenominator }),
  Object.freeze({ family: 'fp', cases: arm64A64FpEncodingCases, validate: validateArm64A64FpDenominator }),
  Object.freeze({ family: 'integer', cases: arm64A64IntegerEncodingCases, validate: validateArm64A64IntegerDenominator }),
  Object.freeze({ family: 'system', cases: arm64A64SystemEncodingCases, validate: validateArm64A64SystemDenominator }),
]);

function fail(code, detail = '') {
  throw new Error(`arm64-source-runner-${code}${detail ? `:${detail}` : ''}`);
}

function bytes32(word) {
  const value = Number(word) >>> 0;
  return Uint8Array.of(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, value >>> 24);
}

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function toolIdentity(toolPath) {
  const result = spawnSync(toolPath, ['--version'], { encoding: 'utf8', maxBuffer: 64 * 1024 });
  if (result.status !== 0) fail('tool-version', `${toolPath}:${result.stderr || result.stdout || result.status}`);
  const versionText = `${result.stdout || ''}\n${result.stderr || ''}`.replace(/\s+/g, ' ').trim();
  return Object.freeze({ path: toolPath, version: versionText });
}

function decodedInstruction(raw, id, ops = parseOperands(raw.opStr), word = null) {
  return {
    instructionId: id,
    address: raw.address,
    mnemonic: raw.mnemonic,
    operands: raw.opStr,
    opStr: raw.opStr,
    ops,
    ...(word == null ? {} : { word }),
    mode: 'a64',
    architectureId: 'arm64',
    origin: { instructionIds: [id] },
  };
}

function parseSimdOperands(opStr) {
  // Capstone prints some lane indices in hexadecimal (for example v0.b[0xf])
  // while the shared operand parser intentionally accepts decimal lanes. This
  // adapter only normalizes the deployed decoder's presentation.
  return parseOperands(opStr).map((operand) => {
    if (operand.k !== 'other') return operand;
    const match = /^v(\d{1,2})\.([bhsd])\[(0x[0-9a-f]+|\d+)\]$/i.exec(operand.text || '');
    if (!match) return operand;
    return {
      k: 'elem',
      text: operand.text,
      num: Number(match[1]),
      size: match[2].toLowerCase(),
      index: Number(BigInt(match[3])),
    };
  });
}

function assembleMemoryCases(cases) {
  const clang = resolveLlvmTool18('clang');
  const objdump = resolveLlvmTool18('llvm-objdump');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hex-arm64-source-memory-'));
  const source = path.join(directory, 'memory.s');
  const object = path.join(directory, 'memory.o');
  try {
    fs.writeFileSync(source, `.text\n${cases.map((item) => item.asm).join('\n')}\n`);
    const assembled = spawnSync(clang, [
      '-target', 'aarch64-none-elf', '-march=armv8.1-a+lse', '-c', source, '-o', object,
    ], { encoding: 'utf8', maxBuffer: 64 * 1024 });
    if (assembled.status !== 0) fail('memory-assemble', assembled.stderr || assembled.stdout || assembled.status);
    const disassembled = spawnSync(objdump, ['-d', object], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
    if (disassembled.status !== 0) fail('memory-disassemble', disassembled.stderr || disassembled.stdout || disassembled.status);
    const rows = [...disassembled.stdout.matchAll(/^\s*[0-9a-f]+:\s+([0-9a-f]{8})\s+([^\n]+)$/gmi)]
      .map((match) => Object.freeze({ word: Number.parseInt(match[1], 16) >>> 0, text: match[2].trim() }));
    if (rows.length !== cases.length) fail('memory-case-count', `${rows.length}:${cases.length}`);
    return Object.freeze({
      rows,
      tools: Object.freeze({ clang: toolIdentity(clang), objdump: toolIdentity(objdump) }),
    });
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

function assembleSimdCases(cases) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hex-arm64-source-simd-'));
  const object = path.join(directory, 'simd.o');
  const binary = path.join(directory, 'simd.bin');
  try {
    const source = `.text\n${cases.map((item) => item.assembly).join('\n')}\n`;
    let assembler;
    let assembled;
    try {
      const llvmMc = resolveLlvmTool18('llvm-mc');
      assembled = spawnSync(llvmMc, [
        '--triple=aarch64', '--mattr=+fullfp16', '--filetype=obj', '-o', object,
      ], { input: source, encoding: 'utf8', maxBuffer: 64 * 1024 });
      assembler = { tool: toolIdentity(llvmMc), mode: 'llvm-mc' };
    } catch (error) {
      const clang = resolveLlvmTool18('clang');
      assembled = spawnSync(clang, [
        '--target=aarch64-none-elf', '-march=armv8.2-a+fp16', '-x', 'assembler', '-c', '-o', object, '-',
      ], { input: source, encoding: 'utf8', maxBuffer: 64 * 1024 });
      assembler = { tool: toolIdentity(clang), mode: 'clang-integrated-llvm-mc', fallback: String(error.message) };
    }
    if (assembled.status !== 0) fail('simd-assemble', assembled.stderr || assembled.stdout || assembled.status);
    const objcopy = resolveLlvmTool18('llvm-objcopy');
    const copied = spawnSync(objcopy, ['-O', 'binary', '--only-section=.text', object, binary], { encoding: 'utf8', maxBuffer: 64 * 1024 });
    if (copied.status !== 0) fail('simd-objcopy', copied.stderr || copied.stdout || copied.status);
    const bytes = fs.readFileSync(binary);
    if (bytes.length !== cases.length * 4) fail('simd-byte-count', `${bytes.length}:${cases.length * 4}`);
    const rows = [];
    for (let offset = 0; offset < bytes.length; offset += 4) {
      rows.push(Object.freeze({
        word: (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0,
      }));
    }
    return Object.freeze({
      rows,
      tools: Object.freeze({ assembler, objcopy: toolIdentity(objcopy) }),
    });
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

function emptyCounts() {
  return { exact: 0, exactWithIntrinsic: 0, partial: 0, unknown: 0, unsupported: 0, error: 0 };
}

function measureRow(counts, classification) {
  if (classification.status === 'unsupported') counts.unsupported += 1;
  else if (classification.status === 'error') counts.error += 1;
  else if (classification.completeness === 'exact') counts.exact += 1;
  else if (classification.completeness === 'exact-with-intrinsic') counts.exactWithIntrinsic += 1;
  else if (classification.completeness === 'partial') counts.partial += 1;
  else if (classification.completeness === 'unknown') counts.unknown += 1;
  else fail('classification', JSON.stringify(classification));
}

function finalizeCounts(counts, denominatorCount) {
  const exactCount = counts.exact + counts.exactWithIntrinsic;
  const coveredCount = exactCount + counts.partial;
  const representedCount = coveredCount + counts.unknown;
  return Object.freeze({
    ...counts,
    denominatorCount,
    coveredCount,
    representedCount,
    exactCount,
    coverageRate: denominatorCount === 0 ? null : coveredCount / denominatorCount,
    representationRate: denominatorCount === 0 ? null : representedCount / denominatorCount,
    exactRate: denominatorCount === 0 ? null : exactCount / denominatorCount,
  });
}

function decodeOne(session, word, id, opsParser = parseOperands) {
  const raw = session.decode(bytes32(word), 0x400000n)[0] ?? null;
  if (raw == null) return null;
  return decodedInstruction(raw, id, opsParser(raw.opStr), word);
}

function expectedReference(rawProofs, memoryProof, simdProof) {
  const rawDenominator = ARM64_A64_DECODER_AUDIT_LOCK.candidateCaseCount;
  const memoryDenominator = memoryProof.encodingCaseCount;
  const simdDenominator = simdProof.caseCount;
  const denominatorCount = rawDenominator + memoryDenominator + simdDenominator;
  const coveredCount = ARM64_A64_DECODER_AUDIT_LOCK.decoderRecognizedCaseCount
    + memoryDenominator + simdDenominator;
  const counts = emptyCounts();
  counts.exact = coveredCount;
  counts.unsupported = ARM64_A64_DECODER_AUDIT_LOCK.decoderRejectedCaseCount;
  return Object.freeze({
    ...finalizeCounts(counts, denominatorCount),
    rawProofs,
    memoryDenominator,
    simdDenominator,
  });
}

async function main() {
  const inventory = loadA2DenominatorInventory();
  const inventoryValidation = validateA2DenominatorInventory(inventory);
  if (!inventoryValidation.valid || inventoryValidation.fullIsaCoverageIncluded || !inventoryValidation.terminalEligible) {
    fail('inventory-not-terminal', JSON.stringify(inventoryValidation));
  }

  const memoryProof = validateArm64A64MemoryDenominator();
  const simdProof = validateArm64A64SimdDenominator();
  const memoryDependency = (await import('../../validation/machine-effects/arm64-a64-memory-denominator.mjs')).arm64A64MemoryDecoderDependencyProof();
  const simdDependency = arm64A64SimdDecoderDependencyProof();
  if (!validateArm64A64DecoderDependencyProof('memory', memoryDependency)
      || !validateArm64A64DecoderDependencyProof('simd', simdDependency)) {
    fail('dependency-proof-invalid');
  }
  const terminal = arm64A64DecoderDenominatorFromLockedAudit({ memory: memoryDependency, simd: simdDependency });
  if (!terminal.terminalEligible) fail('decoder-denominator-not-terminal', JSON.stringify(terminal));

  const session = await createCapstoneArm64Session();
  try {
    const capstoneIdentity = Object.freeze({
      provider: 'capstone/backend',
      architecture: 'arm64',
      mode: 'a64',
      capstoneApi: session.version,
      artifacts: Object.freeze({
        'capstone.js': sha256File(path.join(ROOT, 'capstone.js')),
        'capstone.wasm': sha256File(path.join(ROOT, 'capstone.wasm')),
      }),
      instructionRegistry: buildArm64CapstoneRegistryEvidence(session.instructionName),
      machineEffectsSemanticVersion: ARM64_MACHINE_EFFECTS_SEMANTIC_VERSION,
    });
    if (!verifyArm64A64DecoderIdentity(capstoneIdentity)) fail('decoder-identity');

    const candidateCounts = emptyCounts();
    const familyCounts = {};
    let rawCaseCount = 0;
    for (const input of RAW_FAMILIES) {
      const proof = input.validate();
      familyCounts[input.family] = proof.encodingCaseCount;
      for (const item of input.cases()) {
        rawCaseCount += 1;
        const instruction = decodeOne(session, item.word, `arm64-source:${input.family}:${item.id}`);
        if (instruction == null) {
          candidateCounts.unsupported += 1;
          continue;
        }
        measureRow(candidateCounts, classifyMachineEffectsCoverage('arm64', instruction));
      }
    }

    const memoryCases = [...arm64A64MemoryEncodingCases()];
    const memoryAssembly = assembleMemoryCases(memoryCases);
    familyCounts.memory = memoryProof.encodingCaseCount;
    for (let index = 0; index < memoryCases.length; index += 1) {
      const item = memoryCases[index];
      const instruction = decodeOne(session, memoryAssembly.rows[index].word, `arm64-source:memory:${item.id}`);
      if (instruction == null) candidateCounts.unsupported += 1;
      else measureRow(candidateCounts, classifyMachineEffectsCoverage('arm64', instruction));
    }

    const simdCases = [...ARM64_A64_SIMD_ASSEMBLY_CASES];
    const simdAssembly = assembleSimdCases(simdCases);
    familyCounts.simd = simdProof.caseCount;
    for (let index = 0; index < simdCases.length; index += 1) {
      const item = simdCases[index];
      const instruction = decodeOne(
        session,
        simdAssembly.rows[index].word,
        `arm64-source:simd:${item.id}`,
        parseSimdOperands,
      );
      if (instruction == null) candidateCounts.unsupported += 1;
      else measureRow(candidateCounts, classifyMachineEffectsCoverage('arm64', instruction));
    }

    const denominatorCount = rawCaseCount + memoryCases.length + simdCases.length;
    const candidate = finalizeCounts(candidateCounts, denominatorCount);
    const reference = expectedReference(
      Object.freeze({
        candidateCaseCount: ARM64_A64_DECODER_AUDIT_LOCK.candidateCaseCount,
        recognizedCaseCount: ARM64_A64_DECODER_AUDIT_LOCK.decoderRecognizedCaseCount,
        rejectedCaseCount: ARM64_A64_DECODER_AUDIT_LOCK.decoderRejectedCaseCount,
        decoderAuditSha256: ARM64_A64_DECODER_AUDIT_LOCK.decoderAuditSha256,
        decoderRejectedSha256: ARM64_A64_DECODER_AUDIT_LOCK.decoderRejectedSha256,
      }),
      memoryProof,
      simdProof,
    );
    if (candidate.denominatorCount !== reference.denominatorCount) fail('denominator-count', `${candidate.denominatorCount}:${reference.denominatorCount}`);
    process.stdout.write(`${JSON.stringify({
      schemaVersion: RUNNER_SCHEMA,
      metricId: 'machine-effects-arm64-coverage',
      semanticVersion: ARM64_MACHINE_EFFECTS_SEMANTIC_VERSION,
      candidate,
      reference,
      familyCounts: Object.freeze(familyCounts),
      denominator: Object.freeze({
        inventorySchema: inventory.schemaVersion,
        inventoryDigest: stableDigest(inventory),
        fullIsaCoverageIncluded: inventory.scope.fullIsaCoverageIncluded,
        candidateCorpus: ARM64_A64_CANDIDATE_CORPUS_LOCK,
        rawCaseCount,
        memoryCaseCount: memoryCases.length,
        memoryCorpusSha256: arm64A64MemoryCorpusSha256(),
        simdCaseCount: simdCases.length,
        simdCorpusSha256: arm64A64SimdCorpusSha256(),
        capstoneIdentity,
        decoderIdentity: ARM64_A64_DECODER_IDENTITY_LOCK,
        decoderAudit: ARM64_A64_DECODER_AUDIT_LOCK,
        terminalDecoderDenominator: terminal,
      }),
      assemblerTools: Object.freeze({ memory: memoryAssembly.tools, simd: simdAssembly.tools }),
    }, null, 2)}\n`);
  } finally {
    session.close();
  }
}

try {
  await main();
} catch (error) {
  console.error(error?.stack || error?.message || String(error));
  process.exitCode = 1;
}
