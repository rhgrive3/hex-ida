/*
 * Decompiled by IDA Pro 9.1 with Hex-Rays
 * Binary: /Users/eren/Desktop/Antigravity/compiler/build/arm64/4/4_gcc_O2_no_g
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


/* Function: func_b @ 0x930 */
__int64 __fastcall func_b(int a1)
{
  return (unsigned int)(2 * a1);
}


/* Function: cdecl_func @ 0x940 */
__int64 __fastcall cdecl_func(int a1, int a2)
{
  return (unsigned int)(a1 + a2);
}


/* Function: call_cdecl @ 0x950 */
__int64 call_cdecl()
{
  return 15;
}


/* Function: stdcall_func @ 0x960 */
__int64 __fastcall stdcall_func(int a1, int a2)
{
  return (unsigned int)(a1 * a2);
}


/* Function: call_stdcall @ 0x970 */
__int64 call_stdcall()
{
  return 50;
}


/* Function: fastcall_func @ 0x980 */
__int64 __fastcall fastcall_func(int a1, int a2, int a3)
{
  return (unsigned int)(a1 + a2 + a3);
}


/* Function: call_fastcall @ 0x990 */
__int64 call_fastcall()
{
  return 6;
}


/* Function: call_thiscall @ 0x9A0 */
__int64 call_thiscall()
{
  return 15;
}


/* Function: arm_aapcs_func @ 0x9B0 */
__int64 __fastcall arm_aapcs_func(int a1, int a2, int a3, int a4, int a5)
{
  return (unsigned int)(a1 + a2 + a3 + a4 + a5);
}


/* Function: call_arm_aapcs @ 0x9C4 */
__int64 call_arm_aapcs()
{
  return 15;
}


/* Function: mips_func @ 0x9D0 */
__int64 __fastcall mips_func(int a1, int a2, int a3, int a4)
{
  return (unsigned int)(a1 + a2 + a3 + a4);
}


/* Function: call_mips @ 0x9E0 */
__int64 call_mips()
{
  return 100;
}


/* Function: amd64_sysv_func @ 0x9F0 */
__int64 __fastcall amd64_sysv_func(int a1, int a2, int a3, int a4, int a5, int a6)
{
  return (unsigned int)(a1 + a2 + a3 + a4 + a5 + a6);
}


/* Function: call_amd64_sysv @ 0xA10 */
__int64 call_amd64_sysv()
{
  return 21;
}


/* Function: ms_x64_func @ 0xA20 */
__int64 __fastcall ms_x64_func(int a1, int a2, int a3, int a4, int a5)
{
  return (unsigned int)(a1 + a2 + a3 + a4 + a5);
}


/* Function: call_ms_x64 @ 0xA34 */
__int64 call_ms_x64()
{
  return 15;
}


/* Function: vectorcall_func @ 0xA40 */
__int64 __fastcall vectorcall_func(int a1, int a2, int a3, int a4)
{
  return (unsigned int)(a1 + a2 + a3 + a4);
}


/* Function: call_vectorcall @ 0xA50 */
__int64 call_vectorcall()
{
  return 10;
}


/* Function: mixed_conventions_test @ 0xA60 */
__int64 mixed_conventions_test()
{
  return 33;
}


/* Function: varargs_func @ 0xA70 */
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
  char *v14; // x4

  v10 = -56;
  if ( a1 > 0 )
  {
    v11 = &a9;
    LODWORD(result) = 0;
    v13 = 0;
    while ( 1 )
    {
      if ( v10 < 0 )
      {
        if ( v10 + 8 <= 0 )
        {
          v14 = &a9 + v10;
          v10 += 8;
          goto LABEL_5;
        }
        v10 += 8;
      }
      v14 = v11;
      v11 += 8;
LABEL_5:
      ++v13;
      result = (unsigned int)(result + *(_DWORD *)v14);
      if ( a1 == v13 )
        return result;
    }
  }
  return 0;
}


/* Function: func_no_args @ 0xB40 */
__int64 func_no_args()
{
  return 42;
}


/* Function: func_many_args @ 0xB50 */
__int64 __fastcall func_many_args(int a1, int a2, int a3, int a4, int a5, int a6, int a7, int a8)
{
  return (unsigned int)(a1 + a2 + a3 + a4 + a5 + a6 + a7 + a8);
}


/* Function: func_mixed_args @ 0xB70 */
__int64 __fastcall func_mixed_args(int a1, char *s, __int64 a3, double a4)
{
  int v4; // w19

  v4 = a1;
  if ( s )
    v4 = a1 + strlen(s);
  return (unsigned int)(int)((double)v4 + a4 + (double)a3);
}


/* Function: func_struct_byval @ 0xBC0 */
__int64 __fastcall func_struct_byval(__int64 *a1)
{
  __int64 *v1; // x1
  unsigned int v2; // w2
  __int64 v3; // t1

  v1 = a1;
  v2 = 0;
  do
  {
    v3 = *v1++;
    v2 += v3;
  }
  while ( v1 != a1 + 16 );
  return v2;
}


/* Function: func_struct_byptr @ 0xBF0 */
__int64 __fastcall func_struct_byptr(_DWORD *a1)
{
  if ( a1 )
    return (unsigned int)(*a1 * a1[1]);
  else
    return 0xFFFFFFFFLL;
}


/* Function: test_calling_conventions @ 0xC10 */
__int64 test_calling_conventions()
{
  __int64 v0; // x6
  __int64 v1; // x7
  unsigned int v2; // w0
  __int64 i; // x0
  __int64 *v4; // x0
  __int64 v5; // x2
  __int64 v6; // t1
  char v8; // [xsp+0h] [xbp+0h]
  _OWORD v9[8]; // [xsp+18h] [xbp+18h] BYREF
  _OWORD v10[8]; // [xsp+98h] [xbp+98h] BYREF
  __int64 v11; // [xsp+118h] [xbp+118h] BYREF

  puts(asc_15B0);
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
  v2 = varargs_func(5, 1, 2, 3, 4, 5, v0, v1, v8);
  __printf_chk(1, aCallL206, v2);
  __printf_chk(1, aCallL207, 42);
  __printf_chk(1, aCallL208, 36);
  __printf_chk(1, aCallL209, 117);
  for ( i = 1; i != 17; ++i )
    *((_QWORD *)v9 + i - 1) = i;
  v10[0] = v9[0];
  v10[1] = v9[1];
  v4 = (__int64 *)v10;
  v5 = 0;
  v10[2] = v9[2];
  v10[3] = v9[3];
  v10[4] = v9[4];
  v10[5] = v9[5];
  v10[6] = v9[6];
  v10[7] = v9[7];
  do
  {
    v6 = *v4++;
    v5 += v6;
  }
  while ( &v11 != v4 );
  __printf_chk(1, aCallL210, v5, v9, &v11);
  return __printf_chk(1, aCallL211, 50);
}


/* Function: param_by_value_int @ 0xE20 */
__int64 __fastcall param_by_value_int(int a1)
{
  return (unsigned int)(2 * a1);
}


/* Function: call_by_value_int @ 0xE30 */
__int64 call_by_value_int()
{
  return 15;
}


/* Function: param_by_value_ptr @ 0xE40 */
__int64 __fastcall param_by_value_ptr(_DWORD *a1)
{
  __int64 result; // x0

  result = 1;
  *a1 *= 2;
  return result;
}


/* Function: call_by_value_ptr @ 0xE60 */
__int64 call_by_value_ptr()
{
  return 11;
}


/* Function: param_array_decay @ 0xE70 */
__int64 param_array_decay()
{
  return 8;
}


/* Function: call_array_decay @ 0xE80 */
__int64 call_array_decay()
{
  return 8;
}


/* Function: param_string @ 0xE90 */
__int64 __fastcall param_string(unsigned __int8 *a1)
{
  return *a1 + (unsigned int)a1[1];
}


/* Function: call_string_param @ 0xEA0 */
__int64 call_string_param()
{
  return 173;
}


/* Function: param_ptr_array @ 0xEB0 */
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


/* Function: call_ptr_array @ 0xEF0 */
__int64 call_ptr_array()
{
  return 300;
}


/* Function: param_varargs @ 0xF00 */
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
  char *v14; // x4

  v10 = -56;
  if ( a1 > 0 )
  {
    v11 = &a9;
    LODWORD(result) = 0;
    v13 = 0;
    while ( 1 )
    {
      if ( v10 < 0 )
      {
        if ( v10 + 8 <= 0 )
        {
          v14 = &a9 + v10;
          v10 += 8;
          goto LABEL_5;
        }
        v10 += 8;
      }
      v14 = v11;
      v11 += 8;
LABEL_5:
      ++v13;
      result = (unsigned int)(result + *(_DWORD *)v14);
      if ( a1 == v13 )
        return result;
    }
  }
  return 0;
}


/* Function: call_varargs_param @ 0xFD0 */
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


/* Function: param_func_ptr @ 0xFF0 */
__int64 __fastcall param_func_ptr(unsigned int (__fastcall *a1)(_QWORD), unsigned int a2)
{
  return a1(a2) + 10;
}


/* Function: call_func_ptr_param @ 0x1010 */
__int64 call_func_ptr_param()
{
  return 20;
}


/* Function: param_double_ptr @ 0x1020 */
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


/* Function: call_double_ptr @ 0x1050 */
__int64 call_double_ptr()
{
  return 21;
}


/* Function: param_complex_cast @ 0x1060 */
__int64 __fastcall param_complex_cast(unsigned int *a1, int a2)
{
  if ( !a2 )
    return *a1;
  if ( a2 == 1 )
    return *a1 + a1[1];
  return 0xFFFFFFFFLL;
}


/* Function: call_complex_cast @ 0x1090 */
__int64 call_complex_cast()
{
  return 305419896;
}


/* Function: param_struct_byval @ 0x10A0 */
__int64 __fastcall param_struct_byval(_DWORD *a1)
{
  return (unsigned int)(*a1 + a1[15]);
}


/* Function: call_struct_byval @ 0x10B0 */
__int64 call_struct_byval()
{
  int v0; // w0
  _DWORD *v1; // x1
  _DWORD v3[16]; // [xsp+18h] [xbp+18h] BYREF

  v0 = 0;
  v1 = v3;
  do
    *v1++ = v0++;
  while ( v0 != 16 );
  return (unsigned int)(v3[0] + v3[15]);
}


/* Function: param_order_dep @ 0x1120 */
__int64 __fastcall param_order_dep(int a1, int a2)
{
  return (unsigned int)(a1 + a2);
}


/* Function: call_order_dep @ 0x1130 */
__int64 call_order_dep()
{
  return 4;
}


/* Function: test_parameter_passing @ 0x1140 */
__int64 test_parameter_passing()
{
  __int64 v0; // x5
  __int64 v1; // x6
  __int64 v2; // x7
  int v3; // w0
  _DWORD *v4; // x1
  int i; // w0
  char v7; // [xsp+0h] [xbp+0h]
  _DWORD v8[16]; // [xsp+18h] [xbp+18h] BYREF

  puts(asc_1778);
  __printf_chk(1, "PARAM-L1-01: %d\n", 15);
  __printf_chk(1, "PARAM-L1-02: %d\n", 11);
  __printf_chk(1, "PARAM-L2-01: %d\n", 8);
  __printf_chk(1, "PARAM-L2-02: %d\n", 173);
  __printf_chk(1, "PARAM-L2-03: %d\n", 300);
  v3 = param_varargs(4, 10, 20, 30, 40, v0, v1, v2, v7);
  __printf_chk(1, "PARAM-L2-04: %d\n", v3);
  __printf_chk(1, "PARAM-L3-01: %d\n", 20);
  __printf_chk(1, "PARAM-L3-02: %d\n", 21);
  __printf_chk(1, "PARAM-L3-03: %d\n", 305419896);
  v4 = v8;
  for ( i = 0; i != 16; ++i )
    *v4++ = i;
  __printf_chk(1, "PARAM-L3-04: %d\n", v8[0] + v8[15]);
  return __printf_chk(1, "PARAM-L3-05: %d\n", 4);
}


/* Function: ret_basic_type @ 0x12A4 */
__int64 __fastcall ret_basic_type(int a1)
{
  return (unsigned int)(2 * a1);
}


/* Function: call_ret_basic @ 0x12B0 */
__int64 call_ret_basic()
{
  return 42;
}


/* Function: ret_pointer @ 0x12C0 */
__int64 __fastcall ret_pointer(__int64 a1)
{
  return a1 + 4;
}


/* Function: call_ret_pointer @ 0x12D0 */
__int64 call_ret_pointer()
{
  return 20;
}


/* Function: ret_small_struct @ 0x12E0 */
unsigned __int64 __fastcall ret_small_struct(unsigned int a1, __int64 a2)
{
  return a1 | (unsigned __int64)(a2 << 32);
}


/* Function: call_ret_small_struct @ 0x12F0 */
__int64 call_ret_small_struct()
{
  return 7;
}


/* Function: ret_large_struct @ 0x1300 */
void *__usercall ret_large_struct@<X0>(int a1@<W0>, _OWORD *a2@<X8>)
{
  int v2; // w0
  __int64 i; // x1
  char *v4; // x2
  int v5; // w3
  __int128 v6; // q3
  __int128 v7; // q0
  __int128 v8; // q1
  void *result; // x0
  _OWORD v10[4]; // [xsp+18h] [xbp+18h] BYREF

  v2 = a1 - 1;
  for ( i = 1; i != 17; ++i )
  {
    v4 = (char *)v10 + 4 * i;
    v5 = v2 + i;
    *((_DWORD *)v4 - 1) = v5;
  }
  v6 = v10[1];
  v7 = v10[2];
  v8 = v10[3];
  result = &_stack_chk_guard;
  *a2 = v10[0];
  a2[1] = v6;
  a2[2] = v7;
  a2[3] = v8;
  return result;
}


/* Function: call_ret_large_struct @ 0x1380 */
__int64 call_ret_large_struct()
{
  __int64 i; // x0
  _DWORD *v1; // x1
  int v2; // w2
  _DWORD v4[16]; // [xsp+18h] [xbp+18h] BYREF

  for ( i = 1; i != 17; ++i )
  {
    v1 = &v4[i];
    v2 = i + 99;
    *(v1 - 1) = v2;
  }
  return (unsigned int)(v4[15] + v4[0]);
}


/* Function: ret_func_ptr @ 0x13F4 */
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


/* Function: call_ret_func_ptr @ 0x1410 */
__int64 call_ret_func_ptr()
{
  return 10;
}


/* Function: ret_opaque_handle @ 0x1420 */
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


/* Function: call_ret_opaque @ 0x1440 */
__int64 call_ret_opaque()
{
  return (unsigned int)handle1_1;
}


/* Function: ret_complex_expr @ 0x1450 */
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


/* Function: call_ret_complex_expr @ 0x1464 */
__int64 call_ret_complex_expr()
{
  return 40;
}


/* Function: ret_multi_branch @ 0x1470 */
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


/* Function: call_ret_multi_branch @ 0x1490 */
__int64 call_ret_multi_branch()
{
  return 60;
}


/* Function: ret_void @ 0x14A0 */
__int64 __fastcall ret_void(int a1, _DWORD *a2)
{
  __int64 result; // x0

  result = (unsigned int)(3 * a1);
  *a2 = result;
  return result;
}


/* Function: call_ret_void @ 0x14B0 */
__int64 call_ret_void()
{
  return 21;
}


/* Function: test_return_values @ 0x14C0 */
__int64 test_return_values()
{
  unsigned int v0; // w0

  puts(asc_18A8);
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


/* Function: .term_proc @ 0x1594 */
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

/* Total functions decompiled: 79, failed: 8 */
