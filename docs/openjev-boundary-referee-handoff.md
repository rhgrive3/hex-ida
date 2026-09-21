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

### Jev が真値 c1 を選ぶ質問契約（本引き継ぎで改善）

generic 文言では live choice が誤って c0 (D4) を 5/5 で選んでいた。goal 名と vital pool の
「正味減少・0でクランプ」を与える文言に変えた結果、choice は真値 c1 (D5) を 6/6 (p=0.99)、
parallel noul は 5/5 (p=0.88..0.91) で選択。文言は goal 依存（`hp`/`stamina` のみ）で
`money`/`score`/`level` は従来どおり。実装は `js/ai/provider/worker-semantic-rank.js`。
回帰は `tests/semantic-boundary-worker.mjs` で固定。

`HEX_OPENMW_HOLDOUT_LIVE=1` で live OpenJev を使った結果（証跡:
`/mnt/workspace/.dev-state/agent-work/evidence/openjev-boundary-referee/openmw-holdout-live.json`）:

| 方式 | final top-1 | truth rescue | hit@4 | analyze | semantic | referee |
|---|---|---:|---:|---:|---:|---|
| 現行 D1〜D4 | offset 48 | 0 | 0 | 12 | 0 | no-referee |
| oracle（上限） | offset 48 | 0 | 1 | 12 | 1 | probe-promoted |
| shadow choice | offset 48 | 0 | 0 | 12 | 1 | **received c1 (D5)** |
| shadow parallel noul | offset 48 | 0 | 0 | 12 | 1 | **received c1 (D5)** |
| gated 1-probe | offset 48 | 0 | **1** | 12 | 1 | **admitted → probe reconfirmed** |

- Jev は choice/noul とも真値 c1 を選択し、probe も成功（hit@4=1）。
- しかし **final top-1 は offset 48 のまま**。5候補はすべて `DynamicStat<int>::mCurrent` で、
  決定的 fusion では検証済み候補が 0.9822 で同点、同点は順序で決まる。真値は probe 後 0.9739 で届かない。
- 上流 latency（live, n=数回）: choice p50≈480ms / p95≈580ms、noul p50≈500ms。

結論: **Jev は真値を選択できるようになった**。一方でこの holdout では決定的スコアが真値を
top-1 にできない（5候補が構造的に同一で同点）。OpenJev は順位に影響させない設計のため、
Phase 2 default-on は無効のまま（`promotionEligible: false`）。admission 閾値は緩めない。

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
