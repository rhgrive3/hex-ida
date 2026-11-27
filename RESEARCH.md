# RESEARCH: Freestanding C++20/WASM 採用根拠と技術調査

## 1. ツールチェーン選定: Emscripten 不使用・Freestanding C++20 + Raw C ABI

本プロジェクト（Hex-IDA ブラウザ内逆アセンブラ／デコンパイラ）の WASM エンジン移行では、Emscripten SDK を使わず **LLVM `clang++ --target=wasm32 -std=c++20 -O3 -nostdlib -fno-exceptions -fno-rtti -mbulk-memory -Wl,--no-entry`** と Binaryen **`wasm-opt -O3 --enable-bulk-memory`**、および **`extern "C"` + `HEX_WASM_EXPORT` による raw C ABI** を採用した。

### 採用理由
1. **ランタイムオーバーヘッドとバンドル肥大化の回避**:
   - Emscripten の標準グルー（`embind` / `cwrap` / 仮想 FS / `libc` / `libcxx`）は、単なる純粋計算モジュールに対してもランタイム初期化コストと JS グルーサイズを増大させる。
   - Freestanding C++20（`hex_core` 自作コンテナ `Arena` / `Vec` / `OrderedMap` / `StringView` / `stable_sort`）により、動的ヒープ（`malloc`/`free`）・C++ 例外・RTTI・WASI インポートへの依存をゼロ化し、単一統合 `.wasm` をコンパクトかつ決定的（deterministic）に維持できる。
2. **JS ⇄ WASM 境界往復の最小化とメモリ所有権の明確化**:
   - `ccall`/`cwrap` や `embind` による細粒度オブジェクト変換は境界コストが高く、V8 GC を圧迫する。
   - 3-Arena 設計（Scratch / Binary / Resident IR）とフラットな POD 構造体・CSR 配列による raw C ABI を用いることで、命令バッチデコードや IR 構築・最適化・C 生成を 1 ライフサイクル内で完結させ、`memory.grow` 後の `DataView`/`TypedArray` 再取得ルールを明確に強制できる。
3. **ブラウザ互換性とデバッグ容易性**:
   - `bulk-memory`（`memory.copy` / `memory.fill`）のみを必須とし、未対応環境では `WebAssembly.validate` で即座に検出して JS へフォールバックする。
   - ネイティブ側で同一 C++20 ソースを `clang++ -fsanitize=address,undefined` で直接コンパイル・ファズ検証できるため、WASM 特有の線形メモリ破壊や未定義動作をネイティブテスト段階で完全に潰せる。

## 2. 検証済み一次ソース

- Emscripten ChangeLog（LLVM バックエンド移行・ランタイム構成変遷）:
  - https://github.com/emscripten-core/emscripten/blob/main/ChangeLog.md
- Emscripten JS/C++ 相互運用ドキュメント（`ccall`/`cwrap`・線形メモリ直接アクセスのトレードオフ）:
  - https://emscripten.org/docs/porting/connecting_cpp_and_javascript/Interacting-with-code.html
- Emscripten SIMD ドキュメント（WASM SIMD128 の適用条件と制約）:
  - https://emscripten.org/docs/porting/simd.html
- WebAssembly メモリデバッグガイド（ASan/UBSan 併用と線形メモリ境界検証）:
  - https://web.dev/articles/webassembly-memory-debugging
- V8 公式ブログ: Emscripten と LLVM WebAssembly バックエンド（`clang --target=wasm32` + `wasm-opt` パイプライン）:
  - https://v8.dev/blog/emscripten-llvm-wasm
- radare2 WASM 移植事例（ブラウザ内バイナリ解析ツールの WASM 化アプローチ）:
  - https://github.com/radareorg/r2wasm
- Cloudflare Blog: Workflow Diagrams（ブラウザ内グラフ解析・構造化描画アーキテクチャ）:
  - https://blog.cloudflare.com/workflow-diagrams/
- Archbird（ブラウザベースのバイナリ／アーキテクチャ解析事例）:
  - https://archbird.org/
