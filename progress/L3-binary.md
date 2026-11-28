# L3: Binary Image Store (`cpp/src/binary/image_store`)

統合済み `wasm/hex_engine.wasm`（`scripts/build-wasm.mjs`）に組み込まれている freestanding C++20/WASM バイナリイメージストアおよびフォーマット検証器の現行仕様。

## 対象ファイル

- `cpp/src/binary/image_store.hpp`
- `cpp/src/binary/image_store.cpp`
- `cpp/tests/test_binary_native.cpp`

## 実装内容

- **世代付きハンドル & 公開 C/WASM ABI (`HEX_WASM_EXPORT`)**:
  - `cpp/include/hex_core/hex_core.hpp` のみを使用（STL・例外・RTTI 不使用）。
  - 世代付き不透明ハンドル `HexImageHandle`（slot 8bit + generation 24bit）で UAF を検出。
  - 公開 C ABI: `hex_image_alloc_input`, `hex_image_open`, `hex_image_close`, `hex_image_get_info`, `hex_image_section_count`, `hex_image_get_section`, `hex_image_scratch_alloc`, `hex_image_scratch_reset`。
  - 外部アリーナ注入フック `hex::binary::bind_global_arenas(hex::Arena* image_arena, hex::Arena* scratch_arena)` により統合ランタイムと安全に連携。
- **メモリ安全性・ゼロコピー・ラップアラウンド防御**:
  - 固定 1 MiB scratch アリーナ (`init_fixed`) により超過時は `nullptr` で fail-closed。
  - `hex_image_alloc_input(bytes_len)` による 1 MiB 超バイナリのゼロコピー投入（`ptr_in_image_arena` 判定で二重コピー回避）。
  - `range_fits_u64_closed` / `closed_intervals_overlap` で `addr + size == 2^64` ラップアラウンドを防御し、ELF `ET_REL` 合成配置のカーソル枯渇も検証。
- **フォーマット解析 & fail-closed 検証**:
  - **Mach-O (64/32/Fat 32 & 64)**: `align >= 64`、アラインメント不整合、スライスファイル範囲重複、重複 `(cputype, cpusubtype)`、外側/内側 `(cputype, cpusubtype)` 不一致をすべて `HEX_ERR_INVALID_ARG` で拒否。
  - **ELF (64/32 LE/BE)**: `SHT_NOBITS` 以外の EOF 超過・オーバーフロー検出、および `PT_LOAD` と `SHF_ALLOC` セクションのファイルオフセット整合性検証。
  - **PE (PE32 / PE32+)**: DOS/PE シグネチャ・Optional Header・セクション表の厳密境界チェック。

## 検証

- **Native テスト**: `cpp/tests/test_binary_native.cpp`（ASan + UBSan、実バイナリ 13 本の解析＋UAF 検出・破損/切り詰め・ELF EOF/PT_LOAD 不整合・Mach-O Fat 不正・`2^64` ラップアラウンド・scratch 超過・ゼロコピー投入・`bind_global_arenas`）。
- **WASM 統合ビルド**: `node scripts/build-wasm.mjs` により `wasm/hex_engine.wasm` に統合ビルドされる。
