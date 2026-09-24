#!/usr/bin/env node
/*
 * Diagnostic: rebuild the translation unit from a measured case record (the
 * receipts carry the same final public pseudocode) and report which selected
 * function names the packager resolved, plus which callee names it treated as
 * unresolved.  Diagnosis only; no product mutation.
 */
import fs from 'node:fs';
import path from 'node:path';
import { buildCTranslationUnit } from '../../../js/analysis/query/translation-unit.js';

const runDir = path.resolve(process.argv[2] ?? '.');
const caseId = process.argv[3] ?? '4/4_gcc_O1_g';
const limit = Number(process.argv[4] ?? '64');
const record = JSON.parse(fs.readFileSync(path.join(runDir, 'cases', `${Buffer.from(caseId).toString('hex')}.json`), 'utf8'));
const rows = record.functions.filter((fn) => typeof fn.pseudocode === 'string' && fn.pseudocode.trim()).slice(0, limit);
const unit = buildCTranslationUnit(rows.map((fn) => ({ address: fn.address, name: fn.name, pseudocode: fn.pseudocode })));
console.log('functions in unit:', unit.functions.length);
console.log('names:', unit.functions.map((fn) => fn.name).join(', '));
const interesting = ['init', 'start', 'do_global_dtors_aux'];
for (const name of interesting) {
  const owner = unit.functions.filter((fn) => fn.pseudocode.includes(`${name}(`));
  console.log(`callee ${name}: fallback? ${unit.fallbackDeclarations.some((line) => line.includes(` ${name}(`))}, definitions ${owner.length}`);
}
