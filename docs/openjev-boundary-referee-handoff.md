# OpenJev Boundary Referee 引き継ぎ

## 現在地

- 実装ブランチ: `codex/openjev-boundary-referee`
- 作業ツリー: `/mnt/workspace/.dev-state/agent-work/checkouts/openjev-boundary-referee`
- 最新コミット: `37043bf58 feat: add OpenJev boundary referee shadow harness`
- `origin/main` の先祖を含む状態で、作業ツリーは clean。

## 何を実装したか

- 既存の D1〜D4 deterministic verify は維持。
- OpenJev は optional callback として注入し、core から fetch/Codiv/Cloudflare を直接参照しない。
- interactive single-goal、候補5〜8件、scan完了、未cancel、budget残り、D4/D5曖昧時だけ候補を問い合わせ可能。
- OpenJev は D5〜D8 から最大1件の challenger を返すだけ。
- challenger は通常verifyへ直接入れず、binary-grounded な最大1回の probe を先に行う。
- probe 失敗は完全に従来 D1〜D4 へ戻る。成功しても最終判断は既存証拠だけで行う。
- OpenJev の確率は EvidenceGraph、fusion、proof、verdict、authority、confidence に加えない。
- background auto からは呼ばない。production caller は callback を渡さないため、現状の実運用結果は従来と同じ。
- Worker endpoint は `/api/semantic-rank`。既存の AI capability / provider-spend 認可を再利用し、API key は Worker の `env.OPENJEV_API_KEY` のみ。
- upstream は固定 `openjev-0.1`、timeout 2.5秒、retry 0。失敗はすべて fail-open。

## 主なファイル

- `js/semantic-boundary-referee.js`: facts、発火条件、response検証、admission
- `js/semantic-boundary-client.js`: browser側の薄い注入アダプタ
- `js/ai/provider/worker-semantic-rank.js`: 固定仕様の Worker provider
- `js/pinpoint-legacy.js`: D4境界判定、1-probe、従来fallback
- `worker.js`, `worker-entry.js`: endpoint route と既存認可
- `tests/semantic-boundary-referee.mjs`, `tests/semantic-boundary-worker.mjs`: focused tests
- `tests/semantic-boundary-holdout-eval.mjs`: Phase 0/1 比較 harness

## 検証結果

合成 holdout では、D5 に正解が落ちる counterexample で次の結果になった。

- 現行 D1〜D4: hit@4 `0`、wrong top-1 `1`、false-likely `1`
- gated 1-probe: hit@4 `1`、wrong top-1 `0`、false-likely `0`
- analyze 呼び出し: `5` → `6`（probeの1回分）

choice / parallel noul の shadow 比較も実装済み。ただし実ゲームのラベル付き holdout と実ネットワーク latency の計測データはリポジトリにないため、`promotionEligible: false` のまま。Phase 2 default-on には進めない。

## 実行済みテスト

以下は成功済み。

```text
node tests/semantic-boundary-referee.mjs
node tests/semantic-boundary-worker.mjs
node tests/semantic-boundary-holdout-eval.mjs
node tests/ir-pinpoint-location.mjs
node tests/ai-worker.mjs
node tests/issue-6091-worker-upstream-response-limit.mjs
node --experimental-vm-modules tests/auth/worker-entry-harness.mjs
node tests/check.mjs
node tests/module-boundaries.mjs
node tools/validation/module-boundaries.mjs
node tests/userscript-release-version.mjs
```

## 次にやること

1. 実ゲームのラベル付き holdout を追加し、現行 D1〜D4 / choice / parallel noul / gated 1-probe を比較する。
2. rescue、verification-hit@4、probe precision、wrong top-1、false-likely、analyze delta、API rate、latency p50/p95 を測る。
3. 明確な改善が確認できた場合だけ、interactive single-goal の production caller から callback を注入する。
4. 改善がなければ instrumentation/shadow までで止める。
5. background auto、Deep mode、設定画面、汎用OpenJev proxyは追加しない。

## 注意

- 現在の `/mnt/workspace/hex-ida` 本体ブランチにはこのコミットは入っていない。上記 worktree のブランチをレビュー対象にすること。
- `OPENJEV_API_KEY` の実値を repo、frontend bundle、logs、response、evidence に書かない。
- production を有効化する前に、provider failure（timeout / 401 / 403 / 429 / 5xx / malformed）時の従来結果一致を再確認する。
