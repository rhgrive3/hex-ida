#ifndef HEX_LOOP_ENGINE_HPP
#define HEX_LOOP_ENGINE_HPP

#include "../../include/hex_abi.hpp"
#include "cfg_engine.hpp"

#ifdef __cplusplus
extern "C" {
#endif

typedef enum HexLoopStopReason {
  HEX_LOOP_STOP_NONE = 0,
  HEX_LOOP_STOP_WALK_BUDGET = 1,
  HEX_LOOP_STOP_MEMBERSHIP_BUDGET = 2,
} HexLoopStopReason;

typedef struct HexLoopBudget {
  uint32_t max_loop_memberships;  // 0 => default (1048576)
  uint32_t max_loop_walk_steps;   // 0 => default (4194304)
} HexLoopBudget;

typedef enum HexLoopFieldId {
  HEX_LOOP_FIELD_NUM_BACK_EDGES = 0,
  HEX_LOOP_FIELD_BACK_EDGE_FROM = 1,
  HEX_LOOP_FIELD_BACK_EDGE_TO = 2,
  HEX_LOOP_FIELD_NUM_LOOPS = 3,
  HEX_LOOP_FIELD_LOOP_HEADER = 4,
  HEX_LOOP_FIELD_LOOP_PARENT = 5,
  HEX_LOOP_FIELD_LOOP_NEST_DEPTH = 6,
  HEX_LOOP_FIELD_LOOP_LATCH_OFF = 7,
  HEX_LOOP_FIELD_LOOP_LATCH_NODES = 8,
  HEX_LOOP_FIELD_LOOP_NODE_OFF = 9,
  HEX_LOOP_FIELD_LOOP_BODY_NODES = 10,
  HEX_LOOP_FIELD_LOOP_EXIT_OFF = 11,
  HEX_LOOP_FIELD_LOOP_EXIT_NODES = 12,
  HEX_LOOP_FIELD_NODE_LOOP_DEPTH = 13,
  HEX_LOOP_FIELD_NODE_INNERMOST_LOOP = 14,
  HEX_LOOP_FIELD_HEADER_TO_LOOP = 15,
  HEX_LOOP_FIELD_COMPLETE = 16,
  HEX_LOOP_FIELD_STOP_REASON = 17,
  HEX_LOOP_FIELD_RETAINED_MEMBERSHIPS = 18,
  HEX_LOOP_FIELD_WALK_STEPS = 19,
  // Connected CFG fields
  HEX_LOOP_FIELD_CFG_REACHABLE_MASK = 20,
  HEX_LOOP_FIELD_CFG_REACH_ORDER = 21,
  HEX_LOOP_FIELD_CFG_REACH_COUNT = 22,
  HEX_LOOP_FIELD_CFG_IDOM = 23,
  HEX_LOOP_FIELD_CFG_COMPONENT_OF = 24,
  HEX_LOOP_FIELD_CFG_NUM_COMPONENTS = 25,
  HEX_LOOP_FIELD_CFG_PDOM_IDOM = 26,
} HexLoopFieldId;

typedef struct HexLoopResult {
  HexCfgResult cfg;

  uint32_t num_back_edges;
  int32_t* back_edge_from;       // [num_back_edges]
  int32_t* back_edge_to;         // [num_back_edges]

  uint32_t num_loops;
  int32_t* loop_header;          // [num_loops]
  int32_t* loop_parent;          // [num_loops] (-1 if top-level)
  int32_t* loop_nest_depth;      // [num_loops] (1-based; 1 = top-level)

  uint32_t* loop_latch_off;      // [num_loops + 1]
  int32_t* loop_latch_nodes;     // [loop_latch_off[num_loops]]

  uint32_t* loop_node_off;       // [num_loops + 1]
  int32_t* loop_body_nodes;      // [loop_node_off[num_loops]]

  uint32_t* loop_exit_off;       // [num_loops + 1]
  int32_t* loop_exit_nodes;      // [loop_exit_off[num_loops]]

  int32_t* node_loop_depth;      // [n] (0 if not in any loop)
  int32_t* node_innermost_loop;  // [n] (-1 if not in any loop)
  int32_t* header_to_loop;       // [n] (loop index if header, else -1)

  uint8_t complete;              // 1 if loop analysis completed within budget
  uint8_t stop_reason;           // HexLoopStopReason
  uint32_t retained_memberships;
  uint32_t walk_steps;
} HexLoopResult;

// Core freestanding C++20 natural loop analyzer (connects to hex_cfg_analyze_arena).
HexStatus hex_loop_analyze_arena(
    hex::Arena& arena,
    uint32_t n,
    const uint32_t* succ_off,         // [n + 1]
    const int32_t* succ_dst,          // [succ_off[n]]
    int32_t entry,
    const uint8_t* terminating_mask,  // [n] or nullptr
    const HexLoopBudget* budget,      // nullptr => JS default budgets
    HexLoopResult* out);

// Public C / WASM ABI.
HEX_WASM_EXPORT("hex_loop_reset")
void hex_loop_reset(void);
HEX_WASM_EXPORT("hex_loop_alloc")
uint32_t hex_loop_alloc(uint32_t bytes);
HEX_WASM_EXPORT("hex_loop_analyze")
uint32_t hex_loop_analyze(
    uint32_t n,
    uint32_t succ_off_ptr,
    uint32_t succ_dst_ptr,
    int32_t entry,
    uint32_t terminating_mask_ptr,
    uint32_t max_loop_memberships,
    uint32_t max_loop_walk_steps);
HEX_WASM_EXPORT("hex_loop_get_ptr")
uint32_t hex_loop_get_ptr(uint32_t field_id);

#ifdef __cplusplus
}
#endif

#endif  // HEX_LOOP_ENGINE_HPP
