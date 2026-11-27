// C++ STL Container High-Level Pattern Recognizer (§12.3, JS-side 0B WASM, LRU 4,096 functions).
// INV-005: ZERO direct imports from js/targets/architecture/ or js/targets/abi/.
// High-level overlays (e.g. `vec.push_back(x)`) are strictly Path A-1 (Post-Emit Overlay);
// Path B (C11 recompilation) emits pure C11 structs only.

export const STL_LRU_CAPACITY = 4096;

export const STL_CONTAINER_KIND = Object.freeze({
  VECTOR: 'std::vector',
  STRING_LIBCXX_SSO24: 'std::string(libc++_sso24)',
  STRING_LIBSTDCXX_SSO32: 'std::string(libstdc++_sso32)',
  MAP_TREE: 'std::map',
  UNORDERED_MAP: 'std::unordered_map',
  SHARED_PTR: 'std::shared_ptr',
  UNIQUE_PTR: 'std::unique_ptr',
});

function hasFieldAt(fields, offset, size) {
  return fields.some((f) => f.offset === offset && (size === undefined || f.size === size));
}

function hasSymbolMatch(symbols, re) {
  return symbols.some((s) => re.test(String(s)));
}

function hasAccessPattern(accesses, pattern) {
  return accesses.some((a) => a === pattern || a?.kind === pattern);
}

/**
 * Evaluate independent evidence signals for each STL container family.
 * Requires >= 2 independent evidence items (§12.3) before emitting a recognition.
 */
function evaluateStlCandidates(input) {
  const fields = Array.isArray(input.fields) ? input.fields : [];
  const symbols = Array.isArray(input.symbols) ? input.symbols : [];
  const accesses = Array.isArray(input.accessPatterns) ? input.accessPatterns : [];
  const totalSize = input.structSize ?? 0;
  const ptrSize = input.ptrSize ?? 8;
  const results = [];

  // 1. std::vector<T> — 3 pointers: begin (+0), end (+ptr), cap (+2*ptr)
  {
    const evidence = [];
    if (
      hasFieldAt(fields, 0, ptrSize)
      && hasFieldAt(fields, ptrSize, ptrSize)
      && hasFieldAt(fields, ptrSize * 2, ptrSize)
      && (totalSize === 0 || totalSize === ptrSize * 3)
    ) {
      evidence.push('layout_3ptr_begin_end_cap');
    }
    if (hasAccessPattern(accesses, 'end_eq_cap_grow') || hasAccessPattern(accesses, 'end_sub_begin_div_stride')) {
      evidence.push('vector_growth_or_size_idiom');
    }
    if (hasSymbolMatch(symbols, /std::(__1::)?vector|push_back|__emplace_back|_M_realloc_insert/)) {
      evidence.push('symbol_vector_method');
    }
    if (evidence.length >= 2) {
      results.push({
        kind: STL_CONTAINER_KIND.VECTOR,
        abiFamily: hasSymbolMatch(symbols, /__1::/) ? 'libc++' : 'generic',
        confidence: Math.min(0.99, 0.65 + 0.15 * evidence.length),
        evidence,
        pathA1Overlay: {
          fieldNames: { 0: '__begin_', [ptrSize]: '__end_', [ptrSize * 2]: '__cap_' },
          methodHint: hasAccessPattern(accesses, 'end_eq_cap_grow') ? 'vec.push_back(...)' : 'vec.size()',
        },
        pathBC11Struct: `struct hex_std_vector { void* begin; void* end; void* cap; };`,
      });
    }
  }

  // 2. std::string (libc++ 24B SSO)
  {
    const evidence = [];
    if (totalSize === 24 && (hasFieldAt(fields, 0, 8) || hasFieldAt(fields, 0, 1))) {
      evidence.push('layout_24b_libcxx_sso');
    }
    if (hasAccessPattern(accesses, 'sso_lsb_or_msb_flag_test') || hasAccessPattern(accesses, 'sso_short_len_shift1')) {
      evidence.push('sso_bit_discriminator');
    }
    if (hasSymbolMatch(symbols, /std::__1::basic_string|__grow_by|__init/)) {
      evidence.push('symbol_libcxx_string');
    }
    if (evidence.length >= 2) {
      results.push({
        kind: STL_CONTAINER_KIND.STRING_LIBCXX_SSO24,
        abiFamily: 'libc++',
        confidence: Math.min(0.99, 0.65 + 0.15 * evidence.length),
        evidence,
        pathA1Overlay: {
          fieldNames: { 0: '__r_.cap_or_len', 8: '__r_.size', 16: '__r_.data' },
          methodHint: 'str.c_str()',
        },
        pathBC11Struct: `struct hex_libcxx_string { uint64_t w0; uint64_t w1; uint64_t w2; };`,
      });
    }
  }

  // 3. std::string (libstdc++ 32B SSO: _M_p (+0), _M_string_length (+8), _M_local_buf[16] (+16))
  {
    const evidence = [];
    if (totalSize === 32 && hasFieldAt(fields, 0, 8) && hasFieldAt(fields, 8, 8)) {
      evidence.push('layout_32b_libstdcxx_sso');
    }
    if (hasAccessPattern(accesses, 'ptr_eq_self_plus_16_sso_check')) {
      evidence.push('libstdcxx_local_buf_cmp');
    }
    if (hasSymbolMatch(symbols, /std::__cxx11::basic_string|_M_create|_M_dispose/)) {
      evidence.push('symbol_libstdcxx_string');
    }
    if (evidence.length >= 2) {
      results.push({
        kind: STL_CONTAINER_KIND.STRING_LIBSTDCXX_SSO32,
        abiFamily: 'libstdc++',
        confidence: Math.min(0.99, 0.65 + 0.15 * evidence.length),
        evidence,
        pathA1Overlay: {
          fieldNames: { 0: '_M_dataplus._M_p', 8: '_M_string_length', 16: '_M_local_buf' },
          methodHint: 'str.c_str()',
        },
        pathBC11Struct: `struct hex_libstdcxx_string { char* ptr; uint64_t len; char local_buf[16]; };`,
      });
    }
  }

  // 4. std::map / __tree (red-black tree: left/right/parent/color + size)
  {
    const evidence = [];
    if (
      hasFieldAt(fields, 0, ptrSize)
      && hasFieldAt(fields, ptrSize, ptrSize)
      && hasFieldAt(fields, ptrSize * 2, ptrSize)
      && (hasAccessPattern(accesses, 'rb_tree_walk') || hasAccessPattern(accesses, 'rb_color_bit'))
    ) {
      evidence.push('layout_rb_tree_node');
    }
    if (hasAccessPattern(accesses, 'rb_tree_walk')) {
      evidence.push('tree_traversal_idiom');
    }
    if (hasSymbolMatch(symbols, /std::(__1::)?(__tree|map|set)|_Rb_tree/)) {
      evidence.push('symbol_rb_tree');
    }
    if (evidence.length >= 2) {
      results.push({
        kind: STL_CONTAINER_KIND.MAP_TREE,
        abiFamily: hasSymbolMatch(symbols, /__tree/) ? 'libc++' : 'libstdc++',
        confidence: Math.min(0.99, 0.65 + 0.15 * evidence.length),
        evidence,
        pathA1Overlay: {
          fieldNames: { 0: '__begin_node_', [ptrSize]: '__pair1_', [ptrSize * 2]: '__size_' },
          methodHint: 'map.find(...)',
        },
        pathBC11Struct: `struct hex_std_map { void* begin_node; void* header; uint64_t size; };`,
      });
    }
  }

  // 5. std::unordered_map (bucket_list + bucket_count + size + max_load_factor)
  {
    const evidence = [];
    if (hasFieldAt(fields, 0, ptrSize) && hasFieldAt(fields, ptrSize, ptrSize) && hasAccessPattern(accesses, 'hash_mod_bucket_count')) {
      evidence.push('layout_hash_bucket_table');
    }
    if (hasAccessPattern(accesses, 'hash_mod_bucket_count')) {
      evidence.push('bucket_modulo_lookup');
    }
    if (hasSymbolMatch(symbols, /unordered_map|__hash_table|_Hashtable/)) {
      evidence.push('symbol_hash_table');
    }
    if (evidence.length >= 2) {
      results.push({
        kind: STL_CONTAINER_KIND.UNORDERED_MAP,
        abiFamily: hasSymbolMatch(symbols, /__hash_table/) ? 'libc++' : 'libstdc++',
        confidence: Math.min(0.99, 0.65 + 0.15 * evidence.length),
        evidence,
        pathA1Overlay: {
          fieldNames: { 0: '__bucket_list_', [ptrSize]: '__p1_', [ptrSize * 2]: '__size_' },
          methodHint: 'umap.find(...)',
        },
        pathBC11Struct: `struct hex_std_unordered_map { void* buckets; uint64_t bucket_count; uint64_t size; };`,
      });
    }
  }

  // 6. std::shared_ptr<T> — { T* ptr (+0), control_block* cntrl (+ptr) } + atomic refcount RMW
  {
    const evidence = [];
    if (
      hasFieldAt(fields, 0, ptrSize)
      && hasFieldAt(fields, ptrSize, ptrSize)
      && (totalSize === 0 || totalSize === ptrSize * 2)
    ) {
      evidence.push('layout_2ptr_obj_and_ctrl');
    }
    if (hasAccessPattern(accesses, 'atomic_refcount_rmw')) {
      evidence.push('atomic_refcount_inc_dec');
    }
    if (hasSymbolMatch(symbols, /shared_ptr|__shared_count|__release_shared|_Sp_counted_base/)) {
      evidence.push('symbol_shared_ptr');
    }
    if (evidence.length >= 2) {
      results.push({
        kind: STL_CONTAINER_KIND.SHARED_PTR,
        abiFamily: hasSymbolMatch(symbols, /__shared_count/) ? 'libc++' : 'libstdc++',
        confidence: Math.min(0.99, 0.65 + 0.15 * evidence.length),
        evidence,
        pathA1Overlay: {
          fieldNames: { 0: '__ptr_', [ptrSize]: '__cntrl_' },
          methodHint: 'sp.get()',
        },
        pathBC11Struct: `struct hex_std_shared_ptr { void* ptr; void* ctrl; };`,
      });
    }
  }

  results.sort((a, b) => b.confidence - a.confidence);
  return results;
}

/**
 * LRU-cached STL pattern recognizer (default max 4,096 functions per §12.3).
 */
export class StlPatternRecognizer {
  constructor(maxEntries = STL_LRU_CAPACITY) {
    this.maxEntries = Math.max(1, maxEntries);
    this._cache = new Map();
  }

  recognize(funcKey, input) {
    const key = String(funcKey);
    if (this._cache.has(key)) {
      const hit = this._cache.get(key);
      this._cache.delete(key);
      this._cache.set(key, hit);
      return hit;
    }

    const matches = evaluateStlCandidates(input || {});
    const result = {
      funcKey: key,
      recognized: matches.length > 0,
      primary: matches[0] || null,
      matches,
    };

    if (this._cache.size >= this.maxEntries) {
      const oldestKey = this._cache.keys().next().value;
      this._cache.delete(oldestKey);
    }
    this._cache.set(key, result);
    return result;
  }

  get cacheSize() {
    return this._cache.size;
  }

  clear() {
    this._cache.clear();
  }
}

export function createStlPatternRecognizer(maxEntries = STL_LRU_CAPACITY) {
  return new StlPatternRecognizer(maxEntries);
}
