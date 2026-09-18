/*
 * Decompiled by IDA Pro 9.1 with Hex-Rays
 * Binary: /Users/eren/Desktop/Antigravity/compiler/build/arm64/7/7_clang_O2_g
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
int __cdecl call_string_encryption()
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


/* Function: param_tail_call_optimized @ 0xB1C */
int __fastcall param_tail_call_optimized(int n, int acc)
{
  if ( n >= 1 )
    return acc + n + (n - 1) * (n - 1) - (((unsigned int)(n - 1) * (unsigned __int64)(unsigned int)(n - 2)) >> 1);
  return acc;
}


/* Function: call_tail_call_optimized @ 0xB44 */
int __cdecl call_tail_call_optimized()
{
  return 500500;
}


/* Function: param_non_tail_call @ 0xB50 */
int __fastcall param_non_tail_call(int n)
{
  if ( n < 1 )
    return 0;
  else
    return n + (n - 1) * (n - 1) - (((unsigned int)(n - 1) * (unsigned __int64)(unsigned int)(n - 2)) >> 1);
}


/* Function: call_non_tail_call @ 0xB78 */
int __cdecl call_non_tail_call()
{
  return 5050;
}


/* Function: param_vectorized_loop @ 0xB80 */
int __fastcall param_vectorized_loop(int *a, int *b, int *c, int n)
{
  __int64 v4; // x9
  int *v5; // x12
  int *v6; // x10
  int *v7; // x11
  int32x4_t *v8; // x12
  __int64 v9; // x13
  int32x4_t v10; // q0
  int32x4_t v11; // q1
  int32x4_t v12; // q2
  int32x4_t v13; // q3
  __int64 v14; // x12
  __int64 v15; // x9
  int *v16; // x10
  int *v17; // x11
  int *v18; // x12
  int v19; // w13
  int v20; // t1
  int v21; // t1
  __int64 v22; // x9
  int result; // w0
  int *v24; // x10
  int32x4_t v25; // q0
  __int64 v26; // x11
  int32x4_t v27; // q1
  int32x4_t v28; // q2
  int32x4_t v29; // q3
  int *v30; // x10
  __int64 v31; // x8
  int v32; // t1

  if ( n < 1 )
    return 0;
  if ( (unsigned int)n < 8 )
  {
    v4 = 0;
LABEL_9:
    v14 = v4;
    v15 = (unsigned int)n - v4;
    v16 = &c[v14];
    v17 = &b[v14];
    v18 = &a[v14];
    do
    {
      v20 = *v18++;
      v19 = v20;
      v21 = *v17++;
      --v15;
      *v16++ = v21 + v19;
    }
    while ( v15 );
    goto LABEL_11;
  }
  v4 = 0;
  v5 = &c[n];
  if ( &a[n] > c && v5 > a )
    goto LABEL_9;
  if ( &b[n] > c && v5 > b )
    goto LABEL_9;
  v4 = n & 0xFFFFFFF8;
  v6 = a + 4;
  v7 = b + 4;
  v8 = (int32x4_t *)(c + 4);
  v9 = v4;
  do
  {
    v10 = *((int32x4_t *)v6 - 1);
    v11 = *(int32x4_t *)v6;
    v6 += 8;
    v9 -= 8;
    v12 = *((int32x4_t *)v7 - 1);
    v13 = *(int32x4_t *)v7;
    v7 += 8;
    v8[-1] = vaddq_s32(v12, v10);
    *v8 = vaddq_s32(v13, v11);
    v8 += 2;
  }
  while ( v9 );
  if ( v4 != n )
    goto LABEL_9;
LABEL_11:
  if ( (unsigned int)n < 8 )
  {
    v22 = 0;
    result = 0;
LABEL_17:
    v30 = &c[v22];
    v31 = (unsigned int)n - v22;
    do
    {
      v32 = *v30++;
      --v31;
      result += v32;
    }
    while ( v31 );
    return result;
  }
  v22 = n & 0xFFFFFFF8;
  v24 = c + 4;
  v25 = 0u;
  v26 = v22;
  v27 = 0u;
  do
  {
    v28 = *((int32x4_t *)v24 - 1);
    v29 = *(int32x4_t *)v24;
    v24 += 8;
    v26 -= 8;
    v25 = vaddq_s32(v28, v25);
    v27 = vaddq_s32(v29, v27);
  }
  while ( v26 );
  result = vaddvq_s32(vaddq_s32(v27, v25));
  if ( v22 != n )
    goto LABEL_17;
  return result;
}


/* Function: call_vectorized_loop @ 0xCD0 */
int __cdecl call_vectorized_loop()
{
  return 72;
}


/* Function: param_link_time_optimization @ 0xCD8 */
int __fastcall param_link_time_optimization(int x)
{
  return 2 * x + 10;
}


/* Function: call_link_time_optimization @ 0xCE4 */
int __cdecl call_link_time_optimization()
{
  return 20;
}


/* Function: div_zero_handler @ 0xCEC */
void __fastcall __noreturn div_zero_handler(int sig)
{
  div_zero_caught = 1;
  longjmp(&jmp_buffer, 1);
}


/* Function: param_division_by_zero @ 0xD10 */
int __fastcall param_division_by_zero(int x)
{
  signal(8, (__sighandler_t)div_zero_handler);
  if ( _setjmp(&jmp_buffer) )
    return -1;
  else
    return 10 / x;
}


/* Function: call_division_by_zero @ 0xD5C */
int __cdecl call_division_by_zero()
{
  int v0; // w19
  int v1; // w20

  v0 = param_division_by_zero(5);
  v1 = param_division_by_zero(0);
  signal(8, 0);
  return v1 + v0;
}


/* Function: segv_handler @ 0xD9C */
void __fastcall __noreturn segv_handler(int sig)
{
  segv_caught = 1;
  longjmp(&segv_buffer, 1);
}


/* Function: param_null_pointer_deref @ 0xDC0 */
int __fastcall param_null_pointer_deref(int *p)
{
  signal(11, (__sighandler_t)segv_handler);
  if ( _setjmp(&segv_buffer) )
    return -1;
  else
    return *p;
}


/* Function: call_null_pointer_deref @ 0xE08 */
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


/* Function: param_buffer_overflow_stack @ 0xE58 */
int __fastcall param_buffer_overflow_stack(int x)
{
  return x;
}


/* Function: param_buffer_overflow_heap @ 0xE5C */
int __fastcall param_buffer_overflow_heap(int x)
{
  return x;
}


/* Function: call_buffer_overflow @ 0xE60 */
int __cdecl call_buffer_overflow()
{
  return 30;
}


/* Function: param_integer_overflow @ 0xE68 */
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


/* Function: call_integer_overflow @ 0xEA0 */
int __cdecl call_integer_overflow()
{
  return 2000000000;
}


/* Function: param_undefined_behavior @ 0xEAC */
int __fastcall param_undefined_behavior(int i)
{
  return 2 * i;
}


/* Function: call_undefined_behavior @ 0xEB4 */
int __cdecl call_undefined_behavior()
{
  return 10;
}


/* Function: param_implementation_defined @ 0xEBC */
int __cdecl param_implementation_defined()
{
  return 48;
}


/* Function: call_implementation_defined @ 0xEC4 */
int __cdecl call_implementation_defined()
{
  return 48;
}


/* Function: test_obf_opt_edge @ 0xECC */
void __cdecl test_obf_opt_edge()
{
  int v0; // w8
  int v1; // w9
  int v2; // w10
  __int64 v3; // x1
  int v4; // w8
  unsigned __int8 *v5; // x9
  unsigned __int8 v6; // w11
  int v7; // w19
  int v8; // w0
  int v9; // w19
  int v10; // w20
  int v11; // w19
  int v12; // w20
  int v13[7]; // [xsp+0h] [xbp-20h] BYREF
  char v14; // [xsp+1Fh] [xbp-1h]

  puts(asc_12AD);
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
  strncpy((char *)v13, param_string_encryption_encrypted, 0x20u);
  LOBYTE(v4) = v13[0];
  v14 = 0;
  if ( LOBYTE(v13[0]) )
  {
    v5 = (unsigned __int8 *)v13 + 1;
    do
    {
      v6 = v4 ^ 0x5A;
      v4 = *v5;
      *(v5++ - 1) = v6;
    }
    while ( v4 );
    v7 = LOBYTE(v13[0]);
  }
  else
  {
    v7 = 0;
  }
  v8 = strlen((const char *)v13);
  printf(aObfL405D, (unsigned int)(v8 + v7));
  printf(aOptL401, 500500);
  printf(aOptL401_0, 5050);
  printf(aOptL402, 72);
  printf(aOptL501LtoD, 20);
  v9 = param_division_by_zero(5);
  v10 = param_division_by_zero(0);
  signal(8, 0);
  printf(aEdgeL301D, (unsigned int)(v10 + v9));
  v13[0] = 42;
  v11 = param_null_pointer_deref(v13);
  v12 = param_null_pointer_deref(0);
  signal(11, 0);
  printf(aEdgeL302D, (unsigned int)(v12 + v11));
  printf(aEdgeL303D, 30);
  printf(aEdgeL304D, 2000000000);
  printf(aEdgeL401D, 10);
  printf(aEdgeL402D, 48);
}


/* Function: main @ 0x10AC */
int __fastcall main(int argc, const char **argv, const char **envp)
{
  test_obf_opt_edge();
  return 0;
}


/* Function: .term_proc @ 0x10C4 */
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
