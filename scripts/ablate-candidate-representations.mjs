#!/usr/bin/env node
/**
 * Re-analyzes known regressions (SP08, SP33, XA40) across candidate representation arms:
 * - Arm A: Hex baseline
 * - Arm B: current Jev (fieldName only)
 * - Arm C: Jev (ClassName.fieldName)
 * - Arm D: structured (className, fieldName)
 * - Arm E: structured (className, fieldName, type, offset)
 * - Deterministic: BattleCats 168-point lexical comparator
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  LiveJevClient,
  deterministicLexicalPick,
  isGoldMatch,
  buildCriteria,
  requestBody,
} from './run-jev-realgame-eval.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPORT_DIR = path.resolve(process.env.HEX_JEV_HOLDOUT_DIR
  ?? path.join(ROOT, 'reports/investigations/jev-real-game-freeform-holdout'));

const { openBinary } = await import(path.join(ROOT, 'tests/harness.mjs'));
const { pinpointField, jevShortlist } = await import(path.join(ROOT, 'js/pinpoint.js'));
const { parseGoal } = await import(path.join(ROOT, 'js/goals.js'));

const TARGET_CASES = [
  {
    id: 'SP08',
    binaryPath: '/mnt/workspace/.dev-state/agent-work/cache/hex-completion-20260924/openemu/Sparkle',
    query: 'Host bundle being checked or updated by the basic update driver',
    gold: { class: 'SPUBasicUpdateDriver', field: '_host' },
  },
  {
    id: 'SP33',
    binaryPath: '/mnt/workspace/.dev-state/agent-work/cache/hex-completion-20260924/openemu/Sparkle',
    query: 'Extracted package signatures checked before running installation',
    gold: { class: 'SPUInstallationInputData', field: '_signatures' },
  },
  {
    id: 'XA40',
    binaryPath: '/mnt/workspace/.dev-state/agent-work/evidence/hex-completion-20260924/jevholdout/binaries/XADMaster',
    query: 'Key bytes used to initialise the RC4 stream cipher',
    gold: { class: 'XADRC4Handle', field: 'key' },
  },
];

async function main() {
  if (!process.env.OPENJEV_API_KEY) {
    throw new Error('OPENJEV_API_KEY environment variable is required');
  }

  const client = new LiveJevClient(process.env.OPENJEV_API_KEY);
  const results = [];

  for (const tc of TARGET_CASES) {
    console.log(`\nEvaluating ${tc.id}: "${tc.query}" (Gold: ${tc.gold.class}.${tc.gold.field})...`);
    const world = await openBinary(tc.binaryPath, { log: () => {} });
    const goal = parseGoal(tc.query);

    const hexRes = await pinpointField({
      goal,
      fields: world.fields,
      program: world.program,
      symbols: world.symbols,
      strings: world.strings,
      analyze: world.analyze,
      scanAccess: world.scanAccess,
      limit: 400,
    });

    const candidates = hexRes?.candidates ?? [];
    const shortlist = jevShortlist(candidates, { max: 255 });
    const goldRank = candidates.findIndex((c) => isGoldMatch(c, tc.gold));
    const goldInShortlist = shortlist.some((c) => isGoldMatch(c, tc.gold));

    // Arm A: Hex baseline
    const armA_top = hexRes?.top ?? null;
    const armA_correct = isGoldMatch(armA_top, tc.gold);

    // Deterministic lexical comparator
    const detPick = deterministicLexicalPick(tc.query, shortlist);
    const detCorrect = isGoldMatch(detPick, tc.gold);

    const arms = {};

    for (const arm of ['B', 'C', 'D', 'E']) {
      console.log(`  Calling OpenJev for Arm ${arm}...`);
      const resp = await client.call({
        query: tc.query,
        mode: 'partial',
        candidates: shortlist,
        arm,
      });

      const choiceIdx = resp.choiceIndex;
      const chosenCand = choiceIdx != null ? shortlist[choiceIdx] : null;
      const isCorrect = isGoldMatch(chosenCand, tc.gold);

      arms[arm] = {
        chosenIndex: choiceIdx,
        chosenKey: chosenCand?.key ?? chosenCand?.id ?? null,
        chosenClass: chosenCand?.className ?? chosenCand?.class ?? chosenCand?.key?.split('#')?.[0] ?? null,
        chosenField: chosenCand?.fieldName ?? chosenCand?.name ?? chosenCand?.field?.name ?? chosenCand?.key?.split('#')?.[2] ?? null,
        confidence: resp.confidence,
        preference: resp.preference,
        correct: isCorrect,
        isRegression: armA_correct && !isCorrect,
        isRescue: !armA_correct && isCorrect,
      };

      console.log(`    Arm ${arm}: chosen=${arms[arm].chosenClass}.${arms[arm].chosenField} (conf=${resp.confidence}, pref=${resp.preference}) -> correct=${isCorrect}`);
    }

    results.push({
      id: tc.id,
      query: tc.query,
      gold: tc.gold,
      candidateCount: candidates.length,
      goldRank: goldRank >= 0 ? goldRank + 1 : null,
      goldInShortlist,
      armA: {
        topKey: armA_top?.key ?? null,
        topClass: armA_top?.className ?? armA_top?.key?.split('#')?.[0] ?? null,
        topField: armA_top?.fieldName ?? armA_top?.field?.name ?? armA_top?.key?.split('#')?.[2] ?? null,
        correct: armA_correct,
        verdict: hexRes?.verdict ?? 'none',
      },
      deterministic: {
        key: detPick?.key ?? null,
        class: detPick?.className ?? detPick?.key?.split('#')?.[0] ?? null,
        field: detPick?.fieldName ?? detPick?.field?.name ?? detPick?.key?.split('#')?.[2] ?? null,
        correct: detCorrect,
      },
      arms,
    });
  }

  const outPath = path.join(REPORT_DIR, 'candidate-representation-ablation.json');
  fs.writeFileSync(outPath, JSON.stringify(results, null, 2) + '\n');
  console.log(`\nSaved candidate representation ablation results to ${outPath}`);
}

main().catch((err) => {
  console.error('Fatal ablation error:', err);
  process.exit(1);
});
