#!/usr/bin/env node
/*
 * Full-packaging diagnostic: rebuild the same translation unit the tu-replay
 * harness builds (the first 256 function receipts of one measured case, the
 * packager's own query limit) with the current packager, write the source next
 * to the lane evidence, and report the first clang error diagnostics with
 * source context.
 *
 * Unlike probe-tu.mjs this does not need the product host: the receipts carry
 * the very pseudocode the product published, and buildCTranslationUnit is the
 * packager the host calls.  It is used to locate how far the packaged text is
 * from parsing after the declarations/TU-fallback work.
 *
 * Measurement/diagnosis only; no product mutation.
 *
 * Usage:
 *   node reports/investigations/output-recompilation-20260924/diag-tu-full.mjs \
 *     --run <evidence>/current-output-after --case-id 4/4_gcc_O1_g \
 *     --out <evidence>/diag-tu-full-4.c
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildCTranslationUnit } from '../../../js/analysis/query/translation-unit.js';

function optionValue(args, name, fallback) {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] != null ? args[index + 1] : fallback;
}

/* Same families as reports/investigations/current-main-weakness-20260923/harness/recompile-replay.mjs. */
function diagnosticFamily(message) {
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
  if (/expected '[)};]'/.test(text) || /expected '\}'/.test(text)) return 'expected-closer';
  if (/conflicting types/.test(text)) return 'conflicting-types';
  if (/implicit declaration of function|call to undeclared function/.test(text)) return 'implicit-declaration';
  if (/too (?:few|many) arguments/.test(text)) return 'argument-count-mismatch';
  if (/incomplete (?:type|definition)/.test(text)) return 'incomplete-type';
  if (/invalid operands/.test(text)) return 'invalid-operands';
  return `other:${text.slice(0, 60)}`;
}

const args = process.argv.slice(2);
const runDir = path.resolve(optionValue(args, '--run', '.'));
const caseId = optionValue(args, '--case-id', '4/4_gcc_O1_g');
const outFile = path.resolve(optionValue(args, '--out', 'diag-tu-full.c'));
const shown = Number(optionValue(args, '--show', '6'));
const limit = Number(optionValue(args, '--max-functions', '256'));

const record = JSON.parse(fs.readFileSync(path.join(runDir, 'cases', `${Buffer.from(caseId).toString('hex')}.json`), 'utf8'));
const rows = record.functions.filter((fn) => typeof fn.pseudocode === 'string' && fn.pseudocode.trim()).slice(0, limit);
const unit = buildCTranslationUnit(rows.map((fn) => ({
  functionId: fn.functionId ?? null,
  address: fn.address,
  name: fn.name,
  signature: fn.signature ?? null,
  pseudocode: fn.pseudocode,
  ir: fn.ir ?? null,
  semanticIR: fn.semanticIR ?? null,
})));
fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, unit.source);
console.log(`wrote ${outFile}`);
console.log(`functions ${unit.functions.length}, includes ${JSON.stringify(unit.includes)}, typeDeclarations ${JSON.stringify(unit.typeDeclarations)}`);
console.log(`fallbackDeclarations ${unit.fallbackDeclarations.length}, prototypes ${unit.prototypes.filter((row) => row.declaration).length}, globals ${unit.globals.filter((row) => row.declaration).length}, unresolved ${unit.unresolved.length}`);

const clangArgs = ['-std=gnu11', '-fsyntax-only', '-w', '-ferror-limit=0', outFile];
const check = spawnSync(optionValue(args, '--clang', '/usr/bin/clang'), clangArgs, { encoding: 'utf8', timeout: 120000 });
const lines = String(check.stderr ?? '').split('\n').filter(Boolean);
const errors = lines.filter((line) => /: error: /.test(line));
console.log(`clang status ${check.status}, error diagnostics ${errors.length}`);
const families = new Map();
for (const line of errors) {
  const match = /: error: (.*)$/.exec(line);
  const key = diagnosticFamily(match[1]);
  families.set(key, (families.get(key) ?? 0) + 1);
}
for (const [key, count] of [...families.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${count} x ${key}`);

const source = unit.source.split('\n');
for (const line of errors.slice(0, shown)) {
  const match = /^(.+?):(\d+):(\d+): error: (.*)$/.exec(line);
  if (!match) continue;
  const index = Number(match[2]) - 1;
  console.log(`--- ${match[4]}`);
  for (let i = Math.max(0, index - 2); i <= Math.min(source.length - 1, index + 1); i++) {
    console.log(`${i === index ? '>' : ' '} ${String(i + 1).padStart(6)} | ${source[i]}`);
  }
}
