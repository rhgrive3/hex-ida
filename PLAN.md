# PLAN: Hex-IDA C++20/WASM 統合エンジン移行計画

## 1. 実バイナリ V8 CPU プロファイル結果（移行優先度の根拠）

6 本の ARM64 実バイナリ（26 関数・合計 **113,114 サンプル**）に対する V8 CPU プロファイル計測結果は以下の通り：

| ホットスポット領域 | サンプル占有率 | 主なボトルネック | 移行方針 |
|---|---:|---|---|
| `js/core/identity/` | **50.0%** | `stableStringify` / FNV-1a 64-bit / 構造ダイジェスト生成 | **最優先 WASM 化** (`identity_engine`) |
| `js/decompiler/` | **21.8%** | SSA 最適化反復・制御構造化・C コード生成 | **WASM 化** (`ir_optimizer`, `c_emitter`) |
| `js/semantics/` | **21.5%** | IR/SSA 構築・支配木／支配境界・Def-Use チェーン | **WASM 化** (`resident_ir`) |
| V8 GC | **8.3%** | 短命 JS オブジェクト・Map/Set・BigInt 大量割当 | **3-Arena + POD SoA/CSR で抜本削減** |
| `js/targets/` | **2.4%** | 命令デコード・分類・ビット操作 | **WASM 化** (`arm64_decode`, `x86_64_decode`) |
| `js/analysis/` | **1.7%** | セマンティック関数オーケストレーション | Host 層（JS ファサード＋境界ブリッジ） |
| `js/controlflow.js` | **0.5%** | Lengauer-Tarjan 支配木・Tarjan SCC・自然ループ検出 | **WASM 化** (`cfg_engine`, `loop_engine`) |
| `js/binary/` | **0.4%** | ELF/Mach-O/PE パーサ・セクション索引 | **WASM 化** (`image_store`) |

## 2. アーキテクチャ設計

### 2.1 3-Arena メモリ分離設計
WASM 線形メモリを責務・寿命の異なる 3 つの独立 Arena に分離し、動的 `malloc`/`free` と GC を完全排除する：
1. **Scratch Arena (`init_fixed`)**: 単一 API 呼び出し内の一時作業領域。`ArenaScope`（RAII）と `hex_scratch_reset()` で O(1) 回収。隣接 Arena への越境を防ぐため `memory.grow` 禁止の固定境界で運用。
2. **Persistent Binary Arena (`init_fixed`, 2 MiB)**: バイナリバイト列および `ImageStore` のセクションメタデータを保持。
3. **Persistent Resident IR Arena (`init_external`, growable)**: `IrStore`（最大 256 スロット・世代タグ付きハンドル）の常駐 IR / CFG / SSA / Def-Use CSR を保持。`memory.grow` 発生時は ABI 契約に基づき JS 側で毎 WASM 呼び出し後に `DataView`/`TypedArray` ビューを再取得する。

### 2.2 Host 層境界とフォールバック設計
- **Host ブリッジ**: `js/core/hex-engine-bridge.js`（ルーティング・機能ゲート・出力整合）、`js/core/hex-engine-wasm.js`（単一統合 WASM ローダ＋`bulk-memory` 検証）、`js/core/wasm-telemetry.js`（モジュール別呼び出し回数・フォールバック理由集計）。
- **モード切替**: `opts._engine` > `globalThis.HEX_ENGINE` > `process.env.HEX_ENGINE` > `'auto'`（`'wasm' | 'js' | 'auto'`）。
- **フォールバック原則（サイレントフォールバック禁止）**:
  - すべての JS フォールバック経路で構造化理由コード（`decompile:wasm_disabled`, `UNSUPPORTED_PIPELINE:*`, `UNSUPPORTED_ARCH:*`, `decompile:unsupported_insn:*`, `UNSUPPORTED_OPTION:*`, `UNSUPPORTED_MULTI_BLOCK`, `WASM_UNSUPPORTED`, `WASM_STATUS_*`, `WASM_EXCEPTION`）を `recordFallback(...)` に必ず記録する。
  - 厳密ゲート（`hex_arm64_is_decompiler_supported`, `hex_x86_64_is_decompiler_supported`）により、未対応命令（例: ARM64 `ORR imm`/`FMOV imm`/`MOVK`/`MNEG`/`SMULL`/`RETAA`、x86_64 `LOCK`/`REP`/トランケート命令）は必ず JS へ安全にフォールバックさせる。

### 2.3 未検証アーキテクチャの扱い
- **`riscv64` および `arm64e`**: 独立した実バイナリフィクスチャがリポジトリ未収載のため、WASM デコンパイル対象外とし、明示的な理由コード（`UNSUPPORTED_ARCH:riscv64`, `UNSUPPORTED_ARCH:arm64e` 等）を記録して JS パスへフォールバックする。

## 3. Wave 0〜6 段階的実装計画

- **Wave 0（基盤・ゴールデン・マニフェスト）**: `hex_core`（`Arena`, `Vec`, `OrderedMap`, `StringView`, `js_compat`, `stable_sort`）、`hex_abi.hpp`（`HEX_WASM_EXPORT`）、19 バイナリ（実 13 + 破損 6）ゴールデンフィクスチャ、`MANIFEST.json`。
- **Wave 1（コアエンジン群）**: `identity_engine`, `cfg_engine`, `loop_engine`, `image_store`, `arm64_decode`, `resident_ir` の独立 freestanding C++20/WASM 実装と ASan/UBSan ネイティブ検証。
- **Wave 2（デコンパイラ最適化・C 生成・統合ランタイム）**: `ir_optimizer`（定数畳み込み・コピー伝播・DCE の不動点反復）、`c_emitter`（制御構造化・`break`/`continue`/`goto` 遷移元ソースマップ・`HEX_EMIT_decompile:wasm_disabled_PARITY`）、`engine_runtime`（3-Arena 統合垂直パイプライン）。
- **Wave 3（単一統合 WASM ビルド & JS ブリッジ接続）**: `scripts/build-wasm.mjs` による `js/core/hex-engine-wasm.js (Base64-embedded hex_engine.wasm)` 生成と `js/core/hex-engine-bridge.js` 接続。
- **Wave 4（E2E 差分検証 & 独立レビュー修正ループ）**: 13 実バイナリ + 6 破損バイナリの JS vs WASM E2E 差分テスト（`e2e-decompile-differential.test.mjs`）、`extractSourceMap` 非空検証、命令ゲート厳格化、ロールバック検証。
- **Wave 5（x86_64 デコーダ & パリティ検証）**: `x86_64_decode`（命令長・主要命令デコーダ・命令クラス対応表）実装と実 x86_64 バイナリ 3 本（76 命令）＋トランケート境界テスト。
- **Wave 6（リリースゲート・ファズ堅牢性・ドキュメント整備）**: 2,785+ バイナリファズ＋5,000 ランダム関数ファズ、全テストスイート・最終ベンチマーク・5観点独立レビューによる出荷判定。
