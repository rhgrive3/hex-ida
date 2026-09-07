# Research & Inventory: Versioned Language and Runtime Metadata (HEX-C3-03)

## Ecosystem Inventory & Comparison Matrix

| Aspect | Objective-C (ObjC) | Swift | Go (Golang) | Rust |
|---|---|---|---|---|
| **Binary Sections** | `__objc_classlist`, `__objc_catlist`, `__objc_protolist`, `__objc_selrefs`, `__objc_const`, `__objc_data` | `__swift5_types`, `__swift5_protos`, `__swift5_proto`, `__swift5_fieldmd`, `__swift5_reflstr` | `.gopclntab`, `.gosymtab`, `.rodata`, `.noptrdata`, `.go.buildinfo` | `.comment`, `.note.rustc`, `.rustc`, `.symtab`, `.dynsym` |
| **Magic / Header Signatures** | Class RO pointer, Relative method list header `0x80000000` | 32-bit ContextDescriptor flags (kind: 0..18), Swift 5 ABI | pclntab magic: `0xfffffffb` (1.2), `0xfffffffa` (1.16), `0xfffffff0` (1.18), `0xfffffff1` (1.20+) | `.comment` rustc version string, mangling prefix `_R` (v0), `_ZN` (legacy) |
| **Version Detection** | ObjC 2.0 (Modern 64-bit runtime) | Swift 5.0 - 6.x ABI | Go toolchain header magic + `runtime.buildVersion` | `rustc` version from `.comment` / DWARF producer / symbol hashes |
| **Pointer Types** | 64-bit absolute, chained fixups, PAC tagged pointers | Rel32, Direct/Indirect Relative pointers (low bit tag) | 32/64-bit offsets into moduledata/pclntab tables | Standard pointers in vtables |
| **Type Layout Guarantees** | Class ivars with explicit offsets from runtime metadata | Nominal struct/class field descriptors with mangled types | Moduledata `_type`, `structType` with explicit field offsets | `repr(C)` is stable; `repr(Rust)` field order is compiler/target dependent and NOT stable |
| **Completeness Model** | List-level declared vs scanned vs parsed with IMP validation | Section-level declared vs scanned vs parsed with requirement validation | Table-level function/type counts vs parsed entries with bounds validation | Symbol count vs parsed/demangled entries with recursion bounds |
| **Fail-Closed Policy** | Unreadable slot / invalid method stride -> `complete: false`, non-authoritative | Unknown context kind > 18 or unresolved symbolic ref -> `complete: false` | Unrecognized pclntab magic -> `verdict: 'unsupported'`, no guessed layout | Unstable `repr(Rust)` struct -> soft evidence only, never hard type layout |
| **Downstream Wiring** | `resolveObjcIMP`, `objcMessage`, `TypeConstraintGraph` | `resolveSwiftDispatch`, `swiftCallingConvention`, `TypeConstraintGraph` | Function discovery (`functionCandidates`), symbol table, `TypeConstraintGraph` | Symbol display, trait/vtable discovery, `TypeConstraintGraph` |
