#ifndef HEX_CFG_ENGINE_HPP
#define HEX_CFG_ENGINE_HPP

#include "../../include/hex_abi.hpp"
#include "../../include/hex_core/hex_core.hpp"

#ifdef __cplusplus
extern "C" {
#endif

typedef struct HexCfgResult {
  uint8_t* reachable_mask;      // [n]
  int32_t* reach_order;         // [reach_count] (exact JS DFS visit order)
  uint32_t reach_count;
  int32_t* idom;                // [n]
  int32_t* dom_tin;             // [n]
  int32_t* dom_tout;            // [n]
  int32_t* dom_depth;           // [n]
  int32_t* component_of;        // [n]
  uint32_t num_components;
  int32_t* pdom_idom;           // [n + 1] (index n is synthetic EXIT)
  int32_t* pdom_tin;            // [n + 1]
  int32_t* pdom_tout;           // [n + 1]
  int32_t* pdom_depth;          // [n + 1]
  uint8_t* pdom_reachable_mask; // [n + 1]
  uint8_t* non_term_mask;       // [n]
} HexCfgResult;

// Core freestanding C++20 CFG analyzer (used directly by native tests, loop_engine, resident_ir, and WASM ABI).
HexStatus hex_cfg_analyze_arena(
    hex::Arena& arena,
    uint32_t n,
    const uint32_t* succ_off,        // [n + 1]
    const int32_t* succ_dst,         // [succ_off[n]]
    int32_t entry,
    const uint8_t* terminating_mask, // [n] or nullptr
    HexCfgResult* out);

#if defined(__wasm__)
HEX_WASM_EXPORT("get_heap_base")
uint32_t get_heap_base(void);
HEX_WASM_EXPORT("cfg_reset")
void cfg_reset(void);
HEX_WASM_EXPORT("cfg_alloc")
uint32_t cfg_alloc(uint32_t bytes);
HEX_WASM_EXPORT("cfg_analyze")
uint32_t cfg_analyze(
    uint32_t n,
    uint32_t succ_off_ptr,
    uint32_t succ_dst_ptr,
    int32_t entry,
    uint32_t terminating_mask_ptr);
HEX_WASM_EXPORT("cfg_get_result_ptr")
uint32_t cfg_get_result_ptr(uint32_t field_id);
#endif

#ifdef __cplusplus
}
#endif

#endif  // HEX_CFG_ENGINE_HPP
