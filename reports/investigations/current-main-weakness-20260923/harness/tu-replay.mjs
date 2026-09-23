#!/usr/bin/env node
/*
 * Product translation-unit (TU) packaging replay.
 *
 * Measures the opt-in product packager (`query.translationUnit`) on selected
 * measured cases and compiles the produced TU with the same clang stages as the
 * raw replay. This separates "the emitter text cannot compile" from "the raw
 * concatenation lacks declarations the product packager already emits".
 *
 * Measurement-only; the packager is production code that already exists on main.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openProduct } from '../../../../tools/validation/public-benchmark/product-host.mjs';
import { CASE_SCHEMA, optionValue, optionValues, readJson } from './lib.mjs';
import { runClang, firstDiagnostic, diagnosticFamily, reconstructSource } from './recompile-replay.mjs';

const CHUNK = 256;

function countDiagnostics(stderr, prefix) {
  return String(stderr ?? '').split(/\r?\n/).filter(line => line.includes(`: ${prefix}:`)).length;
}

function loadCaseRecords(runDir) {
  const casesDir = path.join(runDir, 'cases');
  const records = [];
  for (const file of fs.readdirSync(casesDir).sort()) {
    if (!file.endsWith('.json')) continue;
    const record = readJson(path.join(casesDir, file));
    if (record?.schema === CASE_SCHEMA && Array.isArray(record.functions)) records.push(record);
  }
  return records;
}

function compileStage({ clang, sourceFile, clangTimeoutMs, mode }) {
  const result = runClang({ clang, sourceFile, mode, timeoutMs: clangTimeoutMs });
  const first = result.ok ? null : firstDiagnostic(result.stderr);
  return {
    ok: result.ok,
    timedOut: result.timedOut === true,
    errors: countDiagnostics(result.stderr, 'error'),
    warnings: countDiagnostics(result.stderr, 'warning'),
    firstFamily: first ? diagnosticFamily(first.message) : null,
    firstMessage: first ? first.message : null,
  };
}

function unresolvedKinds(unresolved) {
  const counts = {};
  for (const row of Array.isArray(unresolved) ? unresolved : []) {
    const key = row?.kind ?? 'unknown';
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

export async function replayTranslationUnits({
  runDir, outDir, clang = 'clang', clangTimeoutMs = 30000, caseLimit = 0, caseIds = [], log = console.log,
} = {}) {
  const wanted = new Set(caseIds);
  const selected = loadCaseRecords(runDir).filter(record => !wanted.size || wanted.has(record.caseId));
  const records = selected.slice(0, caseLimit > 0 ? caseLimit : undefined);
  fs.mkdirSync(outDir, { recursive: true });
  const rows = [];
  for (const record of records) {
    const bodies = record.functions.filter(fn => typeof fn.pseudocode === 'string' && fn.pseudocode.trim());
    if (!bodies.length) {
      rows.push({ caseId: record.caseId, state: 'NO_BODIES', functions: 0 });
      continue;
    }
    const rawSource = reconstructSource(record.functions);
    const rawFile = path.join(outDir, `${Buffer.from(record.caseId).toString('hex')}-raw.c`);
    fs.writeFileSync(rawFile, rawSource);
    const raw = compileStage({ clang, sourceFile: rawFile, clangTimeoutMs, mode: 'syntax' });
    fs.rmSync(rawFile, { force: true });

    const targets = bodies.slice(0, CHUNK);
    const product = await openProduct(record.binary);
    let tu = null;
    let unit = null;
    try {
      if (product.unsupported) {
        rows.push({ caseId: record.caseId, state: 'UNSUPPORTED', reason: product.reason ?? 'unsupported', raw });
        continue;
      }
      const snapshot = await product.query.snapshot();
      const response = await product.query.translationUnit(snapshot, targets.map(fn => String(fn.address)));
      unit = response?.value ?? null;
      if (!unit) {
        rows.push({
          caseId: record.caseId, state: 'TU_UNSUPPORTED', raw,
          reason: response?.status?.reason ?? 'translation-unit-unavailable',
        });
      } else {
        const tuFile = path.join(outDir, `${Buffer.from(record.caseId).toString('hex')}-tu.c`);
        fs.writeFileSync(tuFile, unit.source);
        const syntax = compileStage({ clang, sourceFile: tuFile, clangTimeoutMs, mode: 'syntax' });
        tu = { ...syntax };
        if (syntax.ok) {
          const object = compileStage({ clang, sourceFile: tuFile, clangTimeoutMs, mode: 'object' });
          tu.object = object.ok;
          if (!object.ok) {
            tu.ok = false;
            tu.errors = object.errors;
            tu.firstFamily = object.firstFamily ?? tu.firstFamily;
            tu.firstMessage = object.firstMessage ?? tu.firstMessage;
          }
        } else {
          tu.object = null;
        }
        fs.rmSync(tuFile, { force: true });
        rows.push({
          caseId: record.caseId,
          state: tu.ok ? 'PASS' : (tu.timedOut ? 'TIMEOUT' : 'FAIL'),
          functions: targets.length,
          discovered: record.functions.length,
          completeness: unit.completeness ?? null,
          reason: unit.reason ?? null,
          unresolved: unresolvedKinds(unit.unresolved),
          includes: Array.isArray(unit.includes) ? unit.includes.length : null,
          prototypes: Array.isArray(unit.prototypes) ? unit.prototypes.filter(row => row.declaration).length : null,
          globals: Array.isArray(unit.globals) ? unit.globals.filter(row => row.declaration).length : null,
          sourceChars: unit.source.length,
          raw,
          tu,
        });
      }
    } catch (error) {
      rows.push({
        caseId: record.caseId, state: 'ERROR', raw,
        reason: String(error?.message || error).slice(0, 400),
      });
    } finally {
      await product?.close?.();
    }
    const last = rows[rows.length - 1];
    log(`${record.caseId}: raw=${last.raw?.ok ? 'ok' : last.raw?.firstFamily ?? 'n/a'} tu=${last.state}${unit ? ` unresolved=${Object.values(last.unresolved ?? {}).reduce((a, b) => a + b, 0)}` : ''}`);
  }

  const caseStates = {};
  for (const row of rows) caseStates[row.state] = (caseStates[row.state] ?? 0) + 1;
  const rawFamilies = {};
  const tuFamilies = {};
  const unresolvedTotals = {};
  let rawOk = 0;
  let tuOk = 0;
  let rescued = 0;
  for (const row of rows) {
    const rawFamily = row.raw?.ok ? 'none' : (row.raw?.firstFamily ?? 'n/a');
    rawFamilies[rawFamily] = (rawFamilies[rawFamily] ?? 0) + 1;
    const tuFamily = row.tu?.ok ? 'none' : (row.tu?.firstFamily ?? 'n/a');
    tuFamilies[tuFamily] = (tuFamilies[tuFamily] ?? 0) + 1;
    if (row.raw?.ok) rawOk += 1;
    if (row.tu?.ok) tuOk += 1;
    if (!row.raw?.ok && row.tu?.ok) rescued += 1;
    for (const [kind, count] of Object.entries(row.unresolved ?? {})) {
      unresolvedTotals[kind] = (unresolvedTotals[kind] ?? 0) + count;
    }
  }
  const summary = {
    schema: 'hex-current-main-tu-replay/v1',
    runDir, clang, clangTimeoutMs, chunkLimit: CHUNK,
    denominator: { cases: rows.length, functions: rows.reduce((total, row) => total + (row.functions ?? 0), 0) },
    caseStates,
    rawCaseFamilies: rawFamilies,
    tuCaseFamilies: tuFamilies,
    comparison: { rawOk, tuOk, rescuedByPackager: rescued },
    unresolvedTotals,
    cases: rows,
  };
  const outPath = path.join(outDir, 'tu-replay-summary.json');
  fs.writeFileSync(outPath, `${JSON.stringify(summary, null, 2)}\n`);
  log(`TU replay summary -> ${outPath}`);
  log(`raw ok ${rawOk}/${rows.length}, TU ok ${tuOk}/${rows.length}, rescued by packager ${rescued}`);
  log(`TU unresolved: ${JSON.stringify(unresolvedTotals)}`);
  return { summary, outPath };
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const runDir = path.resolve(optionValue(args, '--run', '.'));
  const outDir = path.resolve(optionValue(args, '--out', path.join(runDir, 'tu-replay')));
  try {
    await replayTranslationUnits({
      runDir, outDir,
      clang: optionValue(args, '--clang', 'clang'),
      clangTimeoutMs: Number(optionValue(args, '--clang-timeout-ms', '30000')),
      caseLimit: Number(optionValue(args, '--case-limit', '0')),
      caseIds: optionValues(args, '--case-id'),
    });
  } catch (error) {
    console.error(error?.stack || error?.message || error);
    process.exitCode = 1;
  }
}
