/**
 * #6311 — wire budget が負の `maxOutputTokens` を 0 へ clamp し、
 * invalid capability で入力 token 上限を安全 default より拡大していた。
 *
 * `finiteNumber()` は負の有限 number も valid として返し、caller の
 * `Math.max(0, ...)` がそれを「output を 0 token 予約する」という別の
 * valid policy に変換していた。resource capability の invalid 値は
 * safe fallback (`SAFE_PROVIDER_CAPABILITIES.maxOutputTokens`) へ
 * fail-closed に落ちるべきで、output reserve を消してはならない。
 */
import assert from 'node:assert/strict';
import { assertWireBudget, measureWirePayload, providerCapabilities, SAFE_PROVIDER_CAPABILITIES } from '../js/ai/budget/wire.js';

const FALLBACK_OUTPUT = SAFE_PROVIDER_CAPABILITIES.maxOutputTokens;

function capsWith(maxOutputTokens) {
  return { contextTokens: 100, maxOutputTokens, maxRequestBytes: 1024 * 1024 };
}

/* ── 正常系: 有効な capability は従来どおり ─────────────────── */

{
  const usage = measureWirePayload({ messages: [{ role: 'user', content: 'x'.repeat(160) }] });
  const caps = { contextTokens: 32768, maxOutputTokens: 4096, maxRequestBytes: 1024 * 1024 };
  const measured = assertWireBudget({ messages: [{ role: 'user', content: 'x'.repeat(160) }] }, caps);
  assert.equal(measured.estimatedInputTokens, usage.estimatedInputTokens, 'a valid capability must keep the previous behaviour');
}
console.log('  ok 1 a valid maxOutputTokens keeps the previous behaviour (#6311)');

/* ── 0 は正式に許可される (output reserve = 0) ─────────────────── */

{
  // output reserve 0 は「別の valid policy」なので、その分だけ input が伸びる。
  const caps = { contextTokens: 100, maxOutputTokens: 0, maxRequestBytes: 1024 * 1024 };
  const usage = assertWireBudget({ messages: [{ role: 'user', content: 'x'.repeat(140) }] }, caps);
  assert.ok(usage.estimatedInputTokens > 0, 'maxOutputTokens:0 is a valid policy and must keep its wider input ceiling');
}
console.log('  ok 2 maxOutputTokens:0 stays a legitimate policy (#6311)');

/* ── 異常系: 負値 / NaN / Infinity は safe fallback ─────────────── */

for (const bad of [-1, -0.5, -4096, -Infinity, Number.NaN, Infinity]) {
  const caps = capsWith(bad);
  // fallback semantics: output reserve 4096 で input ceiling は 1 token。
  // estimated input は必ず 1 token 超えるので reject されなければならない。
  assert.throws(
    () => assertWireBudget({ messages: [{ role: 'user', content: 'hi' }] }, caps),
    (error) => error?.type === 'context_too_large',
    `maxOutputTokens:${String(bad)} must fail closed to the safe fallback, not clamp to 0 (#6311)`,
  );
}
console.log('  ok 3 negative / non-finite maxOutputTokens fall back to the safe default (#6311)');

{
  // 同じ payload が、fallback semantics なら通る大きさでも、
  // 負値を 0 へ clamp した旧実装では input ceiling が contextTokens 全量に
  // 膨らむため通ってしまう。fallback 後は拒否されることを固定する。
  const caps = capsWith(-1);
  const usage = measureWirePayload({ messages: [{ role: 'user', content: 'x'.repeat(160) }] });
  assert.ok(
    usage.estimatedInputTokens > Math.max(1, 100 - FALLBACK_OUTPUT),
    `fixture must exceed the fallback input ceiling (estimated ${usage.estimatedInputTokens})`,
  );
  assert.throws(
    () => assertWireBudget({ messages: [{ role: 'user', content: 'x'.repeat(160) }] }, caps),
    /exceeds the safe input budget/,
    'a negative capability must not raise the input token ceiling above the safe default (#6311)',
  );
}
console.log('  ok 4 a negative capability cannot widen the input token ceiling (#6311)');

/* ── #2824 の修正維持: non-number は reject ─────────────────── */

for (const bad of ['-1', '4096', true, [4096], { maxOutputTokens: 4096 }, null]) {
  const caps = capsWith(bad);
  assert.throws(
    () => assertWireBudget({ messages: [{ role: 'user', content: 'hi' }] }, caps),
    (error) => error?.type === 'context_too_large',
    `non-number maxOutputTokens (${typeof bad}) must be rejected, not coerced (#2824 regression)`,
  );
}
console.log('  ok 5 non-number maxOutputTokens stay rejected (#2824)');

/* ── byte ceiling の既存検証は維持 ─────────────────────────── */

{
  assert.throws(
    () => assertWireBudget(
      { messages: [{ role: 'user', content: 'x'.repeat(20000) }] },
      { contextTokens: 32768, maxOutputTokens: 4096, maxRequestBytes: 1024 },
    ),
    (error) => error?.type === 'context_too_large',
    'the byte ceiling must keep working unchanged (#6311 must not weaken maxRequestBytes)',
  );
}
console.log('  ok 6 the byte ceiling keeps its existing validation (#6311)');

/* ── providerCapabilities 経由でも負値は fallback へ ───────────── */

{
  const provider = { capabilities: { provider: 'gemini', contextTokens: 32768, maxOutputTokens: -1, maxRequestBytes: 1024 * 1024 } };
  const caps = providerCapabilities(provider);
  assert.equal(caps.maxOutputTokens, -1, 'providerCapabilities reports supplied metadata as-is');
  // estimated input ~29017 tokens: 旧実装 (clamp → ceiling 32768) では通るが、
  // fallback 後の input ceiling は 32768 - 4096 = 28672 なので拒否される。
  const payload = { messages: [{ role: 'user', content: 'x'.repeat(4 * 29000) }] };
  assert.throws(
    () => assertWireBudget(payload, caps),
    (error) => {
      if (error?.type !== 'context_too_large') return false;
      // ceiling が fallback から計算されていることまで固定する。
      assert.equal(error.details.maxTokens, 32768 - FALLBACK_OUTPUT);
      return true;
    },
    'a malformed provider capability must not enlarge the local safety gate via providerCapabilities() (#6311)',
  );
}
console.log('  ok 7 providerCapabilities-sourced negative values fail closed (#6311)');

console.log('issue-6311: PASS');
