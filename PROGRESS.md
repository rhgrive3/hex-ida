# Hex-IDA 現在の開発進捗・到達ステータス（2026-11-28）

本ドキュメントは、過去のフェーズ別作業ログではなく、**2026-11-28 時点の `main` / 最新コードベースにおける稼働状態と到達点**のみを記録します。能力の正確な機械可読定義は `js/platform/capability-maturity.js` および [`docs/SUPPORT_MATRIX.md`](docs/SUPPORT_MATRIX.md) を参照してください。

## 1. 統合 C++20/WASM エンジン (`wasm/hex_engine.wasm`)

- **成果物**: `wasm/hex_engine.wasm`（1,129,165 bytes）および Base64 埋め込みラッパー `js/core/hex-engine-wasm.js`
- **ビルド構成**: Freestanding C++20（62 ユニット・214 エクスポート・0 外部インポート・初期線形メモリ 9.3125 MiB [149 pages]・Emscripten 不使用）
- **ABI バージョン**: `0x00010000`（[`ABI.md`](ABI.md)）
- **ロールバック**: `HEX_ENGINE=js` / `globalThis.HEX_ENGINE = 'js'` / `{ _engine: 'js' }` で即時 JS フォールバック可能（[`ROLLBACK.md`](ROLLBACK.md)）

## 2. アーキテクチャ・フォーマット・マネージド対応状況

| 領域 | 実装済み範囲 | 備考 |
|---|---|---|
| ネイティブアーキテクチャ | `arm64`, `arm64e`, `x86_64`, `riscv64`（RV64IMC/LP64） | いずれも実装深度 A6、累積成熟度 A1（全 ISA 網羅の Exact MachineEffects 未完のため保守的評価） |
| ネイティブフォーマット | Mach-O（Fat/Thin/`MH_OBJECT`/Chained Fixups）, ELF, PE/PE32+, Raw | 累積成熟度 F2、実装深度 Mach-O F5 / ELF F4 / PE F4 |
| マネージド / VM | `wasm`, `dex`, `cil`, `jvm` | 累積成熟度・実装深度とも M5（M6 ランタイムデバッグは未接続） |

## 3. 主要機能・最新到達点

- **iOS / Apple & Beyond-IDA 機能群**:
  - **ARM64e PAC & `LDUR`/`STUR` 対応**: PAC 命令デコード・エミュレーション・ObjC エミッタ対応。
  - **ObjC / Swift 5 解析**: `objc_msgSend$` 解決、ObjC / Swift ARC 畳み込みパス（`js/decompiler/apple-arc-swift-pass.js`）、`__objc_classlist` / Swift 5 メタデータスキャン。
  - **4-ABI ネイティブ WASM デマングラ**: LLVM Itanium C++ / Rust、Apple Swift 5、LLVM Microsoft MSVC デマングラを `wasm/hex_engine.wasm` に統合。
  - **TIL & HEX-SIG**: Ghidra GDT（macOS / Win32 13,176 定義）および iOS フレームワーク TIL、Rizin sigdb / iOS ARM64・ARM64e Mach-O HEX-SIG（6,022 シグネチャ）を統合。
  - **V6 Workbench 配線**: `js/ui/v6-workbench-bridge.js` を通じて UI と統合。
- **デコンパイラ & UX**:
  - **Clean View**: callee-saved 退避/復元畳み込み、連続重複 `semantic-v2` `__asm` 行の集約、安全な不要スタックスピル除去（`js/decompiler/clean-view.js`）。
  - **GraphView i18n**: CFG / Callgraph の日英ローカライズ対応。
  - **Omnibox & キャンセル可能なデコンパイル**: 厳密アドレスジャンプおよび長時間デコンパイルの中断制御。
  - **高速化**: >1 MiB SHA-256 ストリーミング、ARM64 `MOVZ`/`MOVK` 畳み込み・不要 FP 同期除去、`MH_OBJECT` 関数復元（`0x0` 含む）。
- **MiniArm64Emu**:
  - 整数命令・ARM64e PAC に加え、**SIMD & FP（`LDR`/`STR` B/H/S/D/Q、`LDUR`/`STUR`、リテラルロード、NEON `EOR`）** をサポート。
- **AI・Userscript・認証**:
  - 承認ゲート付き AI ツール実行・Dev Supervisor（iPad Safari 単一タブ同一オリジン iframe 構成）。
  - Userscript ビルド（`npm run userscript:build`）と Discord 認証（Cloudflare Worker `worker-entry.js` + D1）。

## 4. 現行検証ゲート

- 統合フルゲート: `node scripts/run-quiet-command.mjs --label check -- npm run check`
- 能力真実性・事前検証: `NODE_OPTIONS=--experimental-global-webcrypto node --test tests/phase6/foundation/capability-truth.test.mjs tests/phase9/foundation/preflight.test.mjs`
- C++/WASM 差分・パリティ: `npm run performance:test`
- Userscript / 認証: `npm run userscript:test` / `npm run auth:test`
