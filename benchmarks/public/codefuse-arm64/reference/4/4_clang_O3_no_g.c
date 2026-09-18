/*
 * Decompiled by IDA Pro 9.1 with Hex-Rays
 * Binary: /Users/eren/Desktop/Antigravity/compiler/build/arm64/4/4_clang_O3_no_g
 * Processor: arm
 */

/* Function: .init_proc @ 0x628 */
__int64 init_proc()
{
  return call_weak_fn();
}


/* Function: sub_640 @ 0x640 */
void sub_640()
{
  JUMPOUT(0);
}


/* Function: _start @ 0x700 */
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


/* Function: call_weak_fn @ 0x734 */
void *call_weak_fn()
{
  void *result; // x0

  result = &_gmon_start__;
  if ( &_gmon_start__ )
    return (void *)__gmon_start__();
  return result;
}


/* Function: deregister_tm_clones @ 0x750 */
char *deregister_tm_clones()
{
  return &_bss_start;
}


/* Function: register_tm_clones @ 0x780 */
char *register_tm_clones()
{
  return &_bss_start;
}


/* Function: __do_global_dtors_aux @ 0x7C0 */
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


/* Function: frame_dummy @ 0x810 */
// attributes: thunk
char *frame_dummy()
{
  return register_tm_clones();
}


/* Function: cdecl_func @ 0x814 */
__int64 __fastcall cdecl_func(int a1, int a2)
{
  return (unsigned int)(a2 + a1);
}


/* Function: call_cdecl @ 0x81C */
__int64 call_cdecl()
{
  return 15;
}


/* Function: stdcall_func @ 0x824 */
__int64 __fastcall stdcall_func(int a1, int a2)
{
  return (unsigned int)(a2 * a1);
}


/* Function: call_stdcall @ 0x82C */
__int64 call_stdcall()
{
  return 50;
}


/* Function: fastcall_func @ 0x834 */
__int64 __fastcall fastcall_func(int a1, int a2, int a3)
{
  return (unsigned int)(a2 + a1 + a3);
}


/* Function: call_fastcall @ 0x840 */
__int64 call_fastcall()
{
  return 6;
}


/* Function: call_thiscall @ 0x848 */
__int64 call_thiscall()
{
  return 15;
}


/* Function: arm_aapcs_func @ 0x850 */
__int64 __fastcall arm_aapcs_func(int a1, int a2, int a3, int a4, int a5)
{
  return (unsigned int)(a2 + a1 + a3 + a4 + a5);
}


/* Function: call_arm_aapcs @ 0x864 */
__int64 call_arm_aapcs()
{
  return 15;
}


/* Function: mips_func @ 0x86C */
__int64 __fastcall mips_func(int a1, int a2, int a3, int a4)
{
  return (unsigned int)(a2 + a1 + a3 + a4);
}


/* Function: call_mips @ 0x87C */
__int64 call_mips()
{
  return 100;
}


/* Function: amd64_sysv_func @ 0x884 */
__int64 __fastcall amd64_sysv_func(int a1, int a2, int a3, int a4, int a5, int a6)
{
  return (unsigned int)(a2 + a1 + a3 + a4 + a5 + a6);
}


/* Function: call_amd64_sysv @ 0x89C */
__int64 call_amd64_sysv()
{
  return 21;
}


/* Function: ms_x64_func @ 0x8A4 */
__int64 __fastcall ms_x64_func(int a1, int a2, int a3, int a4, int a5)
{
  return (unsigned int)(a2 + a1 + a3 + a4 + a5);
}


/* Function: call_ms_x64 @ 0x8B8 */
__int64 call_ms_x64()
{
  return 15;
}


/* Function: vectorcall_func @ 0x8C0 */
__int64 __fastcall vectorcall_func(int a1, int a2, int a3, int a4)
{
  return (unsigned int)(a2 + a1 + a3 + a4);
}


/* Function: call_vectorcall @ 0x8D0 */
__int64 call_vectorcall()
{
  return 10;
}


/* Function: mixed_conventions_test @ 0x8D8 */
__int64 mixed_conventions_test()
{
  return 33;
}


/* Function: varargs_func @ 0x8E0 */
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
  unsigned int v8; // w11
  unsigned int v9; // w8
  unsigned int v10; // w10
  _DWORD *v11; // x11
  _QWORD v13[8]; // [xsp+80h] [xbp-60h] BYREF
  _DWORD *v14; // [xsp+C0h] [xbp-20h] BYREF
  _QWORD *v15; // [xsp+C8h] [xbp-18h]
  _QWORD *v16; // [xsp+D0h] [xbp-10h]
  unsigned __int64 v17; // [xsp+D8h] [xbp-8h]

  v13[3] = a4;
  v13[4] = a5;
  v16 = v13;
  v17 = 0xFFFFFF80FFFFFFC8LL;
  v13[1] = a2;
  v13[2] = a3;
  v13[5] = a6;
  v13[6] = a7;
  v15 = &v14;
  v13[7] = a8;
  if ( a1 >= 1 )
  {
    v8 = v17;
    v9 = 0;
    while ( 1 )
    {
      while ( (v8 & 0x80000000) == 0 )
      {
        v10 = v8;
LABEL_5:
        v11 = v14;
        v14 += 2;
        --a1;
        v9 += *v11;
        v8 = v10;
        if ( !a1 )
          return v9;
      }
      v10 = v8 + 8;
      LODWORD(v17) = v8 + 8;
      if ( v8 > 0xFFFFFFF8 )
        goto LABEL_5;
      --a1;
      v9 += *(_DWORD *)((char *)v15 + (int)v8);
      v8 += 8;
      if ( !a1 )
        return v9;
    }
  }
  return 0;
}


/* Function: func_no_args @ 0xA78 */
__int64 func_no_args()
{
  return 42;
}


/* Function: func_many_args @ 0xA80 */
__int64 __fastcall func_many_args(int a1, int a2, int a3, int a4, int a5, int a6, int a7, int a8)
{
  return (unsigned int)(a2 + a1 + a3 + a4 + a5 + a6 + a7 + a8);
}


/* Function: func_mixed_args @ 0xAA0 */
__int64 __fastcall func_mixed_args(int a1, char *s, __int64 a3, double a4)
{
  int v7; // w0

  if ( s )
    v7 = strlen(s);
  else
    v7 = 0;
  return (unsigned int)(int)((double)(v7 + a1) + a4 + (double)a3);
}


/* Function: func_struct_byval @ 0xAF8 */
__int64 __fastcall func_struct_byval(_DWORD *a1)
{
  return (unsigned int)(a1[30]
                      + a1[28]
                      + a1[26]
                      + a1[24]
                      + a1[22]
                      + a1[20]
                      + a1[18]
                      + a1[16]
                      + a1[14]
                      + a1[12]
                      + a1[10]
                      + a1[8]
                      + a1[6]
                      + a1[4]
                      + a1[2]
                      + *a1);
}


/* Function: func_struct_byptr @ 0xB78 */
__int64 __fastcall func_struct_byptr(_DWORD *a1)
{
  if ( a1 )
    return (unsigned int)(a1[1] * *a1);
  else
    return 0xFFFFFFFFLL;
}


/* Function: test_calling_conventions @ 0xB90 */
__int64 test_calling_conventions()
{
  __int64 v0; // x6
  __int64 v1; // x7
  unsigned int v2; // w0

  puts(asc_1752);
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
  printf(aCallL210, 136);
  return printf(aCallL211, 50);
}


/* Function: param_by_value_int @ 0xCC4 */
__int64 __fastcall param_by_value_int(int a1)
{
  return (unsigned int)(2 * a1);
}


/* Function: call_by_value_int @ 0xCCC */
__int64 call_by_value_int()
{
  return 15;
}


/* Function: param_by_value_ptr @ 0xCD4 */
__int64 __fastcall param_by_value_ptr(_DWORD *a1)
{
  __int64 result; // x0

  result = 1;
  *a1 *= 2;
  return result;
}


/* Function: call_by_value_ptr @ 0xCEC */
__int64 call_by_value_ptr()
{
  return 11;
}


/* Function: param_array_decay @ 0xCF4 */
__int64 param_array_decay()
{
  return 8;
}


/* Function: call_array_decay @ 0xCFC */
__int64 call_array_decay()
{
  return 8;
}


/* Function: param_string @ 0xD04 */
__int64 __fastcall param_string(unsigned __int8 *a1)
{
  return a1[1] + (unsigned int)*a1;
}


/* Function: call_string_param @ 0xD14 */
__int64 call_string_param()
{
  return 173;
}


/* Function: param_ptr_array @ 0xD1C */
__int64 __fastcall param_ptr_array(__int64 a1, int a2)
{
  __int64 v2; // x10
  unsigned int v3; // w8
  int v5; // w8
  int v6; // w11
  unsigned __int8 **v7; // x12
  __int64 v8; // x13
  unsigned __int8 *v9; // x14
  unsigned __int8 *v10; // x15
  unsigned __int8 **v11; // x11
  __int64 v12; // x9
  unsigned __int8 *v13; // t1

  if ( a2 < 1 )
    return 0;
  if ( a2 == 1 )
  {
    v2 = 0;
    v3 = 0;
  }
  else
  {
    v2 = a2 & 0xFFFFFFFE;
    v5 = 0;
    v6 = 0;
    v7 = (unsigned __int8 **)(a1 + 8);
    v8 = v2;
    do
    {
      v9 = *(v7 - 1);
      v10 = *v7;
      v7 += 2;
      v8 -= 2;
      v5 += *v9;
      v6 += *v10;
    }
    while ( v8 );
    v3 = v6 + v5;
    if ( v2 == a2 )
      return v3;
  }
  v11 = (unsigned __int8 **)(a1 + 8 * v2);
  v12 = (unsigned int)a2 - v2;
  do
  {
    v13 = *v11++;
    --v12;
    v3 += *v13;
  }
  while ( v12 );
  return v3;
}


/* Function: call_ptr_array @ 0xDA8 */
__int64 call_ptr_array()
{
  return 300;
}


/* Function: param_varargs @ 0xDB0 */
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
  unsigned int v8; // w11
  unsigned int v9; // w8
  unsigned int v10; // w10
  _DWORD *v11; // x11
  _QWORD v13[8]; // [xsp+80h] [xbp-60h] BYREF
  _DWORD *v14; // [xsp+C0h] [xbp-20h] BYREF
  _QWORD *v15; // [xsp+C8h] [xbp-18h]
  _QWORD *v16; // [xsp+D0h] [xbp-10h]
  unsigned __int64 v17; // [xsp+D8h] [xbp-8h]

  v13[3] = a4;
  v13[4] = a5;
  v16 = v13;
  v17 = 0xFFFFFF80FFFFFFC8LL;
  v13[1] = a2;
  v13[2] = a3;
  v13[5] = a6;
  v13[6] = a7;
  v15 = &v14;
  v13[7] = a8;
  if ( a1 >= 1 )
  {
    v8 = v17;
    v9 = 0;
    while ( 1 )
    {
      while ( (v8 & 0x80000000) == 0 )
      {
        v10 = v8;
LABEL_5:
        v11 = v14;
        v14 += 2;
        --a1;
        v9 += *v11;
        v8 = v10;
        if ( !a1 )
          return v9;
      }
      v10 = v8 + 8;
      LODWORD(v17) = v8 + 8;
      if ( v8 > 0xFFFFFFF8 )
        goto LABEL_5;
      --a1;
      v9 += *(_DWORD *)((char *)v15 + (int)v8);
      v8 += 8;
      if ( !a1 )
        return v9;
    }
  }
  return 0;
}


/* Function: call_varargs_param @ 0xF48 */
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


/* Function: param_func_ptr @ 0xF60 */
__int64 __fastcall param_func_ptr(unsigned int (__fastcall *a1)(_QWORD), unsigned int a2)
{
  return a1(a2) + 10;
}


/* Function: call_func_ptr_param @ 0xF80 */
__int64 call_func_ptr_param()
{
  return 20;
}


/* Function: param_double_ptr @ 0xF88 */
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


/* Function: call_double_ptr @ 0xFB0 */
__int64 call_double_ptr()
{
  return 21;
}


/* Function: param_complex_cast @ 0xFB8 */
__int64 __fastcall param_complex_cast(unsigned int *a1, int a2)
{
  if ( a2 == 1 )
    return a1[1] + *a1;
  if ( a2 )
    return 0xFFFFFFFFLL;
  return *a1;
}


/* Function: call_complex_cast @ 0xFE0 */
__int64 call_complex_cast()
{
  return 305419896;
}


/* Function: param_struct_byval @ 0xFEC */
__int64 __fastcall param_struct_byval(_DWORD *a1)
{
  return (unsigned int)(a1[15] + *a1);
}


/* Function: call_struct_byval @ 0xFFC */
__int64 call_struct_byval()
{
  return 15;
}


/* Function: param_order_dep @ 0x1004 */
__int64 __fastcall param_order_dep(int a1, int a2)
{
  return (unsigned int)(a2 + a1);
}


/* Function: call_order_dep @ 0x100C */
__int64 call_order_dep()
{
  return 3;
}


/* Function: test_parameter_passing @ 0x1014 */
__int64 test_parameter_passing()
{
  __int64 v0; // x5
  __int64 v1; // x6
  __int64 v2; // x7
  int v3; // w0

  puts(asc_1773);
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


/* Function: ret_basic_type @ 0x10F8 */
__int64 __fastcall ret_basic_type(int a1)
{
  return (unsigned int)(2 * a1);
}


/* Function: call_ret_basic @ 0x1100 */
__int64 call_ret_basic()
{
  return 42;
}


/* Function: ret_pointer @ 0x1108 */
__int64 __fastcall ret_pointer(__int64 a1)
{
  return a1 + 4;
}


/* Function: call_ret_pointer @ 0x1110 */
__int64 call_ret_pointer()
{
  return 20;
}


/* Function: ret_small_struct @ 0x1118 */
unsigned __int64 __fastcall ret_small_struct(unsigned int a1, unsigned int a2)
{
  return a1 | ((unsigned __int64)a2 << 32);
}


/* Function: call_ret_small_struct @ 0x1124 */
__int64 call_ret_small_struct()
{
  return 7;
}


/* Function: ret_large_struct @ 0x112C */
int32x4_t __usercall ret_large_struct@<Q0>(unsigned int a1@<W0>, __int64 a2@<X8>)
{
  int32x4_t v2; // q3
  int32x4_t result; // q0

  v2 = vdupq_n_s32(a1);
  *(_DWORD *)a2 = a1;
  result = vaddq_s32(v2, (int32x4_t)xmmword_13D0);
  *(_DWORD *)(a2 + 60) = a1 + 15;
  *(int32x4_t *)(a2 + 4) = result;
  *(int32x4_t *)(a2 + 20) = vaddq_s32(v2, (int32x4_t)xmmword_13E0);
  *(int32x4_t *)(a2 + 36) = vaddq_s32(v2, (int32x4_t)xmmword_13F0);
  *(int32x2_t *)(a2 + 52) = vadd_s32(vdup_n_s32(a1), (int32x2_t)0xE0000000DLL);
  return result;
}


/* Function: call_ret_large_struct @ 0x1184 */
__int64 call_ret_large_struct()
{
  return 215;
}


/* Function: func_a @ 0x118C */
__int64 __fastcall func_a(int a1)
{
  return (unsigned int)(a1 + 10);
}


/* Function: func_b @ 0x1194 */
__int64 __fastcall func_b(int a1)
{
  return (unsigned int)(2 * a1);
}


/* Function: ret_func_ptr @ 0x119C */
__int64 (__fastcall *__fastcall ret_func_ptr(int a1))(int a1)
{
  if ( a1 )
    return func_b;
  else
    return func_a;
}


/* Function: call_ret_func_ptr @ 0x11B8 */
__int64 call_ret_func_ptr()
{
  return 10;
}


/* Function: ret_opaque_handle @ 0x11C0 */
int *__fastcall ret_opaque_handle(int a1)
{
  if ( a1 )
    return (int *)&ret_opaque_handle_handle2;
  else
    return &ret_opaque_handle_handle1;
}


/* Function: call_ret_opaque @ 0x11D8 */
__int64 call_ret_opaque()
{
  return (unsigned int)ret_opaque_handle_handle1;
}


/* Function: ret_complex_expr @ 0x11E4 */
__int64 __fastcall ret_complex_expr(int a1, int a2, int a3)
{
  if ( a1 <= a2 )
    return (unsigned int)(a3 + 10);
  else
    return (unsigned int)(2 * a3);
}


/* Function: call_ret_complex_expr @ 0x11F8 */
__int64 call_ret_complex_expr()
{
  return 40;
}


/* Function: ret_multi_branch @ 0x1200 */
__int64 __fastcall ret_multi_branch(unsigned int a1)
{
  if ( a1 >= 3 )
    return 0xFFFFFFFFLL;
  else
    return 10 * a1 + 10;
}


/* Function: call_ret_multi_branch @ 0x1218 */
__int64 call_ret_multi_branch()
{
  return 60;
}


/* Function: ret_void @ 0x1220 */
__int64 __fastcall ret_void(__int64 result, _DWORD *a2)
{
  *a2 = 3 * result;
  return result;
}


/* Function: call_ret_void @ 0x122C */
__int64 call_ret_void()
{
  return 21;
}


/* Function: test_return_values @ 0x1234 */
__int64 test_return_values()
{
  puts(asc_1794);
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


/* Function: main @ 0x12E0 */
int __fastcall main(int argc, const char **argv, const char **envp)
{
  test_calling_conventions();
  test_parameter_passing();
  puts(asc_1794);
  printf(aRetL101D, 42);
  printf(aRetL102D, 20);
  printf(aRetL103D, 7);
  printf(aRetL104D, 215);
  printf(aRetL201D, 10);
  printf(aRetL202D, (unsigned int)ret_opaque_handle_handle1);
  printf(aRetL301D, 40);
  printf(aRetL302D, 60);
  printf(aRetL303D, 21);
  return 0;
}


/* Function: .term_proc @ 0x139C */
void term_proc()
{
  ;
}


/* FAILED to decompile: strlen @ 0x130B0 */

/* FAILED to decompile: __libc_start_main @ 0x130B8 */

/* FAILED to decompile: __cxa_finalize @ 0x130C0 */

/* FAILED to decompile: abort @ 0x130C8 */

/* FAILED to decompile: puts @ 0x130D0 */

/* FAILED to decompile: printf @ 0x130D8 */

/* FAILED to decompile: __gmon_start__ @ 0x130E8 */

/* Total functions decompiled: 79, failed: 7 */
