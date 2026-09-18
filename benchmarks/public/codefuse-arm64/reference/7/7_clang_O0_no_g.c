/*
 * Decompiled by IDA Pro 9.1 with Hex-Rays
 * Binary: /Users/eren/Desktop/Antigravity/compiler/build/arm64/7/7_clang_O0_no_g
 * Processor: arm
 */

/* Function: .init_proc @ 0x748 */
__int64 init_proc()
{
  return call_weak_fn();
}


/* Function: sub_760 @ 0x760 */
void sub_760()
{
  JUMPOUT(0);
}


/* Function: _start @ 0x840 */
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


/* Function: call_weak_fn @ 0x874 */
void *call_weak_fn()
{
  void *result; // x0

  result = &_gmon_start__;
  if ( &_gmon_start__ )
    return (void *)__gmon_start__();
  return result;
}


/* Function: deregister_tm_clones @ 0x890 */
char *deregister_tm_clones()
{
  return &completed_0;
}


/* Function: register_tm_clones @ 0x8C0 */
char *register_tm_clones()
{
  return &completed_0;
}


/* Function: __do_global_dtors_aux @ 0x900 */
__int64 _do_global_dtors_aux()
{
  __int64 result; // x0

  result = (unsigned __int8)completed_0;
  if ( !completed_0 )
  {
    if ( &_cxa_finalize )
      __cxa_finalize(_dso_handle);
    deregister_tm_clones();
    result = 1;
    completed_0 = 1;
  }
  return result;
}


/* Function: frame_dummy @ 0x950 */
// attributes: thunk
char *frame_dummy()
{
  return register_tm_clones();
}


/* Function: param_fake_branch @ 0x954 */
__int64 __fastcall param_fake_branch(unsigned int a1)
{
  unsigned int v2; // [xsp+8h] [xbp-8h]

  v2 = a1;
  if ( ((a1 * a1) & 0x80000000) != 0 )
    v2 = 2 * a1 - 559038737;
  strlen("test");
  return v2;
}


/* Function: call_fake_branch @ 0x9DC */
__int64 call_fake_branch()
{
  return param_fake_branch(0xAu);
}


/* Function: param_opaque_predicate @ 0x9F4 */
__int64 __fastcall param_opaque_predicate(int a1)
{
  int v2; // [xsp+8h] [xbp-18h]
  int v3; // [xsp+Ch] [xbp-14h]
  int v4; // [xsp+10h] [xbp-10h]

  v4 = a1;
  v3 = a1 + 1;
  while ( v3 )
  {
    v2 = v3;
    v3 = v4 % v3;
    v4 = v2;
  }
  if ( a1 * a1 + 2 * a1 + 1 == (a1 + 1) * (a1 + 1) && v4 == 1 )
    return (unsigned int)(2 * a1 + 10);
  else
    return (unsigned int)(3 * a1 + 20);
}


/* Function: call_opaque_predicate @ 0xB20 */
__int64 call_opaque_predicate()
{
  return param_opaque_predicate(5);
}


/* Function: param_instruction_substitution @ 0xB38 */
__int64 __fastcall param_instruction_substitution(unsigned int a1)
{
  return 6 * a1 + (a1 >> 1) + (a1 & 0xF) + 15 * a1;
}


/* Function: call_instruction_substitution @ 0xBB4 */
__int64 call_instruction_substitution()
{
  return param_instruction_substitution(0xAu);
}


/* Function: decrypt_string @ 0xBCC */
char *__fastcall decrypt_string(const char *a1, char *a2, size_t a3, char a4)
{
  char *i; // [xsp+8h] [xbp-28h]

  strncpy(a2, a1, a3);
  a2[a3 - 1] = 0;
  for ( i = a2; *i; ++i )
    *i ^= a4;
  return a2;
}


/* Function: param_string_encryption @ 0xC5C */
__int64 param_string_encryption()
{
  int v0; // w0
  char v2[32]; // [xsp+10h] [xbp-20h] BYREF

  decrypt_string(param_string_encryption_encrypted, v2, 0x20u, 90);
  v0 = strlen(v2);
  return v0 + (unsigned int)(unsigned __int8)v2[0];
}


/* Function: call_string_encryption @ 0xCA4 */
__int64 call_string_encryption()
{
  return param_string_encryption();
}


/* Function: param_tail_call_optimized @ 0xCB8 */
__int64 __fastcall param_tail_call_optimized(int a1, unsigned int a2)
{
  if ( a1 > 0 )
    return (unsigned int)param_tail_call_optimized((unsigned int)(a1 - 1), a2 + a1);
  else
    return a2;
}


/* Function: call_tail_call_optimized @ 0xD18 */
__int64 call_tail_call_optimized()
{
  return param_tail_call_optimized(1000, 0);
}


/* Function: param_non_tail_call @ 0xD34 */
__int64 __fastcall param_non_tail_call(int a1)
{
  if ( a1 > 0 )
    return (unsigned int)(a1 + param_non_tail_call((unsigned int)(a1 - 1)));
  else
    return 0;
}


/* Function: call_non_tail_call @ 0xD90 */
__int64 call_non_tail_call()
{
  return param_non_tail_call(100);
}


/* Function: param_vectorized_loop @ 0xDA8 */
__int64 __fastcall param_vectorized_loop(__int64 a1, __int64 a2, __int64 a3, int a4)
{
  int j; // [xsp+8h] [xbp-28h]
  unsigned int v6; // [xsp+Ch] [xbp-24h]
  int i; // [xsp+10h] [xbp-20h]

  for ( i = 0; i < a4; ++i )
    *(_DWORD *)(a3 + 4LL * i) = *(_DWORD *)(a1 + 4LL * i) + *(_DWORD *)(a2 + 4LL * i);
  v6 = 0;
  for ( j = 0; j < a4; ++j )
    v6 += *(_DWORD *)(a3 + 4LL * j);
  return v6;
}


/* Function: call_vectorized_loop @ 0xE6C */
__int64 call_vectorized_loop()
{
  _OWORD v1[2]; // [xsp+0h] [xbp-60h] BYREF
  _OWORD v2[2]; // [xsp+20h] [xbp-40h] BYREF
  _OWORD v3[2]; // [xsp+40h] [xbp-20h] BYREF

  v3[0] = xmmword_17F0;
  v3[1] = xmmword_1800;
  v2[0] = xmmword_1810;
  v2[1] = xmmword_1820;
  memset(v1, 0, sizeof(v1));
  return param_vectorized_loop((__int64)v3, (__int64)v2, (__int64)v1, 8);
}


/* Function: param_link_time_optimization @ 0xED4 */
__int64 __fastcall param_link_time_optimization(unsigned int a1)
{
  return lto_target_func(a1);
}


/* Function: lto_target_func @ 0xEF8 */
__int64 __fastcall lto_target_func(int a1)
{
  return (unsigned int)(2 * a1 + 10);
}


/* Function: call_link_time_optimization @ 0xF14 */
__int64 call_link_time_optimization()
{
  return param_link_time_optimization(5u);
}


/* Function: div_zero_handler @ 0xF2C */
void __noreturn div_zero_handler()
{
  div_zero_caught = 1;
  longjmp(&jmp_buffer, 1);
}


/* Function: param_division_by_zero @ 0xF54 */
__int64 __fastcall param_division_by_zero(int a1)
{
  signal(8, (__sighandler_t)div_zero_handler);
  if ( _setjmp(&jmp_buffer) )
    return (unsigned int)-1;
  else
    return (unsigned int)(10 / a1);
}


/* Function: call_division_by_zero @ 0xFC0 */
__int64 call_division_by_zero()
{
  int v1; // [xsp+8h] [xbp-8h]
  int v2; // [xsp+Ch] [xbp-4h]

  v2 = param_division_by_zero(5);
  v1 = param_division_by_zero(0);
  signal(8, 0);
  return (unsigned int)(v2 + v1);
}


/* Function: segv_handler @ 0x1008 */
void __noreturn segv_handler()
{
  segv_caught = 1;
  longjmp(&segv_buffer, 1);
}


/* Function: param_null_pointer_deref @ 0x1030 */
__int64 __fastcall param_null_pointer_deref(unsigned int *a1)
{
  signal(11, (__sighandler_t)segv_handler);
  if ( _setjmp(&segv_buffer) )
    return (unsigned int)-1;
  else
    return *a1;
}


/* Function: call_null_pointer_deref @ 0x1098 */
__int64 call_null_pointer_deref()
{
  int v1; // [xsp+14h] [xbp-Ch]
  int v2; // [xsp+18h] [xbp-8h]
  unsigned int v3; // [xsp+1Ch] [xbp-4h] BYREF

  v3 = 42;
  v2 = param_null_pointer_deref(&v3);
  v1 = param_null_pointer_deref(0);
  signal(11, 0);
  return (unsigned int)(v2 + v1);
}


/* Function: param_buffer_overflow_stack @ 0x10EC */
__int64 __fastcall param_buffer_overflow_stack(unsigned int a1)
{
  int i; // [xsp+Ch] [xbp-14h]
  _BYTE v3[8]; // [xsp+14h] [xbp-Ch]
  unsigned int v4; // [xsp+1Ch] [xbp-4h]

  v4 = a1;
  for ( i = 0; i <= 16; ++i )
    v3[i] = 65;
  return v4;
}


/* Function: param_buffer_overflow_heap @ 0x117C */
__int64 __fastcall param_buffer_overflow_heap(unsigned int a1)
{
  int i; // [xsp+Ch] [xbp-14h]
  _BYTE *ptr; // [xsp+10h] [xbp-10h]

  ptr = malloc(0x10u);
  if ( ptr )
  {
    for ( i = 0; i <= 32; ++i )
      ptr[i] = 66;
    free(ptr);
    return a1;
  }
  else
  {
    return (unsigned int)-2;
  }
}


/* Function: call_buffer_overflow @ 0x1214 */
__int64 call_buffer_overflow()
{
  int v1; // [xsp+Ch] [xbp-4h]

  v1 = param_buffer_overflow_stack(0xAu);
  return v1 + (unsigned int)param_buffer_overflow_heap(0x14u);
}


/* Function: param_integer_overflow @ 0x1250 */
__int64 __fastcall param_integer_overflow(int a1, int a2)
{
  int v3; // [xsp+10h] [xbp-10h]

  v3 = a1 + a2;
  if ( a1 <= 0 || a2 <= 0 || v3 >= 0 )
  {
    if ( a1 >= 0 || a2 >= 0 || v3 <= 0 )
      return (unsigned int)(a1 + a2);
    else
      return (unsigned int)-2;
  }
  else
  {
    return (unsigned int)-1;
  }
}


/* Function: call_integer_overflow @ 0x131C */
__int64 call_integer_overflow()
{
  int v1; // [xsp+Ch] [xbp-4h]

  v1 = param_integer_overflow(1000000000, 1000000000);
  return v1 + (unsigned int)param_integer_overflow(-1, 1);
}


/* Function: param_undefined_behavior @ 0x1364 */
__int64 __fastcall param_undefined_behavior(int a1)
{
  return (unsigned int)(2 * a1);
}


/* Function: call_undefined_behavior @ 0x1384 */
__int64 call_undefined_behavior()
{
  return (unsigned int)param_undefined_behavior(5);
}


/* Function: param_implementation_defined @ 0x13AC */
__int64 param_implementation_defined()
{
  return 48;
}


/* Function: call_implementation_defined @ 0x1460 */
__int64 call_implementation_defined()
{
  return param_implementation_defined();
}


/* Function: test_obf_opt_edge @ 0x1474 */
__int64 test_obf_opt_edge()
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
  unsigned int v11; // w0
  unsigned int v12; // w0
  unsigned int v13; // w0

  printf(asc_15F1);
  v0 = call_fake_branch();
  printf(aObfL402D, v0);
  v1 = call_opaque_predicate();
  printf(aObfL403D, v1);
  v2 = call_instruction_substitution();
  printf(aObfL404D, v2);
  v3 = call_string_encryption();
  printf(aObfL405D, v3);
  v4 = call_tail_call_optimized();
  printf(aOptL401, v4);
  v5 = call_non_tail_call();
  printf(aOptL401_0, v5);
  v6 = call_vectorized_loop();
  printf(aOptL402, v6);
  v7 = call_link_time_optimization();
  printf(aOptL501LtoD, v7);
  v8 = call_division_by_zero();
  printf(aEdgeL301D, v8);
  v9 = call_null_pointer_deref();
  printf(aEdgeL302D, v9);
  v10 = call_buffer_overflow();
  printf(aEdgeL303D, v10);
  v11 = call_integer_overflow();
  printf(aEdgeL304D, v11);
  v12 = call_undefined_behavior();
  printf(aEdgeL401D, v12);
  v13 = call_implementation_defined();
  return printf(aEdgeL402D, v13);
}


/* Function: main @ 0x15A8 */
int __fastcall main(int argc, const char **argv, const char **envp)
{
  test_obf_opt_edge();
  return 0;
}


/* Function: .term_proc @ 0x15D4 */
void term_proc()
{
  ;
}


/* FAILED to decompile: strlen @ 0x12350 */

/* FAILED to decompile: _setjmp @ 0x12358 */

/* FAILED to decompile: __libc_start_main @ 0x12360 */

/* FAILED to decompile: __cxa_finalize @ 0x12368 */

/* FAILED to decompile: signal @ 0x12370 */

/* FAILED to decompile: malloc @ 0x12378 */

/* FAILED to decompile: abort @ 0x12380 */

/* FAILED to decompile: free @ 0x12388 */

/* FAILED to decompile: longjmp @ 0x12390 */

/* FAILED to decompile: strncpy @ 0x12398 */

/* FAILED to decompile: printf @ 0x123A0 */

/* FAILED to decompile: __gmon_start__ @ 0x123B0 */

/* Total functions decompiled: 44, failed: 12 */
