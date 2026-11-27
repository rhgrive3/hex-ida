#ifndef HEX_BINARY_IMAGE_STORE_HPP
#define HEX_BINARY_IMAGE_STORE_HPP

#include "../../include/hex_abi.hpp"
#include "../../include/hex_core/hex_core.hpp"

#ifdef __cplusplus
extern "C" {
#endif

typedef uint32_t HexImageHandle;

typedef enum HexBinaryFormat {
  HEX_FORMAT_UNKNOWN = 0,
  HEX_FORMAT_ELF = 1,
  HEX_FORMAT_MACHO = 2,
  HEX_FORMAT_PE = 3,
} HexBinaryFormat;

typedef enum HexArch {
  HEX_ARCH_UNKNOWN = 0,
  HEX_ARCH_ARM64 = 1,
  HEX_ARCH_ARM64_32 = 2,
  HEX_ARCH_X86_64 = 3,
  HEX_ARCH_X86 = 4,
  HEX_ARCH_ARM = 5,
  HEX_ARCH_RISCV64 = 6,
  HEX_ARCH_RISCV32 = 7,
  HEX_ARCH_PPC64 = 8,
  HEX_ARCH_PPC = 9,
  HEX_ARCH_MIPS64 = 10,
  HEX_ARCH_MIPS = 11,
} HexArch;

typedef enum HexEndian {
  HEX_ENDIAN_UNKNOWN = 0,
  HEX_ENDIAN_LITTLE = 1,
  HEX_ENDIAN_BIG = 2,
} HexEndian;

typedef struct HexImageInfo {
  uint32_t format;          // HexBinaryFormat
  uint32_t arch;            // HexArch
  uint32_t bits;            // 32 or 64
  uint32_t endian;          // HexEndian
  uint32_t section_count;
  uint32_t is_fat;          // 1 if Mach-O Fat container
  uint32_t fat_slice_count;
  uint32_t _pad;
  uint64_t entry_point;
  uint64_t image_base;
  uint64_t file_size;
  uint64_t slice_offset;
  uint64_t slice_size;
} HexImageInfo;

typedef struct HexSectionInfo {
  uint64_t va;
  uint64_t size;
  uint64_t file_offset;
  uint64_t file_size;
  uint32_t flags;
  uint8_t is_exec;
  uint8_t is_write;
  uint8_t is_read;
  uint8_t is_nobits;
  char name[64];
  char segname[32];
} HexSectionInfo;

HEX_WASM_EXPORT("hex_image_alloc_input")
uint8_t* hex_image_alloc_input(uint32_t bytes_len);

HEX_WASM_EXPORT("hex_image_open")
HexStatus hex_image_open(const uint8_t* data, uint32_t len, HexImageHandle* out_handle);

HEX_WASM_EXPORT("hex_image_close")
HexStatus hex_image_close(HexImageHandle handle);

HEX_WASM_EXPORT("hex_image_get_info")
HexStatus hex_image_get_info(HexImageHandle handle, HexImageInfo* out_info);

HEX_WASM_EXPORT("hex_image_section_count")
HexStatus hex_image_section_count(HexImageHandle handle, uint32_t* out_count);

HEX_WASM_EXPORT("hex_image_get_section")
HexStatus hex_image_get_section(
    HexImageHandle handle,
    uint32_t index,
    HexSectionInfo* out_sec);

HEX_WASM_EXPORT("hex_image_scratch_alloc")
uint8_t* hex_image_scratch_alloc(uint32_t bytes);

HEX_WASM_EXPORT("hex_image_scratch_reset")
void hex_image_scratch_reset(void);

#ifdef __cplusplus
}
#endif

#ifdef __cplusplus
namespace hex {
namespace binary {

void bind_global_arenas(hex::Arena* image_arena, hex::Arena* scratch_arena);

}  // namespace binary
}  // namespace hex
#endif

#endif  // HEX_BINARY_IMAGE_STORE_HPP
