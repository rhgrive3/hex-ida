# Universal Binary Foundation

Last updated: 2026-11-28

> **Current platform architecture:** [`universal-platform.md`](universal-platform.md)  
> **Current capability truth:** [`SUPPORT_MATRIX.md`](SUPPORT_MATRIX.md)

The format-neutral binary loader (`js/binary/`) and platform layer (`js/platform/`) are integrated into the production boundary for **Mach-O** (including `MH_OBJECT` and fat/universal images), **dyld shared cache** (including slide info v2/v5), **ELF32/ELF64**, and **PE32/PE32+** (including delay imports, base relocations, and `.pdata`/exception function seeds).

Across architectures, **ARM64 / ARM64e**, **x86-64**, and **RISC-V64** all have implemented Semantic IR, CFG, SSA, MemorySSA, and shared decompiler pipelines. Exact cumulative maturity grades per target and format are tracked authoritatively in [`SUPPORT_MATRIX.md`](SUPPORT_MATRIX.md) and `js/platform/capability-maturity.js`.

Refer to [`universal-platform.md`](universal-platform.md) for current I/O, memory policy, progressive analysis, caching, `.hexproj`, binary diff, Knowledge DB, and Plugin API contracts.
