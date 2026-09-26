# cxx-dwarf-holdout

Tiny ARM64 C++ fixture with a matched debug build (the debug file is kept in the
campaign evidence store, not here). `holdout.cpp` + `abi-stubs.s` were built with
clang 18 `--target=aarch64-linux-gnu` and ld.lld, then stripped. Build ID
`2039dc2893f9ba576230576928b4621211e985b6`.

DWARF truth for `Thing`: `_vptr$Base` at 0, `Base::health` at 8, `Thing::power`
at 12, `Thing::ratio` at 16. `_ZNK5Thing6updateEi` is `ldp w8, w9, [x0, #8]`,
so its two loads must be at offsets 8 and 12.
