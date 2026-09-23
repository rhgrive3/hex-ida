#!/usr/bin/env node
// Post-run scoring only. Never calls Pinpoint or Jev.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EVIDENCE = '/mnt/workspace/.dev-state/agent-work/evidence/jev-holdout-20260923';
const sha256 = (x) => createHash('sha256').update(x).digest('hex');
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const write = (file, value) => fs.writeFileSync(path.join(HERE, file),
  typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n');
const count = (rows, fn) => rows.filter(fn).length;
const ratio = (a, b) => b ? a / b : null;
const percent = (a, b) => b ? `${(100 * a / b).toFixed(1)}%` : 'n/a';
const strong = (v) => v === 'confirmed' || v === 'likely';
const quantile = (values, p) => {
  if (!values.length) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)];
};
const latency = (values) => ({ n: values.length, p50Ms: quantile(values, .5), p95Ms: quantile(values, .95),
  maxMs: values.length ? Math.max(...values) : null, totalMs: values.reduce((a, b) => a + b, 0) });
function wilson(k, n) {
  if (!n) return null;
  const z = 1.959963984540054;
  const p = k / n, z2 = z * z, d = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / d;
  const half = z * Math.sqrt(p * (1 - p) / n + z2 / (4 * n * n)) / d;
  return [Math.max(0, center - half), Math.min(1, center + half)];
}

function main() {
  const frozen = readJson(path.join(HERE, 'freeze-manifest.json'));
  const holdout = readJson(path.join(HERE, 'holdout-manifest.json'));
  const casesBytes = fs.readFileSync(path.join(HERE, 'holdout-cases.json'));
  if (sha256(casesBytes) !== holdout.caseSha256) throw new Error('holdout changed after lock');
  const cases = JSON.parse(casesBytes);
  const complete = readJson(path.join(EVIDENCE, 'run-complete.json'));
  if (complete.caseSha256 !== holdout.caseSha256 || complete.productCommit !== frozen.productCommit)
    throw new Error('run identity mismatch');
  const blindBytes = fs.readFileSync(path.join(EVIDENCE, 'blind-results.jsonl'));
  if (sha256(blindBytes) !== complete.blindResultsSha256) throw new Error('blind result hash mismatch');
  const blind = blindBytes.toString().trim().split('\n').map(JSON.parse);
  if (blind.length !== cases.length || complete.rows !== cases.length) throw new Error('incomplete run');
  const byId = new Map(blind.map((row) => [row.id, row]));
  if (byId.size !== cases.length) throw new Error('duplicate blind result ID');
  const rows = cases.map((c) => {
    const b = byId.get(c.id);
    if (!b || b.query !== c.query || b.binary !== c.binary || b.mode !== c.mode) throw new Error(`case mismatch: ${c.id}`);
    const candidates = b.baseline.candidates;
    const jevValid = b.jev && !b.jev.error && Number.isInteger(b.jev.choiceIndex);
    const baselineIndex = candidates.length ? 0 : null;
    const deterministicIndex = b.deterministic.choiceIndex;
    const cIndex = b.routing.eligible && jevValid ? b.jev.choiceIndex : deterministicIndex;
    const dIndex = c.mode === 'partial' && jevValid ? b.jev.choiceIndex : baselineIndex;
    const choiceIndex = { A_baseline: baselineIndex, B_deterministic_lexical: deterministicIndex,
      C_G28_routed: cIndex, D_Jev_force_all: dIndex };
    const gold = c.gold;
    const choices = Object.fromEntries(Object.entries(choiceIndex).map(([arm, index]) => {
      const candidate = index == null ? null : candidates[index] ?? null;
      const correct = gold ? !!candidate && candidate.className === gold.class && candidate.fieldName === gold.field : null;
      const abstain = !candidate || !strong(b.baseline.verdict);
      const actionCorrect = gold ? correct && !abstain : abstain;
      return [arm, { index, candidateKey: candidate?.key ?? null, className: candidate?.className ?? null,
        fieldName: candidate?.fieldName ?? null, correct, abstain, actionCorrect,
        falseStrong: !!gold && strong(b.baseline.verdict) && !correct,
        unsafeConfident: strong(b.baseline.verdict) && (gold ? !correct : true) }];
    }));
    return { schema: 'hex-jev-holdout-row/v1', id: c.id, binary: c.binary, mode: c.mode, query: c.query,
      family: c.family, difficulty: c.difficulty, gold, abstainReason: c.abstainReason ?? null,
      collectionError: b.collectionError, verdict: b.baseline.verdict, candidates,
      baselineLatencyMs: b.baseline.latencyMs, routing: b.routing, jev: b.jev, choices };
  });
  const answerable = rows.filter((r) => !!r.gold);
  const nonanswerable = rows.filter((r) => !r.gold);
  const arms = ['A_baseline', 'B_deterministic_lexical', 'C_G28_routed', 'D_Jev_force_all'];
  const armSummary = Object.fromEntries(arms.map((arm) => {
    const correct = count(answerable, (r) => r.choices[arm].correct);
    return [arm, { answerableCorrect: correct, answerableN: answerable.length,
      top1Accuracy: ratio(correct, answerable.length), wilson95: wilson(correct, answerable.length),
      actionCorrect: count(rows, (r) => r.choices[arm].actionCorrect), actionN: rows.length,
      abstainCount: count(rows, (r) => r.choices[arm].abstain), abstainRate: ratio(count(rows, (r) => r.choices[arm].abstain), rows.length),
      falseStrongCount: count(rows, (r) => r.choices[arm].falseStrong),
      unsafeConfidentCount: count(rows, (r) => r.choices[arm].unsafeConfident),
      nonanswerableStrongCount: count(nonanswerable, (r) => !r.choices[arm].abstain) }];
  }));
  const routed = rows.filter((r) => r.routing.eligible);
  const routedAnswerable = routed.filter((r) => !!r.gold);
  const validRoutedAnswerable = routedAnswerable.filter((r) => r.jev && !r.jev.error);
  const rescueRows = answerable.filter((r) => !r.choices.B_deterministic_lexical.correct && r.choices.C_G28_routed.correct);
  const regressionRows = answerable.filter((r) => r.choices.B_deterministic_lexical.correct && !r.choices.C_G28_routed.correct);
  const forceRescue = answerable.filter((r) => !r.choices.B_deterministic_lexical.correct && r.choices.D_Jev_force_all.correct);
  const forceRegression = answerable.filter((r) => r.choices.B_deterministic_lexical.correct && !r.choices.D_Jev_force_all.correct);
  const jevAttempts = (set) => set.flatMap((r) => r.jev?.attempts ?? []);
  const attempted = jevAttempts(rows);
  const routedAttempts = jevAttempts(routed);
  const tokenUsage = (set) => {
    const accepted = set.map((r) => r.jev).filter((j) => j && !j.error && j.usage);
    const n = (names) => accepted.reduce((sum, j) => sum + (Number(names.map((key) => j.usage?.[key]).find((x) => Number.isFinite(x))) || 0), 0);
    return { responsesWithUsage: accepted.length, inputTokensReported: n(['input_tokens', 'prompt_tokens']),
      outputTokensReported: n(['output_tokens', 'completion_tokens']),
      attemptsWithoutUsage: jevAttempts(set).length - accepted.length };
  };
  const bySlice = (key) => Object.fromEntries([...new Set(rows.map((r) => r[key]))].sort().map((value) => {
    const set = rows.filter((r) => r[key] === value), ans = set.filter((r) => !!r.gold);
    return [value, { total: set.length, answerable: ans.length,
      A_correct: count(ans, (r) => r.choices.A_baseline.correct),
      B_correct: count(ans, (r) => r.choices.B_deterministic_lexical.correct),
      C_correct: count(ans, (r) => r.choices.C_G28_routed.correct),
      D_correct: count(ans, (r) => r.choices.D_Jev_force_all.correct),
      routed: count(set, (r) => r.routing.eligible),
      rescue: count(ans, (r) => !r.choices.B_deterministic_lexical.correct && r.choices.C_G28_routed.correct),
      regression: count(ans, (r) => r.choices.B_deterministic_lexical.correct && !r.choices.C_G28_routed.correct),
      unsafeC: count(set, (r) => r.choices.C_G28_routed.unsafeConfident) }];
  }));
  const routedChoiceCorrect = count(validRoutedAnswerable, (r) => {
    const x = r.candidates[r.jev.choiceIndex];
    return x?.className === r.gold.class && x?.fieldName === r.gold.field;
  });
  const summary = { schema: 'hex-jev-holdout-summary/v1', productCommit: frozen.productCommit,
    caseSha256: holdout.caseSha256, blindResultsSha256: complete.blindResultsSha256,
    totalCases: rows.length, answerableCases: answerable.length, nonanswerableCases: nonanswerable.length,
    arms: armSummary, routing: { routedCases: routed.length, routedAnswerable: routedAnswerable.length,
      routedValidAnswerable: validRoutedAnswerable.length, routedChoiceCorrect,
      routedChoicePrecision: ratio(routedChoiceCorrect, validRoutedAnswerable.length),
      rescue: rescueRows.length, regression: regressionRows.length,
      netRescue: rescueRows.length - regressionRows.length,
      rescueIds: rescueRows.map((r) => r.id), regressionIds: regressionRows.map((r) => r.id),
      interventionPrecision: ratio(rescueRows.length, rescueRows.length + regressionRows.length),
      rescuePerAnswerable: ratio(rescueRows.length, answerable.length),
      rescuePerRoutedAnswerable: ratio(rescueRows.length, routedAnswerable.length),
      regressionPerAnswerable: ratio(regressionRows.length, answerable.length),
      regressionPerRoutedAnswerable: ratio(regressionRows.length, routedAnswerable.length),
      callsPerRescue: rescueRows.length ? routedAttempts.length / rescueRows.length : routedAttempts.length ? 'Infinity' : 0,
      unnecessaryCallsOnDetCorrect: count(routedAnswerable, (r) => r.choices.B_deterministic_lexical.correct) },
    forceAll: { rescueVersusB: forceRescue.length, regressionVersusB: forceRegression.length,
      netVersusB: forceRescue.length - forceRegression.length, requestedCases: count(rows, (r) => !!r.jev) },
    cost: { C: { httpAttempts: routedAttempts.length, usage: tokenUsage(routed),
        jevLatency: latency(routedAttempts.map((a) => a.latencyMs)) },
      D: { httpAttempts: attempted.length, usage: tokenUsage(rows),
        jevLatency: latency(attempted.map((a) => a.latencyMs)) },
      baseline: { pinpointLatency: latency(rows.map((r) => r.baselineLatencyMs)) },
      usd: null, usdReason: 'No frozen official unit price or invoice; calls and reported tokens are the cost evidence.' },
    apiErrors: count(rows, (r) => r.jev?.error), technicalRetries: count(rows, (r) => (r.jev?.attempts?.length ?? 0) > 1),
    collectionErrors: count(rows, (r) => !!r.collectionError),
    slices: { binary: bySlice('binary'), family: bySlice('family'), difficulty: bySlice('difficulty'), mode: bySlice('mode') } };
  const failures = rows.flatMap((r) => {
    const categories = [];
    const a = r.choices.A_baseline, b = r.choices.B_deterministic_lexical,
      c = r.choices.C_G28_routed, d = r.choices.D_Jev_force_all;
    if (!r.gold) categories.push('ambiguity / insufficient evidence');
    if (r.gold && !a.correct && b.correct) categories.push('deterministic rescue possible');
    if (r.gold && !b.correct && c.correct && r.routing.eligible) categories.push('Jev only rescue');
    if (r.gold && b.correct && !c.correct && r.routing.eligible) categories.push('Jev broke correct result');
    if (r.gold && !b.correct && !r.routing.eligible && d.correct) categories.push('routing mistake');
    if (r.gold && b.correct && r.routing.eligible && !d.correct) categories.push('routing mistake');
    if (r.collectionError || (r.gold && !r.candidates.length)) categories.push('input / data quality issue');
    if (r.goldUncertainty) categories.push('ground-truth uncertainty');
    if (!categories.length && ((r.gold && !c.correct) || c.unsafeConfident)) categories.push('unclassified failure');
    if (!categories.length) return [];
    return [{ id: r.id, categories, family: r.family, difficulty: r.difficulty, routed: r.routing.eligible,
      verdict: r.verdict, gold: r.gold, choices: { A: a.candidateKey, B: b.candidateKey,
        C: c.candidateKey, D: d.candidateKey }, jevError: r.jev?.error ?? null }];
  });
  write('raw-results.jsonl', rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  write('aggregate-summary.json', summary);
  write('failure-classification.jsonl', failures.map((r) => JSON.stringify(r)).join('\n') + '\n');
  const lines = [
    '# Independent Jev holdout: production-routing evidence', '',
    `Product commit: \`${frozen.productCommit}\`. Cases: **${rows.length}** (${answerable.length} answerable, ${nonanswerable.length} abstain-gold).`,
    'This is independent at the case/field/query level; it reuses three historical binaries, so binary-level generalization is not established. G28 is a research candidate and is not deployed.', '',
    '| Arm | answerable top-1 | action correct (all) | abstain | false strong | unsafe confident |',
    '| --- | ---: | ---: | ---: | ---: | ---: |',
    ...arms.map((arm) => { const x = armSummary[arm]; return `| ${arm} | ${x.answerableCorrect}/${x.answerableN} (${percent(x.answerableCorrect, x.answerableN)}) | ${x.actionCorrect}/${x.actionN} | ${x.abstainCount}/${rows.length} | ${x.falseStrongCount} | ${x.unsafeConfidentCount} |`; }),
    '',
    `C routed **${routed.length}** cases; Jev choice precision on valid routed answerable cases was **${routedChoiceCorrect}/${validRoutedAnswerable.length}**.`,
    `Versus B: **${rescueRows.length} rescue, ${regressionRows.length} regression, net rescue ${rescueRows.length - regressionRows.length}**. Calls per rescue: **${summary.routing.callsPerRescue}**.`,
    `B was already correct on **${summary.routing.unnecessaryCallsOnDetCorrect}** routed answerable cases.`,
    `D force-all made **${attempted.length}** HTTP attempts and had **${forceRescue.length} rescue / ${forceRegression.length} regression** versus B.`, '',
    `C HTTP latency p50/p95/max: **${summary.cost.C.jevLatency.p50Ms}/${summary.cost.C.jevLatency.p95Ms}/${summary.cost.C.jevLatency.maxMs} ms**; total **${(summary.cost.C.jevLatency.totalMs / 1000).toFixed(2)} s**.`,
    `D HTTP latency p50/p95/max: **${summary.cost.D.jevLatency.p50Ms}/${summary.cost.D.jevLatency.p95Ms}/${summary.cost.D.jevLatency.maxMs} ms**; total **${(summary.cost.D.jevLatency.totalMs / 1000).toFixed(2)} s**.`,
    `API-reported tokens: C **${summary.cost.C.usage.inputTokensReported} input / ${summary.cost.C.usage.outputTokensReported} output**, D **${summary.cost.D.usage.inputTokensReported} / ${summary.cost.D.usage.outputTokensReported}**. Missing usage for unsuccessful attempts is not imputed. USD cost is unknown.`,
    `Technical retries: **${summary.technicalRetries}**; API errors: **${summary.apiErrors}**; collection errors: **${summary.collectionErrors}**.`, '',
    '## By case family', '',
    '| Family | answerable | B correct | C correct | C rescue | C regression | C routed | C unsafe |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
    ...Object.entries(summary.slices.family).map(([name, x]) => `| ${name} | ${x.answerable} | ${x.B_correct} | ${x.C_correct} | ${x.rescue} | ${x.regression} | ${x.routed} | ${x.unsafeC} |`),
    '', '## Interpretation limits', '',
    '- The current shipped eligibility helper requires an ambiguous verdict while G28 requires a strong verdict. Arm C is a frozen research composition, not the actual shipped route.',
    '- The historical deterministic-first projection used ground truth to skip calls; this run uses only observable B-versus-baseline agreement.',
    '- Jev changes preference only. It does not promote or lower the baseline verdict, and its uniqueness score is diagnostic. Therefore abstain safety depends entirely on the unchanged local verdict.',
    '- Each case had one frozen API decision. Model consistency across independent successful calls is unmeasured; technical retries were only for transport/HTTP failure.',
    '- Failure classes are post-run analysis. They were not used to change this holdout, prompt, route or thresholds.', ''
  ];
  write('production-routing-evidence.md', lines.join('\n'));
  write('g29-candidates.md', '# G29 candidates (future development set only)\n\n- Establish an observable, production-grade deterministic resolution predicate; the old truth-based skip is invalid.\n- Reconcile the ambiguous-only shipped eligibility helper with the strong-only G28 research gate before any production claim.\n- Evaluate explicit abstain/uniqueness policy on a separate future dataset; do not tune it on this holdout.\n- Collect a new binary-disjoint, source-grounded free-form intent dataset for external validity.\n- Preserve preference-only semantics, fail-closed fallback, and critical-path latency accounting.\n');
  console.log(`scored ${rows.length} cases: rescue ${rescueRows.length}, regression ${regressionRows.length}, net ${rescueRows.length - regressionRows.length}`);
}

main();
