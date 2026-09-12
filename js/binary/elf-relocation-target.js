const EM_X86_64 = 62;

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
const X86_64_WORDCLASS_RELOCATIONS = new Set([
  6, // R_X86_64_GLOB_DAT
  7, // R_X86_64_JUMP_SLOT
  8, // R_X86_64_RELATIVE
  37, // R_X86_64_IRELATIVE
]);

export function relocationFieldWidth(machine, type, bits) {
  if (machine !== EM_X86_64) return undefined;
  if (X86_64_WORDCLASS_RELOCATIONS.has(type)) return BigInt(bits === 64 ? 8 : 4);
  return X86_64_RELOCATION_FIELD_BYTES.has(type)
    ? X86_64_RELOCATION_FIELD_BYTES.get(type)
    : null;
}
