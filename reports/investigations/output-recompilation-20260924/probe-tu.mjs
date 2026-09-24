#!/usr/bin/env node
/*
 * Focused diagnostic for one measured case: rebuild the same product
 * translation unit the tu-replay harness builds, write the source next to the
 * lane evidence, and report the first clang diagnostics with context.
 *
 * Measurement/diagnosis only; no product code is imported for mutation.
 *
 * Usage:
 *   node reports/investigations/output-recompilation-20260924/probe-tu.mjs \
 *     --run <evidence>/current-output-after --case-id 1/1_gcc_O1_g \
 *     --out <evidence>/probe-tu-1.c
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { openProduct } from '../../../tools/validation/public-benchmark/product-host.mjs';

function optionValue(args, name, fallback) {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] != null ? args[index + 1] : fallback;
}

const args = process.argv.slice(2);
const runDir = path.resolve(optionValue(args, '--run', '.'));
const caseId = optionValue(args, '--case-id', '1/1_gcc_O1_g');
const outFile = path.resolve(optionValue(args, '--out', 'probe-tu.c'));
const maxFunctions = Number(optionValue(args, '--max-functions', '64'));

const record = JSON.parse(fs.readFileSync(path.join(runDir, 'cases', `${Buffer.from(caseId).toString('hex')}.json`), 'utf8'));
const targets = record.functions.filter((fn) => typeof fn.pseudocode === 'string' && fn.pseudocode.trim()).slice(0, maxFunctions);

const product = await openProduct(record.binary);
const snapshot = await product.query.snapshot();
const response = await product.query.translationUnit(snapshot, targets.map((fn) => String(fn.address)));
const unit = response?.value ?? null;
if (!unit) {
  console.log(`no unit: ${JSON.stringify(response?.status ?? null)}`);
  await product.close();
  process.exit(0);
}
fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, unit.source);
console.log(`wrote ${outFile}`);
console.log(`functions ${unit.functions.length}, includes ${JSON.stringify(unit.includes)}, typeDeclarations ${JSON.stringify(unit.typeDeclarations)}`);
console.log(`fallbackDeclarations ${unit.fallbackDeclarations.length}, unresolved ${unit.unresolved.length}, completeness ${unit.completeness}`);

const clangArgs = optionValue(args, '--clang-target', null) === 'aarch64'
  ? ['-target', 'aarch64-linux-gnu', '-std=gnu11', '-fsyntax-only', '-w', '-ferror-limit=0', '-x', 'c', outFile]
  : ['-std=gnu11', '-fsyntax-only', '-ferror-limit=0', outFile];
const check = spawnSync(optionValue(args, '--clang', '/usr/bin/clang'), clangArgs, { encoding: 'utf8', timeout: 60000 });
const lines = String(check.stderr ?? '').split('\n').filter(Boolean);
console.log(`clang status ${check.status}, diagnostics ${lines.length}`);
const families = new Map();
for (const line of lines) {
  const match = /: (error|warning|note): (.*)$/.exec(line);
  if (!match || match[1] !== 'error') continue;
  const key = match[2].replace(/'[^']*'/g, "'<id>'");
  families.set(key, (families.get(key) ?? 0) + 1);
}
for (const [key, count] of [...families.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)) {
  console.log(`  ${count} x ${key}`);
}
const source = unit.source.split('\n');
for (const line of lines.slice(0, 12)) {
  const match = /^(.+?):(\d+):(\d+): (error|warning|note): (.*)$/.exec(line);
  if (match && match[4] === 'error') {
    const index = Number(match[2]) - 1;
    console.log(`--- ${line}`);
    for (let i = Math.max(0, index - 3); i <= Math.min(source.length - 1, index + 1); i++) {
      console.log(`${i + 1 > index + 1 ? '>' : ' '} ${String(i + 1).padStart(6)} | ${source[i]}`);
    }
  } else {
    console.log(`    ${line}`);
  }
}
await product.close();
