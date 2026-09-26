#!/usr/bin/env node
/*
 * Faithful-body TU replay for the lane-tu evidence.
 *
 * Measurement only. Loads the saved case receipts (evidence .../run/cases),
 * rebuilds each translation unit with the production packager
 * (js/analysis/query/translation-unit.js), and reports honest counts:
 *
 *   - per case: whether the emitted TU parses (`-fsyntax-only`), and whether
 *     the faithful subset alone parses;
 *   - per emitted definition: an isolated clang syntax check of that single
 *     definition plus the shared declaration prelude, so one broken body can
 *     never mask another. Placeholder definitions are checked too, but they
 *     are reported separately and never counted as recovered functions.
 *
 * Usage:
 *   node reports/investigations/output-recompilation-20260924/tu-replay-faithful.mjs \
 *     --run <evidence>/run --out <evidence>/<tag-dir> [--clang /usr/bin/clang-18]
 *     [--case-id <id> ...] [--keep-c]
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildCTranslationUnit } from '../../../js/analysis/query/translation-unit.js';

function optionValue(args, name, fallback) {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] != null ? args[index + 1] : fallback;
}

function optionValues(args, name) {
  const values = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === name && args[i + 1] != null) values.push(args[i + 1]);
  }
  return values;
}

const args = process.argv.slice(2);
const runDir = path.resolve(optionValue(args, '--run', '.'));
const outDir = path.resolve(optionValue(args, '--out', path.join(runDir, 'tu-faithful')));
const clang = optionValue(args, '--clang', '/usr/bin/clang-18');
const keepC = args.includes('--keep-c');
const wantedCaseIds = new Set(optionValues(args, '--case-id'));
const CHUNK = 256;

function runClangFile(file) {
  const result = spawnSync(clang, ['-std=gnu11', '-fsyntax-only', '-ferror-limit=0', file], {
    encoding: 'utf8', timeout: 60000,
  });
  const lines = String(result.stderr ?? '').split('\n').filter((line) => /: error:/.test(line));
  return { ok:result.status === 0, errors:lines.length, first:lines[0] ?? null };
}

/* One definition (+ its signature) prepended to the shared prelude, written
 * to a scratch file and syntax-checked alone. */
function checkFunctionAlone(prelude, definition) {
  const file = path.join(outDir, `alone-${definition.indexHex}.c`);
  fs.writeFileSync(file, `${prelude}\n${definition.source}\n`);
  const verdict = runClangFile(file);
  if (!keepC) fs.rmSync(file, { force:true });
  return verdict;
}

function loadCaseRecords(runDir) {
  const casesDir = path.join(runDir, 'cases');
  const records = [];
  for (const file of fs.readdirSync(casesDir).sort()) {
    if (!file.endsWith('.json')) continue;
    const record = JSON.parse(fs.readFileSync(path.join(casesDir, file), 'utf8'));
    if (record?.schema === 'hex-current-main-harness-case/v1' && Array.isArray(record.functions)) {
      records.push(record);
    }
  }
  return records;
}

fs.mkdirSync(outDir, { recursive:true });
const rows = [];
for (const record of loadCaseRecords(runDir)) {
  if (wantedCaseIds.size && !wantedCaseIds.has(record.caseId)) continue;
  const bodies = record.functions
    .filter((fn) => typeof fn.pseudocode === 'string' && fn.pseudocode.trim())
    .slice(0, CHUNK)
    .map((fn) => ({
      functionId:fn.functionId ?? null, address:fn.address, name:fn.name ?? null,
      signature:null, pseudocode:fn.pseudocode,
    }));
  if (!bodies.length) {
    rows.push({ caseId:record.caseId, state:'NO_BODIES', functions:0 });
    continue;
  }
  const unit = buildCTranslationUnit(bodies, { symbolFor:() => null });
  const source = unit.source;

  // The shared declaration prelude is everything before the first definition.
  // Match the definition (a `{` follows the parameter list), not the selected
  // declaration of the same name (which ends with `;`).
  const firstDefinition = unit.functions[0]?.name ?? null;
  let preludeEnd = -1;
  if (firstDefinition) {
    const escaped = firstDefinition.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const marker = new RegExp(`\\n[^\\n]*\\b${escaped}\\s*\\([^)]*\\)\\s*\\{`);
    const match = marker.exec(source);
    if (match) preludeEnd = match.index;
  }
  const prelude = preludeEnd > 0 ? source.slice(0, preludeEnd) : '';

  const tuFile = path.join(outDir, `${Buffer.from(record.caseId).toString('hex')}-tu.c`);
  fs.writeFileSync(tuFile, source);
  const tuCheck = runClangFile(tuFile);
  if (!keepC) fs.rmSync(tuFile, { force:true });

  const functionRows = [];
  const counts = { faithful:0, placeholders:0, faithfulParse:0, placeholderParse:0, unmasked:0, masked:0 };
  for (let i = 0; i < unit.functions.length; i++) {
    const fn = unit.functions[i];
    const sourceText = `${fn.signature ?? ''}\n${fn.emittedPseudocode}`;
    const definition = {
      indexHex:`${Buffer.from(record.caseId).toString('hex')}-${i}`,
      source:sourceText,
    };
    const alone = checkFunctionAlone(prelude, definition);
    const faithful = fn.syntaxOnly === false;
    if (faithful) {
      counts.faithful += 1;
      if (alone.ok) counts.faithfulParse += 1;
      else if (tuCheck.ok) counts.masked += 1;
      else counts.unmasked += 1;
    } else {
      counts.placeholders += 1;
      if (alone.ok) counts.placeholderParse += 1;
    }
    functionRows.push({
      name:fn.name, faithful, aloneParse:alone.ok,
      firstError:alone.ok ? null : alone.first,
    });
  }

  rows.push({
    caseId:record.caseId,
    state:tuCheck.ok ? 'PASS' : 'FAIL',
    functions:functionRows.length,
    faithful:counts.faithful,
    placeholders:counts.placeholders,
    tuParse:tuCheck.ok,
    tuFirstError:tuCheck.ok ? null : tuCheck.first,
    faithfulParse:counts.faithfulParse,
    placeholderParse:counts.placeholderParse,
    faithfulMaskedInTui:counts.masked,
    faithfulUnmasked:counts.unmasked,
    completeness:unit.completeness,
    unresolved:Object.entries(unit.unresolved.reduce((acc, row) => {
      acc[row.kind] = (acc[row.kind] ?? 0) + 1; return acc;
    }, {})),
    failedFaithfulNames:functionRows.filter((row) => row.faithful && !row.aloneParse)
      .map((row) => ({ name:row.name, firstError:row.firstError })),
  });
  const last = rows[rows.length - 1];
  console.log(`${record.caseId}: tu=${last.state} faithful=${last.faithful}/${last.functions} faithfulAloneParse=${last.faithfulParse}/${last.faithful} unmasked=${last.faithfulUnmasked}`);
}

const totalFunctions = rows.reduce((total, row) => total + (row.functions ?? 0), 0);
const totalFaithful = rows.reduce((total, row) => total + (row.faithful ?? 0), 0);
const totalPlaceholders = rows.reduce((total, row) => total + (row.placeholders ?? 0), 0);
const totalFaithfulParse = rows.reduce((total, row) => total + (row.faithfulParse ?? 0), 0);
const totalPlaceholderParse = rows.reduce((total, row) => total + (row.placeholderParse ?? 0), 0);
const totalUnmasked = rows.reduce((total, row) => total + (row.faithfulUnmasked ?? 0), 0);
const tuOkCount = rows.filter((row) => row.tuParse === true).length;
const summary = {
  schema:'hex-lane-tu-faithful-replay/v2',
  runDir, clang, chunkLimit:CHUNK,
  denominator:{ cases:rows.length, functions:totalFunctions },
  emitted:{ faithful:totalFaithful, placeholders:totalPlaceholders },
  tuParse:{ ok:tuOkCount, total:rows.length },
  faithfulAloneParse:{ ok:totalFaithfulParse, total:totalFaithful },
  placeholderAloneParse:{ ok:totalPlaceholderParse, total:totalPlaceholders },
  faithfulUnmasked:totalUnmasked,
  cases:rows,
};
const outPath = path.join(outDir, 'tu-replay-summary.json');
fs.writeFileSync(outPath, `${JSON.stringify(summary, null, 2)}\n`);
console.log(`faithful replay summary -> ${outPath}`);
console.log(`TU parse ${tuOkCount}/${rows.length}; faithful ${totalFaithful}/${totalFunctions}, alone-parse ${totalFaithfulParse}/${totalFaithful}, unmasked ${totalUnmasked}; placeholders ${totalPlaceholders}, alone-parse ${totalPlaceholderParse}/${totalPlaceholders}`);
