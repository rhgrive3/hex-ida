# OpenJev Boundary Referee 引き継ぎ

## 現在地

- 実装ブランチ: `codex/openjev-boundary-referee`（最新 main `d91f8fa67` 上に rebase 済み）
- 作業ツリー: `/mnt/workspace/.dev-state/agent-work/checkouts/openjev-boundary-referee`
- コミット列: `feat: add OpenJev boundary referee shadow harness` →
  `docs: add OpenJev boundary referee handoff` →
  先頭 `fix(jev): pin OpenJev boundary referee to the live transport contract`
- 引き継ぎ資料: このファイル
- 作業ツリーは clean（実 OpenMW holdout の manifest とハーネスは先頭コミットで追加）。

## 何を実装したか

- 既存の D1〜D4 deterministic verify は維持。OpenJev は optional callback。
- interactive single-goal、候補5〜8件、scan完了、未cancel、budget残り、D4/D5曖昧時だけ問い合わせ可能。
- OpenJev は D5〜D8 から最大1件の challenger を返すだけ。challenger は通常verifyへ入れず、
  binary-grounded な最大1回の probe を行う。probe 失敗は完全に従来 D1〜D4 へ戻る。
- OpenJev の確率は EvidenceGraph / fusion / proof / verdict / authority / confidence に加えない。
- background auto からは呼ばない。production caller は callback を渡さない。
- Worker endpoint は `/api/semantic-rank`。既存の AI capability / provider-spend 認可を再利用し、
  API key は Worker の `env.OPENJEV_API_KEY` のみ。

## 重要: OpenJev 上流契約の修正（本引き継ぎで実施）

初版は `https://api.codiv.ai/v1/systemone` + model `openjev-0.1` に固定していたため、
**live 呼び出しが常に 401 で fail-open していた**。実サービスへ直接プローブして判明した正しい契約:

| 項目 | 誤（初版） | 正（実測） |
|---|---|---|
| endpoint | `https://api.codiv.ai/v1/systemone` | `https://api.openjev.sh/v1/systemone` |
| model | `openjev-0.1` | `openjev` |
| `noul` criteria | `{ yes, no }`（400） | `{ true, false }` |
| `noul` 応答 | `probabilities.{yes,no}` | `{ type: "noul", noul: <P(true)> }` |

- `GET https://api.openjev.sh/v1/models` は `openjev` のみを返す（`openjev-0.1` は 422）。
- `api.codiv.ai` はこのキーを 401 で拒否する。
- `noul` は criteria `{true,false}` で 200 になり、`noul` は P(true/fit)。
  検証: 「空は青い」→0.91、緑→0.06。
- 修正箇所: `js/semantic-boundary-referee.js`（model 定数）、
  `js/ai/provider/worker-semantic-rank.js`（URL・noul 質問/応答）、
  `docs/design/openjev-boundary-referee.md`、本ハンドオフ、各種テスト。

## 主なファイル

- `js/semantic-boundary-referee.js`: facts、発火条件、response検証、admission
- `js/semantic-boundary-client.js`: browser側の薄い注入アダプタ
- `js/ai/provider/worker-semantic-rank.js`: 固定仕様の Worker provider
- `js/pinpoint-legacy.js`: D4境界判定、1-probe、従来fallback
- `tests/semantic-boundary-referee.mjs`, `tests/semantic-boundary-worker.mjs`: focused tests
- `tests/semantic-boundary-holdout-eval.mjs`: 合成 holdout の比較 harness
- `tests/semantic-boundary-openmw-holdout.mjs`: **実 OpenMW arm64 holdout の opt-in harness**
- `tests/fixtures/openmw-boundary-holdout.manifest.json`: holdout の truth と実契約

## 実 OpenMW holdout

固定 OpenMW `ce8a52117c746331251c0ecc353af5a4e735daa2` の `stat.hpp/stat.cpp`（GPL-3.0-only）から
arm64 Mach-O をローカルビルドし、既存 shape scan に通した。GPL 由来のため成果物は
リポジトリに checked-in しない。harness は `HEX_OPENMW_HOLDOUT_ARTIFACT` でローカル成果物を指す。

- 真値: `ActorStats.health.current` = offset 24（D5）。
- candidate 数 5、D4=0.1771、D5=0.1615、gap≈0.0156（曖昧境界を再現）。
- 現行 D1〜D4 の top-1 は offset 48（D1、誤り）。

`HEX_OPENMW_HOLDOUT_LIVE=1` で live OpenJev を使った結果（証跡:
`/mnt/workspace/.dev-state/agent-work/evidence/openjev-boundary-referee/openmw-holdout-live.json`）:

| 方式 | final top-1 | truth rescue | hit@4 | analyze | semantic | referee |
|---|---|---:|---:|---:|---:|---|
| 現行 D1〜D4 | offset 48 | 0 | 0 | 12 | 0 | no-referee |
| oracle（上限） | offset 48 | 0 | 1 | 12 | 1 | probe-promoted |
| shadow choice | offset 48 | 0 | 0 | 12 | 1 | received c0 (D4) |
| shadow parallel noul | offset 48 | 0 | 0 | 12 | 1 | abstain |
| gated 1-probe | offset 48 | 0 | 0 | 12 | 1 | not-admitted:probability |

- live choice は真値 D5(c1) ではなく **D4(c0)** を選び、確率 < 0.8 で admission 棄却。
- live parallel noul は abstain。
- そのため gated 1-probe は probe を撃たず、analyze 12 のまま従来 D1〜D4 と完全一致。
- **oracle（OpenJev が完璧に真値を指した場合の上限）でも top-1 は変わらない**（hit@4=1 まで届くが rescue=0）。
- 上流 latency（live, n=数回）: choice p50≈482ms / p95≈581ms、noul p50≈504ms。

結論: **この実 holdout では OpenJev の choice/noul いずれも top-1 を改善しない**。
oracle 上限でも改善しないため、1-probe 方式はこのケースでは無効。設計の DoD に従い
**Phase 2 default-on は無効のまま**（`promotionEligible: false`）。誤昇格を避けるため
admission 閾値は緩めない。

## 実行済みテスト

以下は成功済み。

```text
node tests/semantic-boundary-referee.mjs
node tests/semantic-boundary-worker.mjs
node tests/semantic-boundary-holdout-eval.mjs
HEX_OPENMW_HOLDOUT_ARTIFACT=... node tests/semantic-boundary-openmw-holdout.mjs
```

## 次にやること

1. さらに多くの実ゲーム holdout（複数 goal / 実リリースバイナリ）で rescue が成立するか確認する。
   単一ケースでは不成立。成立しなければ production 有効化はしない。
2. 改善が確認できた場合のみ interactive single-goal の production caller から callback を注入する。
3. background auto、Deep mode、設定画面、汎用 OpenJev proxy は追加しない。
4. `OPENJEV_API_KEY` の実値を repo / frontend bundle / logs / response / evidence に書かない。

## 注意

- 本体 `/mnt/workspace/hex-ida` ブランチにはこのコミットは入っていない。worktree のブランチをレビュー対象にする。
- 上流が `api.openjev.sh` + `openjev` である点が旧設計書の記述と異なるため、設計書側も更新済み。
- provider failure（timeout / 401 / 403 / 429 / 5xx / malformed / invalid model）は
  すべて従来 D1〜D4 へ fail-open することを focused test で確認済み。
