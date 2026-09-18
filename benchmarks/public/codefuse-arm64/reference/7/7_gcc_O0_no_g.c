/*
 * Decompiled by IDA Pro 9.1 with Hex-Rays
 * Binary: /Users/eren/Desktop/Antigravity/compiler/build/arm64/7/7_gcc_O0_no_g
 * Processor: arm
 */

/* Function: .init_proc @ 0x840 */
__int64 init_proc()
{
  return call_weak_fn();
}


/* Function: sub_860 @ 0x860 */
void sub_860()
{
  JUMPOUT(0);
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
char *deregister_tm_clones()
{
  return &completed_0;
}


/* Function: register_tm_clones @ 0xA00 */
char *register_tm_clones()
{
  return &completed_0;
}


/* Function: __do_global_dtors_aux @ 0xA40 */
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


/* Function: frame_dummy @ 0xA90 */
// attributes: thunk
char *frame_dummy()
{
  return register_tm_clones();
}


/* Function: param_fake_branch @ 0xA94 */
__int64 __fastcall param_fake_branch(__int64 result)
{
  return (unsigned int)result;
}


/* Function: call_fake_branch @ 0xABC */
__int64 call_fake_branch()
{
  return param_fake_branch(10);
}


/* Function: param_opaque_predicate @ 0xAD4 */
__int64 __fastcall param_opaque_predicate(int a1)
{
  int v2; // [xsp+18h] [xbp-18h]
  int v3; // [xsp+1Ch] [xbp-14h]
  int v4; // [xsp+2Ch] [xbp-4h]

  v2 = a1;
  v3 = a1 + 1;
  while ( v3 )
  {
    v4 = v3;
    v3 = v2 % v3;
    v2 = v4;
  }
  if ( a1 * a1 + 2 * a1 + 1 == (a1 + 1) * (a1 + 1) && v2 == 1 )
    return (unsigned int)(2 * (a1 + 5));
  else
    return (unsigned int)(3 * a1 + 20);
}


/* Function: call_opaque_predicate @ 0xBD4 */
__int64 call_opaque_predicate()
{
  return param_opaque_predicate(5);
}


/* Function: param_instruction_substitution @ 0xBEC */
__int64 __fastcall param_instruction_substitution(unsigned int a1)
{
  return 6 * a1 + (a1 >> 1) + (a1 & 0xF) + 15 * a1;
}


/* Function: call_instruction_substitution @ 0xC6C */
__int64 call_instruction_substitution()
{
  return param_instruction_substitution(0xAu);
}


/* Function: decrypt_string @ 0xC84 */
char *__fastcall decrypt_string(const char *a1, char *a2, size_t a3, char a4)
{
  char *i; // [xsp+38h] [xbp+38h]

  strncpy(a2, a1, a3);
  a2[a3 - 1] = 0;
  for ( i = a2; *i; ++i )
    *i ^= a4;
  return a2;
}


/* Function: param_string_encryption @ 0xD10 */
__int64 param_string_encryption()
{
  int v0; // w0
  char s[32]; // [xsp+18h] [xbp+18h] BYREF

  decrypt_string(encrypted_0, s, 0x20u, 90);
  v0 = strlen(s);
  return v0 + (unsigned int)(unsigned __int8)s[0];
}


/* Function: call_string_encryption @ 0xD8C */
__int64 call_string_encryption()
{
  return param_string_encryption();
}


/* Function: param_tail_call_optimized @ 0xDA0 */
__int64 __fastcall param_tail_call_optimized(int a1, unsigned int a2)
{
  if ( a1 > 0 )
    return param_tail_call_optimized((unsigned int)(a1 - 1), a2 + a1);
  else
    return a2;
}


/* Function: call_tail_call_optimized @ 0xDEC */
__int64 call_tail_call_optimized()
{
  return param_tail_call_optimized(1000, 0);
}


/* Function: param_non_tail_call @ 0xE08 */
__int64 __fastcall param_non_tail_call(int a1)
{
  if ( a1 > 0 )
    return (unsigned int)param_non_tail_call((unsigned int)(a1 - 1)) + a1;
  else
    return 0;
}


/* Function: call_non_tail_call @ 0xE48 */
__int64 call_non_tail_call()
{
  return param_non_tail_call(100);
}


/* Function: param_vectorized_loop @ 0xE60 */
__int64 __fastcall param_vectorized_loop(__int64 a1, __int64 a2, __int64 a3, int a4)
{
  int i; // [xsp+24h] [xbp-Ch]
  unsigned int v6; // [xsp+28h] [xbp-8h]
  int j; // [xsp+2Ch] [xbp-4h]

  for ( i = 0; i < a4; ++i )
    *(_DWORD *)(a3 + 4LL * i) = *(_DWORD *)(a1 + 4LL * i) + *(_DWORD *)(a2 + 4LL * i);
  v6 = 0;
  for ( j = 0; j < a4; ++j )
    v6 += *(_DWORD *)(a3 + 4LL * j);
  return v6;
}


/* Function: call_vectorized_loop @ 0xF2C */
__int64 call_vectorized_loop()
{
  _OWORD v1[2]; // [xsp+18h] [xbp+18h] BYREF
  _OWORD v2[2]; // [xsp+38h] [xbp+38h] BYREF
  _QWORD v3[4]; // [xsp+58h] [xbp+58h] BYREF

  v1[0] = xmmword_1678;
  v1[1] = xmmword_1688;
  v2[0] = xmmword_1698;
  v2[1] = xmmword_16A8;
  memset(v3, 0, sizeof(v3));
  return (unsigned int)param_vectorized_loop((__int64)v1, (__int64)v2, (__int64)v3, 8);
}


/* Function: lto_target_func @ 0xFBC */
__int64 __fastcall lto_target_func(int a1)
{
  return (unsigned int)(2 * (a1 + 5));
}


/* Function: param_link_time_optimization @ 0xFD8 */
__int64 __fastcall param_link_time_optimization(int a1)
{
  return lto_target_func(a1);
}


/* Function: call_link_time_optimization @ 0xFF4 */
__int64 call_link_time_optimization()
{
  return param_link_time_optimization(5);
}


/* Function: div_zero_handler @ 0x100C */
void __noreturn div_zero_handler()
{
  div_zero_caught = 1;
  longjmp(&jmp_buffer, 1);
}


/* Function: param_division_by_zero @ 0x1038 */
__int64 __fastcall param_division_by_zero(int a1)
{
  signal(8, (__sighandler_t)div_zero_handler);
  if ( _setjmp(&jmp_buffer) )
    return 0xFFFFFFFFLL;
  else
    return (unsigned int)(10 / a1);
}


/* Function: call_division_by_zero @ 0x108C */
__int64 call_division_by_zero()
{
  int v1; // [xsp+18h] [xbp+18h]
  int v2; // [xsp+1Ch] [xbp+1Ch]

  v1 = param_division_by_zero(5);
  v2 = param_division_by_zero(0);
  signal(8, 0);
  return (unsigned int)(v1 + v2);
}


/* Function: segv_handler @ 0x10CC */
void __noreturn segv_handler()
{
  segv_caught = 1;
  longjmp(&segv_buffer, 1);
}


/* Function: param_null_pointer_deref @ 0x10F8 */
__int64 __fastcall param_null_pointer_deref(unsigned int *a1)
{
  signal(11, (__sighandler_t)segv_handler);
  if ( _setjmp(&segv_buffer) )
    return 0xFFFFFFFFLL;
  else
    return *a1;
}


/* Function: call_null_pointer_deref @ 0x1148 */
__int64 call_null_pointer_deref()
{
  unsigned int v1; // [xsp+1Ch] [xbp+1Ch] BYREF
  int v2; // [xsp+20h] [xbp+20h]
  int v3; // [xsp+24h] [xbp+24h]

  v1 = 42;
  v2 = param_null_pointer_deref(&v1);
  v3 = param_null_pointer_deref(0);
  signal(11, 0);
  return (unsigned int)(v2 + v3);
}


/* Function: param_buffer_overflow_stack @ 0x11CC */
__int64 __fastcall param_buffer_overflow_stack(__int64 result)
{
  int i; // [xsp+28h] [xbp+28h]
  _BYTE v2[8]; // [xsp+30h] [xbp+30h]

  for ( i = 0; i <= 16; ++i )
    v2[i] = 65;
  return (unsigned int)result;
}


/* Function: param_buffer_overflow_heap @ 0x1278 */
__int64 __fastcall param_buffer_overflow_heap(unsigned int a1)
{
  int i; // [xsp+24h] [xbp+24h]
  _BYTE *ptr; // [xsp+28h] [xbp+28h]

  ptr = malloc(0x10u);
  if ( !ptr )
    return 4294967294LL;
  for ( i = 0; i <= 32; ++i )
    ptr[i] = 66;
  free(ptr);
  return a1;
}


/* Function: call_buffer_overflow @ 0x12EC */
__int64 call_buffer_overflow()
{
  int v1; // [xsp+18h] [xbp+18h]

  v1 = param_buffer_overflow_stack(10);
  return v1 + (unsigned int)param_buffer_overflow_heap(0x14u);
}


/* Function: param_integer_overflow @ 0x1320 */
__int64 __fastcall param_integer_overflow(int a1, int a2)
{
  int v3; // [xsp+10h] [xbp-10h]

  v3 = a1 + a2;
  if ( a1 > 0 && a2 > 0 && v3 < 0 )
    return 0xFFFFFFFFLL;
  if ( a1 >= 0 || a2 >= 0 || v3 <= 0 )
    return (unsigned int)(a1 + a2);
  return 4294967294LL;
}


/* Function: call_integer_overflow @ 0x13C0 */
__int64 call_integer_overflow()
{
  int v1; // [xsp+18h] [xbp+18h]

  v1 = param_integer_overflow(1000000000, 1000000000);
  return v1 + (unsigned int)param_integer_overflow(-1, 1);
}


/* Function: param_undefined_behavior @ 0x1404 */
__int64 __fastcall param_undefined_behavior(int a1)
{
  return (unsigned int)(2 * a1);
}


/* Function: call_undefined_behavior @ 0x1424 */
__int64 call_undefined_behavior()
{
  return (unsigned int)param_undefined_behavior(5);
}


/* Function: param_implementation_defined @ 0x1444 */
__int64 param_implementation_defined()
{
  return 48;
}


/* Function: call_implementation_defined @ 0x14EC */
__int64 call_implementation_defined()
{
  return param_implementation_defined();
}


/* Function: test_obf_opt_edge @ 0x1500 */
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

  puts(asc_16B8);
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


/* Function: main @ 0x1638 */
int __fastcall main(int argc, const char **argv, const char **envp)
{
  test_obf_opt_edge();
  return 0;
}


/* Function: .term_proc @ 0x1650 */
void term_proc()
{
  ;
}


/* FAILED to decompile: strlen @ 0x132F0 */

/* FAILED to decompile: _setjmp @ 0x132F8 */

/* FAILED to decompile: __libc_start_main @ 0x13300 */

/* FAILED to decompile: __cxa_finalize @ 0x13308 */

/* FAILED to decompile: signal @ 0x13310 */

/* FAILED to decompile: malloc @ 0x13318 */

/* FAILED to decompile: __stack_chk_fail @ 0x13320 */

/* FAILED to decompile: abort @ 0x13330 */

/* FAILED to decompile: puts @ 0x13338 */

/* FAILED to decompile: free @ 0x13340 */

/* FAILED to decompile: longjmp @ 0x13348 */

/* FAILED to decompile: strncpy @ 0x13350 */

/* FAILED to decompile: printf @ 0x13358 */

/* FAILED to decompile: __gmon_start__ @ 0x13368 */

/* Total functions decompiled: 44, failed: 14 */
