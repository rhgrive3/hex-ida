/*
 * Decompiled by IDA Pro 9.1 with Hex-Rays
 * Binary: /Users/eren/Desktop/Antigravity/compiler/build/arm64/5-23/5-23_clang_O0_g
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
int __cdecl param_macro_constants(int size)
{
  if ( size <= 1024 )
    return 512;
  else
    return 64;
}


/* Function: call_macro_constants @ 0xA10 */
int __cdecl call_macro_constants()
{
  return param_macro_constants(2048);
}


/* Function: param_macro_functions @ 0xA28 */
int __cdecl param_macro_functions(int x, int y)
{
  int v3; // [xsp+0h] [xbp-10h]

  if ( x <= y )
    v3 = y;
  else
    v3 = x;
  return x * x + v3;
}


/* Function: call_macro_functions @ 0xA84 */
int __cdecl call_macro_functions()
{
  return param_macro_functions(5, 3);
}


/* Function: param_conditional_compile @ 0xAA0 */
int __cdecl param_conditional_compile(int x)
{
  return 3 * x + 2;
}


/* Function: call_conditional_compile @ 0xAD0 */
int __cdecl call_conditional_compile()
{
  return param_conditional_compile(10);
}


/* Function: param_multi_branch_compile @ 0xAE8 */
int __cdecl param_multi_branch_compile(int x)
{
  return 5 * x + 57072;
}


/* Function: call_multi_branch_compile @ 0xB0C */
int __cdecl call_multi_branch_compile()
{
  return param_multi_branch_compile(10);
}


/* Function: param_macro_recursion @ 0xB24 */
int __cdecl param_macro_recursion(int x)
{
  return x + 16;
}


/* Function: call_macro_recursion @ 0xB78 */
int __cdecl call_macro_recursion()
{
  return param_macro_recursion(100);
}


/* Function: param_stringize @ 0xB90 */
int __cdecl param_stringize(int value)
{
  size_t v2; // [xsp+0h] [xbp-30h]
  size_t v3; // [xsp+8h] [xbp-28h]

  v2 = strlen("Hello World");
  v3 = v2 + strlen("1.2.3");
  return v3 + strlen("155");
}


/* Function: call_stringize @ 0xC08 */
int __cdecl call_stringize()
{
  return param_stringize(0);
}


/* Function: my_func @ 0xC20 */
int __cdecl my_func(int x)
{
  return 10 * x;
}


/* Function: param_token_paste @ 0xC3C */
int __cdecl param_token_paste(int x)
{
  return my_func(x) + x + 5;
}


/* Function: call_token_paste @ 0xC84 */
int __cdecl call_token_paste()
{
  return param_token_paste(5);
}


/* Function: param_variadic_macro @ 0xC9C */
__int64 __fastcall param_variadic_macro(int x, int y, int z)
{
  printf("LOG: Values: %d, %d, %d\n", x, y, z);
  return (unsigned int)(x + 50);
}


/* Function: call_variadic_macro @ 0xCF4 */
int __cdecl call_variadic_macro()
{
  return param_variadic_macro(10, 20, 30);
}


/* Function: param_macro_override @ 0xD14 */
int __cdecl param_macro_override(int x)
{
  return x + 1 + 2 * x;
}


/* Function: call_macro_override @ 0xD48 */
int __cdecl call_macro_override()
{
  return param_macro_override(5);
}


/* Function: param_include_guard @ 0xD60 */
int __cdecl param_include_guard()
{
  return header_func(5);
}


/* Function: header_func @ 0xD78 */
int __cdecl header_func(int x)
{
  return 100 * x;
}


/* Function: call_include_guard @ 0xD94 */
int __cdecl call_include_guard()
{
  return param_include_guard();
}


/* Function: param_builtin_macros @ 0xDA8 */
int __cdecl param_builtin_macros(int x)
{
  printf(
    "file=%s, func=%s, line=%d, date=%s, time=%s\n",
    "src/5-23.c",
    "param_builtin_macros",
    279,
    "Jan 15 2026",
    "03:01:37");
  return x + 282;
}


/* Function: call_builtin_macros @ 0xE54 */
int __cdecl call_builtin_macros()
{
  return param_builtin_macros(100);
}


/* Function: test_preprocessing_features @ 0xE6C */
void __cdecl test_preprocessing_features()
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

  printf(asc_1719);
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
  printf(aPpL307D, v10);
}


/* Function: param_asm_basic @ 0xF64 */
int __cdecl param_asm_basic(int x)
{
  return x + 10;
}


/* Function: call_asm_basic @ 0xF84 */
int __cdecl call_asm_basic()
{
  return param_asm_basic(5);
}


/* Function: param_asm_clobber @ 0xF9C */
int __cdecl param_asm_clobber(int *arr, int n)
{
  int i; // [xsp+Ch] [xbp-14h]
  int v4; // [xsp+10h] [xbp-10h]

  v4 = 0;
  for ( i = 0; i < n; ++i )
    v4 += arr[i];
  return v4;
}


/* Function: call_asm_clobber @ 0x1000 */
int __cdecl call_asm_clobber()
{
  __int128 v1; // [xsp+0h] [xbp-20h] BYREF
  int v2; // [xsp+10h] [xbp-10h]

  v1 = xmmword_196C;
  v2 = 5;
  return param_asm_clobber((int *)&v1, 5);
}


/* Function: param_asm_multi_insn @ 0x103C */
void __fastcall param_asm_multi_insn(void *dst, const void *src, size_t n)
{
  memcpy(dst, src, n);
}


/* Function: call_asm_multi_insn @ 0x1070 */
int __cdecl call_asm_multi_insn()
{
  bool v1; // [xsp+Ch] [xbp-34h]
  _OWORD dst[2]; // [xsp+10h] [xbp-30h] BYREF
  char src[16]; // [xsp+30h] [xbp-10h] BYREF

  strcpy(src, "Hello ASM");
  memset(dst, 0, sizeof(dst));
  param_asm_multi_insn(dst, src, 9u);
  v1 = 0;
  if ( LOBYTE(dst[0]) == 72 )
    v1 = BYTE4(dst[0]) == 111;
  if ( v1 )
    return 42;
  else
    return -1;
}


/* Function: param_asm_simd @ 0x10F8 */
int __cdecl param_asm_simd(int *a, int *b, int *result)
{
  int i; // [xsp+4h] [xbp-1Ch]

  for ( i = 0; i < 4; ++i )
    result[i] = a[i] + b[i];
  return 0;
}


/* Function: param_simd_intrinsics @ 0x1168 */
int __cdecl param_simd_intrinsics(int *a, int *b, int *result)
{
  int i; // [xsp+4h] [xbp-1Ch]

  for ( i = 0; i < 4; ++i )
    result[i] = a[i] + b[i];
  return 0;
}


/* Function: call_asm_simd @ 0x11D8 */
int __cdecl call_asm_simd()
{
  int v1[4]; // [xsp+0h] [xbp-30h] BYREF
  int b[4]; // [xsp+10h] [xbp-20h] BYREF
  int a[4]; // [xsp+20h] [xbp-10h] BYREF

  *(_OWORD *)a = xmmword_1980;
  *(_OWORD *)b = xmmword_1990;
  param_asm_simd(a, b, v1);
  return v1[0] + v1[1] + v1[2] + v1[3];
}


/* Function: param_asm_atomic @ 0x123C */
int __cdecl param_asm_atomic(int *counter, int increment)
{
  return _aarch64_ldadd4_acq_rel((unsigned int)increment, counter) + increment;
}


/* Function: param_atomic_c11 @ 0x1288 */
int __cdecl param_atomic_c11(int *counter, int increment)
{
  return _aarch64_ldadd4_acq_rel((unsigned int)increment, counter) + increment;
}


/* Function: call_asm_atomic @ 0x12CC */
int __cdecl call_asm_atomic()
{
  int v1; // [xsp+8h] [xbp-8h]
  int counter; // [xsp+Ch] [xbp-4h] BYREF

  counter = 10;
  v1 = param_asm_atomic(&counter, 5);
  return counter + v1;
}


/* Function: param_dynamic_code @ 0x1308 */
int __cdecl param_dynamic_code(int x)
{
  void *addr; // [xsp+8h] [xbp-18h]
  __int64 len; // [xsp+10h] [xbp-10h]

  len = sysconf(30);
  addr = mmap(0, len, 7, 34, -1, 0);
  if ( addr == (void *)-1LL )
    return -1;
  munmap(addr, len);
  return x + 5;
}


/* Function: param_memory_protection @ 0x1394 */
int __cdecl param_memory_protection()
{
  int v1; // [xsp+Ch] [xbp-24h]
  _DWORD *addr; // [xsp+18h] [xbp-18h]
  __int64 page_size; // [xsp+20h] [xbp-10h]

  page_size = sysconf(30);
  addr = mmap(0, page_size, 3, 34, -1, 0);
  if ( addr == (_DWORD *)-1LL )
    return -1;
  *addr = 42;
  if ( mprotect(addr, page_size, 1) )
  {
    munmap(addr, page_size);
    return -2;
  }
  else
  {
    v1 = *addr;
    if ( mprotect(addr, page_size, 3) )
    {
      munmap(addr, page_size);
      return -3;
    }
    else
    {
      *addr = 100;
      munmap(addr, page_size);
      return v1;
    }
  }
}


/* Function: param_clobber_importance @ 0x149C */
int __cdecl param_clobber_importance(int a, int b)
{
  return 2 * (a + b);
}


/* Function: call_asm_privileged @ 0x14C0 */
int __cdecl call_asm_privileged()
{
  int v1; // [xsp+0h] [xbp-10h]
  int v2; // [xsp+4h] [xbp-Ch]
  int v3; // [xsp+8h] [xbp-8h]

  v3 = param_dynamic_code(10);
  v2 = param_memory_protection();
  v1 = param_clobber_importance(3, 7);
  if ( v3 == 15 && v2 == 42 && v1 == 20 )
    return 77;
  else
    return v3;
}


/* Function: param_memory_clobber_demo @ 0x1548 */
int __cdecl param_memory_clobber_demo()
{
  return global_var + 50;
}


/* Function: test_asm_features @ 0x1574 */
void __cdecl test_asm_features()
{
  unsigned int v0; // w0
  unsigned int v1; // w0
  unsigned int v2; // w0
  unsigned int v3; // w0
  unsigned int v4; // w0
  unsigned int v5; // w0

  printf(asc_1897);
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
  printf(aAsmL406D, v5);
}


/* Function: main @ 0x1608 */
int __fastcall main(int argc, const char **argv, const char **envp)
{
  test_preprocessing_features();
  test_asm_features();
  return 0;
}


/* Function: __aarch64_ldadd4_acq_rel @ 0x1640 */
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


/* Function: .term_proc @ 0x1670 */
void term_proc()
{
  ;
}


/* FAILED to decompile: memcpy @ 0x130D8 */

/* FAILED to decompile: strlen @ 0x130E0 */

/* FAILED to decompile: __libc_start_main @ 0x130E8 */

/* FAILED to decompile: __cxa_finalize @ 0x130F0 */

/* FAILED to decompile: __getauxval @ 0x130F8 */

/* FAILED to decompile: abort @ 0x13100 */

/* FAILED to decompile: mmap @ 0x13108 */

/* FAILED to decompile: munmap @ 0x13110 */

/* FAILED to decompile: sysconf @ 0x13118 */

/* FAILED to decompile: printf @ 0x13120 */

/* FAILED to decompile: mprotect @ 0x13128 */

/* FAILED to decompile: __gmon_start__ @ 0x13138 */

/* Total functions decompiled: 55, failed: 12 */
