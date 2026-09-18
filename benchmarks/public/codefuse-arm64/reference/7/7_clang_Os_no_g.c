/*
 * Decompiled by IDA Pro 9.1 with Hex-Rays
 * Binary: /Users/eren/Desktop/Antigravity/compiler/build/arm64/7/7_clang_Os_no_g
 * Processor: arm
 */

/* Function: .init_proc @ 0x710 */
__int64 init_proc()
{
  return call_weak_fn();
}


/* Function: sub_730 @ 0x730 */
void sub_730()
{
  JUMPOUT(0);
}


/* Function: _start @ 0x800 */
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


/* Function: call_weak_fn @ 0x834 */
void *call_weak_fn()
{
  void *result; // x0

  result = &_gmon_start__;
  if ( &_gmon_start__ )
    return (void *)__gmon_start__();
  return result;
}


/* Function: deregister_tm_clones @ 0x850 */
char *deregister_tm_clones()
{
  return &completed_0;
}


/* Function: register_tm_clones @ 0x880 */
char *register_tm_clones()
{
  return &completed_0;
}


/* Function: __do_global_dtors_aux @ 0x8C0 */
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


/* Function: frame_dummy @ 0x910 */
// attributes: thunk
char *frame_dummy()
{
  return register_tm_clones();
}


/* Function: param_fake_branch @ 0x914 */
void param_fake_branch()
{
  ;
}


/* Function: call_fake_branch @ 0x918 */
__int64 call_fake_branch()
{
  return 10;
}


/* Function: param_opaque_predicate @ 0x920 */
__int64 __fastcall param_opaque_predicate(int a1)
{
  int v1; // w8
  int v2; // w10
  int v3; // w11
  int v4; // w12
  int v5; // w11
  unsigned int v6; // w8

  v1 = 2 * a1;
  if ( a1 == -1 )
  {
    v2 = -1;
  }
  else
  {
    v3 = a1;
    v4 = a1 + 1;
    do
    {
      v2 = v4;
      v4 = v3 % v4;
      v3 = v2;
    }
    while ( v4 );
  }
  v5 = (v1 | 1) + a1 * a1;
  v6 = v1 + 10;
  if ( v2 == 1 && v5 == (a1 + 1) * (a1 + 1) )
    return v6;
  else
    return (unsigned int)(3 * a1 + 20);
}


/* Function: call_opaque_predicate @ 0x978 */
__int64 call_opaque_predicate()
{
  int v0; // w8
  int v1; // w9
  int v2; // w10

  v0 = 6;
  v1 = 5;
  do
  {
    v2 = v0;
    v0 = v1 % v0;
    v1 = v2;
  }
  while ( v0 );
  if ( v2 == 1 )
    return 20;
  else
    return 35;
}


/* Function: param_instruction_substitution @ 0x9A8 */
__int64 __fastcall param_instruction_substitution(unsigned int a1)
{
  return (a1 & 0xF) + (a1 >> 1) + 21 * a1;
}


/* Function: call_instruction_substitution @ 0x9BC */
__int64 call_instruction_substitution()
{
  return 225;
}


/* Function: decrypt_string @ 0x9C4 */
char *__fastcall decrypt_string(char *src, char *dest, size_t a3, char a4)
{
  int v7; // w8
  char *v8; // x10
  char v9; // w11

  strncpy(dest, src, a3);
  dest[a3 - 1] = 0;
  LOBYTE(v7) = *dest;
  if ( *dest )
  {
    v8 = dest + 1;
    do
    {
      v9 = v7 ^ a4;
      v7 = (unsigned __int8)*v8;
      *(v8++ - 1) = v9;
    }
    while ( v7 );
  }
  return dest;
}


/* Function: param_string_encryption @ 0xA2C */
__int64 param_string_encryption()
{
  int v0; // w8
  unsigned __int8 *v1; // x9
  unsigned __int8 v2; // w11
  int v3; // w19
  unsigned __int8 v5; // [xsp+0h] [xbp-20h] BYREF
  _BYTE v6[31]; // [xsp+1h] [xbp-1Fh] BYREF

  strncpy((char *)&v5, param_string_encryption_encrypted, 0x20u);
  LOBYTE(v0) = v5;
  v6[30] = 0;
  if ( v5 )
  {
    v1 = v6;
    do
    {
      v2 = v0 ^ 0x5A;
      v0 = *v1;
      *(v1++ - 1) = v2;
    }
    while ( v0 );
    v3 = v5;
  }
  else
  {
    v3 = 0;
  }
  return (unsigned int)strlen((const char *)&v5) + v3;
}


/* Function: call_string_encryption @ 0xAA4 */
// attributes: thunk
__int64 call_string_encryption()
{
  return param_string_encryption();
}


/* Function: param_tail_call_optimized @ 0xAA8 */
__int64 __fastcall param_tail_call_optimized(int a1, unsigned int a2)
{
  if ( a1 >= 1 )
    return a2
         + a1
         + (a1 - 1) * (a1 - 1)
         - (unsigned int)(((unsigned int)(a1 - 1) * (unsigned __int64)(unsigned int)(a1 - 2)) >> 1);
  return a2;
}


/* Function: call_tail_call_optimized @ 0xAD0 */
__int64 call_tail_call_optimized()
{
  return 500500;
}


/* Function: param_non_tail_call @ 0xADC */
__int64 __fastcall param_non_tail_call(int a1)
{
  if ( a1 < 1 )
    return 0;
  else
    return a1
         + (a1 - 1) * (a1 - 1)
         - (unsigned int)(((unsigned int)(a1 - 1) * (unsigned __int64)(unsigned int)(a1 - 2)) >> 1);
}


/* Function: call_non_tail_call @ 0xB04 */
__int64 call_non_tail_call()
{
  return 5050;
}


/* Function: param_vectorized_loop @ 0xB0C */
__int64 __fastcall param_vectorized_loop(int *a1, int *a2, int *a3, int a4)
{
  __int64 v4; // x8
  int *v5; // x10
  __int64 v6; // x9
  int v7; // w11
  int v8; // t1
  int v9; // t1
  __int64 result; // x0
  int v11; // t1

  if ( a4 < 1 )
    return 0;
  v4 = (unsigned int)a4;
  v5 = a3;
  v6 = (unsigned int)a4;
  do
  {
    v8 = *a1++;
    v7 = v8;
    v9 = *a2++;
    --v6;
    *v5++ = v9 + v7;
  }
  while ( v6 );
  LODWORD(result) = 0;
  do
  {
    v11 = *a3++;
    --v4;
    result = (unsigned int)(v11 + result);
  }
  while ( v4 );
  return result;
}


/* Function: call_vectorized_loop @ 0xB60 */
__int64 call_vectorized_loop()
{
  __int64 v0; // x8
  int32x4_t v2; // [xsp+0h] [xbp-20h]
  int32x4_t v3; // [xsp+10h] [xbp-10h]

  v0 = 0;
  v2 = 0u;
  v3 = 0u;
  do
  {
    *(int32x4_t *)((char *)&v2 + v0) = vaddq_s32(
                                         *(int32x4_t *)((char *)&unk_F30 + v0),
                                         *(int32x4_t *)((char *)&unk_F10 + v0));
    v0 += 16;
  }
  while ( v0 != 32 );
  return (unsigned int)vaddvq_s32(vaddq_s32(v3, v2));
}


/* Function: param_link_time_optimization @ 0xBB4 */
__int64 __fastcall param_link_time_optimization(int a1)
{
  return (unsigned int)(2 * a1 + 10);
}


/* Function: call_link_time_optimization @ 0xBC0 */
__int64 call_link_time_optimization()
{
  return 20;
}


/* Function: div_zero_handler @ 0xBC8 */
void __noreturn div_zero_handler()
{
  div_zero_caught = 1;
  longjmp(&jmp_buffer, 1);
}


/* Function: param_division_by_zero @ 0xBEC */
__int64 __fastcall param_division_by_zero(int a1)
{
  signal(8, (__sighandler_t)div_zero_handler);
  if ( _setjmp(&jmp_buffer) )
    return 0xFFFFFFFFLL;
  else
    return (unsigned int)(10 / a1);
}


/* Function: call_division_by_zero @ 0xC38 */
__int64 call_division_by_zero()
{
  int v0; // w19
  int v1; // w20

  v0 = param_division_by_zero(5);
  v1 = param_division_by_zero(0);
  signal(8, 0);
  return (unsigned int)(v1 + v0);
}


/* Function: segv_handler @ 0xC78 */
void __noreturn segv_handler()
{
  segv_caught = 1;
  longjmp(&segv_buffer, 1);
}


/* Function: param_null_pointer_deref @ 0xC9C */
__int64 __fastcall param_null_pointer_deref(unsigned int *a1)
{
  signal(11, (__sighandler_t)segv_handler);
  if ( _setjmp(&segv_buffer) )
    return 0xFFFFFFFFLL;
  else
    return *a1;
}


/* Function: call_null_pointer_deref @ 0xCE4 */
__int64 call_null_pointer_deref()
{
  int v0; // w19
  int v1; // w20
  unsigned int v3; // [xsp+Ch] [xbp-4h] BYREF

  v3 = 42;
  v0 = param_null_pointer_deref(&v3);
  v1 = param_null_pointer_deref(0);
  signal(11, 0);
  return (unsigned int)(v1 + v0);
}


/* Function: param_buffer_overflow_stack @ 0xD34 */
void param_buffer_overflow_stack()
{
  ;
}


/* Function: param_buffer_overflow_heap @ 0xD38 */
void param_buffer_overflow_heap()
{
  ;
}


/* Function: call_buffer_overflow @ 0xD3C */
__int64 call_buffer_overflow()
{
  return 30;
}


/* Function: param_integer_overflow @ 0xD44 */
__int64 __fastcall param_integer_overflow(int a1, int a2)
{
  int v2; // w8

  v2 = a2 + a1;
  if ( a1 >= 1 && a2 >= 1 && v2 < 0 )
    return 0xFFFFFFFFLL;
  if ( v2 > 0 && (a2 & a1) < 0 )
    return 4294967294LL;
  else
    return (unsigned int)v2;
}


/* Function: call_integer_overflow @ 0xD7C */
__int64 call_integer_overflow()
{
  return 2000000000;
}


/* Function: param_undefined_behavior @ 0xD88 */
__int64 __fastcall param_undefined_behavior(int a1)
{
  return (unsigned int)(2 * a1);
}


/* Function: call_undefined_behavior @ 0xD90 */
__int64 call_undefined_behavior()
{
  return 10;
}


/* Function: param_implementation_defined @ 0xD98 */
__int64 param_implementation_defined()
{
  return 48;
}


/* Function: call_implementation_defined @ 0xDA0 */
__int64 call_implementation_defined()
{
  return 48;
}


/* Function: test_obf_opt_edge @ 0xDA8 */
__int64 test_obf_opt_edge()
{
  int v0; // w8
  int v1; // w9
  int v2; // w10
  __int64 v3; // x1
  unsigned int v4; // w0
  unsigned int v5; // w0
  unsigned int v6; // w0
  unsigned int v7; // w0

  puts(asc_1121);
  printf(aObfL402D, 10);
  v0 = 6;
  v1 = 5;
  do
  {
    v2 = v0;
    v0 = v1 % v0;
    v1 = v2;
  }
  while ( v0 );
  if ( v2 == 1 )
    v3 = 20;
  else
    v3 = 35;
  printf(aObfL403D, v3);
  printf(aObfL404D, 225);
  v4 = param_string_encryption();
  printf(aObfL405D, v4);
  printf(aOptL401, 500500);
  printf(aOptL401_0, 5050);
  v5 = call_vectorized_loop();
  printf(aOptL402, v5);
  printf(aOptL501LtoD, 20);
  v6 = call_division_by_zero();
  printf(aEdgeL301D, v6);
  v7 = call_null_pointer_deref();
  printf(aEdgeL302D, v7);
  printf(aEdgeL303D, 30);
  printf(aEdgeL304D, 2000000000);
  printf(aEdgeL401D, 10);
  return printf(aEdgeL402D, 48);
}


/* Function: main @ 0xEE0 */
int __fastcall main(int argc, const char **argv, const char **envp)
{
  test_obf_opt_edge();
  return 0;
}


/* Function: .term_proc @ 0xEF8 */
void term_proc()
{
  ;
}


/* FAILED to decompile: strlen @ 0x12348 */

/* FAILED to decompile: _setjmp @ 0x12350 */

/* FAILED to decompile: __libc_start_main @ 0x12358 */

/* FAILED to decompile: __cxa_finalize @ 0x12360 */

/* FAILED to decompile: signal @ 0x12368 */

/* FAILED to decompile: abort @ 0x12370 */

/* FAILED to decompile: puts @ 0x12378 */

/* FAILED to decompile: longjmp @ 0x12380 */

/* FAILED to decompile: strncpy @ 0x12388 */

/* FAILED to decompile: printf @ 0x12390 */

/* FAILED to decompile: __gmon_start__ @ 0x123A0 */

/* Total functions decompiled: 43, failed: 11 */
