/*
 * Decompiled by IDA Pro 9.1 with Hex-Rays
 * Binary: /Users/eren/Desktop/Antigravity/compiler/build/arm64/5-23/5-23_gcc_O0_no_g
 * Processor: arm
 */

/* Function: .init_proc @ 0x860 */
__int64 init_proc()
{
  return call_weak_fn();
}


/* Function: sub_880 @ 0x880 */
void sub_880()
{
  JUMPOUT(0);
}


/* Function: init_have_lse_atomics @ 0x980 */
__int64 init_have_lse_atomics()
{
  __int64 result; // x0

  result = ((unsigned int)__getauxval(16) >> 8) & 1;
  _aarch64_have_lse_atomics = result;
  return result;
}


/* Function: _start @ 0x9C0 */
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


/* Function: call_weak_fn @ 0x9F4 */
void *call_weak_fn()
{
  void *result; // x0

  result = &_gmon_start__;
  if ( &_gmon_start__ )
    return (void *)__gmon_start__();
  return result;
}


/* Function: deregister_tm_clones @ 0xA10 */
void *deregister_tm_clones()
{
  return &end;
}


/* Function: register_tm_clones @ 0xA40 */
void *register_tm_clones()
{
  return &end;
}


/* Function: __do_global_dtors_aux @ 0xA80 */
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


/* Function: frame_dummy @ 0xAD0 */
// attributes: thunk
void *frame_dummy()
{
  return register_tm_clones();
}


/* Function: param_macro_constants @ 0xAD4 */
__int64 __fastcall param_macro_constants(int a1)
{
  if ( a1 <= 1024 )
    return 512;
  else
    return 64;
}


/* Function: call_macro_constants @ 0xAFC */
__int64 call_macro_constants()
{
  return param_macro_constants(2048);
}


/* Function: param_macro_functions @ 0xB14 */
__int64 __fastcall param_macro_functions(int a1, int a2)
{
  int v2; // w1

  v2 = a1 * a1;
  if ( a2 >= a1 )
    a1 = a2;
  return (unsigned int)(v2 + a1);
}


/* Function: call_macro_functions @ 0xB48 */
__int64 call_macro_functions()
{
  return param_macro_functions(5, 3);
}


/* Function: param_conditional_compile @ 0xB64 */
__int64 __fastcall param_conditional_compile(int a1)
{
  return (unsigned int)(3 * a1 + 2);
}


/* Function: call_conditional_compile @ 0xB98 */
__int64 call_conditional_compile()
{
  return param_conditional_compile(10);
}


/* Function: param_multi_branch_compile @ 0xBB0 */
__int64 __fastcall param_multi_branch_compile(int a1)
{
  return (unsigned int)(5 * a1 + 57072);
}


/* Function: call_multi_branch_compile @ 0xBD8 */
__int64 call_multi_branch_compile()
{
  return param_multi_branch_compile(10);
}


/* Function: param_macro_recursion @ 0xBF0 */
__int64 __fastcall param_macro_recursion(int a1)
{
  return (unsigned int)(a1 + 16);
}


/* Function: call_macro_recursion @ 0xC08 */
__int64 call_macro_recursion()
{
  return param_macro_recursion(100);
}


/* Function: param_stringize @ 0xC20 */
__int64 param_stringize()
{
  int v0; // w19
  int v1; // w19

  v0 = strlen("Hello World");
  v1 = v0 + strlen("1.2.3");
  return v1 + (unsigned int)strlen("155");
}


/* Function: call_stringize @ 0xC84 */
__int64 call_stringize()
{
  return param_stringize();
}


/* Function: my_func @ 0xC9C */
__int64 __fastcall my_func(int a1)
{
  return (unsigned int)(10 * a1);
}


/* Function: param_token_paste @ 0xCC0 */
__int64 __fastcall param_token_paste(int a1)
{
  return (unsigned int)my_func(a1) + a1 + 5;
}


/* Function: call_token_paste @ 0xD00 */
__int64 call_token_paste()
{
  return param_token_paste(5);
}


/* Function: param_variadic_macro @ 0xD18 */
__int64 __fastcall param_variadic_macro(int a1, int a2, int a3)
{
  printf("LOG: Values: %d, %d, %d\n", a1, a2, a3);
  return (unsigned int)(a1 + 50);
}


/* Function: call_variadic_macro @ 0xDB0 */
__int64 call_variadic_macro()
{
  return param_variadic_macro(10, 20, 30);
}


/* Function: param_macro_override @ 0xDD0 */
__int64 __fastcall param_macro_override(int a1)
{
  return (unsigned int)(a1 + 1 + 2 * a1);
}


/* Function: call_macro_override @ 0xE04 */
__int64 call_macro_override()
{
  return param_macro_override(5);
}


/* Function: header_func @ 0xE1C */
__int64 __fastcall header_func(int a1)
{
  return (unsigned int)(100 * a1);
}


/* Function: param_include_guard @ 0xE38 */
__int64 param_include_guard()
{
  return header_func(5);
}


/* Function: call_include_guard @ 0xE50 */
__int64 call_include_guard()
{
  return param_include_guard();
}


/* Function: param_builtin_macros @ 0xE64 */
__int64 __fastcall param_builtin_macros(int a1)
{
  printf(
    "file=%s, func=%s, line=%d, date=%s, time=%s\n",
    "src/5-23.c",
    "param_builtin_macros",
    279,
    "Jan 15 2026",
    "03:01:26");
  return (unsigned int)(a1 + 282);
}


/* Function: call_builtin_macros @ 0xF08 */
__int64 call_builtin_macros()
{
  return param_builtin_macros(100);
}


/* Function: test_preprocessing_features @ 0xF20 */
__int64 test_preprocessing_features()
{
  unsigned int v0; // w0
  unsigned int v1; // w0
  unsigned int v2; // w0
  unsigned int v3; // w0
  unsigned int v4; // w0
  unsigned int v5; // w0
  unsigned int v6; // w0
  unsigned int v7; // w0
  unsigned int v8; // w0
  unsigned int v9; // w0
  unsigned int v10; // w0

  puts(asc_1840);
  v0 = call_macro_constants();
  printf(aPpL201D, v0);
  v1 = call_macro_functions();
  printf(aPpL202D, v1);
  v2 = call_conditional_compile();
  printf(aPpL203D, v2);
  v3 = call_multi_branch_compile();
  printf(aPpL204D, v3);
  v4 = call_macro_recursion();
  printf(aPpL301D, v4);
  v5 = call_stringize();
  printf(aPpL302D, v5);
  v6 = call_token_paste();
  printf(aPpL303D, v6);
  v7 = call_variadic_macro();
  printf(aPpL304D, v7);
  v8 = call_macro_override();
  printf(aPpL305D, v8);
  v9 = call_include_guard();
  printf(aPpL306D, v9);
  v10 = call_builtin_macros();
  return printf(aPpL307D, v10);
}


/* Function: param_asm_basic @ 0x101C */
__int64 __fastcall param_asm_basic(int a1)
{
  return (unsigned int)(a1 + 10);
}


/* Function: call_asm_basic @ 0x103C */
__int64 call_asm_basic()
{
  return param_asm_basic(5);
}


/* Function: param_asm_clobber @ 0x1054 */
__int64 __fastcall param_asm_clobber(__int64 a1, int a2)
{
  unsigned int v3; // [xsp+18h] [xbp-8h]
  int i; // [xsp+1Ch] [xbp-4h]

  v3 = 0;
  for ( i = 0; i < a2; ++i )
    v3 += *(_DWORD *)(a1 + 4LL * i);
  return v3;
}


/* Function: call_asm_clobber @ 0x10B4 */
__int64 call_asm_clobber()
{
  _QWORD v1[2]; // [xsp+10h] [xbp+10h] BYREF
  int v2; // [xsp+20h] [xbp+20h]

  v1[0] = 0x200000001LL;
  v1[1] = 0x400000003LL;
  v2 = 5;
  return (unsigned int)param_asm_clobber((__int64)v1, 5);
}


/* Function: param_asm_multi_insn @ 0x112C */
void *__fastcall param_asm_multi_insn(void *a1, const void *a2, size_t a3)
{
  return memcpy(a1, a2, a3);
}


/* Function: call_asm_multi_insn @ 0x115C */
__int64 call_asm_multi_insn()
{
  __int64 result; // x0
  char v1[16]; // [xsp+18h] [xbp+18h] BYREF
  _QWORD v2[4]; // [xsp+28h] [xbp+28h] BYREF

  strcpy(v1, "Hello ASM");
  memset(v2, 0, sizeof(v2));
  param_asm_multi_insn(v2, v1, 9u);
  if ( LOBYTE(v2[0]) == 72 && BYTE4(v2[0]) == 111 )
    LODWORD(result) = 42;
  else
    LODWORD(result) = -1;
  return (unsigned int)result;
}


/* Function: param_asm_simd @ 0x1200 */
__int64 __fastcall param_asm_simd(__int64 a1, __int64 a2, __int64 a3)
{
  int i; // [xsp+2Ch] [xbp-4h]

  for ( i = 0; i <= 3; ++i )
    *(_DWORD *)(a3 + 4LL * i) = *(_DWORD *)(a1 + 4LL * i) + *(_DWORD *)(a2 + 4LL * i);
  return 0;
}


/* Function: param_simd_intrinsics @ 0x127C */
__int64 __fastcall param_simd_intrinsics(__int64 a1, __int64 a2, __int64 a3)
{
  int i; // [xsp+2Ch] [xbp-4h]

  for ( i = 0; i <= 3; ++i )
    *(_DWORD *)(a3 + 4LL * i) = *(_DWORD *)(a1 + 4LL * i) + *(_DWORD *)(a2 + 4LL * i);
  return 0;
}


/* Function: call_asm_simd @ 0x12F8 */
__int64 call_asm_simd()
{
  _DWORD v1[4]; // [xsp+18h] [xbp+18h] BYREF
  _DWORD v2[4]; // [xsp+28h] [xbp+28h] BYREF
  _DWORD v3[4]; // [xsp+38h] [xbp+38h] BYREF

  v1[0] = 1;
  v1[1] = 2;
  v1[2] = 3;
  v1[3] = 4;
  v2[0] = 5;
  v2[1] = 6;
  v2[2] = 7;
  v2[3] = 8;
  param_asm_simd((__int64)v1, (__int64)v2, (__int64)v3);
  return (unsigned int)(v3[0] + v3[1] + v3[2] + v3[3]);
}


/* Function: param_asm_atomic @ 0x13B0 */
__int64 __fastcall param_asm_atomic(__int64 a1, unsigned int a2)
{
  return (unsigned int)_aarch64_ldadd4_acq_rel(a2, a1) + a2;
}


/* Function: param_atomic_c11 @ 0x13E4 */
__int64 __fastcall param_atomic_c11(__int64 a1, unsigned int a2)
{
  return (unsigned int)_aarch64_ldadd4_acq_rel(a2, a1) + a2;
}


/* Function: call_asm_atomic @ 0x1414 */
__int64 call_asm_atomic()
{
  int v1; // [xsp+10h] [xbp+10h] BYREF
  int v2; // [xsp+14h] [xbp+14h]

  v1 = 10;
  v2 = param_asm_atomic((__int64)&v1, 5u);
  return (unsigned int)(v1 + v2);
}


/* Function: param_dynamic_code @ 0x1484 */
__int64 __fastcall param_dynamic_code(int a1)
{
  __int64 len; // [xsp+30h] [xbp+30h]
  void *addr; // [xsp+38h] [xbp+38h]

  len = sysconf(30);
  addr = mmap(0, len, 7, 34, -1, 0);
  if ( addr == (void *)-1LL )
    return 0xFFFFFFFFLL;
  munmap(addr, len);
  return (unsigned int)(a1 + 5);
}


/* Function: param_memory_protection @ 0x14F4 */
__int64 param_memory_protection()
{
  unsigned int v1; // [xsp+14h] [xbp+14h]
  __int64 len; // [xsp+18h] [xbp+18h]
  _DWORD *addr; // [xsp+20h] [xbp+20h]

  len = sysconf(30);
  addr = mmap(0, len, 3, 34, -1, 0);
  if ( addr == (_DWORD *)-1LL )
    return 0xFFFFFFFFLL;
  *addr = 42;
  if ( mprotect(addr, len, 1) )
  {
    munmap(addr, len);
    return 4294967294LL;
  }
  else
  {
    v1 = *addr;
    if ( mprotect(addr, len, 3) )
    {
      munmap(addr, len);
      return 4294967293LL;
    }
    else
    {
      *addr = 100;
      munmap(addr, len);
      return v1;
    }
  }
}


/* Function: param_clobber_importance @ 0x15D8 */
__int64 __fastcall param_clobber_importance(int a1, int a2)
{
  return (unsigned int)(2 * (a1 + a2));
}


/* Function: call_asm_privileged @ 0x15FC */
__int64 call_asm_privileged()
{
  unsigned int v1; // [xsp+14h] [xbp+14h]
  int v2; // [xsp+18h] [xbp+18h]
  int v3; // [xsp+1Ch] [xbp+1Ch]

  v1 = param_dynamic_code(10);
  v2 = param_memory_protection();
  v3 = param_clobber_importance(3, 7);
  if ( v1 == 15 && v2 == 42 && v3 == 20 )
    return 77;
  else
    return v1;
}


/* Function: param_memory_clobber_demo @ 0x1660 */
__int64 param_memory_clobber_demo()
{
  return (unsigned int)(global_var + 50);
}


/* Function: test_asm_features @ 0x1690 */
__int64 test_asm_features()
{
  unsigned int v0; // w0
  unsigned int v1; // w0
  unsigned int v2; // w0
  unsigned int v3; // w0
  unsigned int v4; // w0
  unsigned int v5; // w0

  puts(asc_1A10);
  v0 = call_asm_basic();
  printf(aAsmL401D, v0);
  v1 = call_asm_clobber();
  printf(aAsmL402D, v1);
  v2 = call_asm_multi_insn();
  printf(aAsmL403D, v2);
  v3 = call_asm_simd();
  printf(aAsmL404D, v3);
  v4 = call_asm_atomic();
  printf(aAsmL405D, v4);
  v5 = call_asm_privileged();
  return printf(aAsmL406D, v5);
}


/* Function: main @ 0x1728 */
int __fastcall main(int argc, const char **argv, const char **envp)
{
  test_preprocessing_features();
  test_asm_features();
  return 0;
}


/* Function: __aarch64_ldadd4_acq_rel @ 0x1750 */
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


/* Function: .term_proc @ 0x1780 */
void term_proc()
{
  ;
}


/* FAILED to decompile: memcpy @ 0x13078 */

/* FAILED to decompile: strlen @ 0x13080 */

/* FAILED to decompile: __libc_start_main @ 0x13088 */

/* FAILED to decompile: __cxa_finalize @ 0x13090 */

/* FAILED to decompile: __stack_chk_fail @ 0x13098 */

/* FAILED to decompile: __getauxval @ 0x130A8 */

/* FAILED to decompile: abort @ 0x130B0 */

/* FAILED to decompile: puts @ 0x130B8 */

/* FAILED to decompile: mmap @ 0x130C0 */

/* FAILED to decompile: munmap @ 0x130C8 */

/* FAILED to decompile: sysconf @ 0x130D0 */

/* FAILED to decompile: printf @ 0x130D8 */

/* FAILED to decompile: mprotect @ 0x130E0 */

/* FAILED to decompile: __gmon_start__ @ 0x130F0 */

/* Total functions decompiled: 55, failed: 14 */
