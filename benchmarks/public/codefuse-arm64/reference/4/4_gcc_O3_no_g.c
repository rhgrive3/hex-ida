/*
 * Decompiled by IDA Pro 9.1 with Hex-Rays
 * Binary: /Users/eren/Desktop/Antigravity/compiler/build/arm64/4/4_gcc_O3_no_g
 * Processor: arm
 */

/* Function: .init_proc @ 0x6F0 */
__int64 init_proc()
{
  return call_weak_fn();
}


/* Function: sub_710 @ 0x710 */
void sub_710()
{
  JUMPOUT(0);
}


/* Function: main @ 0x7C0 */
int __fastcall main(int argc, const char **argv, const char **envp)
{
  __int64 v3; // x0
  __int64 v4; // x0

  v3 = test_calling_conventions(argc, argv, envp);
  v4 = test_parameter_passing(v3);
  test_return_values(v4);
  return 0;
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
  return &_bss_start;
}


/* Function: register_tm_clones @ 0x880 */
char *register_tm_clones()
{
  return &_bss_start;
}


/* Function: __do_global_dtors_aux @ 0x8C0 */
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


/* Function: frame_dummy @ 0x910 */
// attributes: thunk
char *frame_dummy()
{
  return register_tm_clones();
}


/* Function: func_a @ 0x920 */
__int64 __fastcall func_a(int a1)
{
  return (unsigned int)(a1 + 10);
}


/* Function: param_varargs.constprop.0 @ 0x930 */
__int64 __fastcall param_varargs_constprop_0(__int64 a1, int a2, int a3, int a4, int a5)
{
  return (unsigned int)(a2 + a3 + a4 + a5);
}


/* Function: varargs_func.constprop.0 @ 0x9B0 */
__int64 __fastcall varargs_func_constprop_0(__int64 a1, int a2, int a3, int a4, int a5, int a6)
{
  return (unsigned int)(a2 + a3 + a4 + a5 + a6);
}


/* Function: func_b @ 0xA40 */
__int64 __fastcall func_b(int a1)
{
  return (unsigned int)(2 * a1);
}


/* Function: cdecl_func @ 0xA50 */
__int64 __fastcall cdecl_func(int a1, int a2)
{
  return (unsigned int)(a1 + a2);
}


/* Function: call_cdecl @ 0xA60 */
__int64 call_cdecl()
{
  return 15;
}


/* Function: stdcall_func @ 0xA70 */
__int64 __fastcall stdcall_func(int a1, int a2)
{
  return (unsigned int)(a1 * a2);
}


/* Function: call_stdcall @ 0xA80 */
__int64 call_stdcall()
{
  return 50;
}


/* Function: fastcall_func @ 0xA90 */
__int64 __fastcall fastcall_func(int a1, int a2, int a3)
{
  return (unsigned int)(a1 + a2 + a3);
}


/* Function: call_fastcall @ 0xAA0 */
__int64 call_fastcall()
{
  return 6;
}


/* Function: call_thiscall @ 0xAB0 */
__int64 call_thiscall()
{
  return 15;
}


/* Function: arm_aapcs_func @ 0xAC0 */
__int64 __fastcall arm_aapcs_func(int a1, int a2, int a3, int a4, int a5)
{
  return (unsigned int)(a1 + a2 + a3 + a4 + a5);
}


/* Function: call_arm_aapcs @ 0xAD4 */
__int64 call_arm_aapcs()
{
  return 15;
}


/* Function: mips_func @ 0xAE0 */
__int64 __fastcall mips_func(int a1, int a2, int a3, int a4)
{
  return (unsigned int)(a1 + a2 + a3 + a4);
}


/* Function: call_mips @ 0xAF0 */
__int64 call_mips()
{
  return 100;
}


/* Function: amd64_sysv_func @ 0xB00 */
__int64 __fastcall amd64_sysv_func(int a1, int a2, int a3, int a4, int a5, int a6)
{
  return (unsigned int)(a1 + a2 + a3 + a4 + a5 + a6);
}


/* Function: call_amd64_sysv @ 0xB20 */
__int64 call_amd64_sysv()
{
  return 21;
}


/* Function: ms_x64_func @ 0xB30 */
__int64 __fastcall ms_x64_func(int a1, int a2, int a3, int a4, int a5)
{
  return (unsigned int)(a1 + a2 + a3 + a4 + a5);
}


/* Function: call_ms_x64 @ 0xB44 */
__int64 call_ms_x64()
{
  return 15;
}


/* Function: vectorcall_func @ 0xB50 */
__int64 __fastcall vectorcall_func(int a1, int a2, int a3, int a4)
{
  return (unsigned int)(a1 + a2 + a3 + a4);
}


/* Function: call_vectorcall @ 0xB60 */
__int64 call_vectorcall()
{
  return 10;
}


/* Function: mixed_conventions_test @ 0xB70 */
__int64 mixed_conventions_test()
{
  return 33;
}


/* Function: varargs_func @ 0xB80 */
__int64 __fastcall varargs_func(
        int a1,
        __int64 a2,
        __int64 a3,
        __int64 a4,
        __int64 a5,
        __int64 a6,
        __int64 a7,
        __int64 a8,
        char a9)
{
  int v10; // w3
  char *v11; // x2
  __int64 result; // x0
  int v13; // w1
  int v14; // w3
  int v15; // w1
  _DWORD *v16; // x2
  _DWORD *v17; // x3
  int v18; // w5
  char *v19; // x3

  v10 = -56;
  if ( a1 <= 0 )
    return 0;
  v11 = &a9;
  LODWORD(result) = 0;
  v13 = 0;
  while ( v10 < 0 )
  {
    v18 = v10 + 8;
    if ( v10 + 8 <= 0 )
    {
      v19 = &a9 + v10;
    }
    else
    {
      v19 = v11;
      v11 += 8;
    }
    ++v13;
    result = (unsigned int)(result + *(_DWORD *)v19);
    if ( a1 == v13 )
      return result;
    v10 = v18;
  }
  v14 = *(_DWORD *)v11;
  v15 = v13 + 1;
  v16 = v11 + 8;
  result = (unsigned int)(result + v14);
  if ( a1 != v15 )
  {
    do
    {
      v17 = v16;
      ++v15;
      v16 += 2;
      result = (unsigned int)(result + *v17);
    }
    while ( a1 > v15 );
  }
  return result;
}


/* Function: func_no_args @ 0xC80 */
__int64 func_no_args()
{
  return 42;
}


/* Function: func_many_args @ 0xC90 */
__int64 __fastcall func_many_args(int a1, int a2, int a3, int a4, int a5, int a6, int a7, int a8)
{
  return (unsigned int)(a1 + a2 + a3 + a4 + a5 + a6 + a7 + a8);
}


/* Function: func_mixed_args @ 0xCB0 */
__int64 __fastcall func_mixed_args(int a1, char *s, __int64 a3, double a4)
{
  int v4; // w19

  v4 = a1;
  if ( s )
    v4 = a1 + strlen(s);
  return (unsigned int)(int)((double)v4 + a4 + (double)a3);
}


/* Function: func_struct_byval @ 0xD00 */
__int64 __fastcall func_struct_byval(int64x2_t *a1)
{
  return vaddvq_s64(
           vaddq_s64(
             a1[7],
             vaddq_s64(
               a1[6],
               vaddq_s64(a1[5], vaddq_s64(a1[4], vaddq_s64(a1[3], vaddq_s64(a1[2], vaddq_s64(*a1, a1[1]))))))));
}


/* Function: func_struct_byptr @ 0xD40 */
__int64 __fastcall func_struct_byptr(_DWORD *a1)
{
  if ( a1 )
    return (unsigned int)(*a1 * a1[1]);
  else
    return 0xFFFFFFFFLL;
}


/* Function: test_calling_conventions @ 0xD60 */
__int64 test_calling_conventions()
{
  unsigned int v0; // w0

  puts(asc_1598);
  __printf_chk(1, "CALL-L1-01: %d\n", 15);
  __printf_chk(1, "CALL-L1-02: %d\n", 50);
  __printf_chk(1, "CALL-L1-03: %d\n", 6);
  __printf_chk(1, "CALL-L1-04: %d\n", 15);
  __printf_chk(1, "CALL-L1-05: %d\n", 15);
  __printf_chk(1, "CALL-L1-06: %d\n", 100);
  __printf_chk(1, "CALL-L1-07: %d\n", 21);
  __printf_chk(1, "CALL-L1-08: %d\n", 15);
  __printf_chk(1, "CALL-L1-09: %d\n", 10);
  __printf_chk(1, "CALL-L1-10: %d\n", 33);
  v0 = varargs_func_constprop_0(5, 1, 2, 3, 4, 5);
  __printf_chk(1, aCallL206, v0);
  __printf_chk(1, aCallL207, 42);
  __printf_chk(1, aCallL208, 36);
  __printf_chk(1, aCallL209, 117);
  __printf_chk(1, aCallL210, 136);
  return __printf_chk(1, aCallL211, 50);
}


/* Function: param_by_value_int @ 0xED4 */
__int64 __fastcall param_by_value_int(int a1)
{
  return (unsigned int)(2 * a1);
}


/* Function: call_by_value_int @ 0xEE0 */
__int64 call_by_value_int()
{
  return 15;
}


/* Function: param_by_value_ptr @ 0xEF0 */
__int64 __fastcall param_by_value_ptr(_DWORD *a1)
{
  __int64 result; // x0

  result = 1;
  *a1 *= 2;
  return result;
}


/* Function: call_by_value_ptr @ 0xF10 */
__int64 call_by_value_ptr()
{
  return 11;
}


/* Function: param_array_decay @ 0xF20 */
__int64 param_array_decay()
{
  return 8;
}


/* Function: call_array_decay @ 0xF30 */
__int64 call_array_decay()
{
  return 8;
}


/* Function: param_string @ 0xF40 */
__int64 __fastcall param_string(unsigned __int8 *a1)
{
  return *a1 + (unsigned int)a1[1];
}


/* Function: call_string_param @ 0xF50 */
__int64 call_string_param()
{
  return 173;
}


/* Function: param_ptr_array @ 0xF60 */
__int64 __fastcall param_ptr_array(__int64 a1, int a2)
{
  __int64 v3; // x2
  __int64 result; // x0
  unsigned __int8 *v5; // x3

  if ( a2 <= 0 )
    return 0;
  v3 = 0;
  LODWORD(result) = 0;
  do
  {
    v5 = *(unsigned __int8 **)(a1 + 8 * v3++);
    result = (unsigned int)result + *v5;
  }
  while ( a2 > (int)v3 );
  return result;
}


/* Function: call_ptr_array @ 0xFA0 */
__int64 call_ptr_array()
{
  return 300;
}


/* Function: param_varargs @ 0xFB0 */
__int64 __fastcall param_varargs(
        int a1,
        __int64 a2,
        __int64 a3,
        __int64 a4,
        __int64 a5,
        __int64 a6,
        __int64 a7,
        __int64 a8,
        char a9)
{
  int v10; // w3
  char *v11; // x2
  __int64 result; // x0
  int v13; // w1
  int v14; // w3
  int v15; // w1
  _DWORD *v16; // x2
  _DWORD *v17; // x3
  int v18; // w5
  char *v19; // x3

  v10 = -56;
  if ( a1 <= 0 )
    return 0;
  v11 = &a9;
  LODWORD(result) = 0;
  v13 = 0;
  while ( v10 < 0 )
  {
    v18 = v10 + 8;
    if ( v10 + 8 <= 0 )
    {
      v19 = &a9 + v10;
    }
    else
    {
      v19 = v11;
      v11 += 8;
    }
    ++v13;
    result = (unsigned int)(result + *(_DWORD *)v19);
    if ( a1 == v13 )
      return result;
    v10 = v18;
  }
  v14 = *(_DWORD *)v11;
  v15 = v13 + 1;
  v16 = v11 + 8;
  result = (unsigned int)(result + v14);
  if ( a1 != v15 )
  {
    do
    {
      v17 = v16;
      ++v15;
      v16 += 2;
      result = (unsigned int)(result + *v17);
    }
    while ( a1 > v15 );
  }
  return result;
}


/* Function: call_varargs_param @ 0x10B0 */
__int64 call_varargs_param()
{
  return param_varargs_constprop_0(4, 10, 20, 30, 40);
}


/* Function: param_func_ptr @ 0x10D0 */
__int64 __fastcall param_func_ptr(unsigned int (__fastcall *a1)(_QWORD), unsigned int a2)
{
  return a1(a2) + 10;
}


/* Function: call_func_ptr_param @ 0x10F0 */
__int64 call_func_ptr_param()
{
  return 20;
}


/* Function: param_double_ptr @ 0x1100 */
__int64 __fastcall param_double_ptr(_DWORD **a1, int a2)
{
  _DWORD *v3; // x0
  __int64 result; // x0

  if ( !a1 )
    return 0xFFFFFFFFLL;
  v3 = *a1;
  if ( !v3 )
    return 0xFFFFFFFFLL;
  *v3 = a2;
  result = 1;
  *a1 = 0;
  return result;
}


/* Function: call_double_ptr @ 0x1130 */
__int64 call_double_ptr()
{
  return 21;
}


/* Function: param_complex_cast @ 0x1140 */
__int64 __fastcall param_complex_cast(unsigned int *a1, int a2)
{
  if ( !a2 )
    return *a1;
  if ( a2 == 1 )
    return *a1 + a1[1];
  return 0xFFFFFFFFLL;
}


/* Function: call_complex_cast @ 0x1170 */
__int64 call_complex_cast()
{
  return 305419896;
}


/* Function: param_struct_byval @ 0x1180 */
__int64 __fastcall param_struct_byval(_DWORD *a1)
{
  return (unsigned int)(*a1 + a1[15]);
}


/* Function: call_struct_byval @ 0x1190 */
__int64 call_struct_byval()
{
  return 15;
}


/* Function: param_order_dep @ 0x11A0 */
__int64 __fastcall param_order_dep(int a1, int a2)
{
  return (unsigned int)(a1 + a2);
}


/* Function: call_order_dep @ 0x11B0 */
__int64 call_order_dep()
{
  return 4;
}


/* Function: test_parameter_passing @ 0x11C0 */
__int64 test_parameter_passing()
{
  int v0; // w0

  puts(asc_1760);
  __printf_chk(1, "PARAM-L1-01: %d\n", 15);
  __printf_chk(1, "PARAM-L1-02: %d\n", 11);
  __printf_chk(1, "PARAM-L2-01: %d\n", 8);
  __printf_chk(1, "PARAM-L2-02: %d\n", 173);
  __printf_chk(1, "PARAM-L2-03: %d\n", 300);
  v0 = param_varargs_constprop_0(4, 10, 20, 30, 40);
  __printf_chk(1, "PARAM-L2-04: %d\n", v0);
  __printf_chk(1, "PARAM-L3-01: %d\n", 20);
  __printf_chk(1, "PARAM-L3-02: %d\n", 21);
  __printf_chk(1, "PARAM-L3-03: %d\n", 305419896);
  __printf_chk(1, "PARAM-L3-04: %d\n", 15);
  return __printf_chk(1, "PARAM-L3-05: %d\n", 4);
}


/* Function: ret_basic_type @ 0x12D0 */
__int64 __fastcall ret_basic_type(int a1)
{
  return (unsigned int)(2 * a1);
}


/* Function: call_ret_basic @ 0x12E0 */
__int64 call_ret_basic()
{
  return 42;
}


/* Function: ret_pointer @ 0x12F0 */
__int64 __fastcall ret_pointer(__int64 a1)
{
  return a1 + 4;
}


/* Function: call_ret_pointer @ 0x1300 */
__int64 call_ret_pointer()
{
  return 20;
}


/* Function: ret_small_struct @ 0x1310 */
unsigned __int64 __fastcall ret_small_struct(unsigned int a1, __int64 a2)
{
  return a1 | (unsigned __int64)(a2 << 32);
}


/* Function: call_ret_small_struct @ 0x1320 */
__int64 call_ret_small_struct()
{
  return 7;
}


/* Function: ret_large_struct @ 0x1330 */
__int64 __usercall ret_large_struct@<X0>(unsigned int a1@<W0>, int32x4_t *a2@<X8>)
{
  int32x4_t v2; // q0
  __int64 v4; // [xsp+58h] [xbp+58h]

  v2 = vdupq_n_s32(a1);
  *a2 = vaddq_s32(v2, (int32x4_t)xmmword_19D0);
  a2[1] = vaddq_s32(v2, (int32x4_t)xmmword_19E0);
  a2[2] = vaddq_s32(v2, (int32x4_t)xmmword_19F0);
  a2[3] = vaddq_s32(v2, (int32x4_t)xmmword_1A00);
  return v4 - _stack_chk_guard;
}


/* Function: call_ret_large_struct @ 0x13C4 */
__int64 call_ret_large_struct()
{
  return 215;
}


/* Function: ret_func_ptr @ 0x13D0 */
__int64 (__fastcall *__fastcall ret_func_ptr(int a1))(int a1)
{
  bool v1; // zf
  __int64 (__fastcall *result)(int); // x0

  v1 = a1 == 0;
  result = func_b;
  if ( v1 )
    return func_a;
  return result;
}


/* Function: call_ret_func_ptr @ 0x13F0 */
__int64 call_ret_func_ptr()
{
  return 10;
}


/* Function: ret_opaque_handle @ 0x1400 */
int *__fastcall ret_opaque_handle(int a1)
{
  bool v1; // zf
  int *result; // x0

  v1 = a1 == 0;
  result = (int *)&handle2_0;
  if ( v1 )
    return &handle1_1;
  return result;
}


/* Function: call_ret_opaque @ 0x1420 */
__int64 call_ret_opaque()
{
  return (unsigned int)handle1_1;
}


/* Function: ret_complex_expr @ 0x1430 */
__int64 __fastcall ret_complex_expr(int a1, int a2, int a3)
{
  bool v3; // cc
  __int64 result; // x0
  unsigned int v5; // w2

  v3 = a1 <= a2;
  LODWORD(result) = a3 + 10;
  v5 = 2 * a3;
  if ( v3 )
    return (unsigned int)result;
  else
    return v5;
}


/* Function: call_ret_complex_expr @ 0x1444 */
__int64 call_ret_complex_expr()
{
  return 40;
}


/* Function: ret_multi_branch @ 0x1450 */
__int64 __fastcall ret_multi_branch(unsigned int a1)
{
  bool v1; // cf
  __int64 result; // x0

  v1 = a1 >= 3;
  LODWORD(result) = 10 * (a1 + 1);
  if ( v1 )
    return 0xFFFFFFFFLL;
  else
    return (unsigned int)result;
}


/* Function: call_ret_multi_branch @ 0x1470 */
__int64 call_ret_multi_branch()
{
  return 60;
}


/* Function: ret_void @ 0x1480 */
__int64 __fastcall ret_void(int a1, _DWORD *a2)
{
  __int64 result; // x0

  result = (unsigned int)(3 * a1);
  *a2 = result;
  return result;
}


/* Function: call_ret_void @ 0x1490 */
__int64 call_ret_void()
{
  return 21;
}


/* Function: test_return_values @ 0x14A0 */
__int64 test_return_values()
{
  puts(asc_1890);
  __printf_chk(1, aRetL101D, 42);
  __printf_chk(1, aRetL102D, 20);
  __printf_chk(1, aRetL103D, 7);
  __printf_chk(1, aRetL104D, 215);
  __printf_chk(1, aRetL201D, 10);
  __printf_chk(1, aRetL202D, (unsigned int)handle1_1);
  __printf_chk(1, aRetL301D, 40);
  __printf_chk(1, aRetL302D, 60);
  return __printf_chk(1, aRetL303D, 21);
}


/* Function: .term_proc @ 0x1570 */
void term_proc()
{
  ;
}


/* FAILED to decompile: strlen @ 0x13078 */

/* FAILED to decompile: __libc_start_main @ 0x13080 */

/* FAILED to decompile: __cxa_finalize @ 0x13088 */

/* FAILED to decompile: __printf_chk @ 0x13090 */

/* FAILED to decompile: __stack_chk_fail @ 0x13098 */

/* FAILED to decompile: abort @ 0x130A8 */

/* FAILED to decompile: puts @ 0x130B0 */

/* FAILED to decompile: __gmon_start__ @ 0x130C0 */

/* Total functions decompiled: 81, failed: 8 */
