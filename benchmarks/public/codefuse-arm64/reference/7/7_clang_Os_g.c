/*
 * Decompiled by IDA Pro 9.1 with Hex-Rays
 * Binary: /Users/eren/Desktop/Antigravity/compiler/build/arm64/7/7_clang_Os_g
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
int __fastcall param_fake_branch(int x)
{
  return x;
}


/* Function: call_fake_branch @ 0x918 */
int __cdecl call_fake_branch()
{
  return 10;
}


/* Function: param_opaque_predicate @ 0x920 */
int __fastcall param_opaque_predicate(int x)
{
  int v1; // w8
  int v2; // w10
  int v3; // w11
  int v4; // w12
  int v5; // w11
  int v6; // w8

  v1 = 2 * x;
  if ( x == -1 )
  {
    v2 = -1;
  }
  else
  {
    v3 = x;
    v4 = x + 1;
    do
    {
      v2 = v4;
      v4 = v3 % v4;
      v3 = v2;
    }
    while ( v4 );
  }
  v5 = (v1 | 1) + x * x;
  v6 = v1 + 10;
  if ( v2 == 1 && v5 == (x + 1) * (x + 1) )
    return v6;
  else
    return 3 * x + 20;
}


/* Function: call_opaque_predicate @ 0x978 */
int __cdecl call_opaque_predicate()
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
int __fastcall param_instruction_substitution(int x)
{
  return (x & 0xF) + ((unsigned int)x >> 1) + 21 * x;
}


/* Function: call_instruction_substitution @ 0x9BC */
int __cdecl call_instruction_substitution()
{
  return 225;
}


/* Function: decrypt_string @ 0x9C4 */
const char *__fastcall decrypt_string(const char *encrypted, char *buffer, size_t len, char key)
{
  int v7; // w8
  char *v8; // x10
  char v9; // w11

  strncpy(buffer, encrypted, len);
  buffer[len - 1] = 0;
  LOBYTE(v7) = *buffer;
  if ( *buffer )
  {
    v8 = buffer + 1;
    do
    {
      v9 = v7 ^ key;
      v7 = (unsigned __int8)*v8;
      *(v8++ - 1) = v9;
    }
    while ( v7 );
  }
  return buffer;
}


/* Function: param_string_encryption @ 0xA2C */
int __cdecl param_string_encryption()
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
  return strlen((const char *)&v5) + v3;
}


/* Function: call_string_encryption @ 0xAA4 */
// attributes: thunk
int __cdecl call_string_encryption()
{
  return param_string_encryption();
}


/* Function: param_tail_call_optimized @ 0xAA8 */
int __fastcall param_tail_call_optimized(int n, int acc)
{
  if ( n >= 1 )
    return acc + n + (n - 1) * (n - 1) - (((unsigned int)(n - 1) * (unsigned __int64)(unsigned int)(n - 2)) >> 1);
  return acc;
}


/* Function: call_tail_call_optimized @ 0xAD0 */
int __cdecl call_tail_call_optimized()
{
  return 500500;
}


/* Function: param_non_tail_call @ 0xADC */
int __fastcall param_non_tail_call(int n)
{
  if ( n < 1 )
    return 0;
  else
    return n + (n - 1) * (n - 1) - (((unsigned int)(n - 1) * (unsigned __int64)(unsigned int)(n - 2)) >> 1);
}


/* Function: call_non_tail_call @ 0xB04 */
int __cdecl call_non_tail_call()
{
  return 5050;
}


/* Function: param_vectorized_loop @ 0xB0C */
int __fastcall param_vectorized_loop(int *a, int *b, int *c, int n)
{
  __int64 v4; // x8
  int *v5; // x10
  __int64 v6; // x9
  int v7; // w11
  int v8; // t1
  int v9; // t1
  int result; // w0
  int v11; // t1

  if ( n < 1 )
    return 0;
  v4 = (unsigned int)n;
  v5 = c;
  v6 = (unsigned int)n;
  do
  {
    v8 = *a++;
    v7 = v8;
    v9 = *b++;
    --v6;
    *v5++ = v9 + v7;
  }
  while ( v6 );
  result = 0;
  do
  {
    v11 = *c++;
    --v4;
    result += v11;
  }
  while ( v4 );
  return result;
}


/* Function: call_vectorized_loop @ 0xB60 */
int __cdecl call_vectorized_loop()
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
  return vaddvq_s32(vaddq_s32(v3, v2));
}


/* Function: param_link_time_optimization @ 0xBB4 */
int __fastcall param_link_time_optimization(int x)
{
  return 2 * x + 10;
}


/* Function: call_link_time_optimization @ 0xBC0 */
int __cdecl call_link_time_optimization()
{
  return 20;
}


/* Function: div_zero_handler @ 0xBC8 */
void __fastcall __noreturn div_zero_handler(int sig)
{
  div_zero_caught = 1;
  longjmp(&jmp_buffer, 1);
}


/* Function: param_division_by_zero @ 0xBEC */
int __fastcall param_division_by_zero(int x)
{
  signal(8, (__sighandler_t)div_zero_handler);
  if ( _setjmp(&jmp_buffer) )
    return -1;
  else
    return 10 / x;
}


/* Function: call_division_by_zero @ 0xC38 */
int __cdecl call_division_by_zero()
{
  int v0; // w19
  int v1; // w20

  v0 = param_division_by_zero(5);
  v1 = param_division_by_zero(0);
  signal(8, 0);
  return v1 + v0;
}


/* Function: segv_handler @ 0xC78 */
void __fastcall __noreturn segv_handler(int sig)
{
  segv_caught = 1;
  longjmp(&segv_buffer, 1);
}


/* Function: param_null_pointer_deref @ 0xC9C */
int __fastcall param_null_pointer_deref(int *p)
{
  signal(11, (__sighandler_t)segv_handler);
  if ( _setjmp(&segv_buffer) )
    return -1;
  else
    return *p;
}


/* Function: call_null_pointer_deref @ 0xCE4 */
int __cdecl call_null_pointer_deref()
{
  int v0; // w19
  int v1; // w20
  int valid; // [xsp+Ch] [xbp-4h] BYREF

  valid = 42;
  v0 = param_null_pointer_deref(&valid);
  v1 = param_null_pointer_deref(0);
  signal(11, 0);
  return v1 + v0;
}


/* Function: param_buffer_overflow_stack @ 0xD34 */
int __fastcall param_buffer_overflow_stack(int x)
{
  return x;
}


/* Function: param_buffer_overflow_heap @ 0xD38 */
int __fastcall param_buffer_overflow_heap(int x)
{
  return x;
}


/* Function: call_buffer_overflow @ 0xD3C */
int __cdecl call_buffer_overflow()
{
  return 30;
}


/* Function: param_integer_overflow @ 0xD44 */
int __fastcall param_integer_overflow(int a, int b)
{
  int v2; // w8

  v2 = b + a;
  if ( a >= 1 && b >= 1 && v2 < 0 )
    return -1;
  if ( v2 > 0 && (b & a) < 0 )
    return -2;
  else
    return b + a;
}


/* Function: call_integer_overflow @ 0xD7C */
int __cdecl call_integer_overflow()
{
  return 2000000000;
}


/* Function: param_undefined_behavior @ 0xD88 */
int __fastcall param_undefined_behavior(int i)
{
  return 2 * i;
}


/* Function: call_undefined_behavior @ 0xD90 */
int __cdecl call_undefined_behavior()
{
  return 10;
}


/* Function: param_implementation_defined @ 0xD98 */
int __cdecl param_implementation_defined()
{
  return 48;
}


/* Function: call_implementation_defined @ 0xDA0 */
int __cdecl call_implementation_defined()
{
  return 48;
}


/* Function: test_obf_opt_edge @ 0xDA8 */
void __cdecl test_obf_opt_edge()
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
  printf(aEdgeL402D, 48);
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
