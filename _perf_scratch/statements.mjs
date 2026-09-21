/*
 * Dumps the rendered pseudocode of specific frozen-corpus entries and the
 * statement-line witnesses used to prove that a control-flow reshape did not
 * drop or reorder an observable statement.
 *
 * Usage: node _perf_scratch/statements.mjs <entryIdsCommaSeparated>
 */
import { loadCorpus } from '../tools/validation/phase8/build-corpus.mjs';
import { decompileEntry, observationOf } from '../tools/validation/phase8/decompile-corpus.mjs';

const wanted = new Set(String(process.argv[2] ?? '').split(',').map((value) => value.trim()).filter(Boolean));
const corpus = loadCorpus();
const entries = corpus.functions.filter((entry) => wanted.has(entry.id));

const LABEL_ONLY = /^[A-Za-z_][\w.$]*:\s*$/;
const CONTROL = /^(goto\b|if\s*\(|while\s*\(|do\s*\{|\}\s*while\s*\(|\}|else\b|break;|continue;|\{)/;

function statementLines(text) {
  return String(text ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .filter((line) => !LABEL_ONLY.test(line))
    .filter((line) => !CONTROL.test(line));
}

const out = [];
for (const [index, entry] of entries.entries()) {
  const outcome = decompileEntry(entry, {
    index,
    decompilerTimeBudgetMs: 20000,
    phase8Optimize: true,
    toolchain: corpus.toolchain ?? null,
  });
  const observation = observationOf(entry, outcome);
  const text = observation.pseudocode ?? '';
  out.push({
    id: entry.id,
    statements: statementLines(text),
    text,
  });
}
process.stdout.write(`${JSON.stringify(out, null, 1)}\n`);
