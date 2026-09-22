# OpenJev boundary referee — 実ゲーム holdout の label 修正と再計測

- 日付: 2026-09-22
- レーン: OpenJev boundary referee / 実ゲーム holdout（branch `feat/openjev-real-game-holdout`）
- base: 現 main `b1a61d50c0bd2c2b893862c8514e7a05df62ecdd`（reconcile 済み。旧 base は `1e2b89c9b228f6510c7c2bc9b5f7204633f35c90`）
- 正本 fixture: `tests/fixtures/real-game-boundary-holdout.manifest.json`
- 計測器: `tests/semantic-boundary-real-game-holdout.mjs`（artifact 必須。live は `HEX_SEMANTIC_BOUNDARY_HOLDOUT_LIVE=1` + `OPENJEV_API_KEY`）
- 機械可読な同伴証跡: `measurement-2026-09-22.json`（このディレクトリ）
- 前段の引き継ぎ: `docs/openjev-boundary-referee-handoff.md`

## 1. 結論

1. この fixture の label は **反証不能**だった（真値を boundary rank 4 と書いていた）。rank 1〜4 は
   常に baseline の D1〜D4 検証集合に入るため、「rank 4」というラベルは
   **どこに真値があっても `labelsConsistent: true` になる**。真値の boundary rank は **5（= `c1`）**。
   これは harness の欠陥ではなく証跡の欠陥であり、artifact 依存なしに回帰で固定した。
2. 宣言済み oracle の **上限が未計測のまま 0 として報告**されていた。oracle が `c0/c1` しか答えず、
   この artifact の境界集合は 5 候補なので契約が `invalid-response` で応答を捨てていた。
3. 修正後に計測: **1-probe は検証集合を差し替えられるが、返り値を変えられない。**
   真値を `c1` として強制しても、probe は実窓で書き込みを reconfirm し、製品は
   `probe-promoted-by-binary-evidence` で検証 slot を差し替えるが、返る答えは 148 のまま。
   これは合成 OpenMW fixture でも同値の上限が実測されており（5 候補が p=0.9822 で同点・ordering が勝つ）、
   **製品の性質**であってこのバイナリ固有の事情ではない。実 ARM64 リリースで再現した。
4. live の referee は真値を選ばない。boundary rank 4（offset 240 = `player_t.ammo[0]`）を `c0` として選び、
   noul の margin 0.07 は admission 床（0.2）で弾かれ、choice は margin 0.85 で通るが
   `challenger-not-tail`（`c0` は boundary rank 4）で probe に進まない。

→ `promotionEligible: false` を維持し、production は gated のまま。ただし今回は
**「なぜ救済が起きないか」が 2 つの独立した実測（上限と選択）で特定できている**。
fixture は緩めておらず、閾値も goal 文言も動かしていない。

5. **この holdout が見つけた false-likely は、先に main 側で修正された。** reconcile 後に再計測すると、
   同じ top-1（148 = `mobj_t.momz`）が `likely` → **`ambiguous`**、`falseLikely` は **1 → 0**。
   main の `fix(pinpoint): require 3 independent groups for likely verdict`（#9418）は
   この holdout の観測を根拠として引用しており（`tests/fixtures/pinpoint-false-likely-dsda.json` の
   `note` は本 PR #9410 の holdout を出典として明記）、**実ゲームでの再現と修正の両方をこの lane が提供した**。
   残るのは「順位を外す」ことであり、「見つけていない資源を資源だと言う」ことではない（§4.1）。

## 2. 固定した artifact

| 項目 | 値 |
|---|---|
| 上流 | DSDA-Doom v0.29.4（Doom source port, `kraflab/dsda-doom`） |
| commit | `e443ff7a3e6090a1ff92ad7a426916c4fd35ecc5` |
| license | GPL-2.0（`prboom2/COPYING`） |
| release asset | `dsda-doom-0.29.4-mac-arm64.zip` 11,359,462 bytes / sha256 `cc46a12f…3540` |
| 解析対象 | `dsda-doom` Mach-O arm64 2,814,096 bytes / sha256 `76d5427c…73b8` |
| 取得 | `node scripts/fetch-real-game-holdout.mjs`（archive/member 両方を hash 照合、tmp+rename で atomic、`--check` は再取得なし） |

成果物は GPL のため checked-in しない（`tests/.real-game-holdout/` は gitignore）。
harness は測定前に artifact の sha256 を fixture の pin と照合し、一致しなければ測定を拒否する。

### label の二重導出（対象フィールド）

`mobj_t.health` = offset 196。

1. 固定 commit の上流ヘッダを arm64 ABI でレイアウトダンプ
   （`clang -target arm64-apple-macos11 -I prboom2/src -I prboom2/src/dsda -Xclang -fdump-record-layouts-complete -fsyntax-only`）
   → `mobj_t` 464 bytes、`uint64_t flags` 184 / `int intflags` 192 / **`int health` 196**。
2. 固定 artifact の実命令 → `_P_DamageMobj` の死亡ガード `ldr w9, [x0, #196]; cmp w9, #0; b.le`、
   ダメージ書き込み `str w22, [x19, #196]`、`_P_KillMobj` は `[x8, #196]`、`_P_GiveBody` は `str w8, [x9, #196]`。

## 3. 見つけた欠陥と修正

### 3.1 rank label が反証不能だった（修正）

前版は「真値は rank 4（D1〜D4 の内側で検証される）」と書いていた。しかし

- referee の候補 id `c0..` は **shape score 順（boundary 順）** に割り当てられ、
- 真値の boundary rank は **5**（boundary 順 `80, 148, 56, 240, **196**, 404, 256, 212`）であり、
- rank 4 は baseline の検証対象に**常に**含まれるため、そのラベルは絶対に破れない。

つまり「rank 4」は証跡を装った空チェックだった。修正:

- instrumentation に `rankedCandidateOffsets`（boundary 順の offset。内部専用で referee には渡らない）を追加。
- label 検査を `tests/fixtures/real-holdout-labels.mjs` に切り出し、
  **labelled rank が boundary 順で真値の位置と一致すること**を必須化。
- fixture を rank 5 / `oracleChallengerId: "c1"` に修正し、rank claim を oracle の実測に結合。

前版と同一の rank 4 を入れると、いまは必ず失敗する（実測）:

```
truthRankMatchesBoundaryOrder: false / oracleProbeTargetsLabelledRank: false
→ labelsConsistent: false → "no case can be used as evidence"
```

### 3.2 oracle 上限が未計測のまま 0 として報告されていた（修正）

`oracleReferee` は `c0/c1/none` しか返さない固定応答で、この artifact の境界集合は 5 候補
（`c0..c4`）なので `normalizeSemanticBoundaryResponse` が分布不足で応答を棄却し、
oracle variant は `invalid-response` / probe 未実行のまま `oracleCeilingRescues: false` を報告していた。
→ oracle が **request の全 id** に確率を返すよう修正し、宣言済み oracle は
「admission を通り `d<rank>` を実際に probe した」ことまで label 条件に含めた（`oracleCeilingMeasured`）。

### 3.3 （製品）probe の決定が返り値に届かない

`planShapeBoundaryVerification` は probe 成功時に `binaryGroundedPriority` で
「D4 と probed challenger のどちらが最後の通常検証 slot を取るか」を決め、
`probe-promoted-by-binary-evidence` を立てる。しかし返り値の ordering は後段の fusion
（`list.sort(fusion.logOdds)` → `decide`）が決めるため、**昇格した候補は検証 slot を取るだけで
答えにはならない**。本レポートではこれは修正せず、fixture に**上限として記録**した（§4）。
理由: 無条件に「probe 成功＝答えを差し替える」と、他方の labelled holdout が実測済みの
反例（誤った challenger が admission を通り probe も成功するが、既に正しい答えを動かしてはいけない
= OpenMW `stamina` ケース）を壊す。安全に外すには反例 fixture での検証が必須で、
その artifact（ローカルビルドの OpenMW compiler fixture）はこのリポジトリから取得できない。

### 3.4 goal 文言は妥当だったか

`hp` の較正文言は「decrease が increase を厳密に上回る候補を優先する」と言う。真値
`mobj_t.health`(196) は decreases 11 / increases 5 で条件を満たすが、live のモデルは
decreases 25 / increases 1 の offset 240（`player_t.ammo[0]`）を選んだ。
**文言は満たされているが、それだけでは実ゲームで一意に決まらない**というのが実測である
（＝文言の追加変更ではなく、選択の評価集合と admission の設計側の課題）。

## 4. 計測（修正後の label）

`HEX_SEMANTIC_BOUNDARY_HOLDOUT_ARTIFACT=tests/.real-game-holdout/dsda-doom node tests/semantic-boundary-real-game-holdout.mjs`

### 2 つの順序（混同しないこと）

| | 順序 |
|---|---|
| boundary 順（= referee の `c0..` の割当順） | `80, 148, 56, 240, **196**, 404, 256, 212` |
| final answer 順（= fusion 順 = 製品の返り値） | `148, 56, 240, **196**, 404, 256, 212, 80` |

shape score: `0.214286 / 0.208333 / 0.2 / 0.198125 / 0.196591 / 0.183333 / 0.148958 / 0.146875`。
D4/D5 gap = **0.001534** < `maxD4D5Gap` 0.02 → 曖昧ゲートは発火する。

### offline（reconcile 前 = base `1e2b89c9b`）

| variant | final top-1 | rescue | hit@boundary | wrong-top-1 | false-likely | analyze | semantic |
|---|---|---:|---:|---:|---:|---:|---:|
| 現行 D1〜D4 | 148 (`mobj_t.momz`) | 0 | 0 | 1 | 1 | 18 | 0 |
| oracle 1-probe（上限） | 148 | 0 | **1** | 1 | 1 | 18 | 1 |

oracle (`c1` = d5 = 196) の詳細: probe `reconfirmed`（2 analyze、実窓で書き込みを再確認）/
referee `probe-promoted-by-binary-evidence` / `verificationTargets` が `d1,d2,d3,d4` → `d1,d2,d3,d5` /
それでも final top-1 は 148。**このケースの 1-probe 上限は「救済できない」と実測された。**

### live OpenJev（reconcile 前）

| variant | final top-1 | rescue | hit@boundary | semantic | referee |
|---|---|---:|---:|---:|---|
| 現行 D1〜D4 | 148 | 0 | 0 | 0 | no-referee |
| oracle 1-probe（上限） | 148 | 0 | **1** | 1 | `probe-promoted-by-binary-evidence` → probe `reconfirmed` (d5) |
| shadow choice | 148 | 0 | 0 | 1 | received **c0**, margin 0.85 |
| shadow parallel noul | 148 | 0 | 0 | 1 | received **c0**, margin 0.07（admission 床 0.2 未満） |
| gated 1-probe | 148 | 0 | 0 | 1 | `challenger-not-tail`（c0 は boundary rank 4、probe は d5〜d8 のみ） |

latency（この実行のサンプル）: choice p50 420.5 ms / p95 862.7 ms、noul p50 566.9 ms。

`labelsConsistent: true` / `promotionEligible: false` / `artifact.pinned: true`。

### reconcile 後（base `b1a61d50c` = 現 main）

main が `fix(pinpoint): require 3 independent groups for likely verdict`（#9418）を含んで進んだため、
reconcile して同じ artifact / 同じ label / 同じ frozen policy で再計測した。**閾値も fixture も動かしていない。**

| variant | final top-1 | verdict | rescue | hit@boundary | wrong-top-1 | false-likely |
|---|---|---|---:|---:|---:|---:|
| 現行 D1〜D4（offline） | 148 (`mobj_t.momz`) | **ambiguous** | 0 | 0 | 1 | **0** |
| oracle 1-probe（offline, 上限） | 148 | **ambiguous** | 0 | **1** | 1 | **0** |

| variant | final top-1 | verdict | rescue | semantic | referee |
|---|---|---|---:|---:|---|
| 現行 D1〜D4（live） | 148 | **ambiguous** | 0 | 0 | no-referee |
| oracle 1-probe（上限, live） | 148 | **ambiguous** | 0 | 1 | `probe-promoted-by-binary-evidence` → probe `reconfirmed` (d5) |
| shadow choice | 148 | **ambiguous** | 0 | 1 | received **c0**, margin 0.90（c0 = boundary rank 4 = offset 240） |
| shadow parallel noul | 148 | **ambiguous** | 0 | 1 | received **c0**, margin 0.06（admission 床 0.2 未満） |
| gated 1-probe | 148 | **ambiguous** | 0 | 1 | `challenger-not-tail`（c0 は boundary rank 4、probe は d5〜d8 のみ） |

latency（この実行のサンプル）: choice p50 451.7 ms / p95 577.8 ms、noul p50 465.8 ms。

差分は 1 点だけ、しかも本質的である。

| | reconcile 前 | reconcile 後 |
|---|---|---|
| top-1 の verdict | `likely` | `ambiguous` |
| false-likely（top-1 が真値でないのに strong verdict） | 1 | **0** |
| final top-1 | 148 | 148（不変） |
| boundaryRescue | 0 | 0（不変） |
| truth の boundary rank | 5 | 5（不変） |
| oracle 上限 | 救済なし | 救済なし（不変） |

つまり **main の修正はこの実ゲーム holdout で効いている**（本 lane が見つけた false-likely が実際に消えた）。
同時に **解決していないこと**も変わらない: 真値は依然 boundary rank 5 で baseline の検証集合の外にあり、
1-probe は検証 slot を差し替えられるが返り値は 148 のまま、live の選択は依然 `c0`（ammo）である。
`promotionEligible: false` の理由は「名乗りの誤り」から「順位の取り違え」に純化した。

### ARM64 runner での再計測（GitHub Actions）

同じ head を **ARM64 ランナー 2 種**で計測し、測定値そのものを assert して緑にした（ワークフローは
`rhgrive3/actions`。hex-ida 本体の PR からは成果物と `scripts/fetch-real-game-holdout.mjs` で再現できる）。

| 項目 | 値 |
|---|---|
| run（reconcile 後・本レポートの計測） | [35695074399](https://github.com/rhgrive3/actions/actions/runs/35695074399) `success` |
| 計測した head | `9d05bf7c4bc1c017dcc592d78d4168fd4751941f` |
| workflow commit | `a2df06921dcb8037092a8ebd038302006654d7d4` |
| leg 1 | `macos-14` → `uname -m` = `arm64`, node = `darwin arm64` |
| leg 2 | `ubuntu-24.04-arm` → `uname -m` = `aarch64`, node = `linux arm64` |
| 旧（reconcile 前） | [35687189172](https://github.com/rhgrive3/actions/actions/runs/35687189172) @ `6195f1a1f` / [35691359826](https://github.com/rhgrive3/actions/actions/runs/35691359826) @ `45359e755` — どちらも `falseLikely: 1` |

assert した内容（両 leg で `ok: true`、`problems: []`）:

- checkout した head が dispatch した `TARGET_SHA` と一致すること
- ランナーが ARM64 であること（`uname -m` と `process.arch`）
- manifest の upstream commit が pin と一致すること
- artifact の sha256 が manifest の pin と一致してから測定を始めること（`artifact.pinned: true`）
- artifact 不要の label self-check が通ること
- ケースの label（真値 offset/rank、記録済み boundary 順、`labelChecks` 全件 true、`labelsConsistent`）
- baseline は真値が **D1〜D4 の検証集合の外**にあること（`truthHitAtBoundary: 0`）
- baseline の verdict が **`ambiguous`** で `falseLikely: 0` であること（main #9418 との reconcile 結果）
- oracle 上限: probe が d5 を `reconfirmed` し検証 slot を `d1,d2,d3,d5` に差し替え、答えは 148 のまま
- `promotionEligible: false`

両 leg の測定値は一致し、offline / live の reconcile 後表と同一。
証跡は `arm64-runner-evidence-2026-09-22.json`（run の成果物から機械的に生成。`supersededRuns` に reconcile 前の run を保持）。

> 注 1: assert スクリプトの初回実行（run 35694932504）は、私が書いた検査文が oracle variant を宣言前に参照する参照順序のバグで
> 落ちた。製品側の失敗ではない（測定そのものは同じ値）。参照順を修正して再実行した結果が上の run。
>
> 注 2: 上記 run はこのレポートと証跡ファイルを**追加する直前の head**を計測している。
> その後の差分は本ディレクトリのドキュメント/証跡（と `package.json` の test chain）のみで、
> 測定対象のコードは変更していない。最終 head でも同じワークフローを再実行している（PR 本文に記録）。

## 5. 製品側 findings

1. **`hp` の決定的 top-1 が資源ではない。** `mobj_t.momz`（垂直方向の運動量）に
   `loc-drain-verified` が付く（gravity が減らす）ため、実ゲームで 1 位に出る。
   真値 `mobj_t.health` は baseline の検証集合（boundary rank 1〜4）に入っておらず、しかも
   boundary rank 5 に落ちている。
   → **名乗りの部分は修正済み（main #9418）**。reconcile 後は `ambiguous` / `falseLikely: 0` で、
   この fixture が見つけた false-likely は現 main では再現しない（回帰は main の
   `tests/pinpoint-false-likely-confidence.mjs` + `tests/fixtures/pinpoint-false-likely-dsda.json` が固定）。
   残るのは順位の誤りであり、これは未修正（下の 2・3）。
2. **1-probe は答えを変えられない。** oracle 上限で実測（本 fixture と OpenMW fixture の両方）。
3. **live の選択がまだ外れる。** 実ゲームでは `c1`（真値）ではなく `c0`（boundary rank 4 = `player_t.ammo[0]`）を選ぶ。
4. **修正は実ゲームで検証できた。** false-likely の修正が入った main 上で、同じ artifact・同じ label・
   同じ frozen policy の再計測が `falseLikely: 0` を返すこと（§4）が、その修正の実ゲーム側の
   外部検証になっている（main 側テストは合成ベクトルの固定のみ）。

## 6. 残作業（production の gate を外す条件）

1. **probe の昇格を答えに届かせる製品変更**と、その安全条件の定義。
   反例（OpenMW `stamina`: 誤った challenger が admission を通り probe も成功するが、
   既に正しい答えを動かしてはいけない）で検証できることが必須。
   その検証にはローカルビルドの OpenMW compiler fixture が必要（本リポジトリからは取得不可）。
2. 選択の改善（実ゲームで `c1` を選べるようにする）。admission 閾値の緩和では解決しない
   （noul の margin 0.07 は設計どおり棄却されている）。

## 7. 機械強制 / 回帰（このレポートの変更で追加したもの）

- `tests/semantic-boundary-holdout-labels.mjs`（`npm test` に接続）:
  - rank 1〜4 のラベルは**必ず** `labelsConsistent: false` になる（反証不能ラベルの回帰）
  - 宣言済み oracle が admission を通らず probe していなければ失敗（未計測上限の回帰）
  - instrumentation 欠落は fail closed
  - コミット済み fixture 自身が、記録済み boundary 順・oracle id・ceiling と整合すること
- `tests/fixtures/real-holdout-labels.mjs`: 上記検査の実装（artifact 不要）。
- harness: oracle は request の全 id に応答。`ceilingMeasured` を報告（未計測を 0 と混同しない）。
- **実行されていない回帰を canonical gate へ接続**（reconcile で追加）:
  - この lane の focused test は `npm test` chain に 1 つも入っていなかった。
  - さらに main の #9418 が追加した `tests/pinpoint-false-likely-confidence.mjs` も
    **どの runner からも呼ばれていなかった**（`package.json` / workflows / CircleCI を検索して 0 件）。
  - 両方を `npm test` に接続した。実行されない回帰は回帰ではない。
- `falseLikely` の恒久回帰は main 側の `tests/pinpoint-false-likely-confidence.mjs`
  （固定 DSDA 証跡ベクトル7件）が担う。本 fixture はその**出典**であり、artifact 必須のため canonical gate には入れない。

## 8. 証跡

- fixture: `tests/fixtures/real-game-boundary-holdout.manifest.json`
- harness: `tests/semantic-boundary-real-game-holdout.mjs`
- label 検査: `tests/fixtures/real-holdout-labels.mjs`, `tests/semantic-boundary-holdout-labels.mjs`
- 取得: `scripts/fetch-real-game-holdout.mjs`, `tests/semantic-boundary-holdout-fetch.mjs`
- 計測生データ: `measurement-2026-09-22.json`（offline + live の全 variant、latency、label 検査）
- ARM64 runner での再計測: `arm64-runner-evidence-2026-09-22.json`（run 35695074399, head `9d05bf7c4`, 2 legs とも success。reconcile 前の run は `supersededRuns`）
- 手順の正本: `docs/openjev-boundary-referee-handoff.md`（ARM64 節）と PR 本文
