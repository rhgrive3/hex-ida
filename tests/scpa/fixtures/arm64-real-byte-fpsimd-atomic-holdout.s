.text
.p2align 2
.globl fp_scalar_arith
.type fp_scalar_arith,@function
fp_scalar_arith:
  fadd d0, d1, d2
  ret
.size fp_scalar_arith, .-fp_scalar_arith

.p2align 2
.globl fp_compare_branch
.type fp_compare_branch,@function
fp_compare_branch:
  fcmp d0, d1
  b.eq .Lfp_compare_eq
  fsub d0, d1, d2
  ret
.Lfp_compare_eq:
  fmul d0, d1, d2
  ret
.size fp_compare_branch, .-fp_compare_branch

.p2align 2
.globl simd_vector_add
.type simd_vector_add,@function
simd_vector_add:
  add v0.4s, v1.4s, v2.4s
  ret
.size simd_vector_add, .-simd_vector_add

.p2align 2
.globl acquire_load
.type acquire_load,@function
acquire_load:
  ldar x0, [x1]
  ret
.size acquire_load, .-acquire_load

.p2align 2
.globl release_store
.type release_store,@function
release_store:
  stlr x0, [x1]
  ret
.size release_store, .-release_store

.p2align 2
.globl exclusive_pair
.type exclusive_pair,@function
exclusive_pair:
  ldxr x0, [x1]
  stxr w2, x0, [x1]
  ret
.size exclusive_pair, .-exclusive_pair
