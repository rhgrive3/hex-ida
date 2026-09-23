#!/usr/bin/env node
// Offline ablation on frozen candidate lists. BattleCats is development;
// TsumTsum/YWP are evaluation. No truth label enters scoring.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const rows = fs.readFileSync(path.join(HERE, 'rows.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
const words = (s) => String(s || '').replace(/([a-z0-9])([A-Z])/g, '$1 $2')
  .replace(/([A-Z])([A-Z][a-z])/g, '$1 $2').replace(/[^A-Za-z0-9]+/g, ' ')
  .toLowerCase().trim().split(/\s+/).filter(Boolean);

function choose(r, p) {
  const q = words(r.query);
  const scores = r.candidates.map((c, i) => {
    const f = words(c.fieldName); const cl = words(c.className);
    const match = q.filter((w) => f.includes(w)).length;
    const exact = q.join(' ') === f.join(' ') ? 1 : 0;
    const suffix = f.slice(-q.length).join(' ') === q.join(' ') ? 1 : 0;
    const extra = Math.max(0, f.length - match);
    const classMatch = q.filter((w) => cl.includes(w)).length;
    return { i, score: match * 10 + p.exact * exact + p.extra * extra
      + p.classMatch * classMatch + p.suffix * suffix - i * 1e-5 };
  }).sort((a, b) => b.score - a.score);
  return scores[0]?.i ?? 0;
}

const params = [];
for (const exact of [0, 2, 5, 10]) for (const extra of [-3, -1, 0, 0.5, 1, 2, 3])
  for (const classMatch of [0, 1, 3]) for (const suffix of [0, 2])
    params.push({ exact, extra, classMatch, suffix });
const dev = rows.filter((r) => r.mode === 'partial' && r.binary === 'battlecats');
const holdout = rows.filter((r) => r.mode === 'partial' && r.binary !== 'battlecats');
const metrics = (set, p) => {
  const picks = set.map((r) => ({ r, index: choose(r, p) }));
  return {
    N: set.length,
    correct: picks.filter(({ r, index }) => r.candidates[index]?.truth).length,
    wrongToCorrect: picks.filter(({ r, index }) => !r.baselineCorrect && r.candidates[index]?.truth).length,
    correctToWrong: picks.filter(({ r, index }) => r.baselineCorrect && !r.candidates[index]?.truth).length,
  };
};
const ranked = params.map((p) => ({ p, dev: metrics(dev, p) }))
  .sort((a, b) => b.dev.correct - a.dev.correct || a.dev.correctToWrong - b.dev.correctToWrong
    || JSON.stringify(a.p).localeCompare(JSON.stringify(b.p)));
const best = ranked[0];
const output = {
  schema: 'hex-jev-deterministic-screen/v1',
  protocol: 'Fixed 168-point lexical grid; select by BattleCats partial correct count, then fewer regressions; TsumTsum/YWP untouched until selection.',
  configurations: params.length,
  selected: best.p,
  development: best.dev,
  holdout: metrics(holdout, best.p),
  total: metrics([...dev, ...holdout], best.p),
  baseline: { development: dev.filter((r) => r.baselineCorrect).length,
    holdout: holdout.filter((r) => r.baselineCorrect).length },
  perRow: rows.filter((r) => r.mode === 'partial').map((r) => ({
    id: r.id, binary: r.binary, selectedIndex: choose(r, best.p),
    correct: !!r.candidates[choose(r, best.p)]?.truth,
  })),
};
fs.writeFileSync(path.join(HERE, 'deterministic-screen.json'), JSON.stringify(output, null, 2) + '\n');
console.log(JSON.stringify({ selected: output.selected, development: output.development,
  holdout: output.holdout, total: output.total }));
