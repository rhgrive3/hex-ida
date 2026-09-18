/*
 * Decompiled by IDA Pro 9.1 with Hex-Rays
 * Binary: /Users/eren/Desktop/Antigravity/compiler/build/arm64/5-23/5-23_gcc_O3_g
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
  test_preprocessing_features();
  test_asm_features();
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
int __fastcall param_macro_constants(int size)
{
  if ( size > 1024 )
    return 64;
  else
    return 512;
}


/* Function: call_macro_constants @ 0xAB4 */
int __cdecl call_macro_constants()
{
  return 64;
}


/* Function: param_macro_functions @ 0xAC0 */
int __fastcall param_macro_functions(int x, int y)
{
  if ( x >= y )
    y = x;
  return y + x * x;
}


/* Function: call_macro_functions @ 0xAD0 */
int __cdecl call_macro_functions()
{
  return 30;
}


/* Function: param_conditional_compile @ 0xAE0 */
int __fastcall param_conditional_compile(int x)
{
  return 3 * x + 2;
}


/* Function: call_conditional_compile @ 0xAF0 */
int __cdecl call_conditional_compile()
{
  return 32;
}


/* Function: param_multi_branch_compile @ 0xB00 */
int __fastcall param_multi_branch_compile(int x)
{
  return 5 * x + 57072;
}


/* Function: call_multi_branch_compile @ 0xB10 */
int __cdecl call_multi_branch_compile()
{
  return 57122;
}


/* Function: param_macro_recursion @ 0xB20 */
int __fastcall param_macro_recursion(int x)
{
  return x + 16;
}


/* Function: call_macro_recursion @ 0xB30 */
int __cdecl call_macro_recursion()
{
  return 116;
}


/* Function: param_stringize @ 0xB40 */
int __fastcall param_stringize(int value)
{
  return 19;
}


/* Function: call_stringize @ 0xB50 */
int __cdecl call_stringize()
{
  return 19;
}


/* Function: my_func @ 0xB60 */
int __fastcall my_func(int x)
{
  return 10 * x;
}


/* Function: param_token_paste @ 0xB70 */
int __fastcall param_token_paste(int x)
{
  return x + 5 + 10 * x;
}


/* Function: call_token_paste @ 0xB80 */
int __cdecl call_token_paste()
{
  return 60;
}


/* Function: param_variadic_macro @ 0xB90 */
int __fastcall param_variadic_macro(int x, int y, int z)
{
  __printf_chk(1, "LOG: Values: %d, %d, %d\n", x, y, z);
  return x + 50;
}


/* Function: call_variadic_macro @ 0xBD0 */
int __cdecl call_variadic_macro()
{
  __printf_chk(1, "LOG: Values: %d, %d, %d\n", 10, 20, 30);
  return 60;
}


/* Function: param_macro_override @ 0xC00 */
int __fastcall param_macro_override(int x)
{
  return 3 * x + 1;
}


/* Function: call_macro_override @ 0xC10 */
int __cdecl call_macro_override()
{
  return 16;
}


/* Function: param_include_guard @ 0xC20 */
int __cdecl param_include_guard()
{
  return 500;
}


/* Function: call_include_guard @ 0xC30 */
__int64 call_include_guard()
{
  return 500;
}


/* Function: param_builtin_macros @ 0xC40 */
int __fastcall param_builtin_macros(int x)
{
  __printf_chk(
    1,
    "file=%s, func=%s, line=%d, date=%s, time=%s\n",
    "src/5-23.c",
    "param_builtin_macros",
    279,
    "Jan 15 2026",
    "03:01:31");
  return x + 282;
}


/* Function: call_builtin_macros @ 0xC94 */
int __cdecl call_builtin_macros()
{
  __printf_chk(
    1,
    "file=%s, func=%s, line=%d, date=%s, time=%s\n",
    "src/5-23.c",
    "param_builtin_macros",
    279,
    "Jan 15 2026",
    "03:01:31");
  return 382;
}


/* Function: test_preprocessing_features @ 0xCE0 */
void __cdecl test_preprocessing_features()
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
    "03:01:31");
  __printf_chk(1, aPpL307D, 382);
}


/* Function: param_asm_basic @ 0xE30 */
int __fastcall param_asm_basic(int x)
{
  return x + 10;
}


/* Function: call_asm_basic @ 0xE40 */
int __cdecl call_asm_basic()
{
  return 15;
}


/* Function: param_asm_clobber @ 0xE50 */
int __fastcall param_asm_clobber(int *arr, int n)
{
  int *v3; // x2
  int32x4_t v4; // q0
  int32x4_t v5; // t1
  int v6; // w2
  int result; // w0
  int *v8; // x4

  if ( n <= 0 )
    return 0;
  if ( (unsigned int)(n - 1) <= 2 )
  {
    v6 = 0;
    result = 0;
  }
  else
  {
    v3 = arr;
    v4 = 0u;
    do
    {
      v5 = *(int32x4_t *)v3;
      v3 += 4;
      v4 = vaddq_s32(v4, v5);
    }
    while ( v3 != &arr[4 * ((unsigned int)n >> 2)] );
    v6 = n & 0x7FFFFFFC;
    result = vaddvq_s32(v4);
    if ( (n & 3) == 0 )
      return result;
  }
  result += arr[v6];
  if ( n > v6 + 1 )
  {
    v8 = &arr[v6];
    result += v8[1];
    if ( n > v6 + 2 )
      result += v8[2];
  }
  return result;
}


/* Function: call_asm_clobber @ 0xEF4 */
int __cdecl call_asm_clobber()
{
  return 15;
}


/* Function: param_asm_multi_insn @ 0xF00 */
// attributes: thunk
void __fastcall param_asm_multi_insn(void *dst, const void *src, size_t n)
{
  memcpy(dst, src, n);
}


/* Function: call_asm_multi_insn @ 0xF04 */
int __cdecl call_asm_multi_insn()
{
  return 42;
}


/* Function: param_asm_simd @ 0xF10 */
int __fastcall param_asm_simd(int *a, int *b, int *result)
{
  unsigned __int64 v3; // x3
  bool v4; // cf
  bool v5; // zf
  int32x4_t v6; // q0
  int v7; // w0

  v3 = (char *)result - (char *)(b + 1);
  if ( (unsigned __int64)((char *)result - (char *)(a + 1)) > 8 )
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
    v6 = *(int32x4_t *)a;
    v7 = 0;
    *(int32x4_t *)result = vaddq_s32(v6, *(int32x4_t *)b);
  }
  else
  {
    *result = *a + *b;
    result[1] = a[1] + b[1];
    result[2] = a[2] + b[2];
    result[3] = a[3] + b[3];
    return 0;
  }
  return v7;
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
int __cdecl call_asm_simd()
{
  return 36;
}


/* Function: param_asm_atomic @ 0x1020 */
int __fastcall param_asm_atomic(int *counter, int increment)
{
  return _aarch64_ldadd4_acq_rel((unsigned int)increment, counter) + increment;
}


/* Function: param_atomic_c11 @ 0x1050 */
int __fastcall param_atomic_c11(int *counter, int increment)
{
  return _aarch64_ldadd4_acq_rel((unsigned int)increment, counter) + increment;
}


/* Function: call_asm_atomic @ 0x1080 */
int __cdecl call_asm_atomic()
{
  int v0; // w0
  int counter; // [xsp+14h] [xbp+14h] BYREF

  counter = 10;
  v0 = _aarch64_ldadd4_acq_rel(5, &counter);
  return v0 + 5 + counter;
}


/* Function: param_dynamic_code @ 0x10E4 */
int __fastcall param_dynamic_code(int x)
{
  size_t v2; // x20
  void *v3; // x0
  int v4; // w19

  v2 = sysconf(30);
  v3 = mmap(0, v2, 7, 34, -1, 0);
  if ( v3 == (void *)-1LL )
    return -1;
  v4 = x + 5;
  munmap(v3, v2);
  return v4;
}


/* Function: param_memory_protection @ 0x1150 */
int __cdecl param_memory_protection()
{
  size_t v0; // x20
  int *v1; // x0
  int *v2; // x19
  int v3; // w21

  v0 = sysconf(30);
  v1 = (int *)mmap(0, v0, 3, 34, -1, 0);
  v2 = v1;
  if ( v1 == (int *)-1LL )
    return -1;
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
  return v3;
}


/* Function: param_clobber_importance @ 0x1220 */
int __fastcall param_clobber_importance(int a, int b)
{
  return 2 * (a + b);
}


/* Function: call_asm_privileged @ 0x1230 */
int __cdecl call_asm_privileged()
{
  size_t v0; // x20
  void *v1; // x0

  v0 = sysconf(30);
  v1 = mmap(0, v0, 7, 34, -1, 0);
  if ( v1 == (void *)-1LL )
  {
    param_memory_protection();
    return -1;
  }
  else
  {
    munmap(v1, v0);
    if ( param_memory_protection() == 42 )
      return 77;
    else
      return 15;
  }
}


/* Function: param_memory_clobber_demo @ 0x12A4 */
int __cdecl param_memory_clobber_demo()
{
  return global_var + 50;
}


/* Function: test_asm_features @ 0x12B4 */
void __cdecl test_asm_features()
{
  int v0; // w0
  size_t v1; // x20
  void *v2; // x0
  __int64 v3; // x2
  int v4; // [xsp+24h] [xbp+24h] BYREF
  __int64 v5; // [xsp+28h] [xbp+28h]

  __printf_chk(1, asc_1678, &_stack_chk_guard, 0);
  __printf_chk(1, aAsmL401D, 15);
  __printf_chk(1, aAsmL402D, 15);
  __printf_chk(1, aAsmL403D, 42);
  __printf_chk(1, aAsmL404D, 36);
  v4 = 10;
  v0 = _aarch64_ldadd4_acq_rel(5, &v4);
  __printf_chk(1, aAsmL405D, (unsigned int)(v0 + 5 + v4));
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
    if ( param_memory_protection() == 42 )
      v3 = 77;
    else
      v3 = 15;
  }
  __printf_chk(1, aAsmL406D, v3, v5 - _stack_chk_guard);
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
