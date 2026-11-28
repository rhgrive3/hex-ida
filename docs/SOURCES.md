# Hex Research & Technical Sources

> Durable primary-source index for the **Hex Universal Binary Analysis Platform** (`rhgrive3/hex-ida`).

## Verification metadata

- Last updated: **2026-11-28 (JST)**
- Repository: `rhgrive3/hex-ida` — https://github.com/rhgrive3/hex-ida
- Primary architecture specification: [`HEX_MASTER_ARCHITECTURE.md`](HEX_MASTER_ARCHITECTURE.md)
- Machine-readable capability truth: [`SUPPORT_MATRIX.md`](SUPPORT_MATRIX.md) (`js/platform/capability-maturity.js`)

## Source policy

Use sources in this order:

1. **Hex source code and tests** — authoritative source of truth for what Hex currently implements.
2. **Official upstream source repositories** — authoritative for open-source implementations and bundled assets.
3. **Official vendor/developer documentation** — authoritative for proprietary products, ISA/ABI specifications, and public APIs.
4. **Original papers and technical manuals** — authoritative for algorithms and architecture rationale.

Rules:
- Never use leaked or unauthorized proprietary source code.
- Never infer internal algorithms from marketing pages alone.
- Verify the exact `LICENSE` file at the pinned dependency commit/tag before importing any upstream code or data.

## 1. Hex — Repository Source of Truth

- Repository: https://github.com/rhgrive3/hex-ida
- Core JS engine & host bridge: `js/core/` (`js/core/hex-engine-bridge.js`, `js/core/hex-engine-wasm.js`)
- Unified C++20/WASM engine: `cpp/include/`, `cpp/src/`, `wasm/hex_engine.wasm` ([`../ABI.md`](../ABI.md))
- Binary loaders & mapping: `js/binary/`, `js/bytesource/`
- Architecture, ABI & semantics: `js/targets/`, `js/semantics/`, `js/ir-core.js`, `js/ir.js`
- Decompiler & Clean View: `js/decompiler/` (`pipeline-core.js`, `clean-view.js`, `apple-arc-swift-pass.js`)
- Analysis, TIL, HEX-SIG & Demangler: `js/analysis/`
- Managed / VM frontends: `js/managed/` (`wasm`, `dex`, `cil`, `jvm`)
- Symbolic & Runtime: `js/symbolic/`, `js/runtime/`, `js/runtime-evidence/`, `js/trace/`
- AI, Userscript & Auth: `js/ai/`, `js/userscript/`, `userscript/`, `js/auth/`, `worker-entry.js`
- Platform & Capability Truth: `js/platform/` (`capability-maturity.js`, `stage2-capability-maturity.js`, `plugin-api.js`)
- Third-party permissive assets: `third_party/` (`llvm-demangle`, `swift-demangle`, `ghidra-gdt`, `rizin-sigdb`, etc.)

## 2. Integrated / Permissive Upstream Assets & Toolchains

- **Capstone** (BSD): https://github.com/capstone-engine/capstone | https://www.capstone-engine.org/documentation.html
- **LLVM Project — Demangle (Itanium / Rust / Microsoft) & MC / TableGen** (Apache-2.0 WITH LLVM-exception): https://github.com/llvm/llvm-project | https://llvm.org/docs/LangRef.html
- **Apple Swift Demangling** (Apache-2.0 WITH Runtime Library Exception): https://github.com/swiftlang/swift/tree/main/lib/Demangling
- **Ghidra — SLEIGH / P-code / Decompiler / GDT Type Libraries** (Apache-2.0): https://github.com/NationalSecurityAgency/ghidra | https://ghidra.re/ghidra_docs/languages/html/sleigh.html
- **Rizin / sigdb** (LGPL/MIT per component; verify asset license): https://github.com/rizinorg/rizin | https://github.com/rizinorg/sigdb
- **Google BinExport / BinDiff** (Apache-2.0): https://github.com/google/binexport | https://github.com/google/bindiff

## 3. Reverse Engineering, Decompiler & Analysis References

- **IDA Pro / Hex-Rays** (Proprietary — public docs/SDK reference only): https://docs.hex-rays.com/ | https://docs.hex-rays.com/user-guide/types | https://docs.hex-rays.com/user-guide/signatures/flirt
- **Binary Ninja** (Proprietary — public API/docs reference only): https://docs.binary.ninja/dev/bnil-overview.html | https://docs.binary.ninja/guide/warp.html | https://github.com/Vector35/binaryninja-api
- **rev.ng** (Pipeline & model/artifact separation): https://github.com/revng/revng | https://docs.rev.ng/
- **angr** (BSD-2-Clause — symbolic state, CFG, Claripy): https://github.com/angr/angr | https://docs.angr.io/en/latest/
- **Triton** (Apache-2.0 — DSE, taint, SMT abstraction): https://github.com/JonathanSalwan/Triton | https://triton-library.github.io/
- **BAP** (MIT — architecture-independent BIL): https://github.com/BinaryAnalysisPlatform/bap
- **Miasm** (GPL-2.0 — design reference): https://github.com/cea-sec/miasm
- **radare2** (LGPL/GPL — modular IO reference): https://github.com/radareorg/radare2 | https://book.rada.re/
- **REDasm / Glass** (GPL-3.0 — mobile/native UX reference): https://github.com/REDasmOrg/REDasm | https://github.com/azw413/Glass
- **Remill / Rellic** (Lifting & structuring reference): https://github.com/lifting-bits/remill | https://github.com/lifting-bits/rellic
- **RetDec** (Historical reference): https://github.com/avast/retdec
- **Diaphora** (AGPL-3.0 — diff feature reference): https://github.com/joxeankoret/diaphora

## 4. Runtime, Emulation, Debuggers, Loaders & Managed Frontends

- **Frida Gum** (Runtime instrumentation / Interceptor / Stalker): https://github.com/frida/frida-gum | https://frida.re/docs/gum-api/
- **LLDB** (Target/Process/Thread/Platform separation): https://lldb.llvm.org/ | https://github.com/llvm/llvm-project/tree/main/lldb
- **GDB / x64dbg / WinDbg** (Debugger architecture references): https://www.sourceware.org/gdb/current/onlinedocs/ | https://github.com/x64dbg/x64dbg | https://learn.microsoft.com/en-us/windows-hardware/drivers/debugger/introduction
- **Unicorn / Qiling / QEMU TCG** (Emulation references): https://github.com/unicorn-engine/unicorn | https://github.com/qilingframework/qiling | https://www.qemu.org/docs/master/devel/tcg-ops.html
- **LIEF / Rust `object` / goblin** (Loader differential references): https://github.com/lief-project/LIEF | https://github.com/gimli-rs/object | https://github.com/m4b/goblin
- **Kaitai Struct / Construct / ImHex Pattern Language** (Declarative binary schemas): https://kaitai.io/ | https://github.com/construct/construct | https://github.com/WerWolv/PatternLanguage
- **JADX** (Apache-2.0 — DEX/APK frontend reference): https://github.com/skylot/jadx
- **ILSpy** (MIT — CIL/.NET frontend reference): https://github.com/icsharpcode/ILSpy
- **YARA-X / capa** (BSD-3-Clause / Apache-2.0 — deterministic rules & capability facts): https://github.com/VirusTotal/yara-x | https://github.com/mandiant/capa

## 5. ISA & ABI Specifications

- **Arm / AArch64 & AAPCS64**: https://developer.arm.com/architectures | https://github.com/ARM-software/abi-aa
- **RISC-V ISA & ELF psABI**: https://github.com/riscv/riscv-isa-manual | https://github.com/riscv-non-isa/riscv-elf-psabi-doc
- **x86-64 (Intel SDM / System V AMD64 / Microsoft x64)**: https://www.intel.com/content/www/us/en/developer/articles/technical/intel-sdm.html | https://gitlab.com/x86-psABIs/x86-64-ABI | https://learn.microsoft.com/en-us/cpp/build/x64-calling-convention

## 6. Design-to-Reference Mapping

| Hex design area | Primary references |
|---|---|
| Exact `MachineEffects` & ISA semantics | Ghidra SLEIGH/P-code, Arm/RISC-V/Intel ISA manuals, Remill |
| Layered Semantic IR & Decompiler | Binary Ninja BNIL, Ghidra Decompiler |
| TIL, HEX-SIG & 4-ABI Demangling | Ghidra GDT, Rizin sigdb, LLVM Demangle, Apple Swift Demangling, IDA FLIRT/TIL |
| Artifact & incremental pipelines | rev.ng, Ghidra analysis manager |
| Symbolic execution & verification | angr, Triton |
| Runtime evidence & debugger boundaries | Frida Gum, LLDB, GDB |
| Managed frontends (`wasm`, `dex`, `cil`, `jvm`) | JADX, ILSpy |
| Binary diff & capability facts | BinDiff / BinExport2, Diaphora, capa, YARA-X |
| Declarative binary patterns | ImHex Pattern Language, Kaitai Struct |

## 7. Maintenance

When updating this index, verify upstream repository URLs and license terms, keep `rhgrive3/hex-ida` paths aligned with the live repository, and prefer commit permalinks when citing exact implementation details in design documents.
