# cxx-dwarf-holdout

Minimal ARM64 C++ ELF holdout fixture for verifying C++ object layout and field-offset recovery on stripped binaries.

## Committed files

- `holdout.cpp` — defines `Base` and `Thing : Base` with virtual methods (`update`, `interact`) and C entry wrappers (`read_fields`, `virtual_call`).
- `abi-stubs.s` — minimal Itanium C++ ABI vtable stubs (`_ZTVN10__cxxabiv117__class_type_infoE`, `_ZTVN10__cxxabiv120__si_class_type_infoE`).
- `holdout.stripped.elf` — built with Clang 18 (`--target=aarch64-linux-gnu`) and `ld.lld`, then stripped. GNU Build ID: `2039dc2893f9ba576230576928b4621211e985b6`.

## Ground-truth layout

- `Thing` field offsets (from the matched DWARF build):
  - `0`: `_vptr$Base`
  - `8`: `Base::health` (`int`)
  - `12`: `Thing::power` (`int`)
  - `16`: `Thing::ratio` (`float`)
- `_ZNK5Thing6updateEi` executes `ldp w8, w9, [x0, #8]`, so its two recovered member loads must resolve to offsets `8` (`Base::health`) and `12` (`Thing::power`).
