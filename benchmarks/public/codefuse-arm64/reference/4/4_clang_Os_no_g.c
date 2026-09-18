/*
 * Decompiled by IDA Pro 9.1 with Hex-Rays
 * Binary: /Users/eren/Desktop/Antigravity/compiler/build/arm64/4/4_clang_Os_no_g
 * Processor: arm
 */

/* Function: .init_proc @ 0x668 */
__int64 init_proc()
{
  return call_weak_fn();
}


/* Function: sub_680 @ 0x680 */
void sub_680()
{
  JUMPOUT(0);
}


/* Function: _start @ 0x740 */
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


/* Function: call_weak_fn @ 0x774 */
void *call_weak_fn()
{
  void *result; // x0

  result = &_gmon_start__;
  if ( &_gmon_start__ )
    return (void *)__gmon_start__();
  return result;
}


/* Function: deregister_tm_clones @ 0x790 */
char *deregister_tm_clones()
{
  return &_bss_start;
}


/* Function: register_tm_clones @ 0x7C0 */
char *register_tm_clones()
{
  return &_bss_start;
}


/* Function: __do_global_dtors_aux @ 0x800 */
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


/* Function: frame_dummy @ 0x850 */
// attributes: thunk
char *frame_dummy()
{
  return register_tm_clones();
}


/* Function: cdecl_func @ 0x854 */
__int64 __fastcall cdecl_func(int a1, int a2)
{
  return (unsigned int)(a2 + a1);
}


/* Function: call_cdecl @ 0x85C */
__int64 call_cdecl()
{
  return 15;
}


/* Function: stdcall_func @ 0x864 */
__int64 __fastcall stdcall_func(int a1, int a2)
{
  return (unsigned int)(a2 * a1);
}


/* Function: call_stdcall @ 0x86C */
__int64 call_stdcall()
{
  return 50;
}


/* Function: fastcall_func @ 0x874 */
__int64 __fastcall fastcall_func(int a1, int a2, int a3)
{
  return (unsigned int)(a2 + a1 + a3);
}


/* Function: call_fastcall @ 0x880 */
__int64 call_fastcall()
{
  return 6;
}


/* Function: call_thiscall @ 0x888 */
__int64 call_thiscall()
{
  return 15;
}


/* Function: arm_aapcs_func @ 0x890 */
__int64 __fastcall arm_aapcs_func(int a1, int a2, int a3, int a4, int a5)
{
  return (unsigned int)(a2 + a1 + a3 + a4 + a5);
}


/* Function: call_arm_aapcs @ 0x8A4 */
__int64 call_arm_aapcs()
{
  return 15;
}


/* Function: mips_func @ 0x8AC */
__int64 __fastcall mips_func(int a1, int a2, int a3, int a4)
{
  return (unsigned int)(a2 + a1 + a3 + a4);
}


/* Function: call_mips @ 0x8BC */
__int64 call_mips()
{
  return 100;
}


/* Function: amd64_sysv_func @ 0x8C4 */
__int64 __fastcall amd64_sysv_func(int a1, int a2, int a3, int a4, int a5, int a6)
{
  return (unsigned int)(a2 + a1 + a3 + a4 + a5 + a6);
}


/* Function: call_amd64_sysv @ 0x8DC */
__int64 call_amd64_sysv()
{
  return 21;
}


/* Function: ms_x64_func @ 0x8E4 */
__int64 __fastcall ms_x64_func(int a1, int a2, int a3, int a4, int a5)
{
  return (unsigned int)(a2 + a1 + a3 + a4 + a5);
}


/* Function: call_ms_x64 @ 0x8F8 */
__int64 call_ms_x64()
{
  return 15;
}


/* Function: vectorcall_func @ 0x900 */
__int64 __fastcall vectorcall_func(int a1, int a2, int a3, int a4)
{
  return (unsigned int)(a2 + a1 + a3 + a4);
}


/* Function: call_vectorcall @ 0x910 */
__int64 call_vectorcall()
{
  return 10;
}


/* Function: mixed_conventions_test @ 0x918 */
__int64 mixed_conventions_test()
{
  return 33;
}


/* Function: varargs_func @ 0x920 */
__int64 __fastcall varargs_func(
        int a1,
        __int64 a2,
        __int64 a3,
        __int64 a4,
        __int64 a5,
        __int64 a6,
        __int64 a7,
        __int64 a8)
{
  unsigned int v8; // w8
  unsigned int v9; // w11
  unsigned int v10; // w10
  _DWORD *v11; // x11
  _QWORD v13[8]; // [xsp+80h] [xbp-60h] BYREF
  _DWORD *v14; // [xsp+C0h] [xbp-20h] BYREF
  _QWORD *v15; // [xsp+C8h] [xbp-18h]
  _QWORD *v16; // [xsp+D0h] [xbp-10h]
  unsigned __int64 v17; // [xsp+D8h] [xbp-8h]

  v16 = v13;
  v17 = 0xFFFFFF80FFFFFFC8LL;
  v8 = 0;
  v13[3] = a4;
  v13[4] = a5;
  v13[1] = a2;
  v13[2] = a3;
  v13[5] = a6;
  v13[6] = a7;
  v15 = &v14;
  v13[7] = a8;
  if ( a1 >= 1 )
  {
    v9 = v17;
    while ( (v9 & 0x80000000) != 0 )
    {
      v10 = v9 + 8;
      LODWORD(v17) = v9 + 8;
      if ( v9 > 0xFFFFFFF8 )
        goto LABEL_7;
      v11 = (_DWORD *)((char *)v15 + (int)v9);
LABEL_8:
      --a1;
      v8 += *v11;
      v9 = v10;
      if ( !a1 )
        return v8;
    }
    v10 = v9;
LABEL_7:
    v11 = v14;
    v14 += 2;
    goto LABEL_8;
  }
  return v8;
}


/* Function: func_no_args @ 0x9CC */
__int64 func_no_args()
{
  return 42;
}


/* Function: func_many_args @ 0x9D4 */
__int64 __fastcall func_many_args(int a1, int a2, int a3, int a4, int a5, int a6, int a7, int a8)
{
  return (unsigned int)(a2 + a1 + a3 + a4 + a5 + a6 + a7 + a8);
}


/* Function: func_mixed_args @ 0x9F4 */
__int64 __fastcall func_mixed_args(int a1, char *s, __int64 a3, double a4)
{
  int v7; // w0

  if ( s )
    v7 = strlen(s);
  else
    v7 = 0;
  return (unsigned int)(int)((double)(v7 + a1) + a4 + (double)a3);
}


/* Function: func_struct_byval @ 0xA4C */
__int64 __fastcall func_struct_byval(__int64 a1)
{
  int64x2_t v1; // q0
  __int64 i; // x8
  int64x2_t v3; // q1

  v1 = 0u;
  for ( i = 0; i != 128; i += 16 )
  {
    v3 = *(int64x2_t *)(a1 + i);
    v1 = vaddq_s64(v3, v1);
  }
  return vaddvq_s64(v1);
}


/* Function: func_struct_byptr @ 0xA74 */
__int64 __fastcall func_struct_byptr(_DWORD *a1)
{
  if ( a1 )
    return (unsigned int)(a1[1] * *a1);
  else
    return 0xFFFFFFFFLL;
}


/* Function: test_calling_conventions @ 0xA8C */
__int64 test_calling_conventions()
{
  __int64 v0; // x6
  __int64 v1; // x7
  unsigned int v2; // w0
  __int64 v3; // x8
  int64x2_t v4; // q0
  int64x2_t v5; // q1
  int64x2_t v6; // q0
  __int64 i; // x8
  int64x2_t v8; // q1
  _BYTE v10[128]; // [xsp+0h] [xbp-100h] BYREF
  _BYTE src[128]; // [xsp+80h] [xbp-80h] BYREF

  puts(asc_157A);
  printf("CALL-L1-01: %d\n", 15);
  printf("CALL-L1-02: %d\n", 50);
  printf("CALL-L1-03: %d\n", 6);
  printf("CALL-L1-04: %d\n", 15);
  printf("CALL-L1-05: %d\n", 15);
  printf("CALL-L1-06: %d\n", 100);
  printf("CALL-L1-07: %d\n", 21);
  printf("CALL-L1-08: %d\n", 15);
  printf("CALL-L1-09: %d\n", 10);
  printf("CALL-L1-10: %d\n", 33);
  v2 = varargs_func(5, 1, 2, 3, 4, 5, v0, v1);
  printf(aCallL206, v2);
  printf(aCallL207, 42);
  printf(aCallL208, 36);
  printf(aCallL209, 117);
  v3 = 0;
  v4 = (int64x2_t)xmmword_11E0;
  do
  {
    v5 = vaddq_s64(v4, vdupq_n_s64(1u));
    v4 = vaddq_s64(v4, vdupq_n_s64(2u));
    *(int64x2_t *)&src[v3] = v5;
    v3 += 16;
  }
  while ( v3 != 128 );
  memcpy(v10, src, sizeof(v10));
  v6 = 0u;
  for ( i = 0; i != 128; i += 16 )
  {
    v8 = *(int64x2_t *)&v10[i];
    v6 = vaddq_s64(v8, v6);
  }
  printf(aCallL210, vaddvq_s64(v6));
  return printf(aCallL211, 50);
}


/* Function: param_by_value_int @ 0xC44 */
__int64 __fastcall param_by_value_int(int a1)
{
  return (unsigned int)(2 * a1);
}


/* Function: call_by_value_int @ 0xC4C */
__int64 call_by_value_int()
{
  return 15;
}


/* Function: param_by_value_ptr @ 0xC54 */
__int64 __fastcall param_by_value_ptr(_DWORD *a1)
{
  __int64 result; // x0

  result = 1;
  *a1 *= 2;
  return result;
}


/* Function: call_by_value_ptr @ 0xC6C */
__int64 call_by_value_ptr()
{
  return 11;
}


/* Function: param_array_decay @ 0xC74 */
__int64 param_array_decay()
{
  return 8;
}


/* Function: call_array_decay @ 0xC7C */
__int64 call_array_decay()
{
  return 8;
}


/* Function: param_string @ 0xC84 */
__int64 __fastcall param_string(unsigned __int8 *a1)
{
  return a1[1] + (unsigned int)*a1;
}


/* Function: call_string_param @ 0xC94 */
__int64 call_string_param()
{
  return 173;
}


/* Function: param_ptr_array @ 0xC9C */
unsigned __int8 **__fastcall param_ptr_array(unsigned __int8 **result, int a2)
{
  unsigned __int8 **v2; // x8
  __int64 v3; // x9
  unsigned __int8 *v4; // t1

  if ( a2 < 1 )
    return 0;
  v2 = result;
  LODWORD(result) = 0;
  v3 = (unsigned int)a2;
  do
  {
    v4 = *v2++;
    --v3;
    result = (unsigned __int8 **)((unsigned int)result + *v4);
  }
  while ( v3 );
  return result;
}


/* Function: call_ptr_array @ 0xCD0 */
__int64 call_ptr_array()
{
  return 300;
}


/* Function: param_varargs @ 0xCD8 */
__int64 __fastcall param_varargs(
        int a1,
        __int64 a2,
        __int64 a3,
        __int64 a4,
        __int64 a5,
        __int64 a6,
        __int64 a7,
        __int64 a8)
{
  unsigned int v8; // w8
  unsigned int v9; // w11
  unsigned int v10; // w10
  _DWORD *v11; // x11
  _QWORD v13[8]; // [xsp+80h] [xbp-60h] BYREF
  _DWORD *v14; // [xsp+C0h] [xbp-20h] BYREF
  _QWORD *v15; // [xsp+C8h] [xbp-18h]
  _QWORD *v16; // [xsp+D0h] [xbp-10h]
  unsigned __int64 v17; // [xsp+D8h] [xbp-8h]

  v16 = v13;
  v17 = 0xFFFFFF80FFFFFFC8LL;
  v8 = 0;
  v13[3] = a4;
  v13[4] = a5;
  v13[1] = a2;
  v13[2] = a3;
  v13[5] = a6;
  v13[6] = a7;
  v15 = &v14;
  v13[7] = a8;
  if ( a1 >= 1 )
  {
    v9 = v17;
    while ( (v9 & 0x80000000) != 0 )
    {
      v10 = v9 + 8;
      LODWORD(v17) = v9 + 8;
      if ( v9 > 0xFFFFFFF8 )
        goto LABEL_7;
      v11 = (_DWORD *)((char *)v15 + (int)v9);
LABEL_8:
      --a1;
      v8 += *v11;
      v9 = v10;
      if ( !a1 )
        return v8;
    }
    v10 = v9;
LABEL_7:
    v11 = v14;
    v14 += 2;
    goto LABEL_8;
  }
  return v8;
}


/* Function: call_varargs_param @ 0xD84 */
__int64 __fastcall call_varargs_param(
        __int64 a1,
        __int64 a2,
        __int64 a3,
        __int64 a4,
        __int64 a5,
        __int64 a6,
        __int64 a7,
        __int64 a8)
{
  return param_varargs(4, 10, 20, 30, 40, a6, a7, a8);
}


/* Function: param_func_ptr @ 0xD9C */
__int64 __fastcall param_func_ptr(unsigned int (__fastcall *a1)(_QWORD), unsigned int a2)
{
  return a1(a2) + 10;
}


/* Function: call_func_ptr_param @ 0xDBC */
__int64 call_func_ptr_param()
{
  return 20;
}


/* Function: param_double_ptr @ 0xDC4 */
__int64 __fastcall param_double_ptr(_DWORD **a1, int a2)
{
  _DWORD *v3; // x9
  __int64 result; // x0

  if ( !a1 )
    return 0xFFFFFFFFLL;
  v3 = *a1;
  if ( !*a1 )
    return 0xFFFFFFFFLL;
  result = 1;
  *v3 = a2;
  *a1 = 0;
  return result;
}


/* Function: call_double_ptr @ 0xDEC */
__int64 call_double_ptr()
{
  return 21;
}


/* Function: param_complex_cast @ 0xDF4 */
__int64 __fastcall param_complex_cast(unsigned int *a1, int a2)
{
  if ( a2 == 1 )
    return a1[1] + *a1;
  if ( a2 )
    return 0xFFFFFFFFLL;
  return *a1;
}


/* Function: call_complex_cast @ 0xE1C */
__int64 call_complex_cast()
{
  return 305419896;
}


/* Function: param_struct_byval @ 0xE28 */
__int64 __fastcall param_struct_byval(_DWORD *a1)
{
  return (unsigned int)(a1[15] + *a1);
}


/* Function: call_struct_byval @ 0xE38 */
__int64 call_struct_byval()
{
  int v1; // [xsp+0h] [xbp-40h]

  return (unsigned int)(v1 + 15);
}


/* Function: param_order_dep @ 0xE64 */
__int64 __fastcall param_order_dep(int a1, int a2)
{
  return (unsigned int)(a2 + a1);
}


/* Function: call_order_dep @ 0xE6C */
__int64 call_order_dep()
{
  return 3;
}


/* Function: test_parameter_passing @ 0xE74 */
__int64 test_parameter_passing()
{
  __int64 v0; // x5
  __int64 v1; // x6
  __int64 v2; // x7
  int v3; // w0

  puts(asc_159B);
  printf("PARAM-L1-01: %d\n", 15);
  printf("PARAM-L1-02: %d\n", 11);
  printf("PARAM-L2-01: %d\n", 8);
  printf("PARAM-L2-02: %d\n", 173);
  printf("PARAM-L2-03: %d\n", 300);
  v3 = param_varargs(4, 10, 20, 30, 40, v0, v1, v2);
  printf("PARAM-L2-04: %d\n", v3);
  printf("PARAM-L3-01: %d\n", 20);
  printf("PARAM-L3-02: %d\n", 21);
  printf("PARAM-L3-03: %d\n", 305419896);
  printf("PARAM-L3-04: %d\n", 15);
  return printf("PARAM-L3-05: %d\n", 3);
}


/* Function: ret_basic_type @ 0xF80 */
__int64 __fastcall ret_basic_type(int a1)
{
  return (unsigned int)(2 * a1);
}


/* Function: call_ret_basic @ 0xF88 */
__int64 call_ret_basic()
{
  return 42;
}


/* Function: ret_pointer @ 0xF90 */
__int64 __fastcall ret_pointer(__int64 a1)
{
  return a1 + 4;
}


/* Function: call_ret_pointer @ 0xF98 */
__int64 call_ret_pointer()
{
  return 20;
}


/* Function: ret_small_struct @ 0xFA0 */
unsigned __int64 __fastcall ret_small_struct(unsigned int a1, unsigned int a2)
{
  return a1 | ((unsigned __int64)a2 << 32);
}


/* Function: call_ret_small_struct @ 0xFAC */
__int64 call_ret_small_struct()
{
  return 7;
}


/* Function: ret_large_struct @ 0xFB4 */
__int64 __usercall ret_large_struct@<X0>(__int64 result@<X0>, __int64 a2@<X8>)
{
  __int64 v2; // x9
  int32x4_t v3; // q0
  int32x4_t v4; // q2
  int32x4_t v5; // q1
  int32x4_t v6; // q3

  v2 = 0;
  v3.n128_u64[0] = 0x400000004LL;
  v3.n128_u64[1] = 0x400000004LL;
  v4 = vdupq_n_s32(result);
  v5 = (int32x4_t)xmmword_11F0;
  do
  {
    v6 = vaddq_s32(v5, v4);
    v5 = vaddq_s32(v5, v3);
    *(int32x4_t *)(a2 + v2) = v6;
    v2 += 16;
  }
  while ( v2 != 64 );
  return result;
}


/* Function: call_ret_large_struct @ 0xFE4 */
__int64 call_ret_large_struct()
{
  int v1; // [xsp+0h] [xbp-40h]

  return (unsigned int)(v1 + 115);
}


/* Function: func_a @ 0x1010 */
__int64 __fastcall func_a(int a1)
{
  return (unsigned int)(a1 + 10);
}


/* Function: func_b @ 0x1018 */
__int64 __fastcall func_b(int a1)
{
  return (unsigned int)(2 * a1);
}


/* Function: ret_func_ptr @ 0x1020 */
__int64 (__fastcall *__fastcall ret_func_ptr(int a1))(int a1)
{
  if ( a1 )
    return func_b;
  else
    return func_a;
}


/* Function: call_ret_func_ptr @ 0x103C */
__int64 call_ret_func_ptr()
{
  return 10;
}


/* Function: ret_opaque_handle @ 0x1044 */
int *__fastcall ret_opaque_handle(int a1)
{
  if ( a1 )
    return (int *)&ret_opaque_handle_handle2;
  else
    return &ret_opaque_handle_handle1;
}


/* Function: call_ret_opaque @ 0x1060 */
__int64 call_ret_opaque()
{
  return (unsigned int)ret_opaque_handle_handle1;
}


/* Function: ret_complex_expr @ 0x106C */
__int64 __fastcall ret_complex_expr(int a1, int a2, int a3)
{
  if ( a1 <= a2 )
    return (unsigned int)(a3 + 10);
  else
    return (unsigned int)(2 * a3);
}


/* Function: call_ret_complex_expr @ 0x1080 */
__int64 call_ret_complex_expr()
{
  return 40;
}


/* Function: ret_multi_branch @ 0x1088 */
__int64 __fastcall ret_multi_branch(unsigned int a1)
{
  if ( a1 >= 3 )
    return 0xFFFFFFFFLL;
  else
    return 10 * a1 + 10;
}


/* Function: call_ret_multi_branch @ 0x10A0 */
__int64 call_ret_multi_branch()
{
  return 60;
}


/* Function: ret_void @ 0x10A8 */
__int64 __fastcall ret_void(__int64 result, _DWORD *a2)
{
  *a2 = 3 * result;
  return result;
}


/* Function: call_ret_void @ 0x10B4 */
__int64 call_ret_void()
{
  return 21;
}


/* Function: test_return_values @ 0x10BC */
__int64 test_return_values()
{
  puts(asc_15BC);
  printf(aRetL101D, 42);
  printf(aRetL102D, 20);
  printf(aRetL103D, 7);
  printf(aRetL104D, 215);
  printf(aRetL201D, 10);
  printf(aRetL202D, (unsigned int)ret_opaque_handle_handle1);
  printf(aRetL301D, 40);
  printf(aRetL302D, 60);
  return printf(aRetL303D, 21);
}


/* Function: main @ 0x1190 */
int __fastcall main(int argc, const char **argv, const char **envp)
{
  test_calling_conventions();
  test_parameter_passing();
  test_return_values();
  return 0;
}


/* Function: .term_proc @ 0x11B0 */
void term_proc()
{
  ;
}


/* FAILED to decompile: memcpy @ 0x130B8 */

/* FAILED to decompile: strlen @ 0x130C0 */

/* FAILED to decompile: __libc_start_main @ 0x130C8 */

/* FAILED to decompile: __cxa_finalize @ 0x130D0 */

/* FAILED to decompile: abort @ 0x130D8 */

/* FAILED to decompile: puts @ 0x130E0 */

/* FAILED to decompile: printf @ 0x130E8 */

/* FAILED to decompile: __gmon_start__ @ 0x130F8 */

/* Total functions decompiled: 79, failed: 8 */
