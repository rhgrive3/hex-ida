/*
 * Decompiled by IDA Pro 9.1 with Hex-Rays
 * Binary: /Users/eren/Desktop/Antigravity/compiler/build/arm64/7/7_gcc_O3_no_g
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


/* Function: div_zero_handler @ 0xAE0 */
void __noreturn div_zero_handler()
{
  div_zero_caught = 1;
  __longjmp_chk(&jmp_buffer);
}


/* Function: segv_handler @ 0xB00 */
void __noreturn segv_handler()
{
  segv_caught = 1;
  __longjmp_chk(&segv_buffer);
}


/* Function: param_division_by_zero.constprop.0 @ 0xB20 */
__int64 param_division_by_zero_constprop_0()
{
  signal(8, (__sighandler_t)div_zero_handler);
  if ( !_setjmp(&jmp_buffer) )
    __break(0x3E8u);
  return 0xFFFFFFFFLL;
}


/* Function: param_division_by_zero.constprop.1 @ 0xB60 */
__int64 param_division_by_zero_constprop_1()
{
  signal(8, (__sighandler_t)div_zero_handler);
  if ( _setjmp(&jmp_buffer) )
    return 0xFFFFFFFFLL;
  else
    return 2;
}


/* Function: param_fake_branch @ 0xBA0 */
void param_fake_branch()
{
  ;
}


/* Function: call_fake_branch @ 0xBA4 */
__int64 call_fake_branch()
{
  return 10;
}


/* Function: param_opaque_predicate @ 0xBB0 */
__int64 __fastcall param_opaque_predicate(int a1)
{
  int v1; // w1
  _BOOL4 v2; // w6
  int v3; // w2
  int v4; // w3

  v1 = a1 + 1;
  v2 = 2 * a1 + a1 * a1 + 1 == v1 * v1;
  if ( a1 == -1 )
    return (unsigned int)(3 * a1 + 20);
  v3 = a1;
  do
  {
    v4 = v1;
    v1 = v3 % v1;
    v3 = v4;
  }
  while ( v1 );
  if ( v2 && v4 == 1 )
    return (unsigned int)(2 * a1 + 10);
  else
    return (unsigned int)(3 * a1 + 20);
}


/* Function: call_opaque_predicate @ 0xC10 */
__int64 call_opaque_predicate()
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
__int64 __fastcall param_instruction_substitution(unsigned int a1)
{
  return 6 * a1 + (a1 >> 1) + (a1 & 0xF) + 15 * a1;
}


/* Function: call_instruction_substitution @ 0xC64 */
__int64 call_instruction_substitution()
{
  return 225;
}


/* Function: decrypt_string @ 0xC70 */
char *__fastcall decrypt_string(char *src, char *dest, size_t a3, char a4)
{
  char *result; // x0
  char v7; // w2
  char *v8; // x4
  int v9; // t1

  result = strncpy(dest, src, a3);
  result[a3 - 1] = 0;
  v7 = *result;
  if ( *result )
  {
    v8 = result;
    do
    {
      *v8 = a4 ^ v7;
      v9 = (unsigned __int8)*++v8;
      v7 = v9;
    }
    while ( v9 );
  }
  return result;
}


/* Function: param_string_encryption @ 0xCD0 */
__int64 param_string_encryption()
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
  return v1 + (unsigned int)strlen(v2);
}


/* Function: call_string_encryption @ 0xD70 */
__int64 call_string_encryption()
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
  return v1 + (unsigned int)strlen(v2);
}


/* Function: param_tail_call_optimized @ 0xE10 */
__int64 __fastcall param_tail_call_optimized(signed int a1, unsigned int a2)
{
  __int64 result; // x0
  signed int v4; // w5
  int32x4_t v5; // q1
  int v6; // w3
  int32x4_t v7; // q3
  int32x4_t v8; // q0
  int32x4_t v9; // q2
  int v10; // w4
  bool v11; // zf
  unsigned int v12; // w2

  result = a2;
  if ( a1 > 0 )
  {
    v4 = a1;
    if ( a1 <= 8 )
      goto LABEL_6;
    v5 = 0u;
    v6 = 0;
    v7.n128_u64[0] = 0x300000003LL;
    v7.n128_u64[1] = 0x300000003LL;
    v8 = vaddq_s32(vdupq_n_s32(a1), (int32x4_t)xmmword_1870);
    do
    {
      v9 = v8;
      ++v6;
      v8 = vaddq_s32(v8, v7);
      v5 = vaddq_s32(v5, v9);
    }
    while ( (unsigned int)a1 >> 2 != v6 );
    v10 = a1 & 0x7FFFFFFC;
    a1 -= a1 & 0xFFFFFFFC;
    result = a2 + vaddvq_s32(v5);
    if ( v4 != v10 )
    {
LABEL_6:
      result = (unsigned int)(result + a1);
      if ( a1 != 1 )
      {
        result = (unsigned int)(result + a1 - 1);
        if ( a1 != 2 )
        {
          result = (unsigned int)(result + a1 - 2);
          if ( a1 != 3 )
          {
            result = (unsigned int)(result + a1 - 3);
            if ( a1 != 4 )
            {
              result = (unsigned int)(result + a1 - 4);
              if ( a1 != 5 )
              {
                LODWORD(result) = result + a1 - 5;
                v11 = a1 == 6;
                v12 = a1 - 7 + a1 - 6 + result;
                if ( v11 )
                  return (unsigned int)result;
                else
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
__int64 call_tail_call_optimized()
{
  return 500500;
}


/* Function: param_non_tail_call @ 0xEF0 */
__int64 __fastcall param_non_tail_call(signed int a1)
{
  __int64 result; // x0
  signed int v3; // w3
  int32x4_t v4; // q0
  int v5; // w0
  int32x4_t v6; // q3
  int32x4_t v7; // q1
  int32x4_t v8; // q2
  int v9; // w2
  bool v10; // zf
  unsigned int v11; // w1

  result = 0;
  if ( a1 > 0 )
  {
    v3 = a1;
    if ( a1 <= 8 )
    {
      LODWORD(result) = 0;
    }
    else
    {
      v4 = 0u;
      v5 = 0;
      v6.n128_u64[0] = 0x300000003LL;
      v6.n128_u64[1] = 0x300000003LL;
      v7 = vaddq_s32(vdupq_n_s32(a1), (int32x4_t)xmmword_1870);
      do
      {
        v8 = v7;
        ++v5;
        v7 = vaddq_s32(v7, v6);
        v4 = vaddq_s32(v4, v8);
      }
      while ( (unsigned int)a1 >> 2 != v5 );
      v9 = a1 & 0x7FFFFFFC;
      a1 -= a1 & 0xFFFFFFFC;
      result = (unsigned int)vaddvq_s32(v4);
      if ( v3 == v9 )
        return result;
    }
    result = (unsigned int)(result + a1);
    if ( a1 != 1 )
    {
      result = (unsigned int)(result + a1 - 1);
      if ( a1 != 2 )
      {
        result = (unsigned int)(result + a1 - 2);
        if ( a1 != 3 )
        {
          result = (unsigned int)(result + a1 - 3);
          if ( a1 != 4 )
          {
            result = (unsigned int)(result + a1 - 4);
            if ( a1 != 5 )
            {
              LODWORD(result) = result + a1 - 5;
              v10 = a1 == 6;
              v11 = a1 - 7 + a1 - 6 + result;
              if ( v10 )
                return (unsigned int)result;
              else
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
__int64 call_non_tail_call()
{
  return 5050;
}


/* Function: param_vectorized_loop @ 0xFD0 */
__int64 __fastcall param_vectorized_loop(__int64 a1, __int64 a2, int32x4_t *a3, int a4)
{
  unsigned int v4; // w7
  unsigned int v7; // w5
  __int64 v8; // x4
  unsigned int v9; // w4
  __int64 v10; // x6
  int32x4_t v11; // q0
  int32x4_t *v12; // x0
  int32x4_t v13; // t1
  signed int v14; // w1
  __int64 result; // x0
  char *v16; // x2
  __int64 v17; // x4

  if ( a4 <= 0 )
    return 0;
  v4 = a4 - 1;
  if ( (unsigned __int64)a3->n128_u64 - a1 - 4 > 8 && (unsigned __int64)a3->n128_u64 - a2 - 4 > 8 && v4 > 3 )
  {
    v7 = (unsigned int)a4 >> 2;
    v8 = 0;
    do
    {
      a3[v8] = vaddq_s32(*(int32x4_t *)(a1 + v8 * 16), *(int32x4_t *)(a2 + v8 * 16));
      ++v8;
    }
    while ( v8 != (unsigned int)a4 >> 2 );
    v9 = a4 & 0x7FFFFFFC;
    if ( (a4 & 3) != 0 )
    {
      v10 = 4LL * v9;
      a3->n128_u32[(unsigned __int64)v10 / 4] = *(_DWORD *)(a2 + v10) + *(_DWORD *)(a1 + v10);
      if ( a4 > (int)(v9 + 1) )
      {
        a3->n128_u32[(unsigned __int64)v10 / 4 + 1] = *(_DWORD *)(a1 + v10 + 4) + *(_DWORD *)(a2 + v10 + 4);
        if ( a4 > (int)(v9 + 2) )
          a3->n128_u32[(unsigned __int64)v10 / 4 + 2] = *(_DWORD *)(a1 + v10 + 8) + *(_DWORD *)(a2 + v10 + 8);
      }
    }
LABEL_16:
    v11 = 0u;
    v12 = a3;
    do
    {
      v13 = *v12++;
      v11 = vaddq_s32(v11, v13);
    }
    while ( v12 != &a3[v7] );
    v14 = v9;
    result = (unsigned int)vaddvq_s32(v11);
    if ( v9 == a4 )
      return result;
    goto LABEL_19;
  }
  v17 = 0;
  do
  {
    a3->n128_u32[v17] = *(_DWORD *)(a1 + 4 * v17) + *(_DWORD *)(a2 + 4 * v17);
    ++v17;
  }
  while ( a4 > (int)v17 );
  if ( v4 > 2 )
  {
    v7 = (unsigned int)a4 >> 2;
    v9 = a4 & 0xFFFFFFFC;
    goto LABEL_16;
  }
  v14 = 0;
  LODWORD(result) = 0;
LABEL_19:
  result = (unsigned int)(result + a3->n128_u32[v14]);
  if ( v14 + 1 < a4 )
  {
    v16 = (char *)a3 + 4 * v14;
    result = (unsigned int)(result + *((_DWORD *)v16 + 1));
    if ( v14 + 2 < a4 )
      return (unsigned int)(result + *((_DWORD *)v16 + 2));
  }
  return result;
}


/* Function: call_vectorized_loop @ 0x1154 */
__int64 call_vectorized_loop()
{
  return 72;
}


/* Function: param_link_time_optimization @ 0x1160 */
__int64 __fastcall param_link_time_optimization(int a1)
{
  return (unsigned int)(2 * (a1 + 5));
}


/* Function: call_link_time_optimization @ 0x1170 */
__int64 call_link_time_optimization()
{
  return 20;
}


/* Function: param_division_by_zero @ 0x1180 */
__int64 __fastcall param_division_by_zero(int a1)
{
  signal(8, (__sighandler_t)div_zero_handler);
  if ( _setjmp(&jmp_buffer) )
    return 0xFFFFFFFFLL;
  else
    return (unsigned int)(10 / a1);
}


/* Function: call_division_by_zero @ 0x11D0 */
__int64 call_division_by_zero()
{
  int v0; // w20
  int v1; // w19

  v0 = param_division_by_zero_constprop_1();
  v1 = param_division_by_zero_constprop_0();
  signal(8, 0);
  return (unsigned int)(v0 + v1);
}


/* Function: param_null_pointer_deref @ 0x1210 */
__int64 __fastcall param_null_pointer_deref(unsigned int *a1)
{
  signal(11, (__sighandler_t)segv_handler);
  if ( _setjmp(&segv_buffer) )
    return 0xFFFFFFFFLL;
  else
    return *a1;
}


/* Function: call_null_pointer_deref @ 0x1260 */
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


/* Function: param_buffer_overflow_stack @ 0x12E0 */
void param_buffer_overflow_stack()
{
  ;
}


/* Function: param_buffer_overflow_heap @ 0x12E4 */
__int64 __fastcall param_buffer_overflow_heap(unsigned int a1)
{
  void *v2; // x0

  v2 = malloc(0x10u);
  if ( !v2 )
    return 4294967294LL;
  free(v2);
  return a1;
}


/* Function: call_buffer_overflow @ 0x1320 */
__int64 call_buffer_overflow()
{
  void *v0; // x0

  v0 = malloc(0x10u);
  if ( !v0 )
    return 8;
  free(v0);
  return 30;
}


/* Function: param_integer_overflow @ 0x1350 */
__int64 __fastcall param_integer_overflow(int a1, int a2)
{
  bool v3; // zf
  bool v4; // nf
  __int64 result; // x0
  bool v6; // zf
  bool v7; // nf

  if ( a1 > 0 )
  {
    v3 = a2 == 0;
    v4 = a2 < 0;
  }
  else
  {
    v3 = 1;
    v4 = 0;
  }
  LODWORD(result) = a1 + a2;
  if ( v4 || v3 )
  {
    if ( (a1 & a2) < 0 )
    {
      v6 = (_DWORD)result == 0;
      v7 = (int)result < 0;
    }
    else
    {
      v6 = 1;
      v7 = 0;
    }
    if ( v7 || v6 )
      return (unsigned int)result;
    else
      return 4294967294LL;
  }
  else if ( (int)result < 0 )
  {
    return 0xFFFFFFFFLL;
  }
  else
  {
    return (unsigned int)result;
  }
}


/* Function: call_integer_overflow @ 0x1384 */
__int64 call_integer_overflow()
{
  return 2000000000;
}


/* Function: param_undefined_behavior @ 0x1390 */
__int64 __fastcall param_undefined_behavior(int a1)
{
  return (unsigned int)(2 * a1);
}


/* Function: call_undefined_behavior @ 0x13A0 */
__int64 call_undefined_behavior()
{
  return 10;
}


/* Function: param_implementation_defined @ 0x13B0 */
__int64 param_implementation_defined()
{
  return 48;
}


/* Function: call_implementation_defined @ 0x13C0 */
__int64 call_implementation_defined()
{
  return 48;
}


/* Function: test_obf_opt_edge @ 0x13D0 */
__int64 test_obf_opt_edge()
{
  int v0; // w0
  int v1; // w1
  int v2; // w2
  __int64 v3; // x2
  int v4; // w19
  char *v5; // x0
  int v6; // t1
  int v7; // w0
  int v8; // w20
  int v9; // w19
  int v10; // w20
  int v11; // w19
  void *v12; // x0
  __int64 v13; // x2
  unsigned int v15; // [xsp+24h] [xbp+24h] BYREF
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
  __printf_chk(1, &unk_1768, 20);
  v8 = param_division_by_zero_constprop_1();
  v9 = param_division_by_zero_constprop_0();
  signal(8, 0);
  __printf_chk(1, &unk_1788, (unsigned int)(v8 + v9));
  v15 = 42;
  v10 = param_null_pointer_deref(&v15);
  v11 = param_null_pointer_deref(0);
  signal(11, 0);
  __printf_chk(1, &unk_17A8, (unsigned int)(v10 + v11));
  v12 = malloc(0x10u);
  if ( v12 )
  {
    free(v12);
    v13 = 30;
  }
  else
  {
    v13 = 8;
  }
  __printf_chk(1, &unk_17C8, v13);
  __printf_chk(1, &unk_17E8, 2000000000);
  __printf_chk(1, &unk_1820, 10);
  return __printf_chk(1, &unk_1840, 48);
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
