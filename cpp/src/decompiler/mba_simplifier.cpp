#include "hex_deobf.hpp"

namespace {

static constexpr uint32_t kMaxMbaNodes = 64u;
static constexpr uint32_t kMaxVars = 3u;
static constexpr uint32_t kRandSamples = 256u;
static constexpr int64_t kInt64Min = static_cast<int64_t>(0x8000000000000000ULL);

inline uint64_t mask_width(uint64_t v, bool is32) {
  return is32 ? (v & 0xFFFFFFFFULL) : v;
}

// 3-color DFS validation (0=unvisited, 1=visiting, 2=done).
// Strictly detects cycles, out-of-range indices, invalid ops/vars, and depth overflow,
// and computes the exact unique reachable node count.
bool validate_dfs(
    const HexMbaNode* nodes, uint32_t count, uint32_t idx, uint32_t depth,
    uint8_t color[kMaxMbaNodes], uint32_t& unique_count, uint32_t& var_mask,
    bool& has_width32, bool& has_width64) {
  if (idx >= count || depth > kMaxMbaNodes) return false;
  if (color[idx] == 1u) return false;  // Cycle detected
  if (color[idx] == 2u) return true;   // Already validated (shared DAG node)

  color[idx] = 1u;
  ++unique_count;

  const HexMbaNode& n = nodes[idx];
  if ((n.flags & HEX_MBA_FLAG_WIDTH32) != 0u) has_width32 = true;
  else has_width64 = true;

  bool ok = false;
  switch (n.op) {
    case HEX_MBA_VAR:
      if (n.lhs < kMaxVars) {
        var_mask |= (1u << n.lhs);
        ok = true;
      }
      break;
    case HEX_MBA_CONST:
      ok = true;
      break;
    case HEX_MBA_NEG:
    case HEX_MBA_NOT:
    case HEX_MBA_MUL_CONST:
      ok = validate_dfs(nodes, count, n.lhs, depth + 1u, color, unique_count, var_mask,
                        has_width32, has_width64);
      break;
    case HEX_MBA_ADD:
    case HEX_MBA_SUB:
    case HEX_MBA_AND:
    case HEX_MBA_OR:
    case HEX_MBA_XOR:
      ok = validate_dfs(nodes, count, n.lhs, depth + 1u, color, unique_count, var_mask,
                        has_width32, has_width64) &&
           validate_dfs(nodes, count, n.rhs, depth + 1u, color, unique_count, var_mask,
                        has_width32, has_width64);
      break;
    default:
      ok = false;
      break;
  }

  if (!ok) return false;
  color[idx] = 2u;
  return true;
}

bool validate_and_analyze_dag(
    const HexMbaNode* nodes, uint32_t count, uint32_t root_idx,
    uint32_t& unique_count, uint32_t& var_mask, bool& has_width32, bool& has_width64) {
  if (nodes == nullptr || count == 0u || count > kMaxMbaNodes || root_idx >= count) {
    return false;
  }
  uint8_t color[kMaxMbaNodes];
  for (uint32_t i = 0u; i < count; ++i) color[i] = 0u;
  unique_count = 0u;
  var_mask = 0u;
  has_width32 = false;
  has_width64 = false;
  return validate_dfs(nodes, count, root_idx, 0u, color, unique_count, var_mask, has_width32,
                      has_width64);
}

// O(N) memoized DAG evaluation to prevent exponential blowup on shared DAGs.
uint64_t eval_memo_rec(
    const HexMbaNode* nodes, uint32_t count, uint32_t idx,
    uint64_t x, uint64_t y, uint64_t z,
    uint64_t memo[kMaxMbaNodes], uint8_t done[kMaxMbaNodes]) {
  if (idx >= count) return 0ULL;
  if (done[idx] == 2u) return memo[idx];
  if (done[idx] == 1u) return 0ULL;  // Defensive cycle guard

  done[idx] = 1u;
  const HexMbaNode& n = nodes[idx];
  const bool is32 = (n.flags & HEX_MBA_FLAG_WIDTH32) != 0u;
  uint64_t res = 0ULL;

  switch (n.op) {
    case HEX_MBA_VAR: {
      if (n.lhs == 0u) res = x;
      else if (n.lhs == 1u) res = y;
      else if (n.lhs == 2u) res = z;
      else res = 0ULL;
      break;
    }
    case HEX_MBA_CONST:
      res = static_cast<uint64_t>(n.imm);
      break;
    case HEX_MBA_ADD: {
      const uint64_t a = eval_memo_rec(nodes, count, n.lhs, x, y, z, memo, done);
      const uint64_t b = eval_memo_rec(nodes, count, n.rhs, x, y, z, memo, done);
      res = a + b;
      break;
    }
    case HEX_MBA_SUB: {
      const uint64_t a = eval_memo_rec(nodes, count, n.lhs, x, y, z, memo, done);
      const uint64_t b = eval_memo_rec(nodes, count, n.rhs, x, y, z, memo, done);
      res = a - b;
      break;
    }
    case HEX_MBA_NEG: {
      const uint64_t a = eval_memo_rec(nodes, count, n.lhs, x, y, z, memo, done);
      res = 0ULL - a;
      break;
    }
    case HEX_MBA_NOT: {
      const uint64_t a = eval_memo_rec(nodes, count, n.lhs, x, y, z, memo, done);
      res = ~a;
      break;
    }
    case HEX_MBA_AND: {
      const uint64_t a = eval_memo_rec(nodes, count, n.lhs, x, y, z, memo, done);
      const uint64_t b = eval_memo_rec(nodes, count, n.rhs, x, y, z, memo, done);
      res = a & b;
      break;
    }
    case HEX_MBA_OR: {
      const uint64_t a = eval_memo_rec(nodes, count, n.lhs, x, y, z, memo, done);
      const uint64_t b = eval_memo_rec(nodes, count, n.rhs, x, y, z, memo, done);
      res = a | b;
      break;
    }
    case HEX_MBA_XOR: {
      const uint64_t a = eval_memo_rec(nodes, count, n.lhs, x, y, z, memo, done);
      const uint64_t b = eval_memo_rec(nodes, count, n.rhs, x, y, z, memo, done);
      res = a ^ b;
      break;
    }
    case HEX_MBA_MUL_CONST: {
      const uint64_t a = eval_memo_rec(nodes, count, n.lhs, x, y, z, memo, done);
      res = a * static_cast<uint64_t>(n.imm);
      break;
    }
    default:
      res = 0ULL;
      break;
  }

  res = mask_width(res, is32);
  memo[idx] = res;
  done[idx] = 2u;
  return res;
}

uint64_t eval_dag_memo(
    const HexMbaNode* nodes, uint32_t count, uint32_t root_idx,
    uint64_t x, uint64_t y, uint64_t z) {
  if (nodes == nullptr || count == 0u || count > kMaxMbaNodes || root_idx >= count) {
    return 0ULL;
  }
  uint64_t memo[kMaxMbaNodes];
  uint8_t done[kMaxMbaNodes];
  for (uint32_t i = 0u; i < count; ++i) done[i] = 0u;
  return eval_memo_rec(nodes, count, root_idx, x, y, z, memo, done);
}

// Deterministic SplitMix64 generator for Layer 3 verification.
inline uint64_t splitmix64_next(uint64_t& state) {
  state += 0x9E3779B97F4A7C15ULL;
  uint64_t z = state;
  z = (z ^ (z >> 30)) * 0xBF58476D1CE4E5B9ULL;
  z = (z ^ (z >> 27)) * 0x94D049BB133111EBULL;
  return z ^ (z >> 31);
}

// 3-Layer Equivalence Proof (clean first-principles implementation):
//   Layer 1: Exact truth-table check on all 2^k corners {0, 1}^k
//   Layer 2: Full basis check across 8-bit carry/nibble vectors and 64-bit bit-plane vectors
//   Layer 3: Deterministic SplitMix64 64-bit vector fuzzing (256 vectors)
void run_3layer_proof(
    const HexMbaNode* orig, uint32_t orig_count, uint32_t orig_root,
    const HexMbaNode* cand, uint32_t cand_count, uint32_t cand_root,
    uint32_t num_vars, HexMbaProofResult* proof) {
  if (num_vars > kMaxVars) num_vars = kMaxVars;

  // Layer 1: Exact 2^k truth-table check on {0, 1}^k corners.
  bool l1_ok = true;
  const uint32_t corners = 1u << num_vars;
  for (uint32_t mask = 0u; mask < corners; ++mask) {
    const uint64_t vx = (mask & 1u) ? 1ULL : 0ULL;
    const uint64_t vy = (mask & 2u) ? 1ULL : 0ULL;
    const uint64_t vz = (mask & 4u) ? 1ULL : 0ULL;
    const uint64_t vo = eval_dag_memo(orig, orig_count, orig_root, vx, vy, vz);
    const uint64_t vc = eval_dag_memo(cand, cand_count, cand_root, vx, vy, vz);
    if (vo != vc) {
      l1_ok = false;
      break;
    }
  }

  // Layer 2: Full affine/carry basis check across 8-bit and 64-bit bit-planes.
  static constexpr uint64_t kBasis8[8] = {
      0x00ULL, 0x01ULL, 0x02ULL, 0x03ULL, 0x0FULL, 0x33ULL, 0x55ULL, 0xFFULL,
  };
  static constexpr uint64_t kBasis64[6] = {
      0x0000000000000000ULL, 0x0000000000000001ULL, 0x5555555555555555ULL,
      0xAAAAAAAAAAAAAAAAULL, 0x7FFFFFFFFFFFFFFFULL, 0xFFFFFFFFFFFFFFFFULL,
  };

  bool l2_ok = true;
  if (num_vars <= 1u) {
    for (uint32_t x8 = 0u; x8 < 256u; ++x8) {
      if (eval_dag_memo(orig, orig_count, orig_root, x8, 0ULL, 0ULL) !=
          eval_dag_memo(cand, cand_count, cand_root, x8, 0ULL, 0ULL)) {
        l2_ok = false;
        break;
      }
    }
    for (uint32_t i = 0u; l2_ok && i < 6u; ++i) {
      if (eval_dag_memo(orig, orig_count, orig_root, kBasis64[i], 0ULL, 0ULL) !=
          eval_dag_memo(cand, cand_count, cand_root, kBasis64[i], 0ULL, 0ULL)) {
        l2_ok = false;
      }
    }
  } else if (num_vars == 2u) {
    for (uint32_t i = 0u; l2_ok && i < 8u; ++i) {
      for (uint32_t j = 0u; l2_ok && j < 8u; ++j) {
        if (eval_dag_memo(orig, orig_count, orig_root, kBasis8[i], kBasis8[j], 0ULL) !=
            eval_dag_memo(cand, cand_count, cand_root, kBasis8[i], kBasis8[j], 0ULL)) {
          l2_ok = false;
        }
      }
    }
    for (uint32_t i = 0u; l2_ok && i < 6u; ++i) {
      for (uint32_t j = 0u; l2_ok && j < 6u; ++j) {
        if (eval_dag_memo(orig, orig_count, orig_root, kBasis64[i], kBasis64[j], 0ULL) !=
            eval_dag_memo(cand, cand_count, cand_root, kBasis64[i], kBasis64[j], 0ULL)) {
          l2_ok = false;
        }
      }
    }
  } else {
    for (uint32_t i = 0u; l2_ok && i < 8u; ++i) {
      for (uint32_t j = 0u; l2_ok && j < 8u; ++j) {
        for (uint32_t k = 0u; l2_ok && k < 8u; ++k) {
          if (eval_dag_memo(orig, orig_count, orig_root, kBasis8[i], kBasis8[j], kBasis8[k]) !=
              eval_dag_memo(cand, cand_count, cand_root, kBasis8[i], kBasis8[j], kBasis8[k])) {
            l2_ok = false;
          }
        }
      }
    }
    for (uint32_t i = 0u; l2_ok && i < 6u; ++i) {
      for (uint32_t j = 0u; l2_ok && j < 6u; ++j) {
        for (uint32_t k = 0u; l2_ok && k < 6u; ++k) {
          if (eval_dag_memo(orig, orig_count, orig_root, kBasis64[i], kBasis64[j], kBasis64[k]) !=
              eval_dag_memo(cand, cand_count, cand_root, kBasis64[i], kBasis64[j], kBasis64[k])) {
            l2_ok = false;
          }
        }
      }
    }
  }

  // Layer 3: Deterministic SplitMix64 64-bit fuzz check.
  bool l3_ok = true;
  uint64_t rng = 0x243F6A8885A308D3ULL;
  for (uint32_t s = 0u; s < kRandSamples; ++s) {
    const uint64_t vx = splitmix64_next(rng);
    const uint64_t vy = splitmix64_next(rng);
    const uint64_t vz = splitmix64_next(rng);
    if (eval_dag_memo(orig, orig_count, orig_root, vx, vy, vz) !=
        eval_dag_memo(cand, cand_count, cand_root, vx, vy, vz)) {
      l3_ok = false;
      break;
    }
  }

  proof->layer1_tt_ok = l1_ok ? 1u : 0u;
  proof->layer2_basis_ok = l2_ok ? 1u : 0u;
  proof->layer3_rand64_ok = l3_ok ? 1u : 0u;
}

struct AstBuilder {
  HexMbaNode* buf;
  uint32_t cap;
  uint32_t len;
  uint32_t width_flag;
  bool overflow;

  uint32_t push(uint32_t op, uint32_t lhs, uint32_t rhs, int64_t imm) {
    if (len >= cap) {
      overflow = true;
      return 0u;
    }
    const uint32_t idx = len++;
    buf[idx].op = op;
    buf[idx].lhs = lhs;
    buf[idx].rhs = rhs;
    buf[idx].flags = width_flag;
    buf[idx].imm = imm;
    return idx;
  }

  uint32_t var(uint32_t v) { return push(HEX_MBA_VAR, v, 0u, 0); }
  uint32_t cnst(int64_t c) { return push(HEX_MBA_CONST, 0u, 0u, c); }

  uint32_t basis_conj(uint32_t mask) {
    uint32_t acc = 0xFFFFFFFFu;
    for (uint32_t bit = 0u; bit < 3u; ++bit) {
      if ((mask & (1u << bit)) != 0u) {
        const uint32_t v = var(bit);
        acc = (acc == 0xFFFFFFFFu) ? v : push(HEX_MBA_AND, acc, v, 0);
      }
    }
    return acc;
  }
};

// Synthesize compact candidate AST from Mobius coefficients c[0..7].
// Avoids signed negation UB when coeff == INT64_MIN or c[0] == INT64_MIN.
uint32_t synthesize_from_mobius(
    const int64_t c[8], AstBuilder& b, uint32_t& out_kind) {
  bool any_nonconst = false;
  for (uint32_t m = 1u; m < 8u; ++m) {
    if (c[m] != 0) any_nonconst = true;
  }
  if (!any_nonconst) {
    out_kind = HEX_MBA_SIMP_CONST;
    return b.cnst(c[0]);
  }

  static constexpr uint32_t kPairs[3][3] = {
      {0u, 1u, 3u},
      {0u, 2u, 5u},
      {1u, 2u, 6u},
  };
  if (c[0] == 0 && c[7] == 0) {
    for (uint32_t p = 0u; p < 3u; ++p) {
      const uint32_t va = kPairs[p][0];
      const uint32_t vb = kPairs[p][1];
      const uint32_t ma = 1u << va;
      const uint32_t mb = 1u << vb;
      const uint32_t mab = kPairs[p][2];
      bool others_zero = true;
      for (uint32_t m = 1u; m < 8u; ++m) {
        if (m != ma && m != mb && m != mab && c[m] != 0) others_zero = false;
      }
      if (!others_zero) continue;

      if (c[ma] == 1 && c[mb] == 1 && c[mab] == -1) {
        out_kind = HEX_MBA_SIMP_BITWISE_OR;
        const uint32_t na = b.var(va);
        const uint32_t nb = b.var(vb);
        return b.push(HEX_MBA_OR, na, nb, 0);
      }
      if (c[ma] == 1 && c[mb] == 1 && c[mab] == -2) {
        out_kind = HEX_MBA_SIMP_BITWISE_XOR;
        const uint32_t na = b.var(va);
        const uint32_t nb = b.var(vb);
        return b.push(HEX_MBA_XOR, na, nb, 0);
      }
      if (c[ma] == 0 && c[mb] == 0 && c[mab] == 1) {
        out_kind = HEX_MBA_SIMP_BITWISE_AND;
        const uint32_t na = b.var(va);
        const uint32_t nb = b.var(vb);
        return b.push(HEX_MBA_AND, na, nb, 0);
      }
    }
  }

  if (c[0] == 0 && c[3] == 0 && c[5] == 0 && c[6] == 0 && c[7] == 0) {
    for (uint32_t v = 0u; v < 3u; ++v) {
      const uint32_t mv = 1u << v;
      bool others_zero = true;
      for (uint32_t m = 1u; m < 8u; ++m) {
        if (m != mv && c[m] != 0) others_zero = false;
      }
      if (others_zero && c[mv] == -1) {
        out_kind = HEX_MBA_SIMP_NEG_VAR;
        const uint32_t nv = b.var(v);
        return b.push(HEX_MBA_NEG, nv, 0u, 0);
      }
    }
  }

  const bool only_linear = (c[3] == 0 && c[5] == 0 && c[6] == 0 && c[7] == 0);
  out_kind = only_linear ? HEX_MBA_SIMP_LINEAR_VAR : HEX_MBA_SIMP_GENERAL_LIN;

  uint32_t acc = 0xFFFFFFFFu;
  auto add_term = [&](uint32_t term_idx, int64_t coeff) {
    if (coeff == 0) return;
    if (acc == 0xFFFFFFFFu) {
      if (coeff == 1) {
        acc = term_idx;
      } else if (coeff == -1) {
        acc = b.push(HEX_MBA_NEG, term_idx, 0u, 0);
      } else {
        acc = b.push(HEX_MBA_MUL_CONST, term_idx, 0u, coeff);
      }
    } else {
      if (coeff == 1) {
        acc = b.push(HEX_MBA_ADD, acc, term_idx, 0);
      } else if (coeff == -1) {
        acc = b.push(HEX_MBA_SUB, acc, term_idx, 0);
      } else if (coeff == kInt64Min) {
        // Avoid signed overflow UB from -INT64_MIN: use ADD with INT64_MIN directly.
        const uint32_t scaled = b.push(HEX_MBA_MUL_CONST, term_idx, 0u, kInt64Min);
        acc = b.push(HEX_MBA_ADD, acc, scaled, 0);
      } else if (coeff < 0) {
        const int64_t pos = static_cast<int64_t>(0ULL - static_cast<uint64_t>(coeff));
        const uint32_t scaled = b.push(HEX_MBA_MUL_CONST, term_idx, 0u, pos);
        acc = b.push(HEX_MBA_SUB, acc, scaled, 0);
      } else {
        const uint32_t scaled = b.push(HEX_MBA_MUL_CONST, term_idx, 0u, coeff);
        acc = b.push(HEX_MBA_ADD, acc, scaled, 0);
      }
    }
  };

  for (uint32_t m = 1u; m < 8u; ++m) {
    if (c[m] > 0) {
      const uint32_t term = b.basis_conj(m);
      add_term(term, c[m]);
    }
  }
  for (uint32_t m = 1u; m < 8u; ++m) {
    if (c[m] < 0) {
      const uint32_t term = b.basis_conj(m);
      add_term(term, c[m]);
    }
  }
  if (c[0] != 0) {
    if (acc == 0xFFFFFFFFu) {
      acc = b.cnst(c[0]);
    } else if (c[0] > 0 || c[0] == kInt64Min) {
      // Avoid -INT64_MIN signed overflow UB by using ADD directly.
      const uint32_t k = b.cnst(c[0]);
      acc = b.push(HEX_MBA_ADD, acc, k, 0);
    } else {
      const int64_t pos = static_cast<int64_t>(0ULL - static_cast<uint64_t>(c[0]));
      const uint32_t k = b.cnst(pos);
      acc = b.push(HEX_MBA_SUB, acc, k, 0);
    }
  }
  return acc;
}

}  // namespace

extern "C" {

HEX_WASM_EXPORT("hex_mba_eval")
uint64_t hex_mba_eval(
    const HexMbaNode* nodes, uint32_t node_count, uint32_t root_idx,
    uint64_t x, uint64_t y, uint64_t z) {
  uint32_t unique_count = 0u;
  uint32_t var_mask = 0u;
  bool has_w32 = false;
  bool has_w64 = false;
  if (!validate_and_analyze_dag(nodes, node_count, root_idx, unique_count, var_mask, has_w32,
                                has_w64)) {
    return 0ULL;
  }
  return eval_dag_memo(nodes, node_count, root_idx, x, y, z);
}

HEX_WASM_EXPORT("hex_mba_verify_equiv")
HexStatus hex_mba_verify_equiv(
    const HexMbaNode* orig_nodes, uint32_t orig_count, uint32_t orig_root,
    const HexMbaNode* cand_nodes, uint32_t cand_count, uint32_t cand_root,
    uint32_t num_vars, HexMbaProofResult* out_proof) {
  if (out_proof == nullptr) {
    return HEX_ERR_INVALID_ARG;
  }
  uint32_t orig_unique = 0u;
  uint32_t cand_unique = 0u;
  uint32_t orig_vars = 0u;
  uint32_t cand_vars = 0u;
  bool orig_w32 = false, orig_w64 = false;
  bool cand_w32 = false, cand_w64 = false;
  if (!validate_and_analyze_dag(orig_nodes, orig_count, orig_root, orig_unique, orig_vars,
                                orig_w32, orig_w64) ||
      !validate_and_analyze_dag(cand_nodes, cand_count, cand_root, cand_unique, cand_vars,
                                cand_w32, cand_w64)) {
    return HEX_ERR_INVALID_ARG;
  }

  for (uint32_t i = 0u; i < 8u; ++i) out_proof->coeff[i] = 0;
  out_proof->simplified_kind = HEX_MBA_SIMP_NONE;
  out_proof->committed = 0u;
  out_proof->orig_cost = orig_unique;
  out_proof->simp_cost = cand_unique;
  out_proof->out_node_count = 0u;

  run_3layer_proof(orig_nodes, orig_count, orig_root, cand_nodes, cand_count, cand_root, num_vars,
                   out_proof);
  return HEX_OK;
}

HEX_WASM_EXPORT("hex_mba_simplify")
HexStatus hex_mba_simplify(
    const HexMbaNode* in_nodes, uint32_t in_count, uint32_t root_idx,
    HexMbaNode* out_nodes, uint32_t max_out_nodes, uint32_t* out_root_idx,
    HexMbaProofResult* out_proof) {
  if (out_nodes == nullptr || out_root_idx == nullptr || out_proof == nullptr ||
      max_out_nodes == 0u) {
    return HEX_ERR_INVALID_ARG;
  }

  out_proof->layer1_tt_ok = 0u;
  out_proof->layer2_basis_ok = 0u;
  out_proof->layer3_rand64_ok = 0u;
  out_proof->simplified_kind = HEX_MBA_SIMP_NONE;
  out_proof->committed = 0u;
  out_proof->orig_cost = 0u;
  out_proof->simp_cost = 0u;
  out_proof->out_node_count = 0u;
  for (uint32_t i = 0u; i < 8u; ++i) out_proof->coeff[i] = 0;
  *out_root_idx = 0u;

  uint32_t orig_cost = 0u;
  uint32_t var_mask = 0u;
  bool has_w32 = false;
  bool has_w64 = false;
  if (!validate_and_analyze_dag(in_nodes, in_count, root_idx, orig_cost, var_mask, has_w32,
                                has_w64)) {
    return HEX_ERR_INVALID_ARG;
  }
  out_proof->orig_cost = orig_cost;

  // Reject mixed 32-bit / 64-bit DAGs (per §19.2 strict width-uniformity guard).
  if (has_w32 && has_w64) {
    return HEX_OK;
  }

  uint32_t num_vars = 0u;
  if ((var_mask & 4u) != 0u) num_vars = 3u;
  else if ((var_mask & 2u) != 0u) num_vars = 2u;
  else if ((var_mask & 1u) != 0u) num_vars = 1u;

  // Stage 1: Evaluate on the 8 Boolean cube corners {0, 1}^3.
  int64_t f_vals[8];
  for (uint32_t mask = 0u; mask < 8u; ++mask) {
    const uint64_t vx = (mask & 1u) ? 1ULL : 0ULL;
    const uint64_t vy = (mask & 2u) ? 1ULL : 0ULL;
    const uint64_t vz = (mask & 4u) ? 1ULL : 0ULL;
    const uint64_t raw = eval_dag_memo(in_nodes, in_count, root_idx, vx, vy, vz);
    f_vals[mask] = has_w32 ? static_cast<int64_t>(static_cast<int32_t>(raw))
                           : static_cast<int64_t>(raw);
  }

  // Fast Mobius Transform (SOS inverse) over the 3-variable subset lattice.
  int64_t mobius[8];
  for (uint32_t i = 0u; i < 8u; ++i) mobius[i] = f_vals[i];
  for (uint32_t bit = 0u; bit < 3u; ++bit) {
    for (uint32_t mask = 0u; mask < 8u; ++mask) {
      if ((mask & (1u << bit)) != 0u) {
        mobius[mask] = static_cast<int64_t>(
            static_cast<uint64_t>(mobius[mask]) -
            static_cast<uint64_t>(mobius[mask ^ (1u << bit)]));
      }
    }
  }
  for (uint32_t i = 0u; i < 8u; ++i) out_proof->coeff[i] = mobius[i];

  // Stage 2: Synthesize candidate AST into temporary buffer.
  HexMbaNode cand_buf[kMaxMbaNodes];
  AstBuilder builder{cand_buf, kMaxMbaNodes, 0u,
                     has_w32 ? HEX_MBA_FLAG_WIDTH32 : HEX_MBA_FLAG_WIDTH64, false};
  uint32_t simp_kind = HEX_MBA_SIMP_NONE;
  const uint32_t cand_root = synthesize_from_mobius(mobius, builder, simp_kind);
  if (builder.overflow || builder.len == 0u) {
    return HEX_OK;
  }

  out_proof->simp_cost = builder.len;
  out_proof->simplified_kind = simp_kind;

  // Stage 3: Mandatory 3-Layer Equivalence Proof.
  run_3layer_proof(in_nodes, in_count, root_idx, cand_buf, builder.len, cand_root, num_vars,
                   out_proof);

  // Commit ONLY if all 3 layers pass AND simplified AST strictly reduces cost.
  if (out_proof->layer1_tt_ok == 1u && out_proof->layer2_basis_ok == 1u &&
      out_proof->layer3_rand64_ok == 1u && builder.len < orig_cost) {
    if (builder.len > max_out_nodes) {
      return HEX_ERR_RESOURCE_LIMIT;
    }
    for (uint32_t i = 0u; i < builder.len; ++i) {
      out_nodes[i] = cand_buf[i];
    }
    *out_root_idx = cand_root;
    out_proof->out_node_count = builder.len;
    out_proof->committed = 1u;
  }

  return HEX_OK;
}

}  // extern "C"
