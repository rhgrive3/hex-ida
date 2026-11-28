# Phase 5 x86-64 compiler corpus

`manifest.json` (`schemaVersion: "phase5-x86-corpus/v1"`) pins the Phase 5 x86-64 semantic corpus contract:

- **24 mandatory semantic categories** (scalar integer arithmetic, signed/unsigned comparison, conditional branches, loops, switch-like control flow, stack locals/spills, pointer load/store, array indexing, struct fields, direct/indirect calls, multiple arguments, return values, partial-width ops, zero/sign extension, shifts, mul/div, RIP-relative/PIC globals, scalar FP, baseline SIMD, atomic RMW, SysV AMD64 ABI, Microsoft x64 ABI, and variadic ABI edges).
- **3 optimization levels**: `O0`, `O2`, `Os`.
- **2 mandatory targets**: `sysv-amd64-elf` (`x86_64-unknown-linux-gnu`, ELF) and `microsoft-x64-pe` (`x86_64-pc-windows-msvc`, PE).
- **Committed seed source and binaries**: `source/vertical-seed.c` compiled with Ubuntu Clang 18.1.3 / Ubuntu LLD 18.1.3 into `fixtures/vertical-sysv-amd64.elf` (entry `0x401000`, 77 bytes) and `fixtures/vertical-microsoft-x64.exe` (entry `0x140001000`, 84 bytes).

## Verification

```sh
npm run phase5:test
```

CI consumes the committed binaries directly without downloading compiler artifacts. Semantic checks validate structured effects and decompiler meaning rather than pretty-printed pseudocode alone. When regenerating fixtures from the repository root, use the exact Clang/LLD identity and flags recorded in `manifest.json` without weakening or removing existing entries.
