#!/usr/bin/env node
/*
 * Direct-recompilability replay over the current-main measurement receipts.
 *
 * Reconstructs one C translation unit per measured case (all non-null
 * pseudocode bodies joined in discovery order — the same rule as
 * tools/validation/direct-recompilability/measure-g.mjs) and runs the same two
 * clang stages. It additionally compiles a bounded sample of function bodies
 * alone to separate packaging-only failures from function-local ones.
 *
 * Measurement-only: this file never changes production emitter/analysis code.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CASE_SCHEMA, optionValue, readJson } from './lib.mjs';

const FAIL_SAMPLE_LIMIT = 40;

export function reconstructSource(functions) {
  const bodies = [];
  for (const fn of Array.isArray(functions) ? functions : []) {
    if (typeof fn?.pseudocode === 'string' && fn.pseudocode.trim()) bodies.push(fn.pseudocode);
  }
  return bodies.length ? `${bodies.join('\n')}\n` : null;
}

export function runClang({ clang, sourceFile, mode, timeoutMs }) {
  const outputFile = path.join(os.tmpdir(), `hex-replay-${mode}-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.out`);
  const args = mode === 'syntax'
    ? ['-std=gnu11', '-fsyntax-only', '-ferror-limit=0', sourceFile]
    : ['-std=gnu11', '-O0', '-ferror-limit=0', '-c', sourceFile, '-o', outputFile];
  try {
    const result = spawnSync(clang, args, { encoding: 'utf8', timeout: timeoutMs });
    if (result.error?.code === 'ETIMEDOUT') return { ok: false, timedOut: true, stderr: '' };
    if (result.error) return { ok: false, timedOut: false, stderr: String(result.error?.message || result.error) };
    if (result.signal) return { ok: false, timedOut: false, stderr: `clang-signal:${result.signal}` };
    return { ok: result.status === 0, timedOut: false, stderr: String(result.stderr || result.stdout || '') };
  } catch (error) {
    if (error?.code === 'ETIMEDOUT') return { ok: false, timedOut: true, stderr: '' };
    return { ok: false, timedOut: false, stderr: String(error?.message || error) };
  } finally {
    fs.rmSync(outputFile, { force: true });
  }
}

const ERROR_LINE = /^(.+?):(\d+):(\d+): error: (.*)$/;
const WARNING_LINE = /^(.+?):(\d+):(\d+): warning: (.*)$/;

export function firstDiagnostic(stderr) {
  const lines = String(stderr ?? '').split(/\r?\n/);
  for (const line of lines) {
    const match = ERROR_LINE.exec(line);
    if (match) return { kind: 'error', message: match[4] };
  }
  for (const line of lines) {
    const match = WARNING_LINE.exec(line);
    if (match) return { kind: 'warning', message: match[4] };
  }
  return null;
}

export function diagnosticFamily(message) {
  const text = String(message ?? '');
  if (/use of undeclared identifier '([^']+)'/.test(text)) {
    const identifier = /use of undeclared identifier '([^']+)'/.exec(text)[1];
    if (/^(?:local_|var_|local_p)/.test(identifier)) return 'undeclared-local';
    if (/^global_/.test(identifier)) return 'undeclared-global';
    if (/^(?:sub_|func_|fn_)/.test(identifier)) return 'undeclared-function';
    if (/^(?:phi|bit_extract|bit_insert|sext|unknown_call|__a64_movi_|__arm64_)/.test(identifier)) return 'unknown-semantic-helper';
    return 'undeclared-identifier';
  }
  if (/unknown type name/.test(text)) return 'unknown-type-name';
  if (/^expected expression$/.test(text)) return 'expected-expression';
  if (/^expected '\]'/.test(text)) return "expected-']'";
  if (/^expected '[)};]'/.test(text) || /expected '\}'/.test(text)) return 'expected-closer';
  if (/conflicting types/.test(text)) return 'conflicting-types';
  if (/implicit declaration of function|call to undeclared function/.test(text)) return 'implicit-declaration';
  if (/too (?:few|many) arguments/.test(text)) return 'argument-count-mismatch';
  if (/incomplete (?:type|definition)/.test(text)) return 'incomplete-type';
  if (/invalid operands/.test(text)) return 'invalid-operands';
  if (/duplicate (?:member|case)/.test(text)) return 'duplicate-member-or-case';
  if (/unused (?:variable|function)/.test(text)) return 'unused-declaration';
  return `other:${text.slice(0, 60)}`;
}

function countDiagnostics(stderr, prefix) {
  const lines = String(stderr ?? '').split(/\r?\n/);
  return lines.filter(line => line.includes(`: ${prefix}:`)).length;
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


export function replayRecompilation({ runDir, outDir, clang = 'clang', clangTimeoutMs = 30000, maxFunctionsPerCase = 6, caseLimit = 0, log = console.log } = {}) {
  const records = loadCaseRecords(runDir).slice(0, caseLimit > 0 ? caseLimit : undefined);
  fs.mkdirSync(outDir, { recursive: true });
  const rows = [];
  const functionRows = [];
  for (const record of records) {
    const source = reconstructSource(record.functions);
    if (source == null) {
      rows.push({ caseId: record.caseId, state: 'NO_BODIES', syntax: null, object: null, firstDiagnostic: null, errors: 0, warnings: 0 });
      continue;
    }
    const sourceFile = path.join(outDir, `${Buffer.from(record.caseId).toString('hex')}.c`);
    fs.writeFileSync(sourceFile, source);
    const syntax = runClang({ clang, sourceFile, mode: 'syntax', timeoutMs: clangTimeoutMs });
    const syntaxFirst = syntax.ok ? null : firstDiagnostic(syntax.stderr);
    const row = {
      caseId: record.caseId,
      state: syntax.ok ? 'PASS' : (syntax.timedOut ? 'TIMEOUT' : 'FAIL'),
      syntax: syntax.ok,
      object: null,
      firstDiagnostic: syntaxFirst,
      firstFamily: syntaxFirst ? diagnosticFamily(syntaxFirst.message) : null,
      errors: countDiagnostics(syntax.stderr, 'error'),
      warnings: countDiagnostics(syntax.stderr, 'warning'),
      bodies: record.functions.filter(fn => typeof fn.pseudocode === 'string' && fn.pseudocode.trim()).length,
      functions: record.functions.length,
    };
    if (syntax.ok) {
      const object = runClang({ clang, sourceFile, mode: 'object', timeoutMs: clangTimeoutMs });
      row.object = object.ok;
      if (!object.ok) {
        row.state = object.timedOut ? 'TIMEOUT' : 'FAIL';
        const first = firstDiagnostic(object.stderr);
        row.firstDiagnostic = first ?? row.firstDiagnostic;
        row.firstFamily = first ? diagnosticFamily(first.message) : row.firstFamily;
        row.errors = countDiagnostics(object.stderr, 'error');
      }
    }
    rows.push(row);

    const sample = record.functions
      .filter(fn => typeof fn.pseudocode === 'string' && fn.pseudocode.trim())
      .slice(0, maxFunctionsPerCase);
    for (const fn of sample) {
      const fnFile = path.join(os.tmpdir(), `hex-replay-fn-${process.pid}-${Math.random().toString(16).slice(2)}.c`);
      fs.writeFileSync(fnFile, `${fn.pseudocode}\n`);
      const result = runClang({ clang, sourceFile: fnFile, mode: 'syntax', timeoutMs: clangTimeoutMs });
      const first = result.ok ? null : firstDiagnostic(result.stderr);
      functionRows.push({
        caseId: record.caseId, address: fn.address, name: fn.name, sizeBytes: fn.sizeBytes,
        state: fn.state, gotos: fn.gotos, elapsedMs: fn.elapsedMs,
        syntax: result.ok, timedOut: result.timedOut === true,
        firstFamily: first ? diagnosticFamily(first.message) : null,
        firstMessage: first ? first.message : null,
      });
      fs.rmSync(fnFile, { force: true });
    }
    log(`${record.caseId}: ${row.state} (${row.errors} errors, first=${row.firstFamily ?? 'none'})`);
  }

  const caseStates = {};
  for (const row of rows) caseStates[row.state] = (caseStates[row.state] ?? 0) + 1;
  const familyCounts = {};
  for (const row of rows) {
    const key = row.firstFamily ?? 'none';
    familyCounts[key] = (familyCounts[key] ?? 0) + 1;
  }
  const functionFamilies = {};
  for (const row of functionRows) {
    const key = row.firstFamily ?? 'none';
    functionFamilies[key] = (functionFamilies[key] ?? 0) + 1;
  }
  const summary = {
    schema: 'hex-current-main-recompilability-replay/v1',
    runDir, clang, clangTimeoutMs, maxFunctionsPerCase,
    denominator: { cases: rows.length, sampledFunctions: functionRows.length },
    caseStates, caseFirstFamilies: familyCounts,
    functionFirstFamilies: functionFamilies,
    firstFailureSamples: rows.filter(row => row.state !== 'PASS').slice(0, FAIL_SAMPLE_LIMIT)
      .map(row => ({ caseId: row.caseId, firstFamily: row.firstFamily, firstDiagnostic: row.firstDiagnostic, errors: row.errors })),
    cases: rows,
    functions: functionRows,
  };
  const outPath = path.join(outDir, 'replay-summary.json');
  fs.writeFileSync(outPath, `${JSON.stringify(summary, null, 2)}\n`);
  log(`replay summary -> ${outPath}`);
  return { summary, outPath };
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const runDir = path.resolve(optionValue(args, '--run', '.'));
  const outDir = path.resolve(optionValue(args, '--out', path.join(runDir, 'recompilability')));
  try {
    replayRecompilation({
      runDir, outDir,
      clang: optionValue(args, '--clang', 'clang'),
      clangTimeoutMs: Number(optionValue(args, '--clang-timeout-ms', '30000')),
      maxFunctionsPerCase: Number(optionValue(args, '--max-functions-per-case', '6')),
      caseLimit: Number(optionValue(args, '--case-limit', '0')),
    });
  } catch (error) {
    console.error(error?.message || error);
    process.exitCode = 1;
  }
}
