# C3 ユーザー側ローカル受入 — 2026-09-13 最終追記反映

正本は `analysis-roadmap-v8-integration-checkpoint.md` の2026-09-12担当分担。
唯一の開始ツリーは `hex-ida-roadmap-v8-user-c1-c3-20260912.zip`。
C3-01/02の既存canonical graph / ABI / prototypeを組み合わせる。
**新しいtype graph・layout engine・ABI classifierは作っていない。統合はCHECKPOINT-LOCKED。**

## 分類と完了範囲（今回の実測へ更新）

| 対象 | 開始時の4分類 | 今回の結果 |
|---|---|---|
| C3-01 recursive struct/union/array、hard矛盾、soft候補、停止 | 実装済み・受入が必要 | 既存graphを使用する48件PASS。production graph/constraints/SCCは変更なし |
| C3-02 profile × aggregate/varargs | 一部実装済み（既存classifiers多数、接続と受入が不足） | 140件PASS。45 return行すべてphysical proofと実placementの正常受入。旧10 gapは解消 |
| 指定combined tests / 本MD | 未実装 | ABI/type各1ファイルと本MD追加 |
| shared semantic adapter / ABI evidence | 原則別担当。今回の明示許可により必須handoffのみ局所修正 | registry正本のarm64e mappingとhidden-sret width整合を検証。C4 production・metadata/CI/generatedは無変更 |

前回の4分類を保持し、今回実装前にcheckpoint全6,476行と既存証拠を読み5分類で再監査した。
今回の検索・first divergenceは配布ルート `user-c1-c3-final-evidence/preflight-classification.md`。
ファイル不在を機能不在と解釈せず、既存 `c3-01-counterexamples`、aggregate/layout review、
Phase6 ABI、Phase8 required-profile/boundaries、scoped ABI検査を先に読んで利用した。

## C3-01: 再帰型・layout受入

canonical owner: `js/analysis/types/{graph,constraints,scc}.js`。
新規test: `tests/phase7/types/c3-combined-acceptance.test.mjs`。

| 入力・条件 | 期待結果 | 実測 |
|---|---|---|
| self-linked struct / mutual structs / recursive union / recursive array-of-union / ordinary array × complete | kind・size・member/element・recursive SCC identityが宣言どおり。入力順変更・再計算でも一致 | 5形状 × 下記8状態の一部、PASS |
| 同5形状 × hard-conflict / soft-only / soft-tie / cancelled / budget / stale / no-evidence | contradictionまたはunknown/probableを保持。certain accessorで部分結果を出さない。停止理由とsnapshot/entityを検査 | 5×8 = 40件PASS |
| recursive 4形状 × SCC反復1回 | iteration-limit、certainConclusions空、再構成はunknown | 4件PASS |
| 既存10-case corpus × debug/no-debug | falseCertainty=0、矛盾・曖昧候補を落とさない | 1件内の20行と既存metrics検査PASS |
| pointer/integer hard conflict + symbol heuristic + 無関係な正常型 | heuristicで矛盾を決着しない。structural層・別entityは保持 | 1件PASS |
| incomplete aggregate/member extent | size/member-sizeのnullを0にしない。既存min alignment=1をABI確証と解釈しない | 1件内3形状PASS |
| bounded successor列挙 / self-edge / 初回provider failure | 1度だけ列挙、cacheされたself-edge、初回失敗はtruncated | 1件内3状態PASS |

合計 **48件PASS**。関連既存typesは **158/158 PASS**。
これは有限のdeclared hard/soft証拠に対する受入であり、native binary全体からの型発見率や
全再帰layout問題の完了宣言ではない。

### 前回の古いassertionとの整合（今回の差分ではない）

前回作業の開始ZIPでは型の3件が失敗した。今回の唯一の開始ZIPでは既に修正済み。既存#5190と#5271が正本の現行契約だったため、
productionを戻すのではなく次の2既存testファイルだけを局所更新した。

- `c3-layout-review-v6.test.mjs`: 宣言されたstruct boundを保ちながらmember width=nullであることを直接検査。
  incomplete structの既存min align=1を許すが、size=nullを必須とする。unknownを0にする実装は許さない。
- `consolidated-source-regressions.test.mjs`: 旧「self-edgeで2回列挙」を#5271の1回cacheへ揃える。
  初回provider failureの拒否検査は残し、新combined testにも固定した。

`baseline-type-failures.log`: 5PASS/3FAIL。`corrected-type-contracts.log`: 27/27PASS。
assertionを削除してgreenにしたのではなく、既存のより新しい明示契約と整合させた。

## C3-02: profile × aggregate / placement

canonical ownerは `js/targets/abi/**`、`semanticAbiAdapter`、`recoverFunctionPrototype`。
新規test: `tests/phase8/abi/c3-combined-acceptance.test.mjs`。
期待register/pieceは固定fixtureに宣言し、実装を自分自身のoracleとして使わない。

形状: small 64-bit struct / pair 128-bit struct / HFA(2 doubles) / HVA(2 vectors) / large 256-bit struct。
各形状はmember幅・offset・必要なalignment・trivial性を明示する。
SysVはeightbyte classを明示し、MEMORY returnではexplicit indirect-result宣言を別途渡す。

| Profile | 引数分類・physical proof（5形状） | returnの5形状 | 制約 |
|---|---|---|---|
| AAPCS64 | 5行受入 | 5行placement受入 | 既存x8 sretを使用 |
| Darwin arm64 | 5行受入 | 5行placement受入 | alignment証拠必須。large引数のpointer physical pieceを補修 |
| Darwin arm64e | 5行受入 | **5行placement受入** | ABI architecture=arm64とtarget=arm64eの対応を既存registryで証明。x0/x1、v0/v1、x8 indirectを公開 |
| SysV AMD64 | 5行受入 | 5行placement受入 | HVA/largeは明示MEMORY/sret。XMM→物理YMM viewも既存consumerを利用 |
| Microsoft x64 | 5行受入 | 5行placement受入 | register/indirect-copy区別 |
| Microsoft vectorcall | 5行受入 | 5行placement受入 | HFA/HVA、variadicは別途unsupported |
| RISC-V LP64 | 5行受入 | 5行placement受入 | canonical integer bank |
| RISC-V LP64F | 5行受入 | **5行placement受入** | small/pair/double-HFAは既知integer規約x10/x11。真に未知のnested layoutは拒否 |
| RISC-V LP64D | 5行受入 | **5行placement受入** | small/pairはinteger、double-HFAはf10/f11。LP64Fとの差を保持 |

9×5=45行の分類を固定した。**return placement成功45行 / unsupported0行 / shared handoff gap0行**。
以前の35/5/5から実装を修正し、5+5行を正常placementへ移行した。空locationsやunknownを成功扱いした変更ではない。
register引数はprototypeまで、stack引数はphysical proofと下記専用spill検査を区別する。
証拠が足りない型をABIに合わせて推測・再分類する第二実装はない。

| 追加条件 | 期待結果・実測 |
|---|---|
| 9 profiles × stale/cancel/budget/truncated/caller-conflict/ambiguous-thunk/tail-call | 63件PASS。exact publicationを拒否 |
| 9 profiles × variadicの2表記 | 18件PASS。既知fixed prefixと未知anonymous frontierを分離。vectorcallはunsupported |
| Darwin arm64/arm64e × large indirect-copy | 2件の中でregister / register枯渇stack / anonymous stackを検査。pointer64とpointee256を混同しない。欠落・壊れたpieceは拒否 |
| explicit alignment / sret不足、overlap layout | 1件で全profileの保守的拒否を確認 |
| LP64F/LP64Dの明示float32 pair | 1件で引数・戻り値ともf10/f11の正例を確認 |
| unknown profile × 5形状 × variadic bool | 1件でplacement非公開を確認 |
| AAPCS64 HFA32/HFA64/HVA128 × 先行stack slot 0/1 | 6件PASS。frame offset・member byteOffset・tail非重複、誤alignment/ずれたpiece拒否 |
| arm64e shared envelope / simulator / hidden-sret | 新規1件。5 Apple platformの実placement、偽registry/owner/profile/provenance/invalidation/stale/overlap/32-bit hidden pointerを拒否 |
| LP64F/LP64D shared flattening | 新規2件。nested float/integer、実unionのinteger規約、`struct Union`という名前の正常structを区別。unknown nested layoutは拒否 |

合計 **140件PASS**。今回再実行したPhase6 ABI **211/211**、Phase8 ABI（combinedを含む）**208/208**、
既存required-profile script **66/66行PASS**。types（combinedを含む）**206/206**、
aggregate regression **30/30**、Phase8 integration **41/41 PASS**。groupの件数は重複するので合算しない。
前回scoped ABI25件の記録は歴史として保持し、今回の新しい実測はfinal evidenceを参照する。

### 前回の局所修正（今回は変更せず保持）

`darwin-arm64.js` の既存aggregate-indirect-copy引数2経路に、既存AAPCS64と同じ
1個の64-bit pointer physical pieceを付けた。配置規則やshared validatorは変更していない。

`aapcs64.js` の既存stack normalizationで、stackにあるcanonical piecesを正規化後offsetへ揃え、
proven homogeneous elementBytesをpieceのstackAlignmentに渡す。
8-byte aggregate slot alignmentを4-byte HFA memberへ誤適用しない。
先行8-byte scalar後の16-byte HVAでもpiece座標とentry座標がずれない。
coreのallocation規則・aggregate layout推論を複製せず、既存proofの座標/整列情報だけを運ぶ。

既存forced-stack fixtureは#5598のwhole-aggregate packing（float32は0/4、tailは8）へ更新。
required-profileのDarwin fixtureには必要なalignment=8を明示。
semantic adapter / physical validator / type graph / registryは無変更。
ABI semantic versionは既存値を維持（配置規則自体の置換ではない）。公開・moving-main統合時の
canonical producer identity / generated同期は統合担当が最終確認する。

## 今回閉じたproduction gap

1. `semantic-function-base.js` のarm64e手書きplatform集合を既存registryのresolver照合へ置換。
   `targets/abi/evidence.js` はABI owner arm64とtarget profile arm64eの差を、登録済みABIのid/version/identity/digestで認可。
   provenance/invalidationのarchitecture mirrorも検査し、不正なowner変更で空locationsを埋めることは許さない。
2. `canonicalAbiHiddenResult` で、producerが明示するpointerBitsとhidden pointerBitsの矛盾を拒否。
   256-bit aggregateサイズをpointer widthと混同しない。未証明・不正widthの証拠をexactへ昇格しない。
3. `riscv-lp64.js` の既存argument flattening helperを同じclassifier内で共有し、returnにも利用。
   proven-ineligibleは既存integer規約、unknownは拒否、proven-eligibleは既存FP/integer physical piecesを使用する。
   実unionをFP flattenせず、単にUnionと名付けたstructは拒否しない。soft LP64はversion1を維持、
   LP64F/LP64DはsemanticVersion **1.1.0** として古いproof identityを区別する。

新ABI/type engine・別physical truth ownerは作っていない。旧「RISC-V未対応」assertionは削除だけでなく
実reg/width/offsetを要求する正例へ更新。malformed・stale・cancel・budget・不明layoutの拒否は保持している。

## 反証とローカルcompiler照合

最終testsのままproduction 6ファイルだけ開始bytesへ戻すと150件中16FAIL、修正後は同じ150件がPASS。
このうちC3は旧arm64e5行、旧RISC-V5行、新しいguard/flatten3件が赤になる。
証拠: `user-c1-c3-final-evidence/results/counterfactual-production-revert.log` / `counterfactual-fixed-production.log`。

既にローカルに存在した正規Clang 17.0.0で、6つの小C関数をLP64F、LP64D、arm64eの3targetへコンパイルした。
small/pair、double pairのLP64F整数対LP64D FP、nested float pair、union、large sretの生成assemblyを照合。
C source・compiler identity・有限timeout command・18関数のassemblyをfinal evidenceに保存した。
これは代表例の独立compiler corroborationであり、45行全体のnative oracle、hardware実行、frozen release corpusの代替ではない。
RISC-Vのunion規約をDarwinへ流用していない。

## 最終statusと統合注意

**C3-01 COMPLETE、C3-02 COMPLETE（checkpointで割り当てた有限ユーザー側受入の範囲）。**
旧arm64e5行・LP64F/D5行は残件ではない。ロードマップ全体のnative発見率、未提供metadata、全ABI問題、
typed CALLの再構成や実機・独立shadowを含む全体COMPLETEとは異なる。
PDB #4630の古いpositive fixtureは、既存#4210のarg-list/count/calling-convention/options契約へ合わせた。
productionを弱めず、IPI/TPI衝突拒否を保持し、debug268件がPASSした。

full Phase8/9は有限deadlineで未完走、esbuild/playwrightの正規packageは未解決。
full check/build、generated同期、current-main照合、独立shadow・実機releaseは未達。
別版binaryの偽装・依存install・remote操作はしていない。**CHECKPOINT-LOCKEDを維持する。**

今回のsemantic/ABI evidence変更は共有境界とのconflict候補。既存registry mapping、physical proof、
hidden-sret整合、LP64F/Dの新identityを一体で統合し、未知結果の拒否を消さない。
ME/C4 productionは変更していないが、alias1.1.1移行に必須のC4 test fixture literal変更はfinal manifestで明示した。

```sh
timeout -k 2s 30s node --test tests/phase7/types/c3-combined-acceptance.test.mjs \
  tests/phase8/abi/c3-combined-acceptance.test.mjs
timeout -k 2s 30s node tests/phase7/run.mjs --group types
timeout -k 2s 30s node --test tests/phase6/abi/*.test.mjs tests/phase8/abi/*.test.mjs
timeout -k 2s 15s node tests/phase8/abi/hex-c3-02-required-profile-matrix.mjs
```
