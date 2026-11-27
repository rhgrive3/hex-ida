#ifndef HEX_DEMANGLE_HPP
#define HEX_DEMANGLE_HPP

#include <stdint.h>
#include "hex_abi.hpp"

#ifdef __cplusplus
extern "C" {
#endif

// Demangler symbol kind codes returned by hex_demangle_detect_kind()
enum HexDemangleKind {
  HEX_DEMANGLE_NONE        = 0u,
  HEX_DEMANGLE_ITANIUM_CPP = 1u,
  HEX_DEMANGLE_RUST_V0     = 2u,
  HEX_DEMANGLE_RUST_LEGACY = 3u,
  HEX_DEMANGLE_SWIFT       = 4u,
  HEX_DEMANGLE_MSVC_CPP    = 5u,
};

// Dedicated fixed I/O buffers (isolated from shared engine scratch / type arena)
HEX_WASM_EXPORT("hex_demangle_in_buf_ptr")
uint8_t* hex_demangle_in_buf_ptr(void);

HEX_WASM_EXPORT("hex_demangle_in_buf_cap")
uint32_t hex_demangle_in_buf_cap(void);

HEX_WASM_EXPORT("hex_demangle_out_buf_ptr")
uint8_t* hex_demangle_out_buf_ptr(void);

HEX_WASM_EXPORT("hex_demangle_out_buf_cap")
uint32_t hex_demangle_out_buf_cap(void);

HEX_WASM_EXPORT("hex_demangle_out_len_ptr")
uint32_t* hex_demangle_out_len_ptr(void);

// Detect mangling scheme without allocating or mutating state.
// Returns HexDemangleKind (0=none, 1=itanium_cpp, 2=rust_v0, 3=rust_legacy, 4=swift).
HEX_WASM_EXPORT("hex_demangle_detect_kind")
uint32_t hex_demangle_detect_kind(const uint8_t* in_ptr, uint32_t in_len);

// Demangle a C++ Itanium, Rust v0, Rust legacy, or Swift symbol into out_ptr[0..out_cap).
// Guarantees NUL termination (out_ptr[*out_len] == '\0') whenever out_cap >= 1.
// Returns:
//   HEX_OK (0)                on success (*out_len set to written UTF-8 byte length)
//   HEX_ERR_INVALID_ARG (1)   on invalid/unrecognized/malformed input or null pointers
//   HEX_ERR_OOM (2)           on output buffer truncation (writes <= out_cap-1 + NUL) or arena OOM
//   HEX_ERR_RESOURCE_LIMIT(3) on excessive input length or nesting/substitution depth
HEX_WASM_EXPORT("hex_demangle_symbol")
int32_t hex_demangle_symbol(
    const uint8_t* in_ptr,
    uint32_t in_len,
    uint8_t* out_ptr,
    uint32_t out_cap,
    uint32_t* out_len);

#ifdef __cplusplus
}  // extern "C"
#endif

#endif  // HEX_DEMANGLE_HPP
