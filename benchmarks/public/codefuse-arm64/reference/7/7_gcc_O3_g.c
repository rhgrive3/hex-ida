/*
 * Decompiled by IDA Pro 9.1 with Hex-Rays
 * Binary: /Users/eren/Desktop/Antigravity/compiler/build/arm64/7/7_gcc_O3_g
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
  test_obf_opt_edge();
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


/* Function: div_zero_handler @ 0xAE0 */
void __fastcall __noreturn div_zero_handler(int sig)
{
  div_zero_caught = 1;
  __longjmp_chk(jmp_buffer);
}


/* Function: segv_handler @ 0xB00 */
void __fastcall __noreturn segv_handler(int sig)
{
  segv_caught = 1;
  __longjmp_chk(segv_buffer);
}


/* Function: param_division_by_zero_0 @ 0xB20 */
__int64 __fastcall param_division_by_zero_0(int x)
{
  signal(8, (__sighandler_t)div_zero_handler);
  if ( !_setjmp(jmp_buffer) )
    __break(0x3E8u);
  return 0xFFFFFFFFLL;
}


/* Function: param_division_by_zero_1 @ 0xB60 */
__int64 __fastcall param_division_by_zero_1(int x)
{
  signal(8, (__sighandler_t)div_zero_handler);
  if ( _setjmp(jmp_buffer) )
    return 0xFFFFFFFFLL;
  else
    return 2;
}


/* Function: param_fake_branch @ 0xBA0 */
int __fastcall param_fake_branch(int x)
{
  return x;
}


/* Function: call_fake_branch @ 0xBA4 */
int __cdecl call_fake_branch()
{
  return 10;
}


/* Function: param_opaque_predicate @ 0xBB0 */
int __fastcall param_opaque_predicate(int x)
{
  int v1; // w1
  _BOOL4 v2; // w6
  int v3; // w2
  int v4; // w3

  v1 = x + 1;
  v2 = 2 * x + x * x + 1 == v1 * v1;
  if ( x == -1 )
    return 3 * x + 20;
  v3 = x;
  do
  {
    v4 = v1;
    v1 = v3 % v1;
    v3 = v4;
  }
  while ( v1 );
  if ( v2 && v4 == 1 )
    return 2 * x + 10;
  else
    return 3 * x + 20;
}


/* Function: call_opaque_predicate @ 0xC10 */
int __cdecl call_opaque_predicate()
{
  int v0; // w0
  int v1; // w1
  int v2; // w2

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


/* Function: param_instruction_substitution @ 0xC40 */
int __fastcall param_instruction_substitution(int x)
{
  return 6 * x + ((unsigned int)x >> 1) + (x & 0xF) + 15 * x;
}


/* Function: call_instruction_substitution @ 0xC64 */
int __cdecl call_instruction_substitution()
{
  return 225;
}


/* Function: decrypt_string @ 0xC70 */
const char *__fastcall decrypt_string(const char *encrypted, char *buffer, size_t len, char key)
{
  const char *result; // x0
  char v7; // w2
  char *v8; // x4
  int v9; // t1

  result = strncpy(buffer, encrypted, len);
  result[len - 1] = 0;
  v7 = *result;
  if ( *result )
  {
    v8 = (char *)result;
    do
    {
      *v8 = key ^ v7;
      v9 = (unsigned __int8)*++v8;
      v7 = v9;
    }
    while ( v9 );
  }
  return result;
}


/* Function: param_string_encryption @ 0xCD0 */
int __cdecl param_string_encryption()
{
  char *v0; // x0
  int v1; // w19
  const char *v2; // x4
  int v3; // t1
  char decrypted[32]; // [xsp+28h] [xbp+28h] BYREF

  v0 = strncpy(decrypted, encrypted_0, 0x1Fu);
  v1 = (unsigned __int8)decrypted[0];
  decrypted[31] = 0;
  v2 = v0;
  if ( decrypted[0] )
  {
    do
    {
      *v0 = v1 ^ 0x5A;
      v3 = (unsigned __int8)*++v0;
      LOBYTE(v1) = v3;
    }
    while ( v3 );
    v1 = (unsigned __int8)decrypted[0];
  }
  return v1 + strlen(v2);
}


/* Function: call_string_encryption @ 0xD70 */
int __cdecl call_string_encryption()
{
  char *v0; // x0
  int v1; // w19
  const char *v2; // x4
  int v3; // t1
  char dest[32]; // [xsp+28h] [xbp+28h] BYREF

  v0 = strncpy(dest, encrypted_0, 0x1Fu);
  v1 = (unsigned __int8)dest[0];
  dest[31] = 0;
  v2 = v0;
  if ( dest[0] )
  {
    do
    {
      *v0 = v1 ^ 0x5A;
      v3 = (unsigned __int8)*++v0;
      LOBYTE(v1) = v3;
    }
    while ( v3 );
    v1 = (unsigned __int8)dest[0];
  }
  return v1 + strlen(v2);
}


/* Function: param_tail_call_optimized @ 0xE10 */
int __fastcall param_tail_call_optimized(int n, int acc)
{
  int result; // w0
  int v4; // w5
  int32x4_t v5; // q1
  int v6; // w3
  int32x4_t v7; // q3
  int32x4_t v8; // q0
  int32x4_t v9; // q2
  int v10; // w4
  bool v11; // zf
  int v12; // w2

  result = acc;
  if ( n > 0 )
  {
    v4 = n;
    if ( n <= 8 )
      goto LABEL_6;
    v5 = 0u;
    v6 = 0;
    v7.n128_u64[0] = 0x300000003LL;
    v7.n128_u64[1] = 0x300000003LL;
    v8 = vaddq_s32(vdupq_n_s32(n), (int32x4_t)xmmword_1870);
    do
    {
      v9 = v8;
      ++v6;
      v8 = vaddq_s32(v8, v7);
      v5 = vaddq_s32(v5, v9);
    }
    while ( (unsigned int)n >> 2 != v6 );
    v10 = n & 0x7FFFFFFC;
    n -= n & 0xFFFFFFFC;
    result = acc + vaddvq_s32(v5);
    if ( v4 != v10 )
    {
LABEL_6:
      result += n;
      if ( n != 1 )
      {
        result += n - 1;
        if ( n != 2 )
        {
          result += n - 2;
          if ( n != 3 )
          {
            result += n - 3;
            if ( n != 4 )
            {
              result += n - 4;
              if ( n != 5 )
              {
                result += n - 5;
                v11 = n == 6;
                v12 = n - 7 + n - 6 + result;
                if ( !v11 )
                  return v12;
              }
            }
          }
        }
      }
    }
  }
  return result;
}


/* Function: call_tail_call_optimized @ 0xEE0 */
int __cdecl call_tail_call_optimized()
{
  return 500500;
}


/* Function: param_non_tail_call @ 0xEF0 */
int __fastcall param_non_tail_call(int n)
{
  int result; // w0
  int v3; // w3
  int32x4_t v4; // q0
  int v5; // w0
  int32x4_t v6; // q3
  int32x4_t v7; // q1
  int32x4_t v8; // q2
  int v9; // w2
  bool v10; // zf
  int v11; // w1

  result = 0;
  if ( n > 0 )
  {
    v3 = n;
    if ( n <= 8 )
    {
      result = 0;
    }
    else
    {
      v4 = 0u;
      v5 = 0;
      v6.n128_u64[0] = 0x300000003LL;
      v6.n128_u64[1] = 0x300000003LL;
      v7 = vaddq_s32(vdupq_n_s32(n), (int32x4_t)xmmword_1870);
      do
      {
        v8 = v7;
        ++v5;
        v7 = vaddq_s32(v7, v6);
        v4 = vaddq_s32(v4, v8);
      }
      while ( (unsigned int)n >> 2 != v5 );
      v9 = n & 0x7FFFFFFC;
      n -= n & 0xFFFFFFFC;
      result = vaddvq_s32(v4);
      if ( v3 == v9 )
        return result;
    }
    result += n;
    if ( n != 1 )
    {
      result += n - 1;
      if ( n != 2 )
      {
        result += n - 2;
        if ( n != 3 )
        {
          result += n - 3;
          if ( n != 4 )
          {
            result += n - 4;
            if ( n != 5 )
            {
              result += n - 5;
              v10 = n == 6;
              v11 = n - 7 + n - 6 + result;
              if ( !v10 )
                return v11;
            }
          }
        }
      }
    }
  }
  return result;
}


/* Function: call_non_tail_call @ 0xFC0 */
int __cdecl call_non_tail_call()
{
  return 5050;
}


/* Function: param_vectorized_loop @ 0xFD0 */
int __fastcall param_vectorized_loop(int *a, int *b, int *c, int n)
{
  unsigned int v4; // w7
  unsigned int v7; // w5
  __int64 v8; // x4
  unsigned int v9; // w4
  __int64 v10; // x6
  int32x4_t v11; // q0
  int *v12; // x0
  int32x4_t v13; // t1
  unsigned int v14; // w1
  int result; // w0
  int *v16; // x2
  __int64 v17; // x4

  if ( n <= 0 )
    return 0;
  v4 = n - 1;
  if ( (unsigned __int64)((char *)c - (char *)(a + 1)) > 8
    && (unsigned __int64)((char *)c - (char *)(b + 1)) > 8
    && v4 > 3 )
  {
    v7 = (unsigned int)n >> 2;
    v8 = 0;
    do
    {
      *(int32x4_t *)&c[v8] = vaddq_s32(*(int32x4_t *)&a[v8], *(int32x4_t *)&b[v8]);
      v8 += 4;
    }
    while ( v8 != 4LL * ((unsigned int)n >> 2) );
    v9 = n & 0x7FFFFFFC;
    if ( (n & 3) != 0 )
    {
      v10 = v9;
      c[v10] = b[v10] + a[v10];
      if ( n > (int)(v9 + 1) )
      {
        c[v10 + 1] = a[v10 + 1] + b[v10 + 1];
        if ( n > (int)(v9 + 2) )
          c[v10 + 2] = a[v10 + 2] + b[v10 + 2];
      }
    }
LABEL_16:
    v11 = 0u;
    v12 = c;
    do
    {
      v13 = *(int32x4_t *)v12;
      v12 += 4;
      v11 = vaddq_s32(v11, v13);
    }
    while ( v12 != &c[4 * v7] );
    v14 = v9;
    result = vaddvq_s32(v11);
    if ( v9 == n )
      return result;
    goto LABEL_19;
  }
  v17 = 0;
  do
  {
    c[v17] = a[v17] + b[v17];
    ++v17;
  }
  while ( n > (int)v17 );
  if ( v4 > 2 )
  {
    v7 = (unsigned int)n >> 2;
    v9 = n & 0xFFFFFFFC;
    goto LABEL_16;
  }
  v14 = 0;
  result = 0;
LABEL_19:
  result += c[v14];
  if ( (int)(v14 + 1) < n )
  {
    v16 = &c[v14];
    result += v16[1];
    if ( (int)(v14 + 2) < n )
      result += v16[2];
  }
  return result;
}


/* Function: call_vectorized_loop @ 0x1154 */
int __cdecl call_vectorized_loop()
{
  return 72;
}


/* Function: param_link_time_optimization @ 0x1160 */
int __fastcall param_link_time_optimization(int x)
{
  return 2 * (x + 5);
}


/* Function: call_link_time_optimization @ 0x1170 */
int __cdecl call_link_time_optimization()
{
  return 20;
}


/* Function: param_division_by_zero @ 0x1180 */
int __fastcall param_division_by_zero(int x)
{
  signal(8, (__sighandler_t)div_zero_handler);
  if ( _setjmp(jmp_buffer) )
    return -1;
  else
    return 10 / x;
}


/* Function: call_division_by_zero @ 0x11D0 */
int __cdecl call_division_by_zero()
{
  int v0; // w0
  int v1; // w20
  int v2; // w19

  v1 = param_division_by_zero_1(v0);
  v2 = param_division_by_zero_0(v1);
  signal(8, 0);
  return v1 + v2;
}


/* Function: param_null_pointer_deref @ 0x1210 */
int __fastcall param_null_pointer_deref(int *p)
{
  signal(11, (__sighandler_t)segv_handler);
  if ( _setjmp(segv_buffer) )
    return -1;
  else
    return *p;
}


/* Function: call_null_pointer_deref @ 0x1260 */
int __cdecl call_null_pointer_deref()
{
  int v0; // w19
  int v1; // w20
  int valid; // [xsp+24h] [xbp+24h] BYREF

  valid = 42;
  v0 = param_null_pointer_deref(&valid);
  v1 = param_null_pointer_deref(0);
  signal(11, 0);
  return v0 + v1;
}


/* Function: param_buffer_overflow_stack @ 0x12E0 */
void param_buffer_overflow_stack()
{
  ;
}


/* Function: param_buffer_overflow_heap @ 0x12E4 */
int __fastcall param_buffer_overflow_heap(int x)
{
  void *v2; // x0

  v2 = malloc(0x10u);
  if ( !v2 )
    return -2;
  free(v2);
  return x;
}


/* Function: call_buffer_overflow @ 0x1320 */
int __cdecl call_buffer_overflow()
{
  void *v0; // x0

  v0 = malloc(0x10u);
  if ( !v0 )
    return 8;
  free(v0);
  return 30;
}


/* Function: param_integer_overflow @ 0x1350 */
int __fastcall param_integer_overflow(int a, int b)
{
  bool v3; // zf
  bool v4; // nf
  int result; // w0
  bool v6; // zf
  bool v7; // nf

  if ( a > 0 )
  {
    v3 = b == 0;
    v4 = b < 0;
  }
  else
  {
    v3 = 1;
    v4 = 0;
  }
  result = a + b;
  if ( v4 || v3 )
  {
    if ( (a & b) < 0 )
    {
      v6 = result == 0;
      v7 = result < 0;
    }
    else
    {
      v6 = 1;
      v7 = 0;
    }
    if ( !v7 && !v6 )
      return -2;
  }
  else if ( result < 0 )
  {
    return -1;
  }
  return result;
}


/* Function: call_integer_overflow @ 0x1384 */
int __cdecl call_integer_overflow()
{
  return 2000000000;
}


/* Function: param_undefined_behavior @ 0x1390 */
int __fastcall param_undefined_behavior(int i)
{
  return 2 * i;
}


/* Function: call_undefined_behavior @ 0x13A0 */
__int64 call_undefined_behavior()
{
  return 10;
}


/* Function: param_implementation_defined @ 0x13B0 */
int __cdecl param_implementation_defined()
{
  return 48;
}


/* Function: call_implementation_defined @ 0x13C0 */
__int64 call_implementation_defined()
{
  return 48;
}


/* Function: test_obf_opt_edge @ 0x13D0 */
void __cdecl test_obf_opt_edge()
{
  int v0; // w0
  int v1; // w1
  int v2; // w2
  __int64 v3; // x2
  int v4; // w19
  char *v5; // x0
  int v6; // t1
  int v7; // w0
  int v8; // w0
  int v9; // w20
  int v10; // w19
  int v11; // w20
  int v12; // w19
  void *v13; // x0
  __int64 v14; // x2
  int p; // [xsp+24h] [xbp+24h] BYREF
  char v16[32]; // [xsp+28h] [xbp+28h] BYREF

  puts(asc_1638);
  __printf_chk(1, &unk_1668, 10);
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
  __printf_chk(1, &unk_1688, v3);
  __printf_chk(1, &unk_16A8, 225);
  strncpy(v16, encrypted_0, 0x1Fu);
  v4 = (unsigned __int8)v16[0];
  v16[31] = 0;
  if ( v16[0] )
  {
    v5 = v16;
    do
    {
      *v5 = v4 ^ 0x5A;
      v6 = (unsigned __int8)*++v5;
      LOBYTE(v4) = v6;
    }
    while ( v6 );
    v4 = (unsigned __int8)v16[0];
  }
  v7 = strlen(v16);
  __printf_chk(1, &unk_16C8, (unsigned int)(v4 + v7));
  __printf_chk(1, &unk_16E8, 500500);
  __printf_chk(1, &unk_1718, 5050);
  __printf_chk(1, &unk_1740, 72);
  v8 = __printf_chk(1, &unk_1768, 20);
  v9 = param_division_by_zero_1(v8);
  v10 = param_division_by_zero_0(v9);
  signal(8, 0);
  __printf_chk(1, &unk_1788, (unsigned int)(v9 + v10));
  p = 42;
  v11 = param_null_pointer_deref(&p);
  v12 = param_null_pointer_deref(0);
  signal(11, 0);
  __printf_chk(1, &unk_17A8, (unsigned int)(v11 + v12));
  v13 = malloc(0x10u);
  if ( v13 )
  {
    free(v13);
    v14 = 30;
  }
  else
  {
    v14 = 8;
  }
  __printf_chk(1, &unk_17C8, v14);
  __printf_chk(1, &unk_17E8, 2000000000);
  __printf_chk(1, &unk_1820, 10);
  __printf_chk(1, &unk_1840, 48);
}


/* Function: .term_proc @ 0x1618 */
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

/* FAILED to decompile: __printf_chk @ 0x13320 */

/* FAILED to decompile: __stack_chk_fail @ 0x13328 */

/* FAILED to decompile: abort @ 0x13338 */

/* FAILED to decompile: puts @ 0x13340 */

/* FAILED to decompile: free @ 0x13348 */

/* FAILED to decompile: __longjmp_chk @ 0x13350 */

/* FAILED to decompile: strncpy @ 0x13358 */

/* FAILED to decompile: __gmon_start__ @ 0x13368 */

/* Total functions decompiled: 45, failed: 14 */
