/*
 * Decompiled by IDA Pro 9.1 with Hex-Rays
 * Binary: /Users/eren/Desktop/Antigravity/compiler/build/arm64/5-23/5-23_clang_O3_no_g
 * Processor: arm
 */

/* Function: .init_proc @ 0x780 */
__int64 init_proc()
{
  return call_weak_fn();
}


/* Function: sub_7A0 @ 0x7A0 */
void sub_7A0()
{
  JUMPOUT(0);
}


/* Function: init_have_lse_atomics @ 0x880 */
__int64 init_have_lse_atomics()
{
  __int64 result; // x0

  result = ((unsigned int)__getauxval(16) >> 8) & 1;
  _aarch64_have_lse_atomics = result;
  return result;
}


/* Function: _start @ 0x8C0 */
void __fastcall __noreturn start(
        void (*rtld_fini)(void),
        int a2,
        int a3,
        int a4,
        int a5,
        int a6,
        int a7,
        int a8,
        int argc,
        char *ubp_av)
{
  __libc_start_main((int (*)(int, char **, char **))main, argc, &ubp_av, 0, 0, rtld_fini, &argc);
  abort();
}


/* Function: call_weak_fn @ 0x8F4 */
void *call_weak_fn()
{
  void *result; // x0

  result = &_gmon_start__;
  if ( &_gmon_start__ )
    return (void *)__gmon_start__();
  return result;
}


/* Function: deregister_tm_clones @ 0x910 */
void *deregister_tm_clones()
{
  return &end;
}


/* Function: register_tm_clones @ 0x940 */
void *register_tm_clones()
{
  return &end;
}


/* Function: __do_global_dtors_aux @ 0x980 */
__int64 _do_global_dtors_aux()
{
  __int64 result; // x0

  result = (unsigned __int8)_bss_start;
  if ( !_bss_start )
  {
    if ( &_cxa_finalize )
      __cxa_finalize(_dso_handle);
    deregister_tm_clones();
    result = 1;
    _bss_start = 1;
  }
  return result;
}


/* Function: frame_dummy @ 0x9D0 */
// attributes: thunk
void *frame_dummy()
{
  return register_tm_clones();
}


/* Function: param_macro_constants @ 0x9D4 */
__int64 __fastcall param_macro_constants(int a1)
{
  if ( a1 <= 1024 )
    return 512;
  else
    return 64;
}


/* Function: call_macro_constants @ 0x9E8 */
__int64 call_macro_constants()
{
  return 64;
}


/* Function: param_macro_functions @ 0x9F0 */
__int64 __fastcall param_macro_functions(int a1, int a2)
{
  int v2; // w8

  if ( a1 <= a2 )
    v2 = a2;
  else
    v2 = a1;
  return (unsigned int)(v2 + a1 * a1);
}


/* Function: call_macro_functions @ 0xA00 */
__int64 call_macro_functions()
{
  return 30;
}


/* Function: param_conditional_compile @ 0xA08 */
__int64 __fastcall param_conditional_compile(int a1)
{
  return (unsigned int)(3 * a1 + 2);
}


/* Function: call_conditional_compile @ 0xA14 */
__int64 call_conditional_compile()
{
  return 32;
}


/* Function: param_multi_branch_compile @ 0xA1C */
__int64 __fastcall param_multi_branch_compile(int a1)
{
  return (unsigned int)(5 * a1 + 57072);
}


/* Function: call_multi_branch_compile @ 0xA2C */
__int64 call_multi_branch_compile()
{
  return 57122;
}


/* Function: param_macro_recursion @ 0xA34 */
__int64 __fastcall param_macro_recursion(int a1)
{
  return (unsigned int)(a1 + 16);
}


/* Function: call_macro_recursion @ 0xA3C */
__int64 call_macro_recursion()
{
  return 116;
}


/* Function: param_stringize @ 0xA44 */
__int64 param_stringize()
{
  return 19;
}


/* Function: call_stringize @ 0xA4C */
__int64 call_stringize()
{
  return 19;
}


/* Function: my_func @ 0xA54 */
__int64 __fastcall my_func(int a1)
{
  return (unsigned int)(10 * a1);
}


/* Function: param_token_paste @ 0xA60 */
__int64 __fastcall param_token_paste(int a1)
{
  return (unsigned int)(11 * a1 + 5);
}


/* Function: call_token_paste @ 0xA70 */
__int64 call_token_paste()
{
  return 60;
}


/* Function: param_variadic_macro @ 0xA78 */
__int64 __fastcall param_variadic_macro(int a1, int a2, int a3)
{
  printf("LOG: Values: %d, %d, %d\n", a1, a2, a3);
  return (unsigned int)(a1 + 50);
}


/* Function: call_variadic_macro @ 0xAB0 */
__int64 call_variadic_macro()
{
  printf("LOG: Values: %d, %d, %d\n", 10, 20, 30);
  return 60;
}


/* Function: param_macro_override @ 0xADC */
__int64 __fastcall param_macro_override(int a1)
{
  return (unsigned int)(3 * a1 + 1);
}


/* Function: call_macro_override @ 0xAE8 */
__int64 call_macro_override()
{
  return 16;
}


/* Function: param_include_guard @ 0xAF0 */
__int64 param_include_guard()
{
  return 500;
}


/* Function: call_include_guard @ 0xAF8 */
__int64 call_include_guard()
{
  return 500;
}


/* Function: param_builtin_macros @ 0xB00 */
__int64 __fastcall param_builtin_macros(int a1)
{
  printf(
    "file=%s, func=%s, line=%d, date=%s, time=%s\n",
    "src/5-23.c",
    "param_builtin_macros",
    279,
    "Jan 15 2026",
    "03:01:46");
  return (unsigned int)(a1 + 282);
}


/* Function: call_builtin_macros @ 0xB50 */
__int64 call_builtin_macros()
{
  printf(
    "file=%s, func=%s, line=%d, date=%s, time=%s\n",
    "src/5-23.c",
    "param_builtin_macros",
    279,
    "Jan 15 2026",
    "03:01:46");
  return 382;
}


/* Function: test_preprocessing_features @ 0xB94 */
__int64 test_preprocessing_features()
{
  puts(asc_14C7);
  printf(aPpL201D, 64);
  printf(aPpL202D, 30);
  printf(aPpL203D, 32);
  printf(aPpL204D, 57122);
  printf(aPpL301D, 116);
  printf(aPpL302D, 19);
  printf(aPpL303D, 60);
  printf("LOG: Values: %d, %d, %d\n", 10, 20, 30);
  printf(aPpL304D, 60);
  printf(aPpL305D, 16);
  printf(aPpL306D, 500);
  printf(
    "file=%s, func=%s, line=%d, date=%s, time=%s\n",
    "src/5-23.c",
    "param_builtin_macros",
    279,
    "Jan 15 2026",
    "03:01:46");
  return printf(aPpL307D, 382);
}


/* Function: param_asm_basic @ 0xCA4 */
__int64 __fastcall param_asm_basic(int a1)
{
  return (unsigned int)(a1 + 10);
}


/* Function: call_asm_basic @ 0xCAC */
__int64 call_asm_basic()
{
  return 15;
}


/* Function: param_asm_clobber @ 0xCB4 */
__int64 __fastcall param_asm_clobber(int32x4_t *a1, int a2)
{
  __int64 v2; // x10
  unsigned int v3; // w8
  int32x4_t *v5; // x8
  int32x4_t v6; // q0
  __int64 v7; // x11
  int32x4_t v8; // q1
  int32x4_t v9; // q2
  int32x4_t v10; // q3
  int *v11; // x11
  __int64 v12; // x9
  int v13; // t1

  if ( a2 < 1 )
    return 0;
  if ( (unsigned int)a2 >= 8 )
  {
    v2 = a2 & 0xFFFFFFF8;
    v5 = a1 + 1;
    v6 = 0u;
    v7 = v2;
    v8 = 0u;
    do
    {
      v9 = v5[-1];
      v10 = *v5;
      v5 += 2;
      v7 -= 8;
      v6 = vaddq_s32(v9, v6);
      v8 = vaddq_s32(v10, v8);
    }
    while ( v7 );
    v3 = vaddvq_s32(vaddq_s32(v8, v6));
    if ( v2 == a2 )
      return v3;
  }
  else
  {
    v2 = 0;
    v3 = 0;
  }
  v11 = (int *)a1 + v2;
  v12 = (unsigned int)a2 - v2;
  do
  {
    v13 = *v11++;
    --v12;
    v3 += v13;
  }
  while ( v12 );
  return v3;
}


/* Function: call_asm_clobber @ 0xD3C */
__int64 call_asm_clobber()
{
  return 15;
}


/* Function: param_asm_multi_insn @ 0xD44 */
// attributes: thunk
void *param_asm_multi_insn(void *dest, const void *src, size_t n)
{
  return memcpy(dest, src, n);
}


/* Function: call_asm_multi_insn @ 0xD48 */
__int64 call_asm_multi_insn()
{
  return 42;
}


/* Function: param_asm_simd @ 0xD50 */
__int64 __fastcall param_asm_simd(_DWORD *a1, _DWORD *a2, _DWORD *a3)
{
  int v3; // w8
  __int64 result; // x0

  *a3 = *a2 + *a1;
  a3[1] = a2[1] + a1[1];
  a3[2] = a2[2] + a1[2];
  v3 = a1[3];
  result = 0;
  a3[3] = a2[3] + v3;
  return result;
}


/* Function: param_simd_intrinsics @ 0xD98 */
__int64 __fastcall param_simd_intrinsics(_DWORD *a1, _DWORD *a2, _DWORD *a3)
{
  int v3; // w8
  __int64 result; // x0

  *a3 = *a2 + *a1;
  a3[1] = a2[1] + a1[1];
  a3[2] = a2[2] + a1[2];
  v3 = a1[3];
  result = 0;
  a3[3] = a2[3] + v3;
  return result;
}


/* Function: call_asm_simd @ 0xDE0 */
__int64 call_asm_simd()
{
  return 36;
}


/* Function: param_asm_atomic @ 0xDE8 */
__int64 __fastcall param_asm_atomic(__int64 a1, unsigned int a2)
{
  return (unsigned int)_aarch64_ldadd4_acq_rel(a2, a1) + a2;
}


/* Function: param_atomic_c11 @ 0xE14 */
__int64 __fastcall param_atomic_c11(__int64 a1, unsigned int a2)
{
  return (unsigned int)_aarch64_ldadd4_acq_rel(a2, a1) + a2;
}


/* Function: call_asm_atomic @ 0xE40 */
__int64 call_asm_atomic()
{
  int v0; // w0
  int v2; // [xsp+Ch] [xbp-4h] BYREF

  v2 = 10;
  v0 = _aarch64_ldadd4_acq_rel(5, &v2);
  return (unsigned int)(v0 + v2 + 5);
}


/* Function: param_dynamic_code @ 0xE78 */
__int64 __fastcall param_dynamic_code(int a1)
{
  size_t v2; // x20
  unsigned int v3; // w21
  void *v4; // x0

  v2 = sysconf(30);
  v3 = -1;
  v4 = mmap(0, v2, 7, 34, -1, 0);
  if ( v4 != (void *)-1LL )
  {
    v3 = a1 + 5;
    munmap(v4, v2);
  }
  return v3;
}


/* Function: param_memory_protection @ 0xEE0 */
__int64 param_memory_protection()
{
  size_t v0; // x19
  unsigned int v1; // w21
  unsigned int *v2; // x0
  unsigned int *v3; // x20

  v0 = sysconf(30);
  v1 = -1;
  v2 = (unsigned int *)mmap(0, v0, 3, 34, -1, 0);
  if ( v2 != (unsigned int *)-1LL )
  {
    v3 = v2;
    *v2 = 42;
    if ( mprotect(v2, v0, 1) )
    {
      v1 = -2;
    }
    else
    {
      v1 = *v3;
      if ( mprotect(v3, v0, 3) )
        v1 = -3;
      else
        *v3 = 100;
    }
    munmap(v3, v0);
  }
  return v1;
}


/* Function: param_clobber_importance @ 0xF90 */
__int64 __fastcall param_clobber_importance(int a1, int a2)
{
  return (unsigned int)(2 * (a2 + a1));
}


/* Function: call_asm_privileged @ 0xF9C */
__int64 call_asm_privileged()
{
  size_t v0; // x20
  unsigned int v1; // w22
  void *v2; // x0
  void *v3; // x19
  size_t v4; // x20
  int v5; // w23
  int *v6; // x0
  int *v7; // x21

  v0 = sysconf(30);
  v1 = -1;
  v2 = mmap(0, v0, 7, 34, -1, 0);
  v3 = v2;
  if ( v2 != (void *)-1LL )
  {
    munmap(v2, v0);
    v1 = 15;
  }
  v4 = sysconf(30);
  v5 = -1;
  v6 = (int *)mmap(0, v4, 3, 34, -1, 0);
  if ( v6 != (int *)-1LL )
  {
    v7 = v6;
    *v6 = 42;
    if ( mprotect(v6, v4, 1) )
    {
      v5 = -2;
    }
    else
    {
      v5 = *v7;
      if ( mprotect(v7, v4, 3) )
        v5 = -3;
      else
        *v7 = 100;
    }
    munmap(v7, v4);
  }
  if ( v5 != 42 || v3 == (void *)-1LL )
    return v1;
  else
    return 77;
}


/* Function: param_memory_clobber_demo @ 0x10AC */
__int64 param_memory_clobber_demo()
{
  return (unsigned int)(global_var + 50);
}


/* Function: test_asm_features @ 0x10BC */
__int64 test_asm_features()
{
  int v0; // w0
  unsigned int v1; // w0
  int v3; // [xsp+Ch] [xbp-4h] BYREF

  puts(asc_14EE);
  printf(aAsmL401D, 15);
  printf(aAsmL402D, 15);
  printf(aAsmL403D, 42);
  printf(aAsmL404D, 36);
  v3 = 10;
  v0 = _aarch64_ldadd4_acq_rel(5, &v3);
  printf(aAsmL405D, (unsigned int)(v0 + v3 + 5));
  v1 = call_asm_privileged();
  return printf(aAsmL406D, v1);
}


/* Function: main @ 0x1160 */
int __fastcall main(int argc, const char **argv, const char **envp)
{
  int v3; // w0
  unsigned int v4; // w0
  int v6; // [xsp+Ch] [xbp-4h] BYREF

  test_preprocessing_features();
  puts(asc_14EE);
  printf(aAsmL401D, 15);
  printf(aAsmL402D, 15);
  printf(aAsmL403D, 42);
  printf(aAsmL404D, 36);
  v6 = 10;
  v3 = _aarch64_ldadd4_acq_rel(5, &v6);
  printf(aAsmL405D, (unsigned int)(v3 + v6 + 5));
  v4 = call_asm_privileged();
  printf(aAsmL406D, v4);
  return 0;
}


/* Function: __aarch64_ldadd4_acq_rel @ 0x1210 */
__int64 __fastcall _aarch64_ldadd4_acq_rel(unsigned int a1, atomic_uint *a2)
{
  __int64 result; // x0

  if ( _aarch64_have_lse_atomics )
    return atomic_fetch_add(a2, a1);
  do
    result = __ldaxr((unsigned int *)a2);
  while ( __stlxr(result + a1, (unsigned int *)a2) );
  return result;
}


/* Function: .term_proc @ 0x1240 */
void term_proc()
{
  ;
}


/* FAILED to decompile: memcpy @ 0x120D8 */

/* FAILED to decompile: __libc_start_main @ 0x120E0 */

/* FAILED to decompile: __cxa_finalize @ 0x120E8 */

/* FAILED to decompile: __getauxval @ 0x120F0 */

/* FAILED to decompile: abort @ 0x120F8 */

/* FAILED to decompile: puts @ 0x12100 */

/* FAILED to decompile: mmap @ 0x12108 */

/* FAILED to decompile: munmap @ 0x12110 */

/* FAILED to decompile: sysconf @ 0x12118 */

/* FAILED to decompile: printf @ 0x12120 */

/* FAILED to decompile: mprotect @ 0x12128 */

/* FAILED to decompile: __gmon_start__ @ 0x12138 */

/* Total functions decompiled: 54, failed: 12 */
