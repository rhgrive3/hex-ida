# hex

[![License](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-Web%20%2F%20iPad%20Safari%20%2F%20Chrome-blue.svg)]()
[![Engine](https://img.shields.io/badge/engine-C%2B%2B20%20WASM%20%2B%20JS-orange.svg)]()

**hex** は、ブラウザおよび iPad で動作するユニバーサルバイナリ解析・逆アセンブル・デコンパイルプラットフォームです。Mach-O / ELF / PE / 生バイナリのマルチアーキテクチャ解析に加え、WebAssembly / DEX / CIL / JVM のマネージドバイトコード解析、ネイティブ級の高速 C++20/WASM エンジン（`wasm/hex_engine.wasm`）、AI 支援解析、ChatGPT Userscript 連携を備えています。

バイナリ解析の本体はすべて端末内（ブラウザ Web Worker + WebAssembly）でローカル完結し、ユーザーが明示的に承認しない限りバイナリデータが外部送信されることはありません。

## 主な特徴

- **マルチアーキテクチャ & マルチフォーマット対応**
  - **ネイティブアーキテクチャ**: `arm64`（AArch64）、`arm64e`（Pointer Authentication / PAC 対応）、`x86_64`（SysV / Win64）、`riscv64`（RV64IMC / LP64 プロファイル）
  - **ネイティブバイナリ形式**: Mach-O（Fat / Thin / `MH_OBJECT` / Chained Fixups）、ELF（32/64-bit）、PE / PE32+、生バイナリ
  - **マネージド / VM フロントエンド**: WebAssembly (`wasm`)、Android Dalvik (`dex`)、.NET (`cil`)、Java (`jvm`)
  - 詳細な成熟度と制約は [`docs/SUPPORT_MATRIX.md`](docs/SUPPORT_MATRIX.md)（`js/platform/capability-maturity.js` の機械可読プロファイルから投影）を参照してください。
- **統合 C++20/WASM エンジン (`wasm/hex_engine.wasm`)**
  - Emscripten 不使用の Freestanding C++20 エンジン（62 ユニット・214 エクスポート・0 外部インポート・`bulk-memory` 対応）。
  - Identity ハッシュ、CFG / ループ解析、バイナリ画像ストア、文字列・バイト検索、SHA-256（>1 MiB ストリーミング対応）、ARM64 / x86_64 / RISC-V64 デコード、Resident IR・SSA・最適化・C コード生成、暗号・エントロピー解析、Callgraph / 行動分類、難読化解除（CFF Unflatten / MBA Simplifier）までを単一 WASM で高速実行。
  - `HEX_ENGINE=js` または `globalThis.HEX_ENGINE = 'js'` による即時 JS フォールバックに対応（[`ROLLBACK.md`](ROLLBACK.md)）。
- **iOS / Apple 高度なメタデータ・型ライブラリ・シグネチャ認識**
  - **ARM64e PAC & Objective-C / Swift 5**: PAC 命令・`LDUR`/`STUR` 認識、`objc_msgSend$` スタブ解決、ObjC / Swift ARC 畳み込みパス（`js/decompiler/apple-arc-swift-pass.js`）、`__objc_classlist`・Swift 5 メタデータスキャン。
  - **4-ABI ネイティブ WASM デマングラ**: LLVM Itanium C++ / Rust、Apple Swift 5、LLVM Microsoft MSVC デマングラを `wasm/hex_engine.wasm` に統合。
  - **TIL (Type Information Library) & HEX-SIG**: Ghidra GDT（macOS / Win32 13,176 定義等）および iOS フレームワーク TIL、Rizin sigdb / iOS Mach-O HEX-SIG による高速なライブラリ関数・型・セレクタ解決。
  - **Unity (IL2CPP) / Go / Rust / C++ RTTI**: `global-metadata.dat` 復元、C++ RTTI / vtable 抽出、Go / Rust メタデータプロバイダ。
- **洗練されたデコンパイラ & 対話型 UX**
  - **Clean View**: デコンパイラの擬似 C タブで、callee-saved レジスタの退避/復元畳み込み、連続重複する `semantic-v2` の `__asm` 行の集約、安全な不要スタックスピル除去を切り替え可能（`js/decompiler/clean-view.js`）。
  - **GraphView (CFG / Callgraph) i18n**: SVG ベースのインタラクティブな制御フローグラフ・コールグラフ（日英ローカライズ対応）。
  - **Omnibox & キャンセル可能なデコンパイル**: 厳密アドレスジャンプ・シンボル検索を備えた Omnibox と、重い関数でも UI をブロックしないキャンセル可能なデコンパイル実行。
  - **目的指向解析 (Pinpoint / Goal-Oriented Analysis)**: 証拠ベースのスコアリングにより、関心領域（数値計算・課金・通信・暗号など）の関数やフィールド候補を根拠付きで特定。
- **ARM64 エミュレータ (`MiniArm64Emu` & ブラウザ内エミュレータ)**
  - `MiniArm64Emu`（JS / C++ WASM 両対応）により、整数命令に加え **SIMD & FP（`LDR`/`STR` B/H/S/D/Q、`LDUR`/`STUR`、リテラルロード、NEON `EOR`）** や ARM64e PAC 命令を含む高速部分エミュレーション・不透明述語評価・間接分岐解決を実行。
  - 対話型ステップ実行・ブレークポイント・レジスタ/メモリ監視・バイナリパッチ出力も内蔵。
- **AI 支援解析 & Userscript / Worker 実行環境**
  - 承認ゲート付き（Evidence-backed proposal → 承認トークン → `CapabilityExecutor`）の AI アナリスト統合（`js/ai/`）。
  - ChatGPT Web 連携・iPad Safari 単一タブ同一オリジン iframe 構成に対応した Userscript（`userscript/hex.user.template.js`）と Cloudflare Worker（`worker-entry.js`）。

## クイックスタート

### 動作要件
- モダンブラウザ（Safari / iPadOS Safari, Chrome, Firefox, Edge）
- 開発・テスト実行には Node.js（ESM 対応）が必要

### ローカルでの起動

本アプリはビルド不要の静的 Web アプリケーション（HTML / CSS / ESM JS / WebAssembly）です。Web Worker と WASM の制約上、ローカル HTTP サーバー経由で開きます。

```sh
git clone https://github.com/rhgrive3/hex-ida.git
cd hex-ida

# 簡易 HTTP サーバーの起動
npx serve .
# または
python3 -m http.server 8080
```

ブラウザで `http://localhost:8080` を開くと利用できます。サンプルバイナリ生成機能により、手元にバイナリがなくてもすぐに解析を試せます。

## ディレクトリ構成

```text
.
├── index.html                  # Web アプリケーションエントリーポイント
├── worker.js / worker-entry.js # Web Worker / Cloudflare Worker エントリーポイント
├── capstone.js / capstone.wasm # Capstone 5 WebAssembly ビルド
├── css/                        # スタイルシート（テーマ・レスポンシブ・iPad 最適化）
├── cpp/
│   ├── include/                # Freestanding C++20 共通ヘッダ・ABI 定義 (`hex_abi.hpp` 等)
│   ├── src/                    # 統合 WASM エンジン実装 (core/binary/cfg/targets/semantics/decompiler/analysis/recovery)
│   └── tests/                  # ネイティブ ASan/UBSan テストスイート
├── wasm/
│   └── hex_engine.wasm         # 統合 C++20/WASM エンジン成果物
├── js/
│   ├── app.js / backend.js     # アプリ初期化・Worker ブリッジ
│   ├── core/                   # Identity・予算・証拠・`hex-engine-bridge.js`・`hex-engine-wasm.js`
│   ├── binary/                 # Mach-O / ELF / PE / Fat ローダ・文字列・マッピング
│   ├── targets/                # アーキテクチャ (ARM64/x86_64/RISC-V64)・ABI・プラットフォーム定義
│   ├── semantics/              # MachineEffects・Semantic IR・CFG・SSA・MemorySSA
│   ├── decompiler/             # デコンパイラパイプライン・Clean View・ARC/Swift パス・検証
│   ├── analysis/               # 型復元・TIL・HEX-SIG・デマングラ・エイリアス・Pinpoint・スライシング
│   ├── managed/                # マネージドフロントエンド (wasm / dex / cil / jvm)
│   ├── symbolic/               # シンボリック実行・e-graph・ソルバ抽象化・テイント解析
│   ├── runtime/ / trace/       # ランタイムプロバイダ・証拠融合・トレース
│   ├── ai/ / agent/            # AI アナリスト・承認ゲート付きツール実行・セッション管理
│   ├── auth/                   # Discord 認証・サーバー検証
│   ├── platform/               # 能力成熟度 (`capability-maturity.js`)・プラグイン API・キャッシュ
│   ├── project/ / collaboration/ # `.hexproj` 永続化・ChangeLog
│   ├── ui/                     # ルータ・パネル・GraphView・Omnibox・V6 Workbench ブリッジ
│   └── userscript/             # Userscript ホスト・ChatGPT ブリッジ
├── userscript/                 # Userscript テンプレートとリリースバージョン定義
├── scripts/                    # WASM ビルド・Userscript ビルド・TIL/SIG ハブ生成・ベンチマーク
├── tests/                      # 単体・統合・フェーズ別・ブラウザ・パフォーマンス・回帰テスト
├── tools/                      # 検証ツール・不変条件ゲート・ベンチマークハーネス
└── docs/                       # 技術仕様・アーキテクチャ・サポートマトリクス・ガードレール
```

## 開発・ビルド・テストコマンド

広範なテスト実行時は、出力を簡潔に保つため `scripts/run-quiet-command.mjs` の併用を推奨します。

```sh
# 統合フルゲート（リント・不変条件・境界・全フェーズ・回帰・ベースライン）
npm run check
# 低トークン出力ラッパー経由
node scripts/run-quiet-command.mjs --label check -- npm run check

# 並列チェック / 単一チェック実行
npm run check:parallel
npm run check:one

# 主要ドメイン別テスト
npm run lint                    # 静的構文・整合性チェック
npm test                        # コア・回帰テストチェーン
npm run binary:test             # Mach-O / ELF / PE / Fat ローダテスト
npm run semantic-v2:test        # Semantic IR v2 テスト
npm run decompiler:test         # デコンパイラテスト
npm run platform:test           # プラットフォーム・プラグイン・キャッシュテスト
npm run metadata:test           # Apple (ObjC/Swift) / Go / Rust メタデータテスト
npm run ai:test                 # AI 統合・境界・Dev Agent テスト
npm run userscript:test         # Userscript ビルド＆プロトコルテスト
npm run performance:test        # C++/WASM 差分・パリティ・パフォーマンスゲート
npm run auth:test               # 認証・Userscript 公開検証

# 能力真実性・フェーズ検証の例
NODE_OPTIONS=--experimental-global-webcrypto node --test \
  tests/phase6/foundation/capability-truth.test.mjs \
  tests/phase9/foundation/preflight.test.mjs

# 成果物ビルド
node scripts/build-wasm.mjs     # wasm/hex_engine.wasm および js/core/hex-engine-wasm.js の再ビルド
npm run userscript:build        # Userscript ローダおよび保護ランタイムのビルド
npm run hubs:build              # TIL ハブおよび Rizin HEX-SIG DB のビルド
```

## ドキュメント案内

- [`docs/README.md`](docs/README.md) — `docs/` 全体の目次・ガイド一覧
- [`docs/HEX_MASTER_ARCHITECTURE.md`](docs/HEX_MASTER_ARCHITECTURE.md) — マスターアーキテクチャ仕様と不変条件
- [`docs/SUPPORT_MATRIX.md`](docs/SUPPORT_MATRIX.md) — アーキテクチャ / フォーマット / マネージド言語の能力サポートマトリクス
- [`ABI.md`](ABI.md) — 統合 C++20/WASM エンジン C ABI 仕様
- [`ROLLBACK.md`](ROLLBACK.md) — WASM エンジン即時ロールバック手順
- [`docs/ENGINEERING_PROCESS_GUARDRAILS.md`](docs/ENGINEERING_PROCESS_GUARDRAILS.md) — 開発プロセスガードレール

## ライセンス

本プロジェクトは [MIT License](LICENSE) のもとで公開されています。同梱または利用するサードパーティ資産（Capstone、LLVM Demangle、Swift Demangle、Ghidra GDT、Rizin sigdb、BinExport2 等）のライセンスは各コンポーネントの配布条件に準拠します。
