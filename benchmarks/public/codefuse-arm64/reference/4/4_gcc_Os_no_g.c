/*
 * Decompiled by IDA Pro 9.1 with Hex-Rays
 * Binary: /Users/eren/Desktop/Antigravity/compiler/build/arm64/4/4_gcc_Os_no_g
 * Processor: arm
 */

/* Function: .init_proc @ 0x738 */
__int64 init_proc()
{
  return call_weak_fn();
}


/* Function: sub_750 @ 0x750 */
void sub_750()
{
  JUMPOUT(0);
}


/* Function: main @ 0x800 */
int __fastcall main(int argc, const char **argv, const char **envp)
{
  __int64 v3; // x0
  __int64 v4; // x0

  v3 = test_calling_conventions(argc, argv, envp);
  v4 = test_parameter_passing(v3);
  test_return_values(v4);
  return 0;
}


/* Function: _start @ 0x840 */
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


/* Function: call_weak_fn @ 0x874 */
void *call_weak_fn()
{
  void *result; // x0

  result = &_gmon_start__;
  if ( &_gmon_start__ )
    return (void *)__gmon_start__();
  return result;
}


/* Function: deregister_tm_clones @ 0x890 */
char *deregister_tm_clones()
{
  return &_bss_start;
}


/* Function: register_tm_clones @ 0x8C0 */
char *register_tm_clones()
{
  return &_bss_start;
}


/* Function: __do_global_dtors_aux @ 0x900 */
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


/* Function: frame_dummy @ 0x950 */
// attributes: thunk
char *frame_dummy()
{
  return register_tm_clones();
}


/* Function: func_a @ 0x954 */
__int64 __fastcall func_a(int a1)
{
  return (unsigned int)(a1 + 10);
}


/* Function: func_b @ 0x95C */
__int64 __fastcall func_b(int a1)
{
  return (unsigned int)(2 * a1);
}


/* Function: callback_func @ 0x964 */
__int64 __fastcall callback_func(int a1)
{
  return (unsigned int)(2 * a1);
}


/* Function: cdecl_func @ 0x96C */
__int64 __fastcall cdecl_func(int a1, int a2)
{
  return (unsigned int)(a1 + a2);
}


/* Function: call_cdecl @ 0x974 */
__int64 call_cdecl()
{
  return 15;
}


/* Function: stdcall_func @ 0x97C */
__int64 __fastcall stdcall_func(int a1, int a2)
{
  return (unsigned int)(a1 * a2);
}


/* Function: call_stdcall @ 0x984 */
__int64 call_stdcall()
{
  return 50;
}


/* Function: fastcall_func @ 0x98C */
__int64 __fastcall fastcall_func(int a1, int a2, int a3)
{
  return (unsigned int)(a1 + a2 + a3);
}


/* Function: call_fastcall @ 0x998 */
__int64 call_fastcall()
{
  return 6;
}


/* Function: call_thiscall @ 0x9A0 */
__int64 call_thiscall()
{
  return 15;
}


/* Function: arm_aapcs_func @ 0x9A8 */
__int64 __fastcall arm_aapcs_func(int a1, int a2, int a3, int a4, int a5)
{
  return (unsigned int)(a1 + a2 + a3 + a4 + a5);
}


/* Function: call_arm_aapcs @ 0x9BC */
__int64 call_arm_aapcs()
{
  return 15;
}


/* Function: mips_func @ 0x9C4 */
__int64 __fastcall mips_func(int a1, int a2, int a3, int a4)
{
  return (unsigned int)(a1 + a2 + a3 + a4);
}


/* Function: call_mips @ 0x9D4 */
__int64 call_mips()
{
  return 100;
}


/* Function: amd64_sysv_func @ 0x9DC */
__int64 __fastcall amd64_sysv_func(int a1, int a2, int a3, int a4, int a5, int a6)
{
  return (unsigned int)(a1 + a2 + a3 + a4 + a5 + a6);
}


/* Function: call_amd64_sysv @ 0x9F4 */
__int64 call_amd64_sysv()
{
  return 21;
}


/* Function: ms_x64_func @ 0x9FC */
__int64 __fastcall ms_x64_func(int a1, int a2, int a3, int a4, int a5)
{
  return (unsigned int)(a1 + a2 + a3 + a4 + a5);
}


/* Function: call_ms_x64 @ 0xA10 */
__int64 call_ms_x64()
{
  return 15;
}


/* Function: vectorcall_func @ 0xA18 */
__int64 __fastcall vectorcall_func(int a1, int a2, int a3, int a4)
{
  return (unsigned int)(a1 + a2 + a3 + a4);
}


/* Function: call_vectorcall @ 0xA28 */
__int64 call_vectorcall()
{
  return 10;
}


/* Function: mixed_conventions_test @ 0xA30 */
__int64 mixed_conventions_test()
{
  return 33;
}


/* Function: varargs_func @ 0xA38 */
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
  char *v10; // x3
  int v11; // w4
  int v12; // w1
  __int64 result; // x0
  int v14; // w5
  unsigned __int64 v15; // x2
  int v16; // w1

  v10 = &a9;
  v11 = 0;
  v12 = -56;
  result = 0;
  while ( v11 < a1 )
  {
    if ( v12 < 0 )
    {
      v14 = v12 + 8;
      if ( v12 + 8 <= 0 )
      {
        v15 = (unsigned __int64)v10;
        v10 = &a9 + v12;
      }
      else
      {
        v15 = (unsigned __int64)(v10 + 11) & 0xFFFFFFFFFFFFFFF8LL;
      }
    }
    else
    {
      v14 = v12;
      v15 = (unsigned __int64)(v10 + 11) & 0xFFFFFFFFFFFFFFF8LL;
    }
    v16 = *(_DWORD *)v10;
    ++v11;
    v10 = (char *)v15;
    result = (unsigned int)(result + v16);
    v12 = v14;
  }
  return result;
}


/* Function: func_no_args @ 0xB0C */
__int64 func_no_args()
{
  return 42;
}


/* Function: func_many_args @ 0xB14 */
__int64 __fastcall func_many_args(int a1, int a2, int a3, int a4, int a5, int a6, int a7, int a8)
{
  return (unsigned int)(a1 + a2 + a3 + a4 + a5 + a6 + a7 + a8);
}


/* Function: func_mixed_args @ 0xB34 */
__int64 __fastcall func_mixed_args(int a1, char *s, __int64 a3, double a4)
{
  int v7; // w0

  if ( s )
    v7 = strlen(s);
  else
    v7 = 0;
  return (unsigned int)(int)((double)(v7 + a1) + a4 + (double)a3);
}


/* Function: func_struct_byval @ 0xB8C */
__int64 __fastcall func_struct_byval(__int64 a1)
{
  __int64 v2; // x1
  __int64 result; // x0
  __int64 v4; // x3

  v2 = 0;
  result = 0;
  do
  {
    v4 = *(_QWORD *)(a1 + 8 * v2++);
    result += v4;
  }
  while ( v2 != 16 );
  return result;
}


/* Function: func_struct_byptr @ 0xBB0 */
__int64 __fastcall func_struct_byptr(_DWORD *a1)
{
  if ( a1 )
    return (unsigned int)(*a1 * a1[1]);
  else
    return 0xFFFFFFFFLL;
}


/* Function: test_calling_conventions @ 0xBC8 */
__int64 test_calling_conventions()
{
  __int64 v0; // x6
  __int64 v1; // x7
  unsigned int v2; // w0
  unsigned int v3; // w0
  __int64 i; // x0
  __int64 v5; // x2
  __int64 v6; // x2
  __int64 v7; // x1
  __int64 v8; // x3
  char v10; // [xsp+0h] [xbp+0h]
  _OWORD v11[8]; // [xsp+18h] [xbp+18h]
  _OWORD v12[8]; // [xsp+98h] [xbp+98h]

  puts(asc_145C);
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
  v2 = varargs_func(5, 1, 2, 3, 4, 5, v0, v1, v10);
  __printf_chk(1, aCallL206, v2);
  __printf_chk(1, aCallL207, 42);
  __printf_chk(1, aCallL208, 36);
  v3 = func_mixed_args(10, "test", 100, 3.14);
  __printf_chk(1, aCallL209, v3);
  for ( i = 0; i != 16; *((_QWORD *)v11 + v5) = i )
    v5 = i++;
  v6 = 0;
  v12[0] = v11[0];
  v12[1] = v11[1];
  v12[2] = v11[2];
  v12[3] = v11[3];
  v12[4] = v11[4];
  v12[5] = v11[5];
  v7 = 0;
  v12[6] = v11[6];
  v12[7] = v11[7];
  do
  {
    v8 = *((_QWORD *)v12 + v7++);
    v6 += v8;
  }
  while ( v7 != 16 );
  __printf_chk(1, aCallL210, v6);
  return __printf_chk(1, aCallL211, 50);
}


/* Function: param_by_value_int @ 0xDE4 */
__int64 __fastcall param_by_value_int(int a1)
{
  return (unsigned int)(2 * a1);
}


/* Function: call_by_value_int @ 0xDEC */
__int64 call_by_value_int()
{
  return 15;
}


/* Function: param_by_value_ptr @ 0xDF4 */
__int64 __fastcall param_by_value_ptr(_DWORD *a1)
{
  *a1 *= 2;
  return 1;
}


/* Function: call_by_value_ptr @ 0xE08 */
__int64 call_by_value_ptr()
{
  return 11;
}


/* Function: param_array_decay @ 0xE10 */
__int64 param_array_decay()
{
  return 8;
}


/* Function: call_array_decay @ 0xE18 */
__int64 call_array_decay()
{
  return 8;
}


/* Function: param_string @ 0xE20 */
__int64 __fastcall param_string(unsigned __int8 *a1)
{
  return *a1 + (unsigned int)a1[1];
}


/* Function: call_string_param @ 0xE30 */
__int64 call_string_param()
{
  return 173;
}


/* Function: param_ptr_array @ 0xE38 */
__int64 __fastcall param_ptr_array(__int64 a1, int a2)
{
  __int64 v3; // x2
  __int64 result; // x0
  unsigned __int8 *v5; // x4

  v3 = 0;
  result = 0;
  while ( a2 > (int)v3 )
  {
    v5 = *(unsigned __int8 **)(a1 + 8 * v3++);
    result = (unsigned int)result + *v5;
  }
  return result;
}


/* Function: call_ptr_array @ 0xE64 */
__int64 call_ptr_array()
{
  _QWORD v1[3]; // [xsp+10h] [xbp+10h] BYREF

  v1[0] = off_13010;
  v1[1] = off_13018;
  v1[2] = off_13020;
  return param_ptr_array((__int64)v1, 3);
}


/* Function: param_varargs @ 0xECC */
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
  char *v10; // x3
  int v11; // w4
  int v12; // w1
  __int64 result; // x0
  int v14; // w5
  unsigned __int64 v15; // x2
  int v16; // w1

  v10 = &a9;
  v11 = 0;
  v12 = -56;
  result = 0;
  while ( v11 < a1 )
  {
    if ( v12 < 0 )
    {
      v14 = v12 + 8;
      if ( v12 + 8 <= 0 )
      {
        v15 = (unsigned __int64)v10;
        v10 = &a9 + v12;
      }
      else
      {
        v15 = (unsigned __int64)(v10 + 11) & 0xFFFFFFFFFFFFFFF8LL;
      }
    }
    else
    {
      v14 = v12;
      v15 = (unsigned __int64)(v10 + 11) & 0xFFFFFFFFFFFFFFF8LL;
    }
    v16 = *(_DWORD *)v10;
    ++v11;
    v10 = (char *)v15;
    result = (unsigned int)(result + v16);
    v12 = v14;
  }
  return result;
}


/* Function: call_varargs_param @ 0xFA0 */
__int64 __fastcall call_varargs_param(
        __int64 a1,
        __int64 a2,
        __int64 a3,
        __int64 a4,
        __int64 a5,
        __int64 a6,
        __int64 a7,
        __int64 a8,
        char a9)
{
  return param_varargs(4, 10, 20, 30, 40, a6, a7, a8, a9);
}


/* Function: param_func_ptr @ 0xFB8 */
__int64 __fastcall param_func_ptr(unsigned int (__fastcall *a1)(_QWORD), unsigned int a2)
{
  return a1(a2) + 10;
}


/* Function: call_func_ptr_param @ 0xFD8 */
__int64 call_func_ptr_param()
{
  return param_func_ptr((unsigned int (__fastcall *)(_QWORD))callback_func, 5u);
}


/* Function: param_double_ptr @ 0xFE8 */
__int64 __fastcall param_double_ptr(_QWORD *a1, int a2)
{
  if ( !a1 || !*a1 )
    return 0xFFFFFFFFLL;
  *(_DWORD *)*a1 = a2;
  *a1 = 0;
  return 1;
}


/* Function: call_double_ptr @ 0x100C */
__int64 call_double_ptr()
{
  return 21;
}


/* Function: param_complex_cast @ 0x1014 */
__int64 __fastcall param_complex_cast(unsigned int *a1, int a2)
{
  if ( !a2 )
    return *a1;
  if ( a2 == 1 )
    return *a1 + a1[1];
  return 0xFFFFFFFFLL;
}


/* Function: call_complex_cast @ 0x103C */
__int64 call_complex_cast()
{
  return 305419896;
}


/* Function: param_struct_byval @ 0x1048 */
__int64 __fastcall param_struct_byval(_DWORD *a1)
{
  return (unsigned int)(*a1 + a1[15]);
}


/* Function: call_struct_byval @ 0x1058 */
__int64 call_struct_byval()
{
  __int64 i; // x0
  _DWORD v2[16]; // [xsp+18h] [xbp+18h]

  for ( i = 0; i != 16; ++i )
    v2[i] = i;
  return (unsigned int)(v2[0] + v2[15]);
}


/* Function: param_order_dep @ 0x10C0 */
__int64 __fastcall param_order_dep(int a1, int a2)
{
  return (unsigned int)(a1 + a2);
}


/* Function: call_order_dep @ 0x10C8 */
__int64 call_order_dep()
{
  return 4;
}


/* Function: test_parameter_passing @ 0x10D0 */
__int64 test_parameter_passing()
{
  int v0; // w0
  __int64 v1; // x0
  __int64 v2; // x1
  __int64 v3; // x2
  __int64 v4; // x3
  __int64 v5; // x4
  __int64 v6; // x5
  __int64 v7; // x6
  __int64 v8; // x7
  int v9; // w0
  int v10; // w0
  int v11; // w0
  char vars0; // [xsp+0h] [xbp+0h]

  puts(asc_1614);
  __printf_chk(1, "PARAM-L1-01: %d\n", 15);
  __printf_chk(1, "PARAM-L1-02: %d\n", 11);
  __printf_chk(1, "PARAM-L2-01: %d\n", 8);
  __printf_chk(1, "PARAM-L2-02: %d\n", 173);
  v0 = call_ptr_array();
  v1 = __printf_chk(1, "PARAM-L2-03: %d\n", v0);
  v9 = call_varargs_param(v1, v2, v3, v4, v5, v6, v7, v8, vars0);
  __printf_chk(1, "PARAM-L2-04: %d\n", v9);
  v10 = call_func_ptr_param();
  __printf_chk(1, "PARAM-L3-01: %d\n", v10);
  __printf_chk(1, "PARAM-L3-02: %d\n", 21);
  __printf_chk(1, "PARAM-L3-03: %d\n", 305419896);
  v11 = call_struct_byval();
  __printf_chk(1, "PARAM-L3-04: %d\n", v11);
  return __printf_chk(1, "PARAM-L3-05: %d\n", 4);
}


/* Function: ret_basic_type @ 0x11D8 */
__int64 __fastcall ret_basic_type(int a1)
{
  return (unsigned int)(2 * a1);
}


/* Function: call_ret_basic @ 0x11E0 */
__int64 call_ret_basic()
{
  return 42;
}


/* Function: ret_pointer @ 0x11E8 */
__int64 __fastcall ret_pointer(__int64 a1)
{
  return a1 + 4;
}


/* Function: call_ret_pointer @ 0x11F0 */
__int64 call_ret_pointer()
{
  return 20;
}


/* Function: ret_small_struct @ 0x11F8 */
unsigned __int64 __fastcall ret_small_struct(unsigned int a1, __int64 a2)
{
  return a1 | (unsigned __int64)(a2 << 32);
}


/* Function: call_ret_small_struct @ 0x1204 */
__int64 call_ret_small_struct()
{
  return 7;
}


/* Function: ret_large_struct @ 0x120C */
long double __usercall ret_large_struct@<Q0>(int a1@<W0>, long double *a2@<X8>)
{
  __int64 i; // x2
  __int128 v3; // q1
  long double result; // q0
  __int128 v5; // q1
  _OWORD v6[2]; // [xsp+18h] [xbp+18h]
  long double v7; // [xsp+38h] [xbp+38h]
  __int128 v8; // [xsp+48h] [xbp+48h]

  for ( i = 0; i != 16; ++i )
    *((_DWORD *)v6 + i) = a1 + i;
  v3 = v6[1];
  *a2 = *(long double *)v6;
  *((_OWORD *)a2 + 1) = v3;
  result = v7;
  v5 = v8;
  a2[2] = v7;
  *((_OWORD *)a2 + 3) = v5;
  return result;
}


/* Function: call_ret_large_struct @ 0x1278 */
__int64 call_ret_large_struct()
{
  long double v1[3]; // [xsp+18h] [xbp+18h] BYREF
  int v2; // [xsp+54h] [xbp+54h]

  ret_large_struct(100, v1);
  return (unsigned int)(LODWORD(v1[0]) + v2);
}


/* Function: ret_func_ptr @ 0x12D4 */
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


/* Function: call_ret_func_ptr @ 0x12F0 */
__int64 call_ret_func_ptr()
{
  return 10;
}


/* Function: ret_opaque_handle @ 0x12F8 */
int *__fastcall ret_opaque_handle(int a1)
{
  if ( a1 )
    return (int *)&handle2_0;
  else
    return &handle1_1;
}


/* Function: call_ret_opaque @ 0x1314 */
__int64 call_ret_opaque()
{
  return (unsigned int)handle1_1;
}


/* Function: ret_complex_expr @ 0x1320 */
__int64 __fastcall ret_complex_expr(int a1, int a2, int a3)
{
  unsigned int v3; // w3
  unsigned int v4; // w2

  v3 = 2 * a3;
  v4 = a3 + 10;
  if ( a1 > a2 )
    return v3;
  else
    return v4;
}


/* Function: call_ret_complex_expr @ 0x1334 */
__int64 call_ret_complex_expr()
{
  return 40;
}


/* Function: ret_multi_branch @ 0x133C */
__int64 __fastcall ret_multi_branch(unsigned int a1)
{
  if ( a1 >= 3 )
    return 0xFFFFFFFFLL;
  else
    return 10 * a1 + 10;
}


/* Function: call_ret_multi_branch @ 0x1350 */
__int64 call_ret_multi_branch()
{
  return 60;
}


/* Function: ret_void @ 0x1358 */
__int64 __fastcall ret_void(int a1, _DWORD *a2)
{
  __int64 result; // x0

  result = (unsigned int)(3 * a1);
  *a2 = result;
  return result;
}


/* Function: call_ret_void @ 0x1364 */
__int64 call_ret_void()
{
  return 21;
}


/* Function: test_return_values @ 0x136C */
__int64 test_return_values()
{
  unsigned int v0; // w0

  puts(asc_16F0);
  __printf_chk(1, aRetL101D, 42);
  __printf_chk(1, aRetL102D, 20);
  __printf_chk(1, aRetL103D, 7);
  v0 = call_ret_large_struct();
  __printf_chk(1, aRetL104D, v0);
  __printf_chk(1, aRetL201D, 10);
  __printf_chk(1, aRetL202D, (unsigned int)handle1_1);
  __printf_chk(1, aRetL301D, 40);
  __printf_chk(1, aRetL302D, 60);
  return __printf_chk(1, aRetL303D, 21);
}


/* Function: .term_proc @ 0x1440 */
void term_proc()
{
  ;
}


/* FAILED to decompile: strlen @ 0x13090 */

/* FAILED to decompile: __libc_start_main @ 0x13098 */

/* FAILED to decompile: __cxa_finalize @ 0x130A0 */

/* FAILED to decompile: __printf_chk @ 0x130A8 */

/* FAILED to decompile: __stack_chk_fail @ 0x130B0 */

/* FAILED to decompile: abort @ 0x130C0 */

/* FAILED to decompile: puts @ 0x130C8 */

/* FAILED to decompile: __gmon_start__ @ 0x130D8 */

/* Total functions decompiled: 80, failed: 8 */
