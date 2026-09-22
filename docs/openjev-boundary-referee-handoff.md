# OpenJev Boundary Referee 引き継ぎ

## 2026-09-22: 実ゲーム holdout を固定して再計測（現 main）

base は現 main `b1a61d50c0bd2c2b893862c8514e7a05df62ecdd`（`adadf37ac` から reconcile。途中の main 前進は #9409 / #9412 / #9418）。

### 何を固定したか

実ゲーム holdout を「ローカルビルドした 2 ファイル fixture」から
**上流 OSS ゲームの実 ARM64 リリースを GitHub から取得して固定する方式**へ置き換えた。

- 採用: **DSDA-Doom v0.29.4 macOS arm64**（`kraflab/dsda-doom`, commit `e443ff7a3e6090a1ff92ad7a426916c4fd35ecc5`, GPL-2.0）
  - 1 つの GitHub Release 資産 `dsda-doom-0.29.4-mac-arm64.zip`（11,359,462 bytes, sha256 `cc46a12f…3540`）
  - 中身の `dsda-doom-0.29.4-mac-arm64/dsda-doom`（Mach-O arm64, 2,814,096 bytes, sha256 `76d5427c…73b8`）
- 取得: `node scripts/fetch-real-game-holdout.mjs`（archive/member の両方を sha256 で照合、tmp+rename で atomic、`--check` は再取得なしで照合）
- fixture: `tests/fixtures/real-game-boundary-holdout.manifest.json`（identity, license, label provenance, frozen policies, labelled cases）
- 成果物は GPL のため **checked in しない**（`tests/.real-game-holdout/` は gitignore、既存 `tests/.real-fixtures/` と同じ扱い）

### label をどう正当化したか

2 つの独立導出が一致することを要求する。

1. 固定 commit の上流ヘッダを arm64 ABI でレイアウトダンプ:
   `clang -target arm64-apple-macos11 -I prboom2/src -I prboom2/src/dsda -Xclang -fdump-record-layouts-complete -fsyntax-only`
   → `mobj_t` は 464 bytes、`uint64_t flags` 184 / `int intflags` 192 / **`int health` 196**。
2. 固定 artifact の実命令（local symbol table が残っているので関数名で引ける）:
   `_P_DamageMobj` の死亡ガードは `ldr w9, [x0, #196]; cmp w9, #0; b.le`、ダメージ書き込みは `str w22, [x19, #196]`、
   `_P_KillMobj` は `[x8, #196]`、`_P_GiveBody` は `str w8, [x9, #196]`。近傍の `flags` 184 / `player` 224 / `type` 156 / `momx` 140 もヘッダと一致。

### 候補になった artifact（数個試した記録）

| 候補 | 結果 |
|---|---|
| OpenMW `OpenMW-0.51.0-macOS-arm64.dmg` | dmg のみ。この環境に dmg 展開器が無く、CI でも再現手順が増えるため不採用 |
| SuperTuxKart `-linux-arm64.tar.gz` (734 MB) | 大きすぎ、arm64 ELF は得られるが label 導出に使える関数シンボルが無い |
| OpenRCT2 `windows-portable-arm64.zip` | PE arm64。型/シンボルは別 PDB で、label 導出が成果物内で閉じない |
| Luanti `luanti_…_macos12.3_arm64.zip` | arm64 Mach-O として shape scan は動くが、local symbol が落ちていて label を実命令で正当化できない |
| **DSDA-Doom v0.29.4 mac-arm64** | **採用**。小さい / Mach-O arm64 / zip / local function symbol が残る / 実 gameplay 資源フィールドがある |

### 再計測（offline）（reconcile 前 = base `1e2b89c9b`）

`HEX_SEMANTIC_BOUNDARY_HOLDOUT_ARTIFACT=tests/.real-game-holdout/dsda-doom node tests/semantic-boundary-real-game-holdout.mjs`

| variant | final top-1 | rescue | wrong-top-1 | false-likely | analyze | semantic |
|---|---|---:|---:|---:|---:|---:|
| 現行 D1〜D4 | 148 (`mobj_t.momz`) | 0 | 1 | 1 | 18 | 0 |
| oracle 1-probe（上限） | 148 | 0 | 1 | 1 | 18 | 1 |

- 2 つの順序を混同しないこと。**boundary 順**（= shape score 順 = referee の `c0..` の割当順）は
  `80, 148, 56, 240, **196**, 404, 256, 212`、**final answer 順**（= fusion 順 = 製品の返り値）は
  `148, 56, 240, **196**, 404, 256, 212, 80`。真値 `mobj_t.health`(196) は
  boundary **rank 5**（= `c1`）であり、final 順では 4 番目である。
- D4/D5 gap = 0.001534 < `maxD4D5Gap` 0.02 → ゲートは発火する。
- oracle: `c1`(=d5=196) を強制 → probe `reconfirmed` (2 analyze) → referee `probe-promoted-by-binary-evidence`
  （検証 slot が `d1,d2,d3,d4` → `d1,d2,d3,d5` に差し替わる）→ **final top-1 は 148 のまま**。
  つまり 1-probe の上限がこのケースで実測されていて、値は「救済できない」である。
- `labelsConsistent: true` / `promotionEligible: false`。artifact の sha256 は fixture の pin と一致（`artifact.pinned: true`）。

### 再計測（live OpenJev、`HEX_SEMANTIC_BOUNDARY_HOLDOUT_LIVE=1`）（reconcile 前）

| variant | final top-1 | rescue | hit@boundary | analyze | semantic | referee |
|---|---|---:|---:|---:|---:|---|
| 現行 D1〜D4 | 148 | 0 | 0 | 18 | 0 | no-referee |
| oracle 1-probe（上限） | 148 | 0 | **1** | 18 | 1 | `probe-promoted-by-binary-evidence` → probe `reconfirmed` (d5) |
| shadow choice | 148 | 0 | 0 | 18 | 1 | received **c0**, margin 0.85 |
| shadow parallel noul | 148 | 0 | 0 | 18 | 1 | received **c0**, margin 0.07 |
| gated 1-probe | 148 | 0 | 0 | 18 | 1 | `challenger-not-tail`（c0 は boundary rank 4 で、probe は d5〜d8 にしか出せない） |

latency: choice p50 ≈ 421 ms / p95 ≈ 863 ms、noul p50 = 567 ms。

**実ゲームでの結論（2つあり、どちらも実測）:**

1. **live の referee は真値 `c1` ではなく `c0`（boundary rank 4 = offset 240 = `player_t.ammo[0]`、decreases 25 / increases 1）を選ぶ。**
   noul の margin 0.07 は admission（minMargin 0.2）で弾かれ、choice は margin 0.85 で
   admission は通るが `challenger-not-tail` で probe に進まない（c0 は boundary rank 4）。
   つまり**モデル側は still 未成熟**であり、閾値を緩める根拠にはならない。
2. **oracle で真値 `c1` を強制しても final top-1 は動かない。** probe は実窓で書き込みを
   `reconfirmed` し、製品はそれを boundary 検証 slot に昇格させる（`probe-promoted-by-binary-evidence`）が、
   返る答えは 148 のままである。同じ上限は合成 OpenMW fixture でも実測されている
   （5 候補が p=0.9822 で同点になり ordering が勝つ）ので、これは製品の性質であり、
   実 ARM64 リリースで再現したことになる。

### reconcile 後（現 main `b1a61d50c`）

main が `fix(pinpoint): require 3 independent groups for likely verdict`（#9418）を含んで進んだ。
この修正は**この holdout の観測を出典として引いている**（main の `tests/fixtures/pinpoint-false-likely-dsda.json` の
`note` は「PR #9410 holdout」と明記）ので、reconcile して同じ artifact / 同じ label / 同じ frozen policy で再計測した。

| variant (live) | final top-1 | verdict | rescue | hit@boundary | semantic | referee |
|---|---|---|---:|---:|---:|---|
| 現行 D1〜D4 | 148 | **ambiguous** | 0 | 0 | 0 | no-referee |
| oracle 1-probe（上限） | 148 | **ambiguous** | 0 | **1** | 1 | `probe-promoted-by-binary-evidence` → `reconfirmed` (d5) |
| shadow choice | 148 | **ambiguous** | 0 | 0 | 1 | received **c0**, margin 0.90 |
| shadow parallel noul | 148 | **ambiguous** | 0 | 0 | 1 | received **c0**, margin 0.06（床 0.2 未満） |
| gated 1-probe | 148 | **ambiguous** | 0 | 0 | 1 | `challenger-not-tail` |

| | reconcile 前 | reconcile 後 |
|---|---|---|
| top-1 の verdict | `likely` | **`ambiguous`** |
| false-likely | 1 | **0** |
| final top-1 / rescue / 真値 rank / oracle 上限 | 148 / 0 / 5 / 救済なし | 同じ（不変） |

つまり **main の修正は実ゲームで効いている**（本 lane が見つけた false-likely が再現しない）。
同時に、順位の誤り（真値が boundary rank 5 で baseline の検証集合の外、1-probe が返り値を動かせない、
live が `c0`=ammo を選ぶ）は**一切解決していない**ので `promotionEligible: false` は維持される。

### 再計測（ARM64 ランナー、GitHub Actions）

同じ head を **ARM64 ランナー 2 種**で計測し、測定値そのものを assert している。

```
run 35695074399  success  head 9d05bf7c4bc1c017dcc592d78d4168fd4751941f   (reconcile 後)
  leg macos-14          uname -m = arm64    node = darwin arm64
  leg ubuntu-24.04-arm  uname -m = aarch64  node = linux arm64
  -> ok: true  problems: []
     baseline top 148 / verdict ambiguous / falseLikely 0
     truthHitAtBoundary 0 / boundaryRescue 0
     oracle probe reconfirmed(d5) / verificationTargets d1,d2,d3,d5 / top 148
     labelsConsistent true / promotionEligible false

（旧: run 35687189172 @ 6195f1a1f / run 35691359826 @ 45359e755 — 内容は同じで verdict が likely / falseLikely 1 だった）
```

assert しているのは: checkout head = dispatch SHA、ランナーが ARM64 であること（`uname -m` と `process.arch`）、
manifest の upstream commit、**測定前の artifact sha256 = manifest pin**、artifact 不要の label self-check、
ケース label（真値 offset/rank・記録済み boundary 順・`labelChecks` 全件・`labelsConsistent`）、
baseline の「真値は検証集合の外」、oracle 上限の probe 結果と検証 slot の差し替え、`promotionEligible: false`。

証跡: `reports/investigations/openjev-real-game-holdout/arm64-runner-evidence-2026-09-22.json`
（run の成果物 JSON から機械的に生成。手で書いた数値ではない）。

つまり救済が起きない理由は「referee の守備範囲に真値が無い」ではなく、
**probe が検証集合を変えても返り値を変えられない**こと（＋ live の選択がまだ外れること）である。
同時に、決定的経路が「資源ではない運動量フィールド」(`mobj_t.momz`、gravity で減るので
`loc-drain-verified` が付く) を top-1 に出すことも実測で確認された（`wrongTop1: 1`）。
このうち「名乗り」の部分（`likely` / `falseLikely: 1`）は本 holdout の観測を根拠に main の #9418 で修正され、
reconcile 後は `ambiguous` / `falseLikely: 0` である。残るのは**順位の誤り**であり、
これは fixture を緩める話ではなく製品側の findings である（`promotionEligible: false` を維持）。

### 追加した機械強制

- `tests/semantic-boundary-holdout-fetch.mjs`: archive/member の hash 照合、manifest の schema/size/arch/digest 検証、
  `--check` の identity drift（bytes 改変・pin 改変・欠落）で必ず失敗することを固定。
- harness は artifact の sha256 を manifest の pin と照合し、一致しなければ**測定を拒否**する（別バイナリの証跡で promotion できない）。
- `tests/semantic-boundary-referee.mjs`: 3 fixture（synthetic / openmw / 実ゲーム）が同一の frozen policy を使うこと、
  実ゲーム label が pin 済み identity と二重導出 provenance を持つことを固定。
- **label を反証可能にする**: `tests/fixtures/real-holdout-labels.mjs` が rank claim を
  harness の内部計測（`rankedCandidateOffsets` = boundary 順）と突き合わせる。
  以前は「baseline 検証集合に `d<rank>` が入っているか」だけを見ていたので、
  rank 1〜4 は常に集合に入る → **rank 4 のラベルは絶対に反証できない**という穴があった
  （偽の `labelsConsistent: true` を生む）。
- oracle challenger を宣言したケースは、oracle が実際に admission を通り `d<rank>` を probe したことまで要求する。
  以前は oracle 応答が部分的（境界候補が 5 件あるのに `c0/c1` しか返さない）だと契約が `invalid-response` で弾き、
  **上限が未計測のまま 0 として報告される**穴があった（実ゲームで実際に起きていた）。
- `tests/semantic-boundary-holdout-labels.mjs`: 上記 2 つを artifact 無しで回帰固定
  （rank 1〜4 のラベルは必ず失敗 / 未計測 oracle は必ず失敗 / instrumentation 欠落は fail closed /
  コミット済み fixture 自身の rank・oracle・ceiling の整合）。
- **どの runner からも実行されていない regression を canonical gate へ接続**:
  この lane の focused test は `npm test` の chain に 1 つも入っていなかった（実行されない回帰は回帰ではない）。
  今回の PR で lane の test を `npm test` に接続し、さらに main の #9418 が追加した
  `tests/pinpoint-false-likely-confidence.mjs` も**どの runner からも呼ばれていなかった**ため、同じ chain に接続した。
  これは「未実行の回帰が 3 回続いた」という process failure の恒久修正（guardrails: A repeated process failure
  must gain a permanent automated regression where technically possible）。

## 現在地

- 実装ブランチ: `feat/openjev-real-game-holdout`（PR #9410）
- base: 最新 main `b1a61d50c0bd2c2b893862c8514e7a05df62ecdd` に reconcile 済み
- 計測レポート: `reports/investigations/openjev-real-game-holdout/REPORT.md`
  （機械可読な同伴証跡: `measurement-2026-09-22.json`, `arm64-runner-evidence-2026-09-22.json`）
- 正確な SHA は `git log --oneline` を参照。rebase でハッシュが変わるため、以下は subject で記録する（古い順）:
  1. `feat: add OpenJev boundary referee shadow harness`
  2. `docs: add OpenJev boundary referee handoff`
  3. `fix(jev): pin OpenJev boundary referee to the live transport contract`
  4. `feat(jev): select the true boundary candidate on the OpenMW holdout`
  5. `feat(jev): retry unhelpful probe windows and pin goal wording to the holdout`
  6. `docs(jev): refresh the boundary referee handoff`
  7. `feat(jev): only ask the referee for a goal with calibrated guidance`
  8. `docs(jev): reflect the calibrated-goal eligibility`
  9. `test(jev): make the holdout check its own rank labels`
  10. `docs(jev): record the holdout label self-check`
  11. `test(jev): freeze the holdout policies in the fixture, not the harness`
  12. `docs(jev): pin the commit list`
  13. `docs(jev): make the handoff rebase-stable`
  14. `docs(jev): record what survives verification on the holdout`
  15. `test(jev): pin the boundary-referee holdout to a real ARM64 game release`
  16. `test(jev): run the boundary-referee lane tests in the canonical gate`
  17. `fix(jev): make the real-game holdout's own labels falsifiable`
  18. `docs(jev): report the real-game holdout measurement and its ceiling`（このファイルを含む）
- 引き継ぎ資料: このファイル

## 何を実装したか

- 既存の D1〜D4 deterministic verify は維持。OpenJev は optional callback。
- interactive single-goal、候補5〜8件、scan完了、未cancel、budget残り、D4/D5曖昧時だけ問い合わせ可能。
- OpenJev は D5〜D8 から最大1件の challenger を返すだけ。challenger は通常verifyへ入れず、
  binary-grounded な probe を最大1回行う（その1回が開ける関数窓は `VERIFY_FUNCTIONS = 3` 個まで）。
  probe 失敗は完全に従来 D1〜D4 へ戻る。
- OpenJev の確率は EvidenceGraph / fusion / proof / verdict / authority / confidence に加えない。
- background auto からは呼ばない。production caller は callback を渡さない。
- Worker endpoint は `/api/semantic-rank`。既存の AI capability / provider-spend 認可を再利用し、
  API key は Worker の `env.OPENJEV_API_KEY` のみ。

## 重要: OpenJev 上流契約の修正

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

## 本引き継ぎの Jev 改善（3点）

### 1. goal 文言の単一情報源化と provenance の機械強制

- 変更前: 文言と「どの goal に適用するか」の集合が Worker
  (`js/ai/provider/worker-semantic-rank.js`) にハードコードされ、`js/shapes.js` の
  goal 分類 (`hp`/`stamina` は resource-drain 系) と二重管理になっていた。
- 変更後: 文言は referee 契約モジュール `js/semantic-boundary-referee.js` の
  `SEMANTIC_BOUNDARY_GOAL_GUIDANCE` が唯一の情報源。各エントリは
  `{ family, calibratedBy, text }` を持ち、Worker は
  `semanticBoundaryGoalGuidance(goalId)` を読むだけ。
- 強制: `tests/semantic-boundary-referee.mjs` が
  「guidance を持つ goal は必ず実在する holdout ケースでラベルされている」ことを検証する。
  較正されていない goal（`money`/`score`/`level` など）は空文字＝中立文言のまま。
  `constructor`/`toString` などのプロトタイプ由来キーは `Object.hasOwn` で空を返す。
- 回帰: `tests/semantic-boundary-worker.mjs` が「外向きプロンプトは契約テーブルの文言そのもの」を固定。

### 2. probe を「1候補 × 最大3ウィンドウ」に（従来は1ウィンドウで打ち切り）

- 変更前: 候補の最初の scan site が change を再確認できなければ即 `change-not-reconfirmed` で
  諦め、2つ目の site を見なかった。`analyze` が1回失敗しても即 `analyze-failed` で終了。
  さらに `trace.probe.analyzeCalls` が常に `1` 固定で実測と食い違っていた。
- 変更後: 1回の probe 内で distinct な関数窓を最大 `VERIFY_FUNCTIONS = 3` 個まで試す。
  - change を再確認できた窓で即成功。
  - 読み取り不能な窓は「その窓の問題」として次へ進み、全窓が読めなかった場合のみ `analyze-failed`。
  - `analyzeCalls` は実測を計上（`++`）。
- budget: `SEMANTIC_BOUNDARY_PROBE_RESERVE` を `4*3+1 = 13` → `4*3+3 = 15` に。
  D1〜D4 の envelope（12）＋ probe 全体（最大3）を予約し、**失敗した probe が baseline を削らない**。
- 回帰（`tests/semantic-boundary-referee.mjs`）: 最初の窓が不発でも2つ目の窓で成立する、
  全窓不発なら 3 窓で打ち切って結果が baseline と完全一致する、を固定。
- 設計書 `docs/design/openjev-boundary-referee.md` の「one-probe」記述も同じ意味に更新。

### 3. 較正済み goal だけが問い合わせ可能に（`uncalibrated-goal`）

- 変更前: 「supported shape goal」なら誰でも問い合わせ可能だった。
- 実測（合成 fixture）: `level`/`item` は `hp` と**同一の5候補**を返す。つまり
  「この候補のどれが level か」という問いは原理的に答えられず、確信のある誤答を招く。
  `attack`/`damage` は候補 0 件。
- 変更後: `SEMANTIC_BOUNDARY_GOAL_GUIDANCE` にエントリがある goal だけが eligible。
  無い goal は `reason: 'uncalibrated-goal'` で **ネットワーク送出ゼロ**。
  現時点で eligible なのは `hp`/`stamina` のみ。
- 帰結: goal を有効化する正しい手段が「集合を広げる」ではなく
  **「ラベル付き holdout ケースを追加する」**になる（テストがそれを強制）。
- 回帰: `tests/semantic-boundary-referee.mjs`（未較正 6 goal で calls=0、`hp`/`stamina` は eligible）。

### 4. 実 OpenMW holdout を「ケース表」駆動に（1 goal → 2 goal）

- `tests/fixtures/openmw-boundary-holdout.manifest.json` に `cases[]` と `objectLayout` を追加。
  `hp`（`health.current` = offset 24）に加えて
  `stamina`（`fatigue.current` = offset 48、deterministic rank 1）を追加。
- `tests/semantic-boundary-openmw-holdout.mjs` はケースごとに
  current D1〜D4 / oracle上限 / shadow choice / shadow noul / gated probe を評価し、
  ケースごとの `promotionEligible` と「truth が boundary set に到達可能か」を報告する。
- 目的: 単一ケースの結果で production 昇格を判断しないこと（証跡の被覆を広げる）。

### 5. 凍結ポリシーを harness から fixture へ

- 変更前: `maxD4D5Gap: 0.02` / `minProbability: 0.8` / `minMargin: 0.2` が
  `tests/semantic-boundary-openmw-holdout.mjs` のリテラルだった。
- 変更後: `tests/fixtures/openmw-boundary-holdout.manifest.json` の `policies` が唯一の情報源。
  harness は `normalizeSemanticBoundaryAmbiguityPolicy` / `...AdmissionPolicy` で検証し、
  不正なら throw（暗黙の既定値へ落ちない）。証跡レポートに `frozenPolicies` を記録。
- 回帰: `tests/semantic-boundary-referee.mjs` が「合成 holdout と実 OpenMW holdout が
  同一のポリシーを使う」ことを固定。似て見える2つのポリシーが別物にならないようにする。

### 7. なぜ救済が成立しないのか（実測・重要）

oracle referee で真値（offset 24）を probe → 検証成功させたときの fusion item 比較
（`js/evidence.js` の LR 表と `js/pinpoint-legacy.js` の producer から確認）:

| 候補 | loc-drain-verified | loc-clamp-verified | loc-shared | loc-size | logOdds | p |
|---|---|---|---|---|---|---|
| offset 48（leader） | 3.4012 (n=3) | 1.7918 (n=3) | **1.1632 (n=3, lr 3.2)** | 0.4245 | 4.0080 | 0.982155 |
| offset 24（真値） | 3.4012 (n=3) | 1.7918 (n=3) | **0.7754 (n=2, lr 2.1715)** | 0.4245 | 3.6203 | 0.973924 |

- `loc-drain-verified`（lr 30）と `loc-clamp-verified`（lr 6）の LR は **定数**。
  producer は strength `Math.min(1, drains.length / 2)` を渡すが、drains>=2 で **飽和**する。
  よって「検証済み drain」は実質**二値の事実**であり、候補間に差を作らない。
- **検証後に残る唯一の graded な差は `loc-shared`（その offset を触る関数数 = breadth）**。
- この fixture は health を触る関数を decoy より少なく配置しているため、真値は検証後も
  leader に **0.0082 差で負ける**（p 0.9739 vs 0.9822）。oracle 上限でも動かない理由はこれ。
- したがって抑制要因は**製品欠陥ではなく**、「検証後の識別子が使用頻度（breadth）だけ」という
  モデルの性質である。実アプリの HP はダメージ/回復/UI/セーブ/死亡判定など多数の関数から
  触られるため breadth で勝てる可能性がある。
- 次に作るべき holdout の正しい条件: **真値が rank 4〜5 に落ち、かつ breadth で decoy に負けない**ケース。
  公平性のため、各 pool は**上流の実関数を全件**含める（恣意的な部分集合を選ばない）。

### 6. holdout が自分のラベルを検証する（＋ 計測スコアの可視化）

- `js/pinpoint-legacy.js` の instrumentation に「ランク順の shape score 配列」
  (`rankedShapeScores`) を追加（内部専用。referee には渡らない）。
- `tests/semantic-boundary-openmw-holdout.mjs` は manifest を**信じない**。
  - reachability はラベルされた rank から導出する（boundary set は rank 4〜 なので rank>=4 のみ到達可能）。
  - `expectedCandidateCount` が実測候補数と一致すること。
  - `deterministicTopOffset` / `deterministicTopIsTruth` が実測と一致すること。
  - oracle を回すケースでは probe が `d<expectedDeterministicRank>` を狙ったこと。
  - 1つでも食い違えば `labelsConsistent: false` になり、promotion がブロックされる。
- 実測スコア: rank1 = 0.19375 / rank2〜4 = 0.1771（同点） / rank5 = 0.1615。D4/D5 差 0.015625。
  → Hex の決定的スコアは既に rank1（`fatigue.current`）を好んでおり、`hp` の真値
  `health.current` は rank5 に落ちる。
- 目的: manifest のラベルが古くなったら「静かに誤った証跡」にならず、明示的な失敗になること。

## 実 OpenMW holdout（歴史的 fixture。現行の正本は上の実ゲーム holdout）

> 2026-09-22 以降、正本は `tests/fixtures/real-game-boundary-holdout.manifest.json`（上流リリースを固定）。
> この節の fixture は小さい compiler fixture として残し、`HEX_SEMANTIC_BOUNDARY_HOLDOUT_MANIFEST` で
> 今でも再計測できる（policy identity の一致はテストで固定）。

固定 OpenMW `ce8a52117c746331251c0ecc353af5a4e735daa2` の `stat.hpp/stat.cpp`（GPL-3.0-only）から
arm64 Mach-O をローカルビルドし、既存 shape scan に通した。GPL 由来のため成果物は
リポジトリに checked-in しない。harness は `HEX_OPENMW_HOLDOUT_ARTIFACT` でローカル成果物を指す。

`DynamicStat<int>::mCurrent` の実測レイアウト:
24 = health、36 = magicka、48 = fatigue、60 = shield、84 = poison
（72 = breath は fixture に更新がなく candidate に出ない）。

`HEX_OPENMW_HOLDOUT_LIVE=1` の live OpenJev 結果（証跡:
`/mnt/workspace/.dev-state/agent-work/evidence/openjev-boundary-referee/openmw-holdout-live.json`）:

### case `hp`（真値 offset 24、deterministic rank 5、baseline top = 48）

| 方式 | final top-1 | truth rescue | hit@boundary | analyze | semantic | referee |
|---|---|---:|---:|---:|---:|---|
| 現行 D1〜D4 | offset 48 | 0 | 0 | 12 | 0 | no-referee |
| oracle（上限） | offset 48 | 0 | 1 | 12 | 1 | probe-promoted |
| shadow choice | offset 48 | 0 | 0 | 12 | 1 | received c1 (D5) |
| shadow parallel noul | offset 48 | 0 | 0 | 12 | 1 | received c1 (D5) |
| gated 1-probe | offset 48 | 0 | **1** | 12 | 1 | admitted → probe reconfirmed (1窓) |

### case `stamina`（真値 offset 48、deterministic rank 1、baseline top = 48 = 真値）

| 方式 | final top-1 | truth rescue | hit@boundary | analyze | semantic | referee |
|---|---|---:|---:|---:|---:|---|
| 現行 D1〜D4 | offset 48 | **1** | 1 | 12 | 0 | no-referee |
| shadow choice | offset 48 | 1 | 1 | 12 | 1 | received c1 (health) |
| shadow parallel noul | offset 48 | 1 | 1 | 12 | 1 | received c1 (health) |
| gated 1-probe | offset 48 | 1 | 1 | 12 | 1 | admitted → probe reconfirmed (1窓) |

- `stamina` は真値が rank 1 で、referee に渡る boundary set（rank 4〜）に**入っていない**。
  live choice/noul は c1 = `health.current` を返し、probe は rank 4 を rank 5 に差し替える。
  それでも final top-1 は真値のまま = **誤った challenger が正しい結果を動かさない**ことを実測。
- 上流 latency（live）: choice p50≈451ms / p95≈630ms、noul p50≈459ms / p95≈761ms。

結論: **Jev は真値を選択でき、probe も成立する**。ただし `hp` では決定的 fusion が5候補を
同点（0.9822）にするため top-1 は動かない（oracle 上限でも動かない）。
Phase 2 default-on は無効のまま（`promotionEligible: false`）。admission 閾値は緩めない。

## 主なファイル

- `js/semantic-boundary-referee.js`: facts、発火条件、response検証、admission、**goal 文言テーブル**
- `js/semantic-boundary-client.js`: browser側の薄い注入アダプタ
- `js/ai/provider/worker-semantic-rank.js`: 固定仕様の Worker provider（文言は契約から取得）
- `js/pinpoint-legacy.js`: D4境界判定、bounded probe（最大3窓）、従来fallback
- `tests/semantic-boundary-referee.mjs`, `tests/semantic-boundary-worker.mjs`: focused tests
- `tests/semantic-boundary-holdout-eval.mjs`: 合成 holdout の比較 harness
- `tests/semantic-boundary-openmw-holdout.mjs`: 実 OpenMW arm64 holdout の opt-in harness（ケース表駆動）
- `tests/fixtures/openmw-boundary-holdout.manifest.json`: holdout の labelled cases と実契約

## 実行済みテスト

rebased head（base `8d508636d`）で実行済み。

```text
node tests/semantic-boundary-referee.mjs        # PASS
node tests/semantic-boundary-worker.mjs         # PASS
node tests/semantic-boundary-holdout-eval.mjs   # PASS
node tests/check.mjs                            # PASS (5.4s)
node tests/ir-pinpoint-location.mjs             # PASS
node tests/ir-pinpoint-path.mjs                 # PASS
node tests/pinpoint-ui-runtime.mjs              # PASS
node tests/issue-5109-pinpoint-cancel-unexamined.mjs  # PASS
node tests/run.js                               # PASS
# offline: labelsConsistent=true / promotionEligible=false
HEX_OPENMW_HOLDOUT_ARTIFACT=... node tests/semantic-boundary-openmw-holdout.mjs
# live: labelsConsistent=true / promotionEligible=false
HEX_OPENMW_HOLDOUT_ARTIFACT=... HEX_OPENMW_HOLDOUT_LIVE=1 node tests/semantic-boundary-openmw-holdout.mjs
# npm run check: machine-effects ゲートのみ env 要因で失敗（LLVM 18 不在）。他は失敗なし。
```

## 次にやること

1. **救済が成立するケースを増やす。** ただし条件は「設定済み実バイナリ」ではなく上記 §7 に従う:
   - 真値が rank 4〜5 に落ちること、**かつ breadth（`loc-shared` の関数数）で decoy に負けない**こと。
   - `tests/.real-fixtures/` の実アプリ3種（battlecats / TsumTsum / YWP）は `HEX_FIXTURE_*_URL`
     が未設定のためこの環境では取得できない（`scripts/fetch-real-fixtures.mjs` は URL 必須）。
   - 現実的な代替は「別の上流 OSS プロジェクトを固定 commit でビルドし、pool ごとの実関数を
     全件含める」source-grounded fixture。OpenMW の arm64 ビルド手順は再現可能（clang 14 + 固定 commit）。
   - rank 1〜3 のケースは referee の問いが ill-posed（真値が boundary set に無い）ため判定材料にならない。
2. 救済が確認できた場合のみ interactive single-goal の production caller から callback を注入する。
3. `money`/`score`/`level`/`item`/`attack`/`damage` を有効化する場合は、先に goal 別の
   ラベル付き holdout ケースを作る。本引き継ぎで eligibility を「較正済み goal のみ」に
   絞ったため、holdout を足せば自動的に eligible になる（実装変更は不要）。
4. background auto、Deep mode、設定画面、汎用 OpenJev proxy は追加しない。
5. `OPENJEV_API_KEY` の実値を repo / frontend bundle / logs / response / evidence に書かない。

## 注意

- 本体 `/mnt/workspace/hex-ida` ブランチにはこのコミットは入っていない。worktree のブランチをレビュー対象にする。
- 上流が `api.openjev.sh` + `openjev` である点が旧設計書の記述と異なるため、設計書側も更新済み。
- provider failure（timeout / 401 / 403 / 429 / 5xx / malformed / invalid model）は
  すべて従来 D1〜D4 へ fail-open することを focused test で確認済み。
