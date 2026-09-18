/*
 * Decompiled by IDA Pro 9.1 with Hex-Rays
 * Binary: /Users/eren/Desktop/Antigravity/compiler/build/arm64/7/7_gcc_Os_no_g
 * Processor: arm
 */

/* Function: .init_proc @ 0x848 */
__int64 init_proc()
{
  return call_weak_fn();
}


/* Function: sub_860 @ 0x860 */
void sub_860()
{
  JUMPOUT(0);
}


/* Function: main @ 0x980 */
int __fastcall main(int argc, const char **argv, const char **envp)
{
  test_obf_opt_edge(argc, argv, envp);
  return 0;
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
char *deregister_tm_clones()
{
  return &completed_0;
}


/* Function: register_tm_clones @ 0xA40 */
char *register_tm_clones()
{
  return &completed_0;
}


/* Function: __do_global_dtors_aux @ 0xA80 */
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


/* Function: frame_dummy @ 0xAD0 */
// attributes: thunk
char *frame_dummy()
{
  return register_tm_clones();
}


/* Function: div_zero_handler @ 0xAD4 */
void __noreturn div_zero_handler()
{
  div_zero_caught = 1;
  __longjmp_chk(&jmp_buffer);
}


/* Function: segv_handler @ 0xAF4 */
void __noreturn segv_handler()
{
  segv_caught = 1;
  __longjmp_chk(&segv_buffer);
}


/* Function: param_fake_branch @ 0xB14 */
void param_fake_branch()
{
  ;
}


/* Function: call_fake_branch @ 0xB18 */
__int64 call_fake_branch()
{
  return 10;
}


/* Function: param_opaque_predicate @ 0xB20 */
__int64 __fastcall param_opaque_predicate(int a1)
{
  int v1; // w1
  int v2; // w3
  _BOOL4 v3; // w5
  int v6; // w4

  v1 = a1 + 1;
  v2 = a1;
  v3 = a1 * a1 + 2 * a1 + 1 == v1 * v1;
  while ( v1 )
  {
    v6 = v2 % v1;
    v2 = v1;
    v1 = v6;
  }
  if ( v3 && v2 == 1 )
    return (unsigned int)(2 * a1 + 10);
  else
    return (unsigned int)(3 * a1 + 20);
}


/* Function: call_opaque_predicate @ 0xB78 */
__int64 call_opaque_predicate()
{
  return param_opaque_predicate(5);
}


/* Function: param_instruction_substitution @ 0xB80 */
__int64 __fastcall param_instruction_substitution(unsigned int a1)
{
  return 6 * a1 + (a1 >> 1) + (a1 & 0xF) + 15 * a1;
}


/* Function: call_instruction_substitution @ 0xBA4 */
__int64 call_instruction_substitution()
{
  return 225;
}


/* Function: decrypt_string @ 0xBAC */
char *__fastcall decrypt_string(char *src, char *dest, size_t a3, char a4)
{
  char *v6; // x4
  char *v7; // x1

  v6 = strncpy(dest, src, a3);
  v7 = v6;
  v6[a3 - 1] = 0;
  while ( *v7 )
    *v7++ ^= a4;
  return v6;
}


/* Function: param_string_encryption @ 0xC04 */
__int64 param_string_encryption()
{
  int v0; // w0
  char dest[32]; // [xsp+28h] [xbp+28h] BYREF

  decrypt_string(encrypted_0, dest, 0x20u, 90);
  v0 = strlen(dest);
  return (unsigned int)(unsigned __int8)dest[0] + v0;
}


/* Function: call_string_encryption @ 0xC7C */
// attributes: thunk
__int64 call_string_encryption()
{
  return param_string_encryption();
}


/* Function: param_tail_call_optimized @ 0xC80 */
__int64 __fastcall param_tail_call_optimized(int a1, unsigned int a2)
{
  __int64 result; // x0

  result = a2;
  while ( a1 > 0 )
    result = (unsigned int)(result + a1--);
  return result;
}


/* Function: call_tail_call_optimized @ 0xCA0 */
__int64 call_tail_call_optimized()
{
  return 500500;
}


/* Function: param_non_tail_call @ 0xCAC */
__int64 __fastcall param_non_tail_call(int a1)
{
  __int64 result; // x0

  result = 0;
  while ( a1 > 0 )
    result = (unsigned int)(result + a1--);
  return result;
}


/* Function: call_non_tail_call @ 0xCCC */
__int64 call_non_tail_call()
{
  return param_non_tail_call(100);
}


/* Function: param_vectorized_loop @ 0xCD4 */
__int64 __fastcall param_vectorized_loop(__int64 a1, __int64 a2, __int64 a3, int a4)
{
  __int64 i; // x4
  __int64 v5; // x1
  __int64 result; // x0
  int v7; // w4

  for ( i = 0; a4 > (int)i; ++i )
    *(_DWORD *)(a3 + 4 * i) = *(_DWORD *)(a1 + 4 * i) + *(_DWORD *)(a2 + 4 * i);
  v5 = 0;
  result = 0;
  while ( a4 > (int)v5 )
  {
    v7 = *(_DWORD *)(a3 + 4 * v5++);
    result = (unsigned int)(result + v7);
  }
  return result;
}


/* Function: call_vectorized_loop @ 0xD1C */
__int64 call_vectorized_loop()
{
  _OWORD v1[2]; // [xsp+18h] [xbp+18h] BYREF
  _OWORD v2[2]; // [xsp+38h] [xbp+38h] BYREF
  _QWORD v3[4]; // [xsp+58h] [xbp+58h] BYREF

  memset(v3, 0, sizeof(v3));
  v1[0] = xmmword_1320;
  v1[1] = xmmword_1330;
  v2[0] = xmmword_1340;
  v2[1] = xmmword_1350;
  return param_vectorized_loop((__int64)v1, (__int64)v2, (__int64)v3, 8);
}


/* Function: param_link_time_optimization @ 0xD94 */
__int64 __fastcall param_link_time_optimization(int a1)
{
  return (unsigned int)(2 * (a1 + 5));
}


/* Function: call_link_time_optimization @ 0xDA0 */
__int64 call_link_time_optimization()
{
  return 20;
}


/* Function: param_division_by_zero @ 0xDA8 */
__int64 __fastcall param_division_by_zero(int a1)
{
  signal(8, (__sighandler_t)div_zero_handler);
  if ( _setjmp(&jmp_buffer) )
    return 0xFFFFFFFFLL;
  else
    return (unsigned int)(10 / a1);
}


/* Function: call_division_by_zero @ 0xDF4 */
__int64 call_division_by_zero()
{
  int v0; // w20
  int v1; // w19

  v0 = param_division_by_zero(5);
  v1 = param_division_by_zero(0);
  signal(8, 0);
  return (unsigned int)(v0 + v1);
}


/* Function: param_null_pointer_deref @ 0xE34 */
__int64 __fastcall param_null_pointer_deref(unsigned int *a1)
{
  signal(11, (__sighandler_t)segv_handler);
  if ( _setjmp(&segv_buffer) )
    return 0xFFFFFFFFLL;
  else
    return *a1;
}


/* Function: call_null_pointer_deref @ 0xE7C */
__int64 call_null_pointer_deref()
{
  int v0; // w19
  int v1; // w20
  unsigned int v3; // [xsp+24h] [xbp+24h] BYREF

  v3 = 42;
  v0 = param_null_pointer_deref(&v3);
  v1 = param_null_pointer_deref(0);
  signal(11, 0);
  return (unsigned int)(v0 + v1);
}


/* Function: param_buffer_overflow_stack @ 0xEF8 */
void param_buffer_overflow_stack()
{
  ;
}


/* Function: param_buffer_overflow_heap @ 0xEFC */
__int64 __fastcall param_buffer_overflow_heap(unsigned int a1)
{
  void *v2; // x0

  v2 = malloc(0x10u);
  if ( !v2 )
    return 4294967294LL;
  free(v2);
  return a1;
}


/* Function: call_buffer_overflow @ 0xF34 */
__int64 call_buffer_overflow()
{
  return (unsigned int)param_buffer_overflow_heap(0x14u) + 10;
}


/* Function: param_integer_overflow @ 0xF50 */
__int64 __fastcall param_integer_overflow(int a1, int a2)
{
  __int64 result; // x0

  result = (unsigned int)(a1 + a2);
  if ( a1 <= 0 || a2 <= 0 )
  {
    if ( (a1 & a2) < 0 )
    {
      if ( (int)result > 0 )
        return 4294967294LL;
      else
        return (unsigned int)result;
    }
  }
  else if ( (int)result < 0 )
  {
    return 0xFFFFFFFFLL;
  }
  else
  {
    return (unsigned int)result;
  }
  return result;
}


/* Function: call_integer_overflow @ 0xF88 */
__int64 call_integer_overflow()
{
  return 2000000000;
}


/* Function: param_undefined_behavior @ 0xF94 */
__int64 __fastcall param_undefined_behavior(int a1)
{
  return (unsigned int)(2 * a1);
}


/* Function: call_undefined_behavior @ 0xF9C */
__int64 call_undefined_behavior()
{
  return 10;
}


/* Function: param_implementation_defined @ 0xFA4 */
__int64 param_implementation_defined()
{
  return 48;
}


/* Function: call_implementation_defined @ 0xFAC */
__int64 call_implementation_defined()
{
  return 48;
}


/* Function: test_obf_opt_edge @ 0xFB4 */
__int64 test_obf_opt_edge()
{
  unsigned int v0; // w0
  unsigned int v1; // w0
  unsigned int v2; // w0
  __int64 v3; // x1
  unsigned int v4; // w0
  unsigned int v5; // w0
  unsigned int v6; // w0
  unsigned int v7; // w0
  unsigned int v8; // w0

  puts(asc_1120);
  __printf_chk(1, &unk_114D, 10);
  v0 = call_opaque_predicate();
  __printf_chk(1, &unk_1169, v0);
  __printf_chk(1, &unk_1185, 225);
  v1 = param_string_encryption();
  __printf_chk(1, &unk_11A2, v1);
  v2 = call_tail_call_optimized();
  __printf_chk(1, v3, v2);
  v4 = call_non_tail_call();
  __printf_chk(1, &unk_11E8, v4);
  v5 = call_vectorized_loop();
  __printf_chk(1, &unk_120D, v5);
  __printf_chk(1, &unk_1233, 20);
  v6 = call_division_by_zero();
  __printf_chk(1, &unk_1253, v6);
  v7 = call_null_pointer_deref();
  __printf_chk(1, &unk_126F, v7);
  v8 = call_buffer_overflow();
  __printf_chk(1, &unk_128C, v8);
  __printf_chk(1, &unk_12A9, 2000000000);
  __printf_chk(1, &unk_12DA, 10);
  return __printf_chk(1, &unk_12F7, 48);
}


/* Function: .term_proc @ 0x1108 */
void term_proc()
{
  ;
}


/* FAILED to decompile: strlen @ 0x122F0 */

/* FAILED to decompile: _setjmp @ 0x122F8 */

/* FAILED to decompile: __libc_start_main @ 0x12300 */

/* FAILED to decompile: __cxa_finalize @ 0x12308 */

/* FAILED to decompile: signal @ 0x12310 */

/* FAILED to decompile: malloc @ 0x12318 */

/* FAILED to decompile: __printf_chk @ 0x12320 */

/* FAILED to decompile: __stack_chk_fail @ 0x12328 */

/* FAILED to decompile: abort @ 0x12338 */

/* FAILED to decompile: puts @ 0x12340 */

/* FAILED to decompile: free @ 0x12348 */

/* FAILED to decompile: __longjmp_chk @ 0x12350 */

/* FAILED to decompile: strncpy @ 0x12358 */

/* FAILED to decompile: __gmon_start__ @ 0x12368 */

/* Total functions decompiled: 43, failed: 14 */
