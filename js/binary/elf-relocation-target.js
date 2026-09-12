const EM_X86_64 = 62;
const EM_AARCH64 = 183;

// x86-64 psABI relocation storage widths in bytes. A zero width denotes a
// relocation with no storage field. Relocations whose field is `wordclass`
// are kept separate because x86-64 ILP32 uses 4-byte words while LP64 uses
// 8-byte words. Missing entries are intentionally not guessed.
const X86_64_RELOCATION_FIELD_BYTES = new Map([
  [0, 0n], // R_X86_64_NONE
  [1, 8n], // R_X86_64_64
  [2, 4n], // R_X86_64_PC32
  [3, 4n], // R_X86_64_GOT32
  [4, 4n], // R_X86_64_PLT32
  [5, 0n], // R_X86_64_COPY
  [9, 4n], // R_X86_64_GOTPCREL
  [10, 4n], // R_X86_64_32
  [11, 4n], // R_X86_64_32S
  [12, 2n], // R_X86_64_16
  [13, 2n], // R_X86_64_PC16
  [14, 1n], // R_X86_64_8
  [15, 1n], // R_X86_64_PC8
  [16, 8n], // R_X86_64_DTPMOD64
  [17, 8n], // R_X86_64_DTPOFF64
  [18, 8n], // R_X86_64_TPOFF64
  [19, 4n], // R_X86_64_TLSGD
  [20, 4n], // R_X86_64_TLSLD
  [21, 4n], // R_X86_64_DTPOFF32
  [22, 4n], // R_X86_64_GOTTPOFF
  [23, 4n], // R_X86_64_TPOFF32
  [24, 8n], // R_X86_64_PC64
  [25, 8n], // R_X86_64_GOTOFF64
  [26, 4n], // R_X86_64_GOTPC32
  [27, 8n], // R_X86_64_GOT64
  [28, 8n], // R_X86_64_GOTPCREL64
  [29, 8n], // R_X86_64_GOTPC64
  [30, 8n], // R_X86_64_GOTPLT64
  [31, 8n], // R_X86_64_PLTOFF64
  [32, 4n], // R_X86_64_SIZE32
  [33, 8n], // R_X86_64_SIZE64
  [34, 4n], // R_X86_64_GOTPC32_TLSDESC
  [35, 0n], // R_X86_64_TLSDESC_CALL
  [36, 16n], // R_X86_64_TLSDESC (pair of word64 fields)
  [38, 8n], // R_X86_64_RELATIVE64
  [41, 4n], // R_X86_64_GOTPCRELX
  [42, 4n], // R_X86_64_REX_GOTPCRELX
  [43, 4n], // R_X86_64_CODE_4_GOTPCRELX
  [44, 4n], // R_X86_64_CODE_4_GOTTPOFF
  [45, 4n], // R_X86_64_CODE_4_GOTPC32_TLSDESC
  [46, 4n], // R_X86_64_CODE_5_GOTPCRELX
  [47, 4n], // R_X86_64_CODE_5_GOTTPOFF
  [48, 4n], // R_X86_64_CODE_5_GOTPC32_TLSDESC
  [49, 4n], // R_X86_64_CODE_6_GOTPCRELX
  [50, 4n], // R_X86_64_CODE_6_GOTTPOFF
  [51, 4n], // R_X86_64_CODE_6_GOTPC32_TLSDESC
]);

// AArch64 AAELF64 relocation storage widths in bytes. Instruction relocations
// occupy one 32-bit A64 instruction. Null/relaxation-only relocations have no
// storage field. COPY is size-dependent, so this helper deliberately records
// zero rather than inventing a fixed width. Unallocated/reserved codes are not
// present and therefore fail closed for this recognized machine.
const AARCH64_RELOCATION_FIELD_BYTES = new Map([
  [0, 0n], [256, 0n], // R_AARCH64_NONE (both encodings are specified)
  [257, 8n], [258, 4n], [259, 2n], // ABS64/32/16
  [260, 8n], [261, 4n], [262, 2n], // PREL64/32/16
  ...Array.from({ length: 18 }, (_, i) => [263 + i, 4n]), // 263..280
  ...Array.from({ length: 12 }, (_, i) => [282 + i, 4n]), // 282..293; 281 reserved
  [299, 4n],
  ...Array.from({ length: 7 }, (_, i) => [300 + i, 4n]),
  [307, 8n], // GOTREL64
  [308, 4n], // GOTREL32
  ...Array.from({ length: 9 }, (_, i) => [309 + i, i === 8 ? 8n : 4n]), // 309..317; FUNCINIT64 is 8
  ...Array.from({ length: 48 }, (_, i) => [512 + i, 4n]), // TLS static instruction relocations 512..559
  ...Array.from({ length: 7 }, (_, i) => [560 + i, 4n]), // TLSDESC instruction relocations
  [567, 0n], [568, 0n], [569, 0n], // relaxation-only markers
  [570, 4n], [571, 4n], [572, 4n], [573, 4n],
  [580, 8n], // AUTH_ABS64
  ...Array.from({ length: 17 }, (_, i) => [581 + i, 4n]),
  [598, 0n], // AUTH_TLSDESC_CALL relaxation marker
  [1024, 0n], // COPY: width is symbol st_size, not a type-fixed field
  [1025, 8n], [1026, 8n], [1027, 8n], [1028, 8n], [1029, 8n], [1030, 8n],
  [1031, 16n], // TLSDESC is a consecutive pair of pointer-sized values
  [1032, 8n],
  [1041, 8n], [1042, 8n], [1043, 16n], [1044, 8n],
]);
const X86_64_WORDCLASS_RELOCATIONS = new Set([
  6, // R_X86_64_GLOB_DAT
  7, // R_X86_64_JUMP_SLOT
  8, // R_X86_64_RELATIVE
  37, // R_X86_64_IRELATIVE
]);

export function relocationFieldWidth(machine, type, bits) {
  if (machine === EM_X86_64) {
    if (X86_64_WORDCLASS_RELOCATIONS.has(type)) return BigInt(bits === 64 ? 8 : 4);
    return X86_64_RELOCATION_FIELD_BYTES.has(type)
      ? X86_64_RELOCATION_FIELD_BYTES.get(type)
      : null;
  }
  if (machine === EM_AARCH64) {
    // AAELF64 and the beta ELF32/P32 ABI use different relocation code spaces.
    // This table is intentionally ELF64-only; preserve the prior no-authority
    // behavior for P32 rather than misclassifying its valid codes as reserved.
    if (bits !== 64) return undefined;
    return AARCH64_RELOCATION_FIELD_BYTES.has(type)
      ? AARCH64_RELOCATION_FIELD_BYTES.get(type)
      : null;
  }
  return undefined;
}
