# PLAN: Hex-IDA C++20/WASM 統合エンジン設計・運用方針

## 1. 設計方針

Hex-IDA は、ブラウザおよび iPad Safari 上でネイティブ解析ツールに匹敵する速度と決定性（determinism）を両立するため、高負荷な解析ホットパスを **Freestanding C++20/WASM 統合エンジン (`wasm/hex_engine.wasm`)** に集約し、JavaScript Host 層と厳格な境界で分離している。

### 移行済み・稼働中の主要ドメイン
| ドメイン | C++20/WASM モジュール (`cpp/src/`) | 役割 |
|---|---|---|
| Core | `core/{identity_engine,byte_search,sha256}.cpp` | FNV-1a 64-bit・構造ダイジェスト・マスク付きバイト検索・SHA-256（>1 MiB ストリーミング対応） |
| Binary | `binary/{image_store,string_scanner,elf_symbols,crypto_entropy_scanner}.cpp` | バイナリ画像ストア・UTF-8/16 文字列スキャン・ELF シンボル抽出・暗号定数/エントロピー検出 |
| Targets | `targets/{arm64,x86_64,riscv64}_decode.cpp`, `targets/x86_64_{decomp,semantic_emit}.cpp` | ARM64/ARM64e・x86_64・RISC-V64 デコード、x86_64 デコンパイル・セマンティック出力 |
| CFG & Semantics | `cfg/{cfg_engine,loop_engine,cff_unflatten}.cpp`, `semantics/resident_ir.cpp` | 支配木・SCC・ループ解析・CFF 平坦化解除・Resident IR/SSA |
| Decompiler | `decompiler/{ir_optimizer,c_emitter,region_decomp,stack_web,asm_island,typed_emit_ctx,mba_simplifier}.cpp`, `decompiler/passes/*.cpp` | IR 最適化・制御構造化・C 生成・ARM64 専用パス群（ObjC / PAC / フレーム / FP・Atomic 等）・MBA 簡約 |
| Analysis & v6 | `analysis/{type_arena,til_engine,hexsig_engine,sig_prop_wasm,mini_arm64_emu,deobf_eval_arm64,objc_swift_metadata_scanner,vtable_rtti_scanner,llvm_demangle_wasm,swift_demangle_wasm,msvc_demangle_wasm,...}.cpp` | 型アリーナ・TIL・HEX-SIG・4-ABI デマングラ・MiniArm64Emu（SIMD&FP / PAC）・ObjC/Swift5・RTTI/vtable・行動分類 |
| Manual Recovery | `recovery/{manual_segment_map,func_chunk_cfg,custom_abi_spec}.cpp` | 手動セグメント配置・関数チャンク CFG 結合・カスタム ABI / スタック上書き / シフトポインタ |

## 2. メモリ分離と Host 層境界

### 固定境界 Arena 設計
- 動的 `malloc`/`free`・C++ 例外・RTTI・Emscripten グルーを一切使わず、固定境界の独立 Arena（`g_image_arena`, `g_ir_arena`, `g_scratch_arena`, `g_emit_arena` および `TypeArena`・`Recovery`・`Deobf`・`Demangle` 向け専用領域）で運用する。
- `g_scratch_arena` は RAII（`ArenaScope`）と `hex_engine_scratch_reset()` で O(1) 回収し、`g_emit_arena` と物理分離することで出力バッファ破壊を防ぐ。

### Host 境界と Fail-Closed フォールバック
- **境界**: `js/ui/`, `js/ai/`, `js/auth/`, `js/userscript/` は内部エンジンモジュールを直接 import せず、`js/core/hex-engine-bridge.js` および `js/core/hex-engine-wasm.js` を経由する（`npm run module-boundaries:test` で強制）。
- **モード解決優先順位**: `opts._engine` > `globalThis.HEX_ENGINE` > `process.env.HEX_ENGINE` > `'auto'`（`'wasm' | 'js' | 'auto'`）。
- **サイレントフォールバック禁止**: すべての JS フォールバック経路で `js/core/wasm-telemetry.js` の `recordFallback(...)` に構造化理由コードを記録する。

## 3. 今後の重点改善テーマ

1. **Exact MachineEffects 網羅率の継続拡大**: ARM64 / ARM64e / x86_64 / RISC-V64 における未対応命令・拡張命令（RISC-V A/F/D/V 等）の正確なセマンティックカバレッジ拡充（`docs/SUPPORT_MATRIX.md` と同期）。
2. **デコンパイラ可読性と Clean View の深化**: ObjC / Swift 5 ARC 畳み込み・callee-saved 畳み込み・型伝播精度のさらなる向上（completeness と provenance を犠牲にしない範囲）。
3. **iOS / Safari 制約下での低メモリ・高応答性維持**: 初期線形メモリ（現在 9.3125 MiB）とピークヒープの抑制、キャンセル可能な解析パイプラインの徹底。
4. **ネイティブ ASan/UBSan と JS/WASM 差分テストの継続**: すべての C++ 変更に対しネイティブ ASan/UBSan テストおよび Node 差分テストで 0-diff・0-UB を維持する。
