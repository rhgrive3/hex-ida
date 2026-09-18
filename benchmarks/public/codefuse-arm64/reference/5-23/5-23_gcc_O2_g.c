/*
 * Decompiled by IDA Pro 9.1 with Hex-Rays
 * Binary: /Users/eren/Desktop/Antigravity/compiler/build/arm64/5-23/5-23_gcc_O2_g
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
    "03:01:29");
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
    "03:01:29");
  return 382;
}


/* Function: test_preprocessing_features @ 0xCE0 */
void __cdecl test_preprocessing_features()
{
  __printf_chk(1, asc_1550);
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
    "03:01:29");
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
  __int64 v3; // x2
  int result; // w0
  int v5; // w3

  if ( n <= 0 )
    return 0;
  v3 = 0;
  result = 0;
  do
  {
    v5 = arr[v3++];
    result += v5;
  }
  while ( n > (int)v3 );
  return result;
}


/* Function: call_asm_clobber @ 0xE90 */
int __cdecl call_asm_clobber()
{
  __int64 v0; // x1
  int result; // w0
  int *v2; // x2
  int arr[5]; // [xsp+10h] [xbp+10h] BYREF

  v0 = 1;
  result = 0;
  *(_QWORD *)arr = 0x200000001LL;
  *(_QWORD *)&arr[2] = 0x400000003LL;
  arr[4] = 5;
  do
  {
    v2 = &arr[v0++];
    result += *(v2 - 1);
  }
  while ( v0 != 6 );
  return result;
}


/* Function: param_asm_multi_insn @ 0xF10 */
// attributes: thunk
void __fastcall param_asm_multi_insn(void *dst, const void *src, size_t n)
{
  memcpy(dst, src, n);
}


/* Function: call_asm_multi_insn @ 0xF14 */
int __cdecl call_asm_multi_insn()
{
  return 42;
}


/* Function: param_asm_simd @ 0xF20 */
int __fastcall param_asm_simd(int *a, int *b, int *result)
{
  __int64 i; // x3

  for ( i = 0; i != 4; ++i )
    result[i] = a[i] + b[i];
  return 0;
}


/* Function: param_simd_intrinsics @ 0xF50 */
__int64 __fastcall param_simd_intrinsics(__int64 a1, __int64 a2, __int64 a3)
{
  __int64 i; // x3

  for ( i = 0; i != 16; i += 4 )
    *(_DWORD *)(a3 + i) = *(_DWORD *)(a1 + i) + *(_DWORD *)(a2 + i);
  return 0;
}


/* Function: call_asm_simd @ 0xF80 */
int __cdecl call_asm_simd()
{
  __int64 v0; // x0
  int *v1; // x1
  int *v2; // x2
  int *v3; // x3
  int a[4]; // [xsp+18h] [xbp+18h] BYREF
  int b[4]; // [xsp+28h] [xbp+28h] BYREF
  int result[4]; // [xsp+38h] [xbp+38h] BYREF

  *(_QWORD *)b = 0x600000005LL;
  *(_QWORD *)&b[2] = 0x800000007LL;
  v0 = 2;
  result[0] = 6;
  *(_QWORD *)a = 0x200000001LL;
  *(_QWORD *)&a[2] = 0x400000003LL;
  do
  {
    v1 = &a[v0];
    v2 = &b[v0];
    v3 = &result[v0++];
    *(v3 - 1) = *(v1 - 1) + *(v2 - 1);
  }
  while ( v0 != 5 );
  return result[0] + result[1] + result[2] + result[3];
}


/* Function: param_asm_atomic @ 0x1060 */
int __fastcall param_asm_atomic(int *counter, int increment)
{
  return _aarch64_ldadd4_acq_rel((unsigned int)increment, counter) + increment;
}


/* Function: param_atomic_c11 @ 0x1090 */
int __fastcall param_atomic_c11(int *counter, int increment)
{
  return _aarch64_ldadd4_acq_rel((unsigned int)increment, counter) + increment;
}


/* Function: call_asm_atomic @ 0x10C0 */
int __cdecl call_asm_atomic()
{
  int v0; // w0
  int counter; // [xsp+14h] [xbp+14h] BYREF

  counter = 10;
  v0 = _aarch64_ldadd4_acq_rel(5, &counter);
  return v0 + 5 + counter;
}


/* Function: param_dynamic_code @ 0x1124 */
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


/* Function: param_memory_protection @ 0x1190 */
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


/* Function: param_clobber_importance @ 0x1260 */
int __fastcall param_clobber_importance(int a, int b)
{
  return 2 * (a + b);
}


/* Function: call_asm_privileged @ 0x1270 */
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


/* Function: param_memory_clobber_demo @ 0x12E4 */
int __cdecl param_memory_clobber_demo()
{
  return global_var + 50;
}


/* Function: test_asm_features @ 0x12F4 */
void __cdecl test_asm_features()
{
  __int64 v0; // x0
  __int64 v1; // x2
  char *v2; // x1
  unsigned int v3; // w0
  int v4; // w0
  size_t v5; // x20
  void *v6; // x0
  __int64 v7; // x2
  int v8; // [xsp+2Ch] [xbp+2Ch] BYREF
  _QWORD v9[2]; // [xsp+30h] [xbp+30h] BYREF
  int v10; // [xsp+40h] [xbp+40h]
  __int64 v11; // [xsp+48h] [xbp+48h]

  __printf_chk(1, asc_16F8, &_stack_chk_guard, 0);
  __printf_chk(1, aAsmL401D, 15);
  v0 = 1;
  LODWORD(v1) = 0;
  v9[0] = 0x200000001LL;
  v9[1] = 0x400000003LL;
  v10 = 5;
  do
  {
    v2 = (char *)v9 + 4 * v0++;
    v1 = (unsigned int)(v1 + *((_DWORD *)v2 - 1));
  }
  while ( v0 != 6 );
  __printf_chk(1, aAsmL402D, v1);
  __printf_chk(1, aAsmL403D, 42);
  v3 = call_asm_simd();
  __printf_chk(1, aAsmL404D, v3);
  v8 = 10;
  v4 = _aarch64_ldadd4_acq_rel(5, &v8);
  __printf_chk(1, aAsmL405D, (unsigned int)(v4 + 5 + v8));
  v5 = sysconf(30);
  v6 = mmap(0, v5, 7, 34, -1, 0);
  if ( v6 == (void *)-1LL )
  {
    param_memory_protection();
    v7 = 0xFFFFFFFFLL;
  }
  else
  {
    munmap(v6, v5);
    if ( param_memory_protection() == 42 )
      v7 = 77;
    else
      v7 = 15;
  }
  __printf_chk(1, aAsmL406D, v7, v11 - _stack_chk_guard);
}


/* Function: __aarch64_ldadd4_acq_rel @ 0x1480 */
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


/* Function: .term_proc @ 0x14B0 */
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
