# Universal Binary Platform

Last updated: 2026-11-28

## Scope

The universal binary platform layer (`js/binary/`, `js/platform/`) owns format-neutral binary I/O, container metadata, architecture capability detection, `.hexproj` persistence, binary diffing, local knowledge storage, and iPad-safe memory management independently from Semantic IR, decompilation, and Objective-C/Swift recovery.

## File-Open Pipeline

Browser files enter through a single format-neutral facade:

`File/Blob -> ByteSource -> CachedByteSource -> detectBinary -> format engine -> capability -> Backend`

- `js/platform/worker.js` owns `ByteSource`-backed format detection.
- ELF and PE continue through `openBinarySource -> BinaryImage`; ARM64 ELF/PE regions are registered into `js/worker.js` so disassembly, search, and scans operate without assuming Mach-O.
- Mach-O is detected through the same `ByteSource` stage and handed to the multi-slice compatibility parser without constructing a duplicate universal `BinaryImage` graph at startup, preserving chained fixups, function starts (`LC_FUNCTION_STARTS`), `MH_OBJECT` function recovery (including `0x0`), and selector metadata while respecting iPad memory limits.
- Node CLI and benchmark tools use `NodeFileByteSource` over the same `js/binary/*` core.

## Supported Container Formats (`js/binary/`)

- **Mach-O 32/64 & Universal/Fat (`macho.js`, `macho-core.js`, `macho-dyld.js`, `macho-fat.js`)**: Multi-slice images, `MH_OBJECT` relocatable objects, chained fixups (including ARM64e PAC pointer formats), `LC_FUNCTION_STARTS`, indirect symbols, TLV initializers, and `LC_CODE_SIGNATURE` metadata.
- **dyld shared cache (`dyld-shared-cache.js`, `dyld-shared-cache-core.js`, `dyld-shared-cache-slide-v5.js`)**: Mapping tables and slide info decoding (including v2 and v5).
- **ELF32/ELF64 (`elf.js`, `elf-core.js`, `elf-dynamic.js`, `elf-unwind.js`, `elf-gnu-property.js`)**: Including sectionless and stripped images, dynamic imports/exports, relocations, unwind-derived function seeds, GNU property notes (PAC/BTI/GCS), and executable mappings.
- **PE32/PE32+ (`pe.js`, `pe-loader.js`, `pe-chpe.js`, `pe-armnt-exception.js`, `pe-safeseh.js`)**: Imports/exports, delay imports, base relocations, `.pdata`/exception-directory function seeds, CHPE/SafeSEH metadata, and executable mappings.

Malformed range arithmetic is rejected before allocation. Source reads use `BigInt` offsets and bounded `Number` lengths.

## Architecture Capability

- `js/architecture/index.js` defines the platform-facing architecture boundary (instruction alignment/size, control-flow, call, and return categories). ARM64 is fixed-width; x86-64 and RISC-V64 (with C extension) are variable-width.
- `js/platform/capstone-probe-worker.js` probes the deployed Capstone runtime; `Backend.disassembleAt()` provides range disassembly for neutral ranges when supported.
- ARM64/ARM64e, x86-64, and RISC-V64 all have implemented Semantic IR, CFG, SSA, MemorySSA, and shared decompiler verticals. Authoritative capability maturity grades are maintained in [`SUPPORT_MATRIX.md`](SUPPORT_MATRIX.md), `js/platform/capability-maturity.js`, and `js/platform/stage2-capability-maturity.js`.

## Memory & Streaming Policy (iPad / WebKit)

- Browser `File`/`Blob` inputs are never copied into a single whole-file `ArrayBuffer` by the platform path.
- Content hashing (`js/platform/hash.js` / WASM SHA-256 streaming for `> 1 MiB` inputs) is lazy and streaming, not a prerequisite for header/section display.
- Runtime byte pages use a bounded LRU (`CachedByteSource`) with `Transferable` `ArrayBuffer` chunks.
- ELF/PE metadata parsing enforces bounded source-range budgets and adaptive prefetching.
- Stale UI epochs reject late worker results; file changes cancel in-flight worker requests; hidden-page cleanup drops queued chunks and caches.
- `Backend.memoryStats()` exposes cached bytes/chunks, indexed functions, and estimated memory.

## Progressive Analysis & Caching

- The neutral ELF/PE worker emits `analysisProgress` phases (`header`, `sections`, `symbols/imports`, `deferred strings`, `functions`, `deferred expensive analysis`) via `Backend.onAnalysisProgress`, with paged `binaryMetadata(kind, start, limit)` fetches.
- `AnalysisCache` stores only schema-versioned derived products (format metadata, function seeds, string indexes, imports, analysis summaries) keyed by streaming content hash; raw binary bytes are never cached.

## `.hexproj`, Binary Diff, Knowledge DB & Plugin API

- **`.hexproj` (v1, `application/vnd.hex.project+json`)**: Tagged-`BigInt` JSON storing binary hash/metadata, names, comments, types, structs, bookmarks, patches, confirmed findings, agent answers, evidence, settings, cache references, and navigation state without embedding binary bytes.
- **Binary Diff**: Relocation-normalized byte/shape/IR/string/import/call fingerprints with sparse-token one-to-one matching (`identical`, `moved`, `slightly changed`, `new`, `deleted`).
- **Knowledge DB & Vendor Hints**: Local IndexedDB (or in-memory test backend) `FunctionKnowledge` storage with ambiguity-window reidentification; vendor/SDK fingerprinting (Firebase, Unity, IL2CPP, libSystem, Foundation, Swift runtime, etc.) is strictly evidence-only.
- **Plugin API (`js/platform/plugin-api.js`)**: Supports `registerFormat`, `registerArchitecture`, `registerAnalyzer`, `registerKnowledgeProvider`, `registerSignatureProvider`, `registerRecognitionProvider`, `registerViewContribution`, and `registerGoalProvider` (plus `registerPlugin` manifest registration) over a narrow frozen host context with per-contribution exception isolation.

## Remaining Platform Limits

- Variable-length architecture product/viewer integration remains less uniform than ARM64's fixed-width path.
- Semantic IR v2 compatibility is the production default behind `js/ir-core.js`; the primary remaining semantic limit is complete exact MachineEffects coverage across all ISA contracts rather than missing IR/dataflow pipelines.
- Universal Mach-O UI intentionally retains the multi-slice compatibility parser so iPad memory budgets are not doubled by a second full metadata graph.
