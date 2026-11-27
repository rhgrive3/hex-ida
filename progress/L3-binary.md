# L3-binary 永続再構築 進捗報告

## 対象ファイル
- `cpp/src/binary/image_store.hpp`
- `cpp/src/binary/image_store.cpp`
- `cpp/tests/test_binary_native.cpp`
- `progress/L3-binary.md`

## 実装サマリ（過去レビュー全修正を初期完備）
1. **Freestanding C++20/WASM & 公開 C ABI (`HEX_WASM_EXPORT`)**:
   - `cpp/include/hex_core/hex_core.hpp` のみを使用（`std::unordered_map`・例外・RTTI 不使用）。
   - 世代付き不透明ハンドル `HexImageHandle`（slot 8bit + generation 24bit）で UAF を検出。
   - 公開 C ABI: `hex_image_alloc_input`, `hex_image_open`, `hex_image_close`, `hex_image_get_info`, `hex_image_section_count`, `hex_image_get_section`, `hex_image_scratch_alloc`, `hex_image_scratch_reset`。
   - 外部アリーナ注入フック `hex::binary::bind_global_arenas(hex::Arena* image_arena, hex::Arena* scratch_arena)` を実装し、外部バインド後は `ensure_arenas()` が再初期化しないよう隔離。
2. **メモリ安全性・ゼロコピー・ラップアラウンド防御**:
   - 固定 1 MiB scratch アリーナ (`init_fixed`) で超過時は `nullptr`（fail-closed）とし、隣接する image アリーナへの侵食を根絶。
   - `hex_image_alloc_input(bytes_len)` による 1 MiB 超バイナリのゼロコピー投入を実装（`ptr_in_image_arena` 判定により二重コピー回避）。
   - `range_fits_u64_closed` / `closed_intervals_overlap` により `addr + size == 2^64` のラップアラウンドを完全に防御し、ELF `ET_REL` 合成配置のカーソル枯渇も検証。
3. **フォーマット解析 & fail-closed 検証**:
   - **Mach-O (64/32/Fat 32 & 64)**: `align >= 64`、アラインメント不整合、スライスファイル範囲重複、重複 `(cputype, cpusubtype)`、外側/内側 `(cputype, cpusubtype)` 不一致をすべて fail-closed (`HEX_ERR_INVALID_ARG`)。
   - **ELF (64/32 LE/BE)**: `SHT_NOBITS` 以外の EOF 超過・オーバーフロー検出、および `PT_LOAD` と `SHF_ALLOC` セクションのファイルオフセット整合性を検証。
   - **PE (PE32 / PE32+)**: DOS/PE シグネチャ・Optional Header・セクション表の厳密境界チェック。

## 検証結果
- **Native ASan + UBSan (`-std=c++20 -O2 -g -fsanitize=address,undefined -Wall -Wextra -Werror`)**: **ALL PASS**
  - リポジトリ実バイナリ 13 本（ELF 8 本 / Mach-O 2 本 / PE 3 本）のフォーマット・アーキテクチャ・ビット幅・エンディアン・セクション抽出＋クローズ後 UAF 検出 PASS
  - 破損/切り詰め・ELF EOF 超過・ELF `PT_LOAD` 不整合・Mach-O Fat 不正（6 パターン）・`2^64` ラップアラウンド・固定 scratch 超過・1.5 MiB ゼロコピー投入・`bind_global_arenas` すべて PASS
- **wasm32 ビルド (`clang++ --target=wasm32 -std=c++20 -O3 -nostdlib -fno-exceptions -fno-rtti -mbulk-memory -Wall -Wextra -Werror -Wl,--no-entry`)**: **警告 0 PASS**（15,738 bytes、全 8 公開関数 + `memory` エクスポート確認済）
