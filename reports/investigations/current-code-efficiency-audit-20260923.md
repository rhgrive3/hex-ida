# 現行コードの精度・速度・ブラウザメモリ監査

日付: 2026-09-23
対象: `main` の `2b8e98d61ee59cedc365a9baf102f75b7189eb28`。作業ツリーに既存の変更があるため、以下はコミット済みの実装に対する静的監査であり、今回の性能実測や製品受入ではない。監査後の実装差分は末尾に記録した。動作テストは実施していない。

## 要約

今回確認できた最も明確な精度課題は、**候補が存在しても正しい候補を先頭に選べず、誤った候補を強く表示すること**である。直近の実バイナリ調査では部分名クエリの正解候補は 196/196 に存在したが、先頭正解は 53/196、全426件中の誤った strong 判定は67件だった。これは今回のコミットで再測定した値ではない。現行の候補融合・判定経路は [`js/pinpoint.js`](../../js/pinpoint.js) と [`js/evidence.js`](../../js/evidence.js) に残っている。

速度面では、PE 再配置、SSA の PHI 配置、デコンパイラのアドレス参照に、入力規模に応じて繰り返す配列構築・全件探索がある。これらはソルバや精度ゲートを緩めずに改善できる。ブラウザでは、`readAt` が転送済みの専有バイト列を逆アセンブル用にもう一度コピーする経路が確認できた。

| 優先 | 対象 | 主な効果 | 根拠の強さ |
| --- | --- | --- | --- |
| P0 | 部分名検索の順位・誤 strong 判定 | 精度、誤誘導防止 | 実バイナリ調査と現行判定経路 |
| P1 | PE 再配置の所有領域探索 | PE 読込速度・一時割当 | 現行コードのエントリ内再計算 |
| P1 | SSA PHI 配置と支配検証 | 大関数の解析速度・GC | 現行コードの繰り返しソート／線形探索 |
| P1 | デコンパイラのブロックアドレスと stack provenance 探索 | 大関数の表示速度 | 現行コードの線形探索 |
| P2 | Legacy フォールバックの二重実行 | 未対応命令を含む関数の待ち時間 | 現行コードの二系統実行 |
| P2 | ブラウザ逆アセンブルの二重バイトコピー | UI スレッド割当・ピークメモリ | 現行 Worker 転送経路 |
| P2 | x86 再検証 Worker の寿命 | 長時間利用時の常駐メモリ | 現行コードのモジュール単位 Worker |
| P2 | Points-to の全値再評価 | 大関数の解析速度・予算内の到達範囲 | 現行コードの固定点ループ |
| P3 | 明示的証明経路の再検査粒度 | API 利用時の待ち時間 | 内部製品経路では未使用 |
| P3 | Discovery V1/V2 の並存 | 保守負担・古い経路の誤最適化防止 | 内部呼出し経路の照合 |

## 具体的な指摘

### 1. 部分名検索は候補生成後の順位付けが主な精度課題（P0）

[`pinpoint-confidence-calibration/README.md`](pinpoint-confidence-calibration/README.md) と [`pinpoint-jev-probe-audit-20260923/README.md`](pinpoint-jev-probe-audit-20260923/README.md) の426件では、正解候補の存在率は100%だが、部分名の先頭正解は53/196、誤 strong は67件。現行コードは候補ごとに `fuse` し、順位順の結果を `decide` へ渡す（[`js/pinpoint.js:352`](../../js/pinpoint.js) と [`js/evidence.js:1053`](../../js/evidence.js)）。したがって候補追加や一律の確信度しきい値変更だけでは、順位と誤 strong の双方を十分に直せない。調査で使った3つの実バイナリとクエリ集合への限定結果であり、全製品精度ではない。

**実施案:** 誤 strong 67件を「受信オブジェクトに紐付いた読み書き・caller・型・vtable などの区別可能なバイナリ根拠が欠けたもの」と「根拠はあるが融合・順位が誤るもの」に分ける。特に直近の probe 調査が22件で示した receiver 安全な `scanAccess` 接続不足を、狭い陽性・陰性の実例で先に改善する。正解候補を知らない実運用での再順位付けと誤 strong ゼロ増を採用条件にする。Jev 導入前の probe 調査では予算内 oracle の追加解決が2/61件、後付けの H6 探索との差が0件だった。Jev API はこの調査で呼ばれておらず、調査の結論は導入見送りである。

**追加内訳（同日）:** 誤 strong 67件のうち24件は、部分名クエリと偶然完全一致した別フィールドが `askedByName` で先行し、正解は後段の recall lane に置かれていた。残り43件の誤先頭は語並び・語彙一致の候補だった。全67件の誤先頭には検証済み根拠がある。完全一致の正解クエリにも後段候補が併存する例が46件あるため、後段候補の存在だけで strong を下げる変更は採用しない。識別に使うクラス・受信オブジェクトの根拠と追加解析の費用を先に限定する。

### 2. Discovery の V1 衝突エンジンは現行内部経路から外れている（P3）

[`js/analysis/discovery/artifact.js:333`](../../js/analysis/discovery/artifact.js) には候補・参照と code interval を総当たりする V1 エンジンが残る。一方、同ファイルは V2 アーティファクトを標準スキーマとして公開し、現行内部の [`js/analysis/index.js:290`](../../js/analysis/index.js) は `createDiscoveryArtifact` の V2 を呼ぶ。V1 を使う `functionDiscoveryArtifact` は公開関数として残るが、`js/` 内に呼び出しは見つからない。したがって V1 の二重ループを**現行 UI の速度ボトルネックとは評価しない**。

**実施案:** 外部利用・テスト・保存済み V1 互換性の要否を確かめ、不要なら V1 API と実装の廃止計画を立てる。必要なら利用負荷を測ってから区間索引を検討する。V2 の現行意味論に V1 の衝突 budget を移植しない。

### 3. PE 再配置の各エントリが所有領域配列を二度作る（P1）

[`js/binary/pe-loader-core.js:549`](../../js/binary/pe-loader-core.js) と同ファイルの `mappedBaseRelocationTargetSpan` は、呼び出しごとに sections と segments を連結・filter する。両者は [`parseBaseRelocations` の内側ループ](../../js/binary/pe-loader-core.js)から再配置エントリごとに呼ばれる。再配置数を `R`、所有領域数を `S` とすると、概ね `O(R×S)` の探索に加えて少なくとも二つの一時配列がエントリごとに生じる。

**実施案:** exact mapping owner の一覧を解析開始時に一度だけ作り、二つの検査へ渡す。大きな PE でまだ支配的なら区間索引に進む。重複・重なり・境界を含む現行の保守的判定は維持する。効果量は再配置密度の高い実 PE で計測する。

### 4. SSA は同じ候補集合を毎回ソートし、支配判定を線形探索する（P1）

[`js/semantics/ssa/build-core.js:438`](../../js/semantics/ssa/build-core.js) の PHI 配置は `pending` から一要素取り出すたびに `[...pending].sort()[0]` を実行する。定義 variant とフロンティアが増える大関数で配列割当と比較が増える。同ファイルの [`:748`](../../js/semantics/ssa/build-core.js) は各 scalar use で dominator 配列に `.includes` する。

**実施案:** PHI の取り出しは現行と同じ block ID 順の最小ヒープにする。支配判定は同じ dominance tree の区間番号で定数時間化するか、関数内で使うブロックだけ索引を作る。PHI 順序は SSA ID と digest に影響するため順序を変えない。支配配列を全ブロック分 `Set` に複製する案はブラウザメモリを増やすので先に採用しない。

### 5. デコンパイラが命令列を繰り返し走査する（P1）

[`js/decompiler/semantic-core.js:2412`](../../js/decompiler/semantic-core.js) の `blockAddress` は呼び出しごとに全命令から `row` を `.find` する。[`js/decompiler/pipeline.js:259`](../../js/decompiler/pipeline.js) の return provenance 再結合も、return node ごとの stack load 探索に加え、条件に合う store を全命令から `.find` する。大きな CFG や stack spill の多い関数では同じ配列の反復走査になる。

**実施案:** 関数単位で `row → address` と `definitionId → store候補` の読み取り専用索引を一度作る。重複 ID がある場合は元の探索順を保持する。`reanchorExactStackReturn` が二度現れる点は、中間の stack recovery 後に意味が変わり得るため、単純に削除しない。

### 6. 明示的な証明最適化では全グラフの鮮度検査が重複し得る（P3）

通常の対話的処理は [`js/decompiler/phase8/index.js:130`](../../js/decompiler/phase8/index.js) で `canonical-facts` のみ。証明は [`js/decompile.js:32`](../../js/decompile.js) の明示的な経路であり、`js/` 内にその `decompileWithProof` の呼び出しは見つからない。一方、[`js/decompiler/pipeline.js:69`](../../js/decompiler/pipeline.js) の `isProducerProjection` は IR roots と AST/IR 観測の `matches()` を走査し、`optimizeSemanticDecompilation` 中の複数境界で呼ばれる。観測側は [`js/decompiler/phase8/projection-origin.js:135`](../../js/decompiler/phase8/projection-origin.js) で node descriptor を全件確認する。さらに対象未指定では [`js/decompiler/pipeline.js:597`](../../js/decompiler/pipeline.js) から関数内の eligible scalar を列挙する。現時点で通常 UI の遅さとして数えない。

**実施案:** 証明 API を UI に接続する場合は表示中の式・条件と少数の優先 target を明示し、関数全体の自動対象化は明示操作に限定する。利用実測で待ち時間を確認してから、連続した同期処理内だけ検査結果を共有する。`await` 後と最終公開の鮮度検査は残す。既存の descriptor 読取削減（旧資料では 1,017,774→160,997回）は前進だが、120ms達成の証拠ではない（[`docs/解析ツール改善.md`](../../docs/解析ツール改善.md)）。

### 7. 未対応命令のある関数で Legacy デコンパイラを追加実行する（P2）

[`js/decompile-base.js:495`](../../js/decompile-base.js) は semantic decompile 完了後、unknown instruction が一つでもあれば `legacyDecompile` を関数全体で実行し、raw assembly 行数の少ない出力を選ぶ。フォールバック自体は表示の保全に必要だが、未対応命令の多い実バイナリでは二系統の費用を払う。

**実施案:** まず semantic 出力の assembly 行数がゼロなら legacy が勝てないため、追加実行を省く。その他は「未知命令が何件で、legacy が何回選ばれたか」を関数単位で計測し、得られない場合だけ局所 fallback の設計に進む。単に Legacy を停止すると精度が下がり得る。

### 8. ブラウザ逆アセンブルで転送後のバイト列を再コピーする（P2）

platform Worker の [`js/platform/worker.js:509`](../../js/platform/worker.js) は `readAt` の結果を `slice()` して転送リストで Backend 側へ渡す。Backend の [`js/backend.js:982`](../../js/backend.js) は逆アセンブル Worker に渡す前に同じバイト列を再度 `slice()` する。通常要求は4KiB、上限は1MiB。二番目のコピーは UI スレッドの割当とコピー時間を増やす。

**実施案:** `disassembleAt` の `readAt` 応答が専有転送バッファであることを境界で明示し、その経路だけ直接次の Worker へ transfer する。任意の呼び出し元や共有 view は従来どおりコピーする。ピークメモリと UI 応答時間を実ブラウザで比較する。

### 9. x86 再検証 Worker がファイル切替後も常駐する（P2、計測待ち）

[`js/targets/architecture/x86_64/semantic-function.js:9`](../../js/targets/architecture/x86_64/semantic-function.js) は module scope の Worker を再利用し、失敗時には terminate するが、正常時のファイル閉鎖や idle 時の終了経路はない。再利用は起動費用を減らすため、これは直ちに leak と断定できない。WASM デコーダを読み込んだ後の常駐 heap が iPad で負担なら、明示的な idle 破棄または参照数による所有を検討できる。

**実施案:** 実機または WebKit 互換環境で、x86 解析後に別バイナリへ切り替えた際の Worker/heap 生存量と再起動費用を測る。省メモリの利益が勝つ場合だけ寿命を変更する。

### 10. Points-to の固定点計算が毎回全 SSA/IR 値を再評価する（P2、設計検討）

[`js/analysis/pointsto/local.js:1043`](../../js/analysis/pointsto/local.js) は変更が一つでもあれば、各 iteration で全 `ssaOrder` と `irOrder` に transfer・join・等価判定を実行する。収束回数を `K`、値数を `N` とすると `O(K×N)` で、変化しない値も再計算する。ループやポインタ演算の多い関数では時間予算や iteration 上限に先に達し得る。

**実施案:** まず iteration ごとの変更値数と transfer 時間を収集する。支配的なら依存辺を索引化し、変わった値の consumer だけを安定した順序で再投入する。widening の時点と結果を変える恐れがあるため、一足飛びに置換せず、SCC 単位の小さな実バイナリから結果・partial 状態・digest を照合する。

## 既存レポートとの整合と測定順序

- [`docs/deep-research-report.md`](../../docs/deep-research-report.md) は2026-08-16の歴史的スナップショットで、現行機能の欠落判定には使わない。
- 旧 [`unsupported-semantics`](unsupported-semantics/README.md) の `DT_INIT/DT_FINI` 320件は当時の結果。現行には [`elf-loader-entry-extent.js`](../../js/binary/elf-loader-entry-extent.js) があり、同じ欠落として再掲しない。
- 旧 [`direct-recompilability`](direct-recompilability/00-baseline.md) の raw TU 0/160 は修復前の測定。2026-09-19の [`production repair`](direct-recompilability-production-20260919/README.md) は増分で、現在の160件再測定結果は示していない。
- [`reports/public-benchmark-parallel/summary.json`](../public-benchmark-parallel/summary.json) は旧コミットの公開 IDA Pro 9.1 成果物との比較で、semantic correctness・recompilability・競合速度は `UNMEASURED`。現行 HEAD の IDA 越えの主張には使えない（[`docs/PUBLIC_COMPETITOR_BENCHMARK.md`](../../docs/PUBLIC_COMPETITOR_BENCHMARK.md)）。

**進め方:** まず各対象の実負荷を一つずつ採り、PE 再配置数、SSA block/variant 数、デコンパイルの per-pass 時間、ブラウザのピークメモリと初回有用結果までの時間を記録する。改善は純粋な索引化から着手し、同じ入力で結果・unknown/partial・順序・digest が変わらないことを小さな既存ケースで確認する。ソルバ証明、独立 verifier、全コーパスは各変更のリスクと最終受入に必要な境界で使い、探索段階で毎回全件を回さない。既存の exact-head と実機要件は [`docs/ENGINEERING_PROCESS_GUARDRAILS.md`](../../docs/ENGINEERING_PROCESS_GUARDRAILS.md) に従う。

次点の調査対象は、[`analysis-scheduler.js`](../../js/core/scheduler/analysis-scheduler.js) の依存辺登録ごとの経路探索、[`analysis-cache.js`](../../js/cache/analysis-cache.js) の共有バッファ探索後の clone と scheduler の encode/decode、[`PassManager`](../../js/decompiler/passes/manager.js) の optional pass ごとの rollback snapshot である。いずれも実装上の反復作業は確認できるが、通常のユーザー操作で支配的か未計測。キャッシュの clone は隔離・権限境界を、snapshot は失敗時の原状回復を守るため、単純な削除や参照共有は提案しない。旧 [`tests/benchmark-baseline.json`](../../tests/benchmark-baseline.json) では `peakMemory` と初回有用結果時間は未計測であり、現行 HEAD の改善量を判断する基準にはできない。

**未計測:** この監査では speedup、ブラウザのピークメモリ削減量、現行 HEAD の IDA との差を数値化していない。優先順位はコードの計算量、対象頻度、過去の実バイナリ結果からの仮説である。

## 監査後の初回実装（同日、作業ツリー）

OpenCode の独立作業ツリーで PE、SSA、デコンパイラを並行調査・編集し、差分をレビューして取り込んだ。PE の所有領域リストを解析ごとに一度だけ生成し、SSA の PHI 候補を同じ文字列順の優先キューで取り出す。デコンパイラはブロック開始行だけのアドレス索引を作り、semantic 側の assembly 行がゼロのときは勝てない Legacy 実行を省く。ブラウザの逆アセンブルでは、専有バッファとして Worker から転送された読取結果に限り UI スレッドでの再コピーを省く。

精度側の追加読取では、既存 baseline の誤 strong 67 件すべてで先頭候補の `fusion.verified` が真だった。24 件は `askedByName`、42 件は `askedBySequence` で、これらの件数は重複し得る。単純な verified 条件の追加や一律の閾値変更では、正解候補の順位問題を解決したとみなせないため、精度判定のコードはこの回では変更していない。

この実装は `git diff --check` のみ確認済み。動作テスト、性能測定、ブラウザのピークメモリ測定、IDA との再比較は未実施である。

続く作業ツリーの改善では、SSA の scalar-use 支配判定に支配木の区間番号を使い、各 use の dominator 配列探索を省いた。return 命令の逆順検索は配列コピーを作らず走査する。Scheduler は DAG に未登録の新規ノードについて、自己参照以外の経路探索を省く。既存の結果を保つ意図で局所的に変更したが、動作テストと実測は未実施である。

次の改善では、CFG の支配集合を作る際に親ブロックの整列済み集合を再利用し、各ブロックで祖先をたどり直して全件ソートする処理を省いた。`foldShapes` は同じオフセットでもオブジェクト由来ごとにサイトを分けるが、Pinpoint の補助サイト表示はオフセットだけで併合していた。由来が複数ある場合は誤った変更箇所を示し得るため、その補助表示を控える。いずれも実測は未実施である。

x86 検証 Worker の60秒アイドル破棄は試作したが、操作間隔次第で WASM 再起動の待ち時間を増やす。メモリ削減量と再起動費用が未測定のため、既定動作には採用していない。試作差分は永続 evidence に保管した。

## 既定 fast 経路を優先した追加改善

この PR では `js/decompiler/profiles.js` の未指定時 profile を `fast` に変更した。通常の対話的処理はデコンパイラ30ms、Phase 8は30ms／10,000 work item、render provenance は128 transform records と256 consumers の設定を使う。明示的な `deep` 指定は残す。以下の追加変更はこの既定経路を対象にした。

- `decompile-base.js` の `finalize` 入口でも profile を適用し、switch 履歴と fallback provenance に `fast` の上限が伝わるようにした。以前は semantic 本体と後段 pipeline で設定されていたが、この二つの境界は元の `opts` を受け取り、上限を欠いたまま実行し得た。明示的な profile と各上限の指定は profile 解決規則のまま扱う。
- `semanticModelForDecompiler` は対象の分岐・呼出し先を実際に補完する場合だけ命令配列を複製する。補完がない関数では入力 model をそのまま返し、従来の全命令 `map` による一時配列を作らない。補完する命令の値と配列内の順序は維持する。
- `pipeline.js` の return source 再結合で、canonical な memory forwarding から対応する stack store を繰り返し探す場合だけ、命令列の stack key 別索引を遅延生成する。最初の2回は元の線形探索を維持し、単発・少数の照会で索引の割当を増やさない。同じ key の候補順序を保ち、従来の `.find` が返す最初の store を選ぶ。通常の `reachingStore` が直接使える場合は索引を作らない。索引の一時参照は store 数に比例し、処理終了後に破棄される。
- `pipeline-core.js` の予算到達後の式マップ補完は、`expressionMemo` 全体を配列化して `filter`・`map` する代わりに、必要なキーだけを Map へ直接追加する。同じ挿入順と後勝ちの Map 意味論を維持し、一時配列を減らす。

OpenCode の並行読取では、通常の `fast` 表示で provenance map の再構築や emitter 履歴の収集も候補として挙がった。ただし map は projection の完全性判定に使われ、履歴は個別の証拠源と欠落理由を持つ。単純な削除や総量128件への先着制限は正確性を損なう恐れがあるため採用していない。PassManager の rollback snapshot も例外時の原状回復に必要で、計測なしには削らない。これらの速度・メモリ効果は未測定である。
