# RESEARCH: Freestanding C++20/WASM 採用根拠と技術調査

## 1. ツールチェーン選定: Emscripten 不使用・Freestanding C++20 + Raw C ABI

Hex-IDA の統合 WASM エンジン (`wasm/hex_engine.wasm`) では、Emscripten SDK を使わず **LLVM `clang++ --target=wasm32 -std=c++20 -O3 -nostdlib -fno-exceptions -fno-rtti -mbulk-memory -Wl,--no-entry`** と Binaryen **`wasm-opt -O3 --enable-bulk-memory`**、および **`extern "C"` + `HEX_WASM_EXPORT` による raw C ABI** を採用している（ビルドスクリプト: `scripts/build-wasm.mjs`）。

### 採用理由

1. **ランタイムオーバーヘッドと外部インポートの排除**
   - Emscripten の標準グルー（`embind` / `cwrap` / 仮想 FS / `libc` / `libcxx`）は初期化コストとバンドルサイズを増大させ、Web Worker や Userscript の保護ランタイムに不要な依存を持ち込む。
   - Freestanding C++20（`cpp/include/hex_core/` の自作 `Arena` / `Vec` / `OrderedMap` / `StringView` / `stable_sort`）により、動的ヒープ・C++ 例外・RTTI・外部インポート（0 imports）を完全に排除し、決定的な単一 `.wasm`（61 ユニット [本体 58 + デマングラ 3]・214 エクスポート・1,129,165 bytes）として配信できる。
   - LLVM Itanium/Rust/MSVC Demangle や Apple Swift 5 Demangle のような大規模上流 C++ コードも、最小の freestanding スタブヘッダと `-Os` / `-ffunction-sections` / `--gc-sections` により外部ランタイムなしで統合できる。
2. **JS ⇄ WASM 境界往復の最小化とメモリ所有権の明確化**
   - 細粒度オブジェクト変換による V8 GC 圧迫を避け、物理分離された固定容量 Arena（Image / IR / Scratch / Emit 等）とフラットな POD 構造体・CSR 配列でデータをやり取りする。
   - `bulk-memory`（`memory.copy` / `memory.fill`）のみを必須機能とし、未対応環境では `WebAssembly.validate` で即座に検出して構造化テレメトリ付きで JS へフォールバックする。
3. **ネイティブ ASan/UBSan による厳格な安全性検証**
   - 同一の C++20 ソースをホスト上で `clang++ -fsanitize=address,undefined` で直接コンパイル・ファズ検証（`cpp/tests/`）できるため、線形メモリ境界外アクセスや未定義動作をブラウザ実行前に確実に検出できる。

## 2. 一次参考ソース

- **Emscripten ChangeLog**（LLVM バックエンド移行・ランタイム構成）: https://github.com/emscripten-core/emscripten/blob/main/ChangeLog.md
- **Emscripten JS/C++ 相互運用ドキュメント**（線形メモリ直接アクセスのトレードオフ）: https://emscripten.org/docs/porting/connecting_cpp_and_javascript/Interacting-with-code.html
- **Emscripten SIMD ドキュメント**（WASM SIMD128 の適用条件と制約）: https://emscripten.org/docs/porting/simd.html
- **WebAssembly メモリデバッグガイド**（ASan/UBSan 併用と線形メモリ境界検証）: https://web.dev/articles/webassembly-memory-debugging
- **V8 公式ブログ: Emscripten と LLVM WebAssembly バックエンド**: https://v8.dev/blog/emscripten-llvm-wasm
- **LLVM Demangle**（Itanium / Rust / Microsoft デマングラ上流）: https://github.com/llvm/llvm-project/tree/main/llvm/lib/Demangle
- **Apple Swift Demangling**（Swift 5 デマングラ上流）: https://github.com/swiftlang/swift/tree/main/lib/Demangling
- **radare2 WASM 移植事例**: https://github.com/radareorg/r2wasm
- **Cloudflare Blog: Workflow Diagrams**（ブラウザ内グラフ解析・構造化描画）: https://blog.cloudflare.com/workflow-diagrams/
- **Archbird**（ブラウザベース解析事例）: https://archbird.org/
