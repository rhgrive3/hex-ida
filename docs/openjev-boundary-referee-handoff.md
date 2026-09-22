# OpenJev Boundary Referee 引き継ぎ

## 現在地

- 実装ブランチ: `codex/openjev-boundary-referee`
- base: 最新 main `8d508636d287a4fd95b2550b25f20ae8a3723f2a` に rebase 済み（12 commits, 作業ツリー clean）
- 作業ツリー: `/mnt/workspace/.dev-state/agent-work/checkouts/openjev-boundary-referee`
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
  12. `docs(jev): pin the commit list`（このファイル更新）
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

### 8. 実バイナリでの救済探索（実行済み）と、そこで当たった壁

**実バイナリは取得できた:**

```sh
cd <worktree>
node tools/fetch-large-fixtures.mjs battlecats   # → tests/battlecats（git 追跡対象なので即退避＋restore）
```

`tools/fetch-large-fixtures.mjs` は `tests/large-fixtures.json` の公開 GitHub raw URL から取得し、
size と Git blob sha1 を検証する（secret 不要）。3種をスクラッチへ退避して placeholder を復元した:

| fixture | bytes | SHA-256（`tests/fixtures/real-binaries.json` と一致） |
|---|---|---|
| battlecats | 28153072 | `567234909b2a33d62548257c4148290d9215d7edf414fa17c6b06fcf8c7cdf13` |
| TsumTsum | 45994784 | `4f877bb1d4e1503b439ce07c601a1fddd6a38a6f32395bfd3071b056f77839b3` |
| YWP | 63455952 | `cd1c72a30ba29f423a670f9e534c8865689ca09890769a95822869c162d240a6` |

退避先: `/mnt/workspace/.dev-state/agent-work/scratch/real-fixtures/`（worktree は clean のまま）

**しかし真値の壁に当たった。** 3種について ObjC metadata の ivar を全量調べ、
「名前がバイナリ中で一意」かつ `parseGoal(name).id` が referee の対応 goal になるものを抽出した結果:

| fixture | classes | ivars | 一意名 | そのうち goal に写像できるもの | 内訳 |
|---|---:|---:|---:|---:|---|
| battlecats | 3151 | 11078 | 4479 | **8** | money 5 / level 2 / item 1 |
| TsumTsum | 3260 | 11775 | 4674 | **9** | money 4 / item 2 / level 2 / attack 1 |
| YWP | 3590 | 15093 | 6269 | **8** | money 3 / item 3 / level 2 |

- 抽出されたのはすべて **AdMob / Facebook / 課金SDK のフィールド**（`GADAdValue.currencyCode`,
  `FBAdExperienceConfig.adExperienceType`, `APMInAppPurchaseItem.webOrderLineItemID` など）。
- **`hp` / `stamina` に写像できる一意名は 3種とも 0 件**。ゲーム値は ObjC ivar として
  一意名で露出していない。
- したがって「実アプリで hp の救済を測る」には、名前由来の真値ではなく
  **手動 RE で真値を確定する**必要がある。
- 参考: `tests/accuracy-base.mjs` の `pinpoint` feature はまさに「一意名の ivar」を正解として
  使っている。つまり repository の実バイナリ精度測定は **名前が残っている経路** を測っており、
  referee が住む **名前の無い shape 経路** はこのラベル源では被覆されない。
  （独立オラクル `tests/oracle.py` は python + `lief` + `capstone` が必要で、この環境には未導入。
  導入しても真値は結局 ivar 名に依存するため、この壁は残る。）

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

## 実 OpenMW holdout

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

1. **救済が成立するケースを増やす。** 条件は §7 と §8 の両方:
   - 真値が rank 4〜5 に落ちること、**かつ breadth（`loc-shared` の関数数）で decoy に負けない**こと。
   - 実バイナリは取得可能（§8）だが、**hp/stamina の名前由来真値は 3種とも存在しない**。
     実アプリで測るなら「手動 RE で真値を確定したラベル付きケース」を人手で作るしかない。
   - 自前で完結させるなら「上流 OSS を固定 commit でビルドし、pool ごとの実関数を**全件**含める」
     source-grounded fixture（OpenMW の arm64 手順が再現可能。clang 14 + 固定 commit）。
     部分集合を選ばないことが公平性の条件。
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
