> **完了 — 2026-09-09:** 改善版ZIPを取り込み済み。所有者の指示により性能改善・プロファイリング・250ms達成の追跡は終了。以下は引き継ぎ時の履歴であり、新しい改善依頼ではありません。今後の変更は検証で見つかったバグ修正に限定します。

# Hex 性能改善オーダー（別ローカル AI 向け）

この ZIP のソースを起点に、解析・逆コンパイルの性能改善を実装してください。
提案だけで終わらず、効果のある変更、関連テスト、変更前後の測定結果を返してください。
開発速度を優先します。実機確認は全開発終了後です。

## 作業の分担

- あなたは性能改善を担当します。元の作業環境では機能チェックを並行して進めています。
- 独立したローカル作業として進め、共有ブランチへの強制 push、main の変更、公開・デプロイは行わないでください。
- `docs/ENGINEERING_PROCESS_GUARDRAILS.md` 冒頭の開発速度・実機延期の改訂を適用してください。各編集のたびに全テスト、履歴の再検証、二重ビルド、Stage A/B の管理手続きを繰り返す必要はありません。
- フォルダ `tmp` は所有者の別作業です。触らないでください。解析 md の別実装も今回の対象外です。
- Stage A/B のチェック欄、CI、ガードレールの緩和ではなく、実際の製品処理を速くしてください。

## 起点と現状

引き継ぎ用ブランチは `handoff/performance-20260908` です。元の開発ブランチは
`perf/development-gate-policy`。このオーダーと生成物更新の直前のソースコミットは
`98a606df7e10a969c86fbb78bc1f2a379669ba58` です。
ZIP には `.git` がないため、ダウンロード元のコミット固定 URL の SHA を入力ソースの識別子として保存してください。
Git 履歴がないことを理由にソースを取得し直したり、作業を止めたりする必要はありません。

最後に完走した CPU 測定は **97621a38e2f7fd18556faeaee79b6e1f97b8a8af** に対するものです。
生データ全件は同梱の
`specs/005-analysis-final-closure/evidence/current-cpu-performance.json` にあります。

| 指標 | 実測 median | 上限 | 状態 |
| --- | ---: | ---: | --- |
| coldActiveFunction | 379.479 ms | 250 ms | 未達 |
| phase8InteractiveStage | 0.467 ms | 5 ms | 通過 |
| phase8OptimizeStage | 106.739 ms | 150 ms | 通過 |

- Node 22.20.0 / Linux x64。コーパスのコンパイラ記録は Clang 18.1.3。
- 全 135 関数、stage 適用 125 ID、3 反復、405 生サンプル。optimizer 未公開数 0。
- 所要 351.668 秒。cold の各反復平均は 438.652 / 379.479 / 344.452 ms。
- 集計は「各反復内の関数平均を取り、その 3 値の中央値」です。全サンプルの中央値に変えてはいけません。
- 過去 5d46 の cold 359.341 ms からの改善は、この測定では確認できていません。
- **この ZIP は測定後の jsonSafe 修正を含みます。379.479 ms を ZIP の実測値と扱わず、同じ環境で ZIP を変更前の基準として測定してください。**

## 既に取り込んだ変更（作り直さないこと）

1. `js/core/identity/index.js` の FNV64 を BigInt の毎文字乗算から 32bit word 演算に変更済み。UTF-16 入力、seed、32桁 digest を維持し、独立 BigInt oracle のテストがあります。
2. `js/decompiler/provenance.js` の内部 entityRefs キャッシュと数値ソート改善済み。数値・文字列混在時の従来の並び順を維持しています。
3. `98a606df7` で `jsonSafe` の通常キーを直接代入に変更済み。`key in out` の場合は従来の `Object.defineProperty` を使い、継承 setter、`__proto__`、読取専用の継承プロパティを安全に上書きします。0〜1キーの不要な sort も省いています。
   - 関連 `core:test` は統合後 PASS（3.5秒）。継承 setter と getter 順序の回帰テストを含みます。
   - 同一プロセス内の代表 AST のシリアライズ比較では短縮を観測しましたが、全 405 サンプルの改善はまだ測定していません。
   - 代表3関数の semanticAst / types / evidence / phase8 のシリアライズ出力を比較し、12組で完全一致を確認済みです。

未完の `origin.js` キャッシュ案は元環境の隔離作業場所で停止しました。
**その未検証の差分はこの ZIP に入れていません。** 以下の観測を使い、必要なら独立して実装してください。

## プロファイルから分かっていること

97621 の `x86_64.quality.loop_nested.O2` の診断プロファイルでは、self time は
jsonSafe 約778ms、deepFreeze 約293ms、GC 約247ms、stableStringify 約223ms、
`js/core/identity/origin.js` の uniqueSorted 約215ms でした。
jsonSafe のうち約242msは `origin.js → uniqueSorted → createOriginSet` 経由です。
重い診断と機能テストが同じホストで走ったため、この数字は原因調査用で、合格判定には使えません。

優先して見る場所:

- `js/core/identity/origin.js`: `mergeOriginSets`、`createOriginSet`、`createTransformRecord`、`uniqueSorted`。正規化・凍結済みの内部生成データを何度も正規化・シリアライズしていないか。
- `js/core/identity/index.js`: `jsonSafe`、`stableStringify`、`stableDigest`、`deepFreeze`。既存改善後のプロファイルで残る負荷を判断すること。
- `js/decompiler/provenance.js`: source 正規化と参照計算。ただし前述のキャッシュは既にあります。

重い代表ケース: `x86_64.quality.loop_nested.O2`、
`x86_64.quality.aggregate_array_stride.O2`、`x86_64.quality.loop_nested.O0`。

`jsonSafe` の null-prototype + prototype 復元や Object.fromEntries への単純置換では、
全体処理の明確な改善は得られませんでした。小変更を多数試すより、重複処理の除去を優先してください。

## 守る意味・互換性

- 出力、digest、ID、コーパス、unknown の扱い、適用分母、固定閾値を変えないこと。optimizer の上限は所有者承認済みの **150ms** です。30ms に戻す必要はありません。
- `Object.isFrozen` だけで外部入力を信頼しないこと。再利用するなら、内部の正規化済み・深く凍結した生成物に限ったブランド等を使ってください。
- `uniqueSorted` の localeCompare 順序、同じキーの最後の値を残す動作、入力検証を維持すること。
- ミュータブルな入力、getter、`__proto__`、継承 setter、型・数値のエラーを弱めないこと。
- 大きなハッシュ入力の省略、証拠の削除、時間予算の撤廃、処理の skip による見かけの短縮は不可です。

## 測定と確認

1. Node 22 を使い、必要なら `npm ci`。既存の凍結コーパス
   `tests/phase8/corpus/functions.json` を使ってください。測定のために `phase8:corpus` を再生成すると入力の同一性を失います。
2. まず現状を一度測定し、プロファイルに基づく変更をまとめて実装。編集ごとの全チェックは不要です。
3. 小さい対象テストと代表例の出力一致を確認。identity/origin の変更なら `npm run core:test` と変更箇所の既存テストを使います。
4. 実際の CPU 測定は、重いテストや別の CPU 測定と同時に走らせないでください。
5. 下記の正規 API を使います。測定用の別エンジン・集計ロジックは作らないでください。

以下の標準出力は JSON ファイルへ保存し、大量の生データを会話へ流さないでください。

```js
import fs from 'node:fs';
import { loadCorpus } from './tools/validation/phase8/build-corpus.mjs';
import { performanceMetrics, phase8PerformanceFailures } from './tools/validation/phase8/metrics.mjs';

const corpus = loadCorpus();
const profile = JSON.parse(fs.readFileSync('tools/validation/phase8/profile.json', 'utf8'));
const result = performanceMetrics({ repetitions: profile.performance.repetitions, corpus });
const failures = phase8PerformanceFailures(result, profile);
// result の samples、denominator、stageDenominator、runs を含む全データを保存する。
// 併せて入力 ZIP の SHA、変更差分、Node/OS、開始終了時刻、corpus/profile identity を記録する。
// 出力先はディレクトリではなく /任意の保存先/performance.json のようなファイルにする。
console.log(JSON.stringify({ profile, corpusDigest: corpus.corpusDigest, result, failures }));
```

個別のプロファイルに `decompileEntry` を使う場合も、正規の
`corpusAbiIdForEntry(corpus, entry)` を渡してください。cold は
`deterministicTransforms:false, phase8Optimize:false`、optimizer 比較は
`phase8Optimize:true`。正規測定の関数一覧を代表3件だけに置換しないでください。

全体チェックが必要な最終バッチだけ
`node scripts/run-quiet-command.mjs --label check -- npm run check` を使います。
このコマンドに npm test と benchmark:baseline が含まれるので、成功後に重複実行しないでください。
実機測定・デプロイ・main への取り込みはこのオーダーの対象外です。

## 返してほしいもの

1. 適用可能なソースとテストの patch または変更済み ZIP。
2. 何の重複処理を減らしたかと、意味を維持できる理由。
3. 同じ環境・入力での変更前後の cold / interactive / optimizer と全生サンプル。分母は 135 / 125 / 405。
4. 関連テストの結果、出力一致の確認、未達があればその値と残件。

測定できない環境では、実装・確認できた範囲と、こちらで実行する正確なコマンドを返してください。
未測定を PASS と書かず、測定不能を理由に実装まで停止しないでください。
