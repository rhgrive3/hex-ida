#!/usr/bin/env node
/*
 * Track 10 (§14): Gate E 10-Axis Head-to-Head Scorecard Harness.
 *
 * Fail-Closed design:
 * - Zero hardcoded fake-pass baseline metrics.
 * - Without `--input <metrics.json>`, probes ONLY real local artifacts
 *   (`wasm/hex_engine.wasm` raw/gzip size & WebAssembly import count,
 *   all Track 10 UI files existence + extended XSS sink audit,
 *   `PRIMARY_NAV.length === 4`, and live `export-interop` <-> `delta-session`
 *   round-trip). All unmeasured external benchmark axes are honestly reported
 *   as `UNMEASURED` (`passed: false`, exit code `1`).
 * - With `--input <metrics.json>`, evaluates all 10 axes against strict
 *   numeric thresholds and hard disqualifiers (`NaN`/non-number = immediate
 *   disqualifier FAIL). Only when all 10 axes are measured and pass with 0
 *   disqualifiers does it emit `BEYOND_IDA_TOTAL_PASS` (exit code `0`).
 *
 * Pure ESM, zero external runtime dependencies.
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { PRIMARY_NAV } from '../../../js/ui/registry.js';
import { parseDeltaJson } from '../../../js/cache/delta-session.js';
import {
  exportCHeader,
  exportInteropJson,
  importInteropJson,
  exportDwarfSummaryJson,
  validateDwarfSummaryJson,
  exportHexDbDeltaBundle,
  importHexDbDeltaBundle,
} from '../../../js/ui/export-interop.js';

export const GATE_E_SCHEMA_ID = 'hex-ida-gate-e-scorecard/v1';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

export const TRACK10_UI_FILES = Object.freeze([
  'js/ui/type-edit-popover.js',
  'js/ui/slice-panel.js',
  'js/ui/export-interop.js',
  'js/ui/manual-recovery-popover.js',
]);

export const UNSAFE_HTML_SINK_RE = /\.(?:innerHTML|outerHTML)\s*=|insertAdjacentHTML\s*\(|document\.writeln?\s*\(|createContextualFragment\s*\(|\bDOMParser\b|\beval\s*\(|\bnew\s+Function\s*\(|setAttribute\s*\(\s*['"`]on[a-z]+/gi;

function isFiniteNumber(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

/**
 * Evaluates a numeric check with Fail-Closed handling:
 * - `undefined` or `null` -> `unmeasured: true, passed: false`
 * - `NaN`, `Infinity`, or non-number -> immediate disqualifier FAIL
 * - finite number -> evaluates `predicate(actual)`
 */
function numChk(name, actual, thresholdDesc, predicate, disqualifierOnFail = false) {
  if (actual === undefined || actual === null) {
    return Object.freeze({
      name,
      actual: null,
      threshold: thresholdDesc,
      passed: false,
      unmeasured: true,
      disqualifier: false,
    });
  }
  if (!isFiniteNumber(actual)) {
    return Object.freeze({
      name,
      actual: Number.isNaN(actual) ? 'NaN' : actual,
      threshold: thresholdDesc,
      passed: false,
      unmeasured: false,
      disqualifier: true,
      reason: 'non-finite-or-non-numeric',
    });
  }
  const ok = Boolean(predicate(actual));
  const isDisq = !ok && (typeof disqualifierOnFail === 'function' ? Boolean(disqualifierOnFail(actual)) : Boolean(disqualifierOnFail));
  return Object.freeze({
    name,
    actual,
    threshold: thresholdDesc,
    passed: ok,
    unmeasured: false,
    disqualifier: isDisq,
  });
}

export const GATE_E_AXES = Object.freeze([
  Object.freeze({
    number: 1,
    id: 'type-sig-propagation',
    name: 'Type/Sig Propagation',
    specRef: '§2 / §9 / §14.1 (Axes 1-2)',
    targetCategory: 'CLEAR_WIN',
    evaluate(m = {}) {
      return [
        numChk('humanEvalExecPassRate', m.humanEvalExecPassRate, '== 1.0', (v) => v === 1.0, true),
        numChk('compilerTruthMismatches', m.compilerTruthMismatches, '== 0', (v) => v === 0, true),
        numChk('dirtyConeSyncMs', m.dirtyConeSyncMs, '<= 16', (v) => v <= 16),
        numChk('pathA2ReDecompileMs', m.pathA2ReDecompileMs, '< 15', (v) => v < 15),
        numChk('r2iPathB', m.r2iPathB, '>= 1.15', (v) => v >= 1.15),
        numChk('r2iPathA1', m.r2iPathA1, '>= 1.25', (v) => v >= 1.25),
      ];
    },
  }),
  Object.freeze({
    number: 2,
    id: 'til-sdk-resolution',
    name: 'TIL/SDK Resolution',
    specRef: '§3 / §10 / §18 / §14.1 (Axes 7 & 9)',
    targetCategory: 'CLEAR_WIN',
    evaluate(m = {}) {
      return [
        numChk('tilHubTop1Accuracy', m.tilHubTop1Accuracy, '>= 0.95', (v) => v >= 0.95),
        numChk('il2cppPartialParseRecovery', m.il2cppPartialParseRecovery, '>= 0.99', (v) => v >= 0.99),
        numChk('headerParsePeakMb', m.headerParsePeakMb, '<= 4.0', (v) => v <= 4.0),
        numChk('sdkBatchRecovery', m.sdkBatchRecovery, '>= 0.98', (v) => v >= 0.98),
        numChk('zipBombTraversalRejectRate', m.zipBombTraversalRejectRate, '== 1.0', (v) => v === 1.0, true),
      ];
    },
  }),
  Object.freeze({
    number: 3,
    id: 'struct-bitfield-union',
    name: 'Struct/Bitfield/Union',
    specRef: '§4 / §14.1 (Axis 3)',
    targetCategory: 'PARITY_OR_BETTER',
    evaluate(m = {}) {
      const idaF1 = isFiniteNumber(m.idaMacroF1) ? m.idaMacroF1 : 0.85;
      const idaBfF1 = isFiniteNumber(m.idaBitfieldF1) ? m.idaBitfieldF1 : 0.75;
      const idaStructF1 = isFiniteNumber(m.idaStructF1) ? m.idaStructF1 : 0.85;
      return [
        numChk('macroF1', m.macroF1, `>= max(0.85, ${idaF1} - 0.01)`, (v) => v >= 0.85 && v >= idaF1 - 0.01),
        numChk('bitfieldF1', m.bitfieldF1, `>= ${idaBfF1} + 0.05`, (v) => v >= idaBfF1 + 0.05),
        numChk('structF1', m.structF1, `>= ${idaStructF1}`, (v) => v >= idaStructF1),
        numChk('falseCertaintyRate', m.falseCertaintyRate, '<= 0.015 (disq > 0.02)', (v) => v >= 0 && v <= 0.015, (v) => v > 0.02 || v < 0),
      ];
    },
  }),
  Object.freeze({
    number: 4,
    id: 'manual-recovery',
    name: 'Manual Recovery',
    specRef: '§15 / §14.1 (Axis 8)',
    targetCategory: 'CLEAR_WIN',
    evaluate(m = {}) {
      return [
        numChk('deltaV2RoundTripRate', m.deltaV2RoundTripRate, '== 1.0', (v) => v === 1.0, true),
        numChk('undoRedoRestoreRate', m.undoRedoRestoreRate, '== 1.0', (v) => v === 1.0, true),
        numChk('containerOfC11CompileFailures', m.containerOfC11CompileFailures, '== 0', (v) => v === 0, true),
      ];
    },
  }),
  Object.freeze({
    number: 5,
    id: 'region-stackweb-asm-island',
    name: 'Region/StackWeb/ASM Island',
    specRef: '§16 / §14.1 (Axis 8)',
    targetCategory: 'CLEAR_WIN',
    evaluate(m = {}) {
      return [
        numChk('hugeFuncSilentFallbacks', m.hugeFuncSilentFallbacks, '== 0', (v) => v === 0, true),
        numChk('stackWebSplitF1', m.stackWebSplitF1, '>= 0.90', (v) => v >= 0.90),
        numChk('nonEscapeMisSplits', m.nonEscapeMisSplits, '== 0', (v) => v === 0, true),
        numChk('asmIslandSsaCorruptions', m.asmIslandSsaCorruptions, '== 0', (v) => v === 0, true),
      ];
    },
  }),
  Object.freeze({
    number: 6,
    id: 'hexsig-delta-porting',
    name: 'HEX-SIG & Delta Porting',
    specRef: '§11 / §14.1 (Axis 4)',
    targetCategory: 'CLEAR_WIN',
    evaluate(m = {}) {
      const idaSame = isFiniteNumber(m.idaFlirtSameOptF1) ? m.idaFlirtSameOptF1 : 0.90;
      const idaCross = isFiniteNumber(m.idaFlirtCrossOptF1) ? m.idaFlirtCrossOptF1 : 0.55;
      return [
        numChk('sameOptF1', m.sameOptF1, `>= max(0.90, ${idaSame} - 0.02)`, (v) => v >= 0.90 && v >= idaSame - 0.02),
        numChk('crossOptF1', m.crossOptF1, `>= ${idaCross} + 0.15`, (v) => v >= idaCross + 0.15),
        numChk('crossOptFpr', m.crossOptFpr, '<= 0.005', (v) => v >= 0 && v <= 0.005, true),
        numChk('deltaPortAccuracy', m.deltaPortAccuracy, '>= 0.95', (v) => v >= 0.95),
      ];
    },
  }),
  Object.freeze({
    number: 7,
    id: 'cross-func-slicing-cxx-stl',
    name: 'Cross-Func Slicing & C++/STL',
    specRef: '§12 / §13 / §14.1 (Axes 3 & 7)',
    targetCategory: 'CLEAR_WIN',
    evaluate(m = {}) {
      return [
        numChk('sliceBudgetViolations', m.sliceBudgetViolations, '== 0', (v) => v === 0, true),
        numChk('stackXorStringRecall', m.stackXorStringRecall, '>= 0.90', (v) => v >= 0.90),
        numChk('stackXorStringFpr', m.stackXorStringFpr, '== 0.0', (v) => v === 0.0, true),
        numChk('copyFindBarZeroDiffRate', m.copyFindBarZeroDiffRate, '== 1.0', (v) => v === 1.0, true),
        numChk('stlMultiInheritF1', m.stlMultiInheritF1, '>= 0.80', (v) => v >= 0.80),
      ];
    },
  }),
  Object.freeze({
    number: 8,
    id: 'deobfuscation-cff-mba-emu',
    name: 'Deobfuscation CFF/MBA/Emu',
    specRef: '§19 / §14.1 (Axis 10)',
    targetCategory: 'CLEAR_WIN',
    evaluate(m = {}) {
      return [
        numChk('cffRecoveryRate', m.cffRecoveryRate, '>= 0.90', (v) => v >= 0.90),
        numChk('naturalFsmFalsePositiveRate', m.naturalFsmFalsePositiveRate, '== 0.0', (v) => v === 0.0, true),
        numChk('mbaSimplificationRate', m.mbaSimplificationRate, '>= 0.90', (v) => v >= 0.90),
        numChk('mbaEquivProofErrors', m.mbaEquivProofErrors, '== 0', (v) => v === 0, true),
        numChk('miniEmuDecodeRecall', m.miniEmuDecodeRecall, '>= 0.85', (v) => v >= 0.85),
        numChk('miniEmuOutOfBoundsWrites', m.miniEmuOutOfBoundsWrites, '== 0', (v) => v === 0, true),
      ];
    },
  }),
  Object.freeze({
    number: 9,
    id: 'hexdb-memory-budgets',
    name: 'HEX-DB & Memory Budgets',
    specRef: '§8 / §16 / §17 / §14.1 (Axes 6 & 9)',
    targetCategory: 'CLEAR_WIN',
    evaluate(m = {}) {
      return [
        numChk('hexdbXrefMissingRate', m.hexdbXrefMissingRate, '== 0.0', (v) => v === 0.0, true),
        numChk('hexdbQueryMedianMs', m.hexdbQueryMedianMs, '< 50', (v) => v >= 0 && v < 50),
        numChk('mobilePeakHeapMb', m.mobilePeakHeapMb, '<= 256', (v) => v > 0 && v <= 256, true),
        numChk('desktopPeakHeapMb', m.desktopPeakHeapMb, '<= 1024', (v) => v > 0 && v <= 1024, true),
        numChk('ioTransferRatio', m.ioTransferRatio, '<= 0.12', (v) => v >= 0 && v <= 0.12),
        numChk('wasmSizeRawMib', m.wasmSizeRawMib, '<= 1.40', (v) => v > 0 && v <= 1.40, true),
        numChk('wasmSizeGzipKib', m.wasmSizeGzipKib, '<= 520', (v) => v > 0 && v <= 520, true),
      ];
    },
  }),
  Object.freeze({
    number: 10,
    id: 'export-ui-interop-rollback-parity',
    name: 'Export/UI Interop & Rollback Parity',
    specRef: '§7 / §9 / §10.2 / §14.1 (Gate D)',
    targetCategory: 'CLEAR_WIN',
    evaluate(m = {}) {
      return [
        numChk('primaryNavLength', m.primaryNavLength, '== 4', (v) => v === 4, true),
        numChk('missingUiFiles', m.missingUiFiles, '== 0', (v) => v === 0, true),
        numChk('uiXssSinkCount', m.uiXssSinkCount, '== 0', (v) => v === 0, true),
        numChk('exportInteropRoundTripRate', m.exportInteropRoundTripRate, '== 1.0', (v) => v === 1.0, true),
        numChk('wasmJsParityRate', m.wasmJsParityRate, '== 1.0', (v) => v === 1.0, true),
        numChk('wasmExternalImports', m.wasmExternalImports, '== 0', (v) => v === 0, true),
      ];
    },
  }),
]);

/**
 * Probes ONLY real, verifiable local artifacts in the repository.
 * Unmeasured external benchmark axes are intentionally left empty (not faked).
 */
export function collectLocalMetrics(repoRoot = REPO_ROOT) {
  let missingUiFiles = 0;
  let uiXssSinkCount = 0;

  for (const rel of TRACK10_UI_FILES) {
    const abs = path.join(repoRoot, rel);
    if (!fs.existsSync(abs)) {
      missingUiFiles += 1;
      continue;
    }
    const src = fs.readFileSync(abs, 'utf8');
    const matches = src.match(UNSAFE_HTML_SINK_RE);
    if (matches) uiXssSinkCount += matches.length;
  }

  // Real wasm/hex_engine.wasm inspection (size + WebAssembly.Module.imports)
  let wasmSizeRawMib = null;
  let wasmSizeGzipKib = null;
  let wasmExternalImports = null;
  const wasmPath = path.join(repoRoot, 'wasm/hex_engine.wasm');
  if (fs.existsSync(wasmPath)) {
    const buf = fs.readFileSync(wasmPath);
    wasmSizeRawMib = Math.round((buf.byteLength / (1024 * 1024)) * 10000) / 10000;
    const gz = zlib.gzipSync(buf, { level: 9 });
    wasmSizeGzipKib = Math.round((gz.byteLength / 1024) * 100) / 100;
    const mod = new WebAssembly.Module(buf);
    wasmExternalImports = WebAssembly.Module.imports(mod).length;
  }

  // Live export-interop + delta-session mutual round-trip probe
  const sampleModel = {
    binarySha256: '0123456789abcdef',
    binaryName: 'probe_bin',
    arch: 'arm64',
    imageBase: '0x100000000',
    functions: [{ va: '0x100004000', name: 'probe_fn', sig: 'int probe_fn(void *ctx)', pinned: true }],
    structs: [{ name: 'ProbeCtx', size: 16, align: 8, members: [{ offset: 0, name: 'flags', type: 'uint32_t', size: 4 }] }],
    globals: [{ va: '0x100020000', name: 'g_ctx', type: 'ProbeCtx *' }],
  };
  let rtPassed = 0;
  const rtTotal = 5;
  if (exportCHeader(sampleModel).includes('struct ProbeCtx')) rtPassed += 1;
  const interop = exportInteropJson(sampleModel);
  if (importInteropJson(JSON.stringify(interop)).ok) rtPassed += 1;
  const dwarf = exportDwarfSummaryJson(sampleModel);
  if (validateDwarfSummaryJson(JSON.stringify(dwarf)).valid) rtPassed += 1;
  const delta = exportHexDbDeltaBundle({
    binarySha256: '0123456789abcdef',
    manualSegments: [{ startVa: '0x100004000', byteLen: 4, kind: 1 }],
    funcChunks: [{ funcVa: '0x100004000', startVa: '0x100004100', endVa: '0x100004120' }],
    shiftedPtrs: [{ funcVa: '0x100004000', varKey: 'arg:0', parentType: 'ProbeCtx', shiftOffset: 8 }],
    pinnedMasks: { '0x100004000': 1 },
  });
  if (importHexDbDeltaBundle(delta.json).ok) rtPassed += 1;
  if (parseDeltaJson(delta.json).ok) rtPassed += 1;

  return {
    'hexdb-memory-budgets': {
      wasmSizeRawMib,
      wasmSizeGzipKib,
    },
    'export-ui-interop-rollback-parity': {
      primaryNavLength: Array.isArray(PRIMARY_NAV) ? PRIMARY_NAV.length : -1,
      missingUiFiles,
      uiXssSinkCount,
      exportInteropRoundTripRate: rtPassed / rtTotal,
      wasmExternalImports,
    },
  };
}

/**
 * Deterministic 10-axis Gate E evaluation engine.
 */
export function evaluateGateEScorecard(inputMetrics = null, options = {}) {
  const metricsByAxis = inputMetrics ?? collectLocalMetrics(options.repoRoot ?? REPO_ROOT);
  const axesResults = [];
  let totalChecks = 0;
  let passedChecks = 0;
  let unmeasuredChecksTotal = 0;
  let totalDisqualifiers = 0;

  for (const axis of GATE_E_AXES) {
    const raw = metricsByAxis[axis.id] ?? {};
    const checks = axis.evaluate(raw);
    const axisPassedChecks = checks.filter((c) => c.passed).length;
    const axisUnmeasuredChecks = checks.filter((c) => c.unmeasured).length;
    const axisMeasuredFailed = checks.filter((c) => !c.passed && !c.unmeasured).length;
    const axisDisqualifiers = checks.filter((c) => c.disqualifier).length;

    let status;
    let passed = false;
    if (axisMeasuredFailed > 0 || axisDisqualifiers > 0) {
      status = 'FAIL';
      passed = false;
    } else if (axisUnmeasuredChecks > 0) {
      status = 'UNMEASURED';
      passed = false;
    } else {
      status = axis.targetCategory;
      passed = true;
    }

    const measuredCount = checks.length - axisUnmeasuredChecks;
    const score = measuredCount > 0 ? Math.round((axisPassedChecks / checks.length) * 1000) / 10 : 0;

    totalChecks += checks.length;
    passedChecks += axisPassedChecks;
    unmeasuredChecksTotal += axisUnmeasuredChecks;
    totalDisqualifiers += axisDisqualifiers;

    axesResults.push(Object.freeze({
      number: axis.number,
      id: axis.id,
      name: axis.name,
      specRef: axis.specRef,
      targetCategory: axis.targetCategory,
      status,
      passed,
      unmeasured: status === 'UNMEASURED',
      disqualified: axisDisqualifiers > 0,
      disqualifierCount: axisDisqualifiers,
      score,
      checks: Object.freeze(checks),
    }));
  }

  const passedAxes = axesResults.filter((a) => a.passed).length;
  const failedAxes = axesResults.filter((a) => a.status === 'FAIL').length;
  const unmeasuredAxes = axesResults.filter((a) => a.status === 'UNMEASURED').length;
  const allAxesPass = passedAxes === GATE_E_AXES.length && totalDisqualifiers === 0 && unmeasuredAxes === 0;

  let verdict;
  if (allAxesPass) verdict = 'BEYOND_IDA_TOTAL_PASS';
  else if (failedAxes > 0 || totalDisqualifiers > 0) verdict = 'FAIL';
  else verdict = 'UNMEASURED';

  return Object.freeze({
    schema: GATE_E_SCHEMA_ID,
    verdict,
    passed: allAxesPass,
    exitCode: allAxesPass ? 0 : 1,
    summary: Object.freeze({
      axesTotal: GATE_E_AXES.length,
      axesPassed: passedAxes,
      axesFailed: failedAxes,
      axesUnmeasured: unmeasuredAxes,
      checksTotal: totalChecks,
      checksPassed: passedChecks,
      checksUnmeasured: unmeasuredChecksTotal,
      disqualifiers: totalDisqualifiers,
      overallScore: totalChecks > 0 ? Math.round((passedChecks / totalChecks) * 1000) / 10 : 0,
    }),
    axes: Object.freeze(axesResults),
  });
}

export function formatGateEJson(result) {
  return JSON.stringify(result, null, 2);
}

export function formatGateETable(result) {
  const lines = [];
  lines.push(`# Gate E 10-Axis Scorecard (${result.schema})`);
  lines.push(`Verdict: ${result.verdict} | Axes: ${result.summary.axesPassed}/${result.summary.axesTotal} passed, ${result.summary.axesUnmeasured} unmeasured, ${result.summary.axesFailed} failed | Disqualifiers: ${result.summary.disqualifiers}`);
  lines.push('');
  lines.push('| # | Axis | Target | Status | Score | Checks |');
  lines.push('|---:|---|---|---|---:|---:|');
  for (const axis of result.axes) {
    const okCount = axis.checks.filter((c) => c.passed).length;
    const statusLabel = axis.disqualified ? 'FAIL (DISQ)' : axis.status;
    lines.push(`| ${axis.number} | ${axis.name} | ${axis.targetCategory} | ${statusLabel} | ${axis.score.toFixed(1)}% | ${okCount}/${axis.checks.length} |`);
  }
  const nonPassingAxes = result.axes.filter((a) => !a.passed);
  if (nonPassingAxes.length > 0) {
    lines.push('');
    lines.push('Non-Passing Checks:');
    for (const axis of nonPassingAxes) {
      for (const c of axis.checks.filter((x) => !x.passed)) {
        const tag = c.unmeasured ? ' [UNMEASURED]' : (c.disqualifier ? ' [DISQUALIFIER]' : '');
        lines.push(`- [Axis ${axis.number} ${axis.name}] ${c.name}: actual=${JSON.stringify(c.actual)}, expected ${c.threshold}${tag}`);
      }
    }
  }
  return lines.join('\n') + '\n';
}

export function runGateECli(argv = process.argv.slice(2)) {
  let inputPath = null;
  let outPath = null;
  let format = 'both';

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--input' && argv[i + 1]) {
      inputPath = argv[++i];
    } else if (arg === '--out' && argv[i + 1]) {
      outPath = argv[++i];
    } else if (arg === '--format' && argv[i + 1]) {
      format = argv[++i];
    } else if (arg === '--help' || arg === '-h') {
      console.log('Usage: node gate-e-scorecard.mjs [--input metrics.json] [--format json|table|both] [--out report.json]');
      return 0;
    } else {
      console.error(`Unknown argument: ${arg}`);
      return 2;
    }
  }

  let inputMetrics = null;
  if (inputPath) {
    try {
      inputMetrics = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
    } catch (err) {
      console.error(`Failed to read --input ${inputPath}: ${err.message}`);
      return 2;
    }
  }

  const result = evaluateGateEScorecard(inputMetrics);
  const jsonText = formatGateEJson(result);
  const tableText = formatGateETable(result);

  if (outPath) {
    fs.writeFileSync(outPath, jsonText + '\n', 'utf8');
  }
  if (format === 'json') {
    console.log(jsonText);
  } else if (format === 'table') {
    console.log(tableText);
  } else {
    console.log(tableText);
    console.log(jsonText);
  }
  return result.exitCode;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  process.exitCode = runGateECli();
}
