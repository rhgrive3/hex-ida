import assert from "node:assert/strict";
import { groupByFeature, detectEngine, classifyFeaturesAndEngineAsync } from "../js/features.js";
import { rankCandidates } from "../js/rank.js";
import { goalFromPreset } from "../js/goals.js";
import { diffFunctions } from "../js/diff/index.js";
import { matchFunctions } from "../js/recognition/matcher.js";

console.log("Testing Issues #2595, #2597, #2598 regressions...");

// ── 1. Issue #2595: groupByFeature & classifyFeaturesAndEngineAsync ──
{
  const strings = [];
  for (let i = 0; i < 60000; i++) {
    if (i % 300 === 0) {
      strings.push({ addr: BigInt(0x1000 + i * 4), text: `user_login_session_token_${i}` });
    } else if (i % 400 === 0) {
      strings.push({ addr: BigInt(0x1000 + i * 4), text: `gacha_draw_rare_reward_${i}` });
    } else if (i % 500 === 0) {
      strings.push({ addr: BigInt(0x1000 + i * 4), text: `UnityFramework libil2cpp.so version ${i}` });
    } else {
      strings.push({ addr: BigInt(0x1000 + i * 4), text: `misc_string_constant_identifier_${i}` });
    }
  }

  const start = Date.now();
  const grouped = groupByFeature(strings, 200);
  const elapsed = Date.now() - start;
  assert.ok(grouped.length > 0, "Must have grouped features");
  assert.ok(elapsed < 500, `groupByFeature on 60k strings took ${elapsed}ms (expected < 500ms)`);

  const loginFeature = grouped.find((f) => f.id === "login");
  assert.ok(loginFeature, "Login feature must be found");
  assert.ok(loginFeature.items.length <= 200, "Must adhere to perFeature limit");
  for (let i = 1; i < loginFeature.items.length; i++) {
    assert.ok(loginFeature.items[i - 1].score >= loginFeature.items[i].score, "Items must be sorted descending by score");
  }

  // Async classification with AbortSignal
  const controller = new AbortController();
  const progressUpdates = [];
  const asyncPromise = classifyFeaturesAndEngineAsync(strings, {
    perFeature: 200,
    signal: controller.signal,
    chunkSize: 5000,
    onProgress: (done, all) => progressUpdates.push({ done, all }),
  });
  const res = await asyncPromise;
  assert.ok(res.features.length > 0);
  assert.equal(res.engine?.id, "unity");
  assert.ok(progressUpdates.length > 0, "Progress callbacks must have fired");

  // Immediate abort cancels processing
  const abortController = new AbortController();
  abortController.abort();
  const abortedRes = await classifyFeaturesAndEngineAsync(strings, {
    signal: abortController.signal,
  });
  assert.equal(abortedRes.features.length, 0, "Aborted classification returns empty");
}

// ── 2. Issue #2597: rankCandidates fast filtering ──
{
  const goal = goalFromPreset("hp");
  const strings = [
    { addr: 0x1000n, text: "player hp recovery" },
    { addr: 0x1020n, text: "generic_noise_string_1" },
    { addr: 0x1040n, text: "generic_noise_string_2" },
    { addr: 0x1060n, text: "max_health_bonus" },
  ];
  const ranked = rankCandidates({ goal, strings, limit: 10 });
  assert.equal(ranked.matchedStrings.length, 2, "Must match exact HP-related strings");
  assert.ok(ranked.matchedStrings.some((s) => s.text.includes("player hp")));
  assert.ok(ranked.matchedStrings.some((s) => s.text.includes("max_health")));
}

// ── 3. Issue #2598: diffFunctions option propagation & cancellation ──
{
  const before = [
    { address: 0x1000n, name: "sub_1000", instructions: ["sub sp, sp, #32", "ret"], bytes: new Uint8Array([0x1f, 0x20, 0x03, 0xd5]) },
    { address: 0x1020n, name: "sub_1020", instructions: ["mov x0, #1", "ret"], bytes: new Uint8Array([0x1f, 0x20, 0x03, 0xd5]) },
  ];
  const after = [
    { address: 0x1000n, name: "sub_1000", instructions: ["sub sp, sp, #32", "ret"], bytes: new Uint8Array([0x1f, 0x20, 0x03, 0xd5]) },
    { address: 0x1030n, name: "sub_1030_renamed", instructions: ["mov x0, #1", "ret"], bytes: new Uint8Array([0x1f, 0x20, 0x03, 0xd5]) },
  ];

  // Fast mode propagation
  const diffResult = diffFunctions(before, after, { mode: "fast" });
  assert.ok(diffResult.matches.length > 0, "Diff matching must succeed");

  // AbortSignal propagation
  const controller = new AbortController();
  controller.abort();
  const abortedDiff = diffFunctions(before, after, { signal: controller.signal });
  assert.equal(abortedDiff.truncated, true, "Aborted diff must be marked truncated");
  assert.match(abortedDiff.matching?.budget?.reason || "", /aborted/i, "Reason must indicate abortion");
}

console.log("Issues #2595, #2597, #2598 regression tests PASS!");
