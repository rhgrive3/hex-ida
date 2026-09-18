/*
 * Decompiled by IDA Pro 9.1 with Hex-Rays
 * Binary: /Users/eren/Desktop/Antigravity/compiler/build/arm64/5-23/5-23_gcc_O3_no_g
 * Processor: arm
 */

/* Function: .init_proc @ 0x7F0 */
__int64 init_proc()
{
  return call_weak_fn();
}


/* Function: sub_810 @ 0x810 */
void sub_810()
{
  JUMPOUT(0);
}


/* Function: main @ 0x900 */
int __fastcall main(int argc, const char **argv, const char **envp)
{
  __int64 v3; // x0

  v3 = test_preprocessing_features(argc, argv, envp);
  test_asm_features(v3);
  return 0;
}


/* Function: init_have_lse_atomics @ 0x920 */
__int64 init_have_lse_atomics()
{
  __int64 result; // x0

  result = ((unsigned int)__getauxval(16) >> 8) & 1;
  _aarch64_have_lse_atomics = result;
  return result;
}


/* Function: _start @ 0x980 */
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


/* Function: call_weak_fn @ 0x9B4 */
void *call_weak_fn()
{
  void *result; // x0

  result = &_gmon_start__;
  if ( &_gmon_start__ )
    return (void *)__gmon_start__();
  return result;
}


/* Function: deregister_tm_clones @ 0x9D0 */
void *deregister_tm_clones()
{
  return &end;
}


/* Function: register_tm_clones @ 0xA00 */
void *register_tm_clones()
{
  return &end;
}


/* Function: __do_global_dtors_aux @ 0xA40 */
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


/* Function: frame_dummy @ 0xA90 */
// attributes: thunk
void *frame_dummy()
{
  return register_tm_clones();
}


/* Function: param_macro_constants @ 0xAA0 */
__int64 __fastcall param_macro_constants(int a1)
{
  if ( a1 > 1024 )
    return 64;
  else
    return 512;
}


/* Function: call_macro_constants @ 0xAB4 */
__int64 call_macro_constants()
{
  return 64;
}


/* Function: param_macro_functions @ 0xAC0 */
__int64 __fastcall param_macro_functions(int a1, int a2)
{
  if ( a1 >= a2 )
    a2 = a1;
  return (unsigned int)(a2 + a1 * a1);
}


/* Function: call_macro_functions @ 0xAD0 */
__int64 call_macro_functions()
{
  return 30;
}


/* Function: param_conditional_compile @ 0xAE0 */
__int64 __fastcall param_conditional_compile(int a1)
{
  return (unsigned int)(3 * a1 + 2);
}


/* Function: call_conditional_compile @ 0xAF0 */
__int64 call_conditional_compile()
{
  return 32;
}


/* Function: param_multi_branch_compile @ 0xB00 */
__int64 __fastcall param_multi_branch_compile(int a1)
{
  return (unsigned int)(5 * a1 + 57072);
}


/* Function: call_multi_branch_compile @ 0xB10 */
__int64 call_multi_branch_compile()
{
  return 57122;
}


/* Function: param_macro_recursion @ 0xB20 */
__int64 __fastcall param_macro_recursion(int a1)
{
  return (unsigned int)(a1 + 16);
}


/* Function: call_macro_recursion @ 0xB30 */
__int64 call_macro_recursion()
{
  return 116;
}


/* Function: param_stringize @ 0xB40 */
__int64 param_stringize()
{
  return 19;
}


/* Function: call_stringize @ 0xB50 */
__int64 call_stringize()
{
  return 19;
}


/* Function: my_func @ 0xB60 */
__int64 __fastcall my_func(int a1)
{
  return (unsigned int)(10 * a1);
}


/* Function: param_token_paste @ 0xB70 */
__int64 __fastcall param_token_paste(int a1)
{
  return (unsigned int)(a1 + 5 + 10 * a1);
}


/* Function: call_token_paste @ 0xB80 */
__int64 call_token_paste()
{
  return 60;
}


/* Function: param_variadic_macro @ 0xB90 */
__int64 __fastcall param_variadic_macro(int a1, int a2, int a3)
{
  __printf_chk(1, "LOG: Values: %d, %d, %d\n", a1, a2, a3);
  return (unsigned int)(a1 + 50);
}


/* Function: call_variadic_macro @ 0xBD0 */
__int64 call_variadic_macro()
{
  __printf_chk(1, "LOG: Values: %d, %d, %d\n", 10, 20, 30);
  return 60;
}


/* Function: param_macro_override @ 0xC00 */
__int64 __fastcall param_macro_override(int a1)
{
  return (unsigned int)(3 * a1 + 1);
}


/* Function: call_macro_override @ 0xC10 */
__int64 call_macro_override()
{
  return 16;
}


/* Function: param_include_guard @ 0xC20 */
__int64 param_include_guard()
{
  return 500;
}


/* Function: call_include_guard @ 0xC30 */
__int64 call_include_guard()
{
  return 500;
}


/* Function: param_builtin_macros @ 0xC40 */
__int64 __fastcall param_builtin_macros(int a1)
{
  __printf_chk(
    1,
    "file=%s, func=%s, line=%d, date=%s, time=%s\n",
    "src/5-23.c",
    "param_builtin_macros",
    279,
    "Jan 15 2026",
    "03:01:33");
  return (unsigned int)(a1 + 282);
}


/* Function: call_builtin_macros @ 0xC94 */
__int64 call_builtin_macros()
{
  __printf_chk(
    1,
    "file=%s, func=%s, line=%d, date=%s, time=%s\n",
    "src/5-23.c",
    "param_builtin_macros",
    279,
    "Jan 15 2026",
    "03:01:33");
  return 382;
}


/* Function: test_preprocessing_features @ 0xCE0 */
__int64 test_preprocessing_features()
{
  __printf_chk(1, asc_14D0);
  __printf_chk(1, aPpL201D, 64);
  __printf_chk(1, aPpL202D, 30);
  __printf_chk(1, aPpL203D, 32);
  __printf_chk(1, aPpL204D, 57122);
  __printf_chk(1, aPpL301D, 116);
  __printf_chk(1, aPpL302D, 19);
  __printf_chk(1, aPpL303D, 60);
  __printf_chk(1, "LOG: Values: %d, %d, %d\n", 10, 20, 30);
  __printf_chk(1, aPpL304D, 60);
  __printf_chk(1, aPpL305D, 16);
  __printf_chk(1, aPpL306D, 500);
  __printf_chk(
    1,
    "file=%s, func=%s, line=%d, date=%s, time=%s\n",
    "src/5-23.c",
    "param_builtin_macros",
    279,
    "Jan 15 2026",
    "03:01:33");
  return __printf_chk(1, aPpL307D, 382);
}


/* Function: param_asm_basic @ 0xE30 */
__int64 __fastcall param_asm_basic(int a1)
{
  return (unsigned int)(a1 + 10);
}


/* Function: call_asm_basic @ 0xE40 */
__int64 call_asm_basic()
{
  return 15;
}


/* Function: param_asm_clobber @ 0xE50 */
__int64 __fastcall param_asm_clobber(int32x4_t *a1, int a2)
{
  int32x4_t *v3; // x2
  int32x4_t v4; // q0
  int32x4_t v5; // t1
  int v6; // w2
  __int64 result; // x0
  char *v8; // x4

  if ( a2 <= 0 )
    return 0;
  if ( (unsigned int)(a2 - 1) <= 2 )
  {
    v6 = 0;
    LODWORD(result) = 0;
  }
  else
  {
    v3 = a1;
    v4 = 0u;
    do
    {
      v5 = *v3++;
      v4 = vaddq_s32(v4, v5);
    }
    while ( v3 != &a1[(unsigned int)a2 >> 2] );
    v6 = a2 & 0x7FFFFFFC;
    result = (unsigned int)vaddvq_s32(v4);
    if ( (a2 & 3) == 0 )
      return result;
  }
  result = (unsigned int)(result + a1->n128_u32[v6]);
  if ( a2 > v6 + 1 )
  {
    v8 = (char *)a1 + 4 * v6;
    result = (unsigned int)(result + *((_DWORD *)v8 + 1));
    if ( a2 > v6 + 2 )
      return (unsigned int)(result + *((_DWORD *)v8 + 2));
  }
  return result;
}


/* Function: call_asm_clobber @ 0xEF4 */
__int64 call_asm_clobber()
{
  return 15;
}


/* Function: param_asm_multi_insn @ 0xF00 */
// attributes: thunk
void *param_asm_multi_insn(void *dest, const void *src, size_t n)
{
  return memcpy(dest, src, n);
}


/* Function: call_asm_multi_insn @ 0xF04 */
__int64 call_asm_multi_insn()
{
  return 42;
}


/* Function: param_asm_simd @ 0xF10 */
__int64 __fastcall param_asm_simd(int32x4_t *a1, int32x4_t *a2, int32x4_t *a3)
{
  unsigned __int64 v3; // x3
  bool v4; // cf
  bool v5; // zf
  int32x4_t v6; // q0
  __int64 result; // x0

  v3 = (char *)a3 - (char *)&a2->n128_u8[4];
  if ( (unsigned __int64)((char *)a3 - (char *)&a1->n128_u8[4]) > 8 )
  {
    v4 = v3 >= 8;
    v5 = v3 == 8;
  }
  else
  {
    v4 = 0;
    v5 = 0;
  }
  if ( !v5 && v4 )
  {
    v6 = *a1;
    result = 0;
    *a3 = vaddq_s32(v6, *a2);
  }
  else
  {
    a3->n128_u32[0] = a1->n128_u32[0] + a2->n128_u32[0];
    a3->n128_u32[1] = a1->n128_u32[1] + a2->n128_u32[1];
    a3->n128_u32[2] = a1->n128_u32[2] + a2->n128_u32[2];
    a3->n128_u32[3] = a1->n128_u32[3] + a2->n128_u32[3];
    return 0;
  }
  return result;
}


/* Function: param_simd_intrinsics @ 0xF90 */
__int64 __fastcall param_simd_intrinsics(int32x4_t *a1, int32x4_t *a2, int32x4_t *a3)
{
  unsigned __int64 v3; // x3
  bool v4; // cf
  bool v5; // zf
  int32x4_t v6; // q0
  __int64 result; // x0

  v3 = (char *)a3 - (char *)&a2->n128_u8[4];
  if ( (unsigned __int64)((char *)a3 - (char *)&a1->n128_u8[4]) > 8 )
  {
    v4 = v3 >= 8;
    v5 = v3 == 8;
  }
  else
  {
    v4 = 0;
    v5 = 0;
  }
  if ( !v5 && v4 )
  {
    v6 = *a1;
    result = 0;
    *a3 = vaddq_s32(v6, *a2);
  }
  else
  {
    a3->n128_u32[0] = a1->n128_u32[0] + a2->n128_u32[0];
    a3->n128_u32[1] = a1->n128_u32[1] + a2->n128_u32[1];
    a3->n128_u32[2] = a1->n128_u32[2] + a2->n128_u32[2];
    a3->n128_u32[3] = a1->n128_u32[3] + a2->n128_u32[3];
    return 0;
  }
  return result;
}


/* Function: call_asm_simd @ 0x1010 */
__int64 call_asm_simd()
{
  return 36;
}


/* Function: param_asm_atomic @ 0x1020 */
__int64 __fastcall param_asm_atomic(__int64 a1, unsigned int a2)
{
  return (unsigned int)_aarch64_ldadd4_acq_rel(a2, a1) + a2;
}


/* Function: param_atomic_c11 @ 0x1050 */
__int64 __fastcall param_atomic_c11(__int64 a1, unsigned int a2)
{
  return (unsigned int)_aarch64_ldadd4_acq_rel(a2, a1) + a2;
}


/* Function: call_asm_atomic @ 0x1080 */
__int64 call_asm_atomic()
{
  int v0; // w0
  int v2; // [xsp+14h] [xbp+14h] BYREF

  v2 = 10;
  v0 = _aarch64_ldadd4_acq_rel(5, &v2);
  return (unsigned int)(v0 + 5 + v2);
}


/* Function: param_dynamic_code @ 0x10E4 */
__int64 __fastcall param_dynamic_code(int a1)
{
  size_t v2; // x20
  void *v3; // x0
  unsigned int v4; // w19

  v2 = sysconf(30);
  v3 = mmap(0, v2, 7, 34, -1, 0);
  if ( v3 == (void *)-1LL )
  {
    return (unsigned int)-1;
  }
  else
  {
    v4 = a1 + 5;
    munmap(v3, v2);
  }
  return v4;
}


/* Function: param_memory_protection @ 0x1150 */
__int64 param_memory_protection()
{
  size_t v0; // x20
  _DWORD *v1; // x0
  _DWORD *v2; // x19
  unsigned int v3; // w21

  v0 = sysconf(30);
  v1 = mmap(0, v0, 3, 34, -1, 0);
  v2 = v1;
  if ( v1 == (_DWORD *)-1LL )
  {
    return (unsigned int)-1;
  }
  else
  {
    *v1 = 42;
    if ( mprotect(v1, v0, 1) )
    {
      v3 = -2;
      munmap(v2, v0);
    }
    else
    {
      v3 = *v2;
      if ( mprotect(v2, v0, 3) )
        v3 = -3;
      else
        *v2 = 100;
      munmap(v2, v0);
    }
  }
  return v3;
}


/* Function: param_clobber_importance @ 0x1220 */
__int64 __fastcall param_clobber_importance(int a1, int a2)
{
  return (unsigned int)(2 * (a1 + a2));
}


/* Function: call_asm_privileged @ 0x1230 */
__int64 call_asm_privileged()
{
  size_t v0; // x20
  void *v1; // x0

  v0 = sysconf(30);
  v1 = mmap(0, v0, 7, 34, -1, 0);
  if ( v1 == (void *)-1LL )
  {
    param_memory_protection();
    return 0xFFFFFFFFLL;
  }
  else
  {
    munmap(v1, v0);
    if ( (unsigned int)param_memory_protection() == 42 )
      return 77;
    else
      return 15;
  }
}


/* Function: param_memory_clobber_demo @ 0x12A4 */
__int64 param_memory_clobber_demo()
{
  return (unsigned int)(global_var + 50);
}


/* Function: test_asm_features @ 0x12B4 */
__int64 test_asm_features()
{
  int v0; // w0
  size_t v1; // x20
  void *v2; // x0
  __int64 v3; // x2
  int v5; // [xsp+24h] [xbp+24h] BYREF
  __int64 v6; // [xsp+28h] [xbp+28h]

  __printf_chk(1, asc_1678, &_stack_chk_guard, 0);
  __printf_chk(1, aAsmL401D, 15);
  __printf_chk(1, aAsmL402D, 15);
  __printf_chk(1, aAsmL403D, 42);
  __printf_chk(1, aAsmL404D, 36);
  v5 = 10;
  v0 = _aarch64_ldadd4_acq_rel(5, &v5);
  __printf_chk(1, aAsmL405D, (unsigned int)(v0 + 5 + v5));
  v1 = sysconf(30);
  v2 = mmap(0, v1, 7, 34, -1, 0);
  if ( v2 == (void *)-1LL )
  {
    param_memory_protection();
    v3 = 0xFFFFFFFFLL;
  }
  else
  {
    munmap(v2, v1);
    if ( (unsigned int)param_memory_protection() == 42 )
      v3 = 77;
    else
      v3 = 15;
  }
  return __printf_chk(1, aAsmL406D, v3, v6 - _stack_chk_guard);
}


/* Function: __aarch64_ldadd4_acq_rel @ 0x1400 */
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


/* Function: .term_proc @ 0x1430 */
void term_proc()
{
  ;
}


/* FAILED to decompile: memcpy @ 0x13078 */

/* FAILED to decompile: __libc_start_main @ 0x13080 */

/* FAILED to decompile: __cxa_finalize @ 0x13088 */

/* FAILED to decompile: __printf_chk @ 0x13090 */

/* FAILED to decompile: __stack_chk_fail @ 0x13098 */

/* FAILED to decompile: __getauxval @ 0x130A8 */

/* FAILED to decompile: abort @ 0x130B0 */

/* FAILED to decompile: mmap @ 0x130B8 */

/* FAILED to decompile: munmap @ 0x130C0 */

/* FAILED to decompile: sysconf @ 0x130C8 */

/* FAILED to decompile: mprotect @ 0x130D0 */

/* FAILED to decompile: __gmon_start__ @ 0x130E0 */

/* Total functions decompiled: 54, failed: 12 */
