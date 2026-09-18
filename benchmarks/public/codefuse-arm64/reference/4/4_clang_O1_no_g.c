/*
 * Decompiled by IDA Pro 9.1 with Hex-Rays
 * Binary: /Users/eren/Desktop/Antigravity/compiler/build/arm64/4/4_clang_O1_no_g
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
  unsigned int v8; // w8
  _DWORD *v9; // x10
  __int64 v10; // x10
  _QWORD v12[8]; // [xsp+80h] [xbp-60h] BYREF
  _DWORD *v13; // [xsp+C0h] [xbp-20h] BYREF
  _QWORD *v14; // [xsp+C8h] [xbp-18h]
  _QWORD *v15; // [xsp+D0h] [xbp-10h]
  unsigned __int64 v16; // [xsp+D8h] [xbp-8h]

  v15 = v12;
  v16 = 0xFFFFFF80FFFFFFC8LL;
  v8 = 0;
  v12[3] = a4;
  v12[4] = a5;
  v12[1] = a2;
  v12[2] = a3;
  v12[5] = a6;
  v12[6] = a7;
  v14 = &v13;
  v12[7] = a8;
  if ( a1 >= 1 )
  {
    do
    {
      v10 = (int)v16;
      if ( (v16 & 0x80000000) != 0 && (LODWORD(v16) = v16 + 8, (int)v10 + 8 <= 0) )
      {
        v9 = (_DWORD *)((char *)v14 + v10);
      }
      else
      {
        v9 = v13;
        v13 += 2;
      }
      --a1;
      v8 += *v9;
    }
    while ( a1 );
  }
  return v8;
}


/* Function: func_no_args @ 0x984 */
__int64 func_no_args()
{
  return 42;
}


/* Function: func_many_args @ 0x98C */
__int64 __fastcall func_many_args(int a1, int a2, int a3, int a4, int a5, int a6, int a7, int a8)
{
  return (unsigned int)(a2 + a1 + a3 + a4 + a5 + a6 + a7 + a8);
}


/* Function: func_mixed_args @ 0x9AC */
__int64 __fastcall func_mixed_args(int a1, char *s, __int64 a3, double a4)
{
  int v7; // w0

  if ( s )
    v7 = strlen(s);
  else
    v7 = 0;
  return (unsigned int)(int)((double)(v7 + a1) + a4 + (double)a3);
}


/* Function: func_struct_byval @ 0xA04 */
__int64 __fastcall func_struct_byval(__int64 a1)
{
  __int64 v1; // x9
  unsigned int v2; // w8
  __int64 v3; // x10

  v1 = 0;
  v2 = 0;
  do
  {
    v3 = *(_QWORD *)(a1 + v1);
    v1 += 8;
    v2 += v3;
  }
  while ( v1 != 128 );
  return v2;
}


/* Function: func_struct_byptr @ 0xA28 */
__int64 __fastcall func_struct_byptr(_DWORD *a1)
{
  if ( a1 )
    return (unsigned int)(a1[1] * *a1);
  else
    return 0xFFFFFFFFLL;
}


/* Function: test_calling_conventions @ 0xA40 */
__int64 test_calling_conventions()
{
  __int64 v0; // x6
  __int64 v1; // x7
  unsigned int v2; // w0
  __int64 v3; // x8
  bool v4; // zf
  __int64 v5; // x8
  __int64 v6; // x1
  __int64 v7; // x10
  _OWORD v9[8]; // [xsp+0h] [xbp-100h]
  _OWORD v10[8]; // [xsp+80h] [xbp-80h]

  puts(asc_14BE);
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
  do
  {
    v4 = v3 == 15;
    *((_QWORD *)v10 + v3) = v3 + 1;
    ++v3;
  }
  while ( !v4 );
  v5 = 0;
  v6 = 0;
  v9[4] = v10[4];
  v9[5] = v10[5];
  v9[6] = v10[6];
  v9[7] = v10[7];
  v9[0] = v10[0];
  v9[1] = v10[1];
  v9[2] = v10[2];
  v9[3] = v10[3];
  do
  {
    v7 = *(_QWORD *)((char *)v9 + v5);
    v5 += 8;
    v6 += v7;
  }
  while ( v5 != 128 );
  printf(aCallL210, v6);
  return printf(aCallL211, 50);
}


/* Function: param_by_value_int @ 0xBE0 */
__int64 __fastcall param_by_value_int(int a1)
{
  return (unsigned int)(2 * a1);
}


/* Function: call_by_value_int @ 0xBE8 */
__int64 call_by_value_int()
{
  return 15;
}


/* Function: param_by_value_ptr @ 0xBF0 */
__int64 __fastcall param_by_value_ptr(_DWORD *a1)
{
  __int64 result; // x0

  result = 1;
  *a1 *= 2;
  return result;
}


/* Function: call_by_value_ptr @ 0xC08 */
__int64 call_by_value_ptr()
{
  return 11;
}


/* Function: param_array_decay @ 0xC10 */
__int64 param_array_decay()
{
  return 8;
}


/* Function: call_array_decay @ 0xC18 */
__int64 call_array_decay()
{
  return 8;
}


/* Function: param_string @ 0xC20 */
__int64 __fastcall param_string(unsigned __int8 *a1)
{
  return a1[1] + (unsigned int)*a1;
}


/* Function: call_string_param @ 0xC30 */
__int64 call_string_param()
{
  return 173;
}


/* Function: param_ptr_array @ 0xC38 */
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


/* Function: call_ptr_array @ 0xC6C */
__int64 call_ptr_array()
{
  return 300;
}


/* Function: param_varargs @ 0xC74 */
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
  _DWORD *v9; // x10
  __int64 v10; // x10
  _QWORD v12[8]; // [xsp+80h] [xbp-60h] BYREF
  _DWORD *v13; // [xsp+C0h] [xbp-20h] BYREF
  _QWORD *v14; // [xsp+C8h] [xbp-18h]
  _QWORD *v15; // [xsp+D0h] [xbp-10h]
  unsigned __int64 v16; // [xsp+D8h] [xbp-8h]

  v15 = v12;
  v16 = 0xFFFFFF80FFFFFFC8LL;
  v8 = 0;
  v12[3] = a4;
  v12[4] = a5;
  v12[1] = a2;
  v12[2] = a3;
  v12[5] = a6;
  v12[6] = a7;
  v14 = &v13;
  v12[7] = a8;
  if ( a1 >= 1 )
  {
    do
    {
      v10 = (int)v16;
      if ( (v16 & 0x80000000) != 0 && (LODWORD(v16) = v16 + 8, (int)v10 + 8 <= 0) )
      {
        v9 = (_DWORD *)((char *)v14 + v10);
      }
      else
      {
        v9 = v13;
        v13 += 2;
      }
      --a1;
      v8 += *v9;
    }
    while ( a1 );
  }
  return v8;
}


/* Function: call_varargs_param @ 0xD18 */
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


/* Function: param_func_ptr @ 0xD40 */
__int64 __fastcall param_func_ptr(unsigned int (__fastcall *a1)(_QWORD), unsigned int a2)
{
  return a1(a2) + 10;
}


/* Function: call_func_ptr_param @ 0xD60 */
__int64 call_func_ptr_param()
{
  return 20;
}


/* Function: param_double_ptr @ 0xD68 */
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


/* Function: call_double_ptr @ 0xD90 */
__int64 call_double_ptr()
{
  return 21;
}


/* Function: param_complex_cast @ 0xD98 */
__int64 __fastcall param_complex_cast(unsigned int *a1, int a2)
{
  if ( a2 == 1 )
    return a1[1] + *a1;
  if ( a2 )
    return 0xFFFFFFFFLL;
  return *a1;
}


/* Function: call_complex_cast @ 0xDC0 */
__int64 call_complex_cast()
{
  return 305419896;
}


/* Function: param_struct_byval @ 0xDCC */
__int64 __fastcall param_struct_byval(_DWORD *a1)
{
  return (unsigned int)(a1[15] + *a1);
}


/* Function: call_struct_byval @ 0xDDC */
__int64 call_struct_byval()
{
  __int64 i; // x8
  _DWORD v2[16]; // [xsp+0h] [xbp-40h]

  for ( i = 0; i != 16; ++i )
    v2[i] = i;
  return (unsigned int)(v2[15] + v2[0]);
}


/* Function: param_order_dep @ 0xE0C */
__int64 __fastcall param_order_dep(int a1, int a2)
{
  return (unsigned int)(a2 + a1);
}


/* Function: call_order_dep @ 0xE14 */
__int64 call_order_dep()
{
  return 3;
}


/* Function: test_parameter_passing @ 0xE1C */
__int64 test_parameter_passing()
{
  __int64 v0; // x5
  __int64 v1; // x6
  __int64 v2; // x7
  int v3; // w0
  __int64 i; // x8
  _DWORD v6[16]; // [xsp+0h] [xbp-40h]

  puts(asc_14DF);
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
  for ( i = 0; i != 16; ++i )
    v6[i] = i;
  printf("PARAM-L3-04: %d\n", v6[15] + v6[0]);
  return printf("PARAM-L3-05: %d\n", 3);
}


/* Function: ret_basic_type @ 0xF2C */
__int64 __fastcall ret_basic_type(int a1)
{
  return (unsigned int)(2 * a1);
}


/* Function: call_ret_basic @ 0xF34 */
__int64 call_ret_basic()
{
  return 42;
}


/* Function: ret_pointer @ 0xF3C */
__int64 __fastcall ret_pointer(__int64 a1)
{
  return a1 + 4;
}


/* Function: call_ret_pointer @ 0xF44 */
__int64 call_ret_pointer()
{
  return 20;
}


/* Function: ret_small_struct @ 0xF4C */
unsigned __int64 __fastcall ret_small_struct(unsigned int a1, unsigned int a2)
{
  return a1 | ((unsigned __int64)a2 << 32);
}


/* Function: call_ret_small_struct @ 0xF58 */
__int64 call_ret_small_struct()
{
  return 7;
}


/* Function: ret_large_struct @ 0xF60 */
__int64 __usercall ret_large_struct@<X0>(__int64 result@<X0>, __int64 a2@<X8>)
{
  __int64 i; // x9

  for ( i = 0; i != 16; ++i )
    *(_DWORD *)(a2 + 4 * i) = result + i;
  return result;
}


/* Function: call_ret_large_struct @ 0xF80 */
__int64 call_ret_large_struct()
{
  __int64 i; // x8
  _DWORD v2[16]; // [xsp+0h] [xbp-40h]

  for ( i = 0; i != 16; ++i )
    v2[i] = i + 100;
  return (unsigned int)(v2[15] + v2[0]);
}


/* Function: func_a @ 0xFB4 */
__int64 __fastcall func_a(int a1)
{
  return (unsigned int)(a1 + 10);
}


/* Function: func_b @ 0xFBC */
__int64 __fastcall func_b(int a1)
{
  return (unsigned int)(2 * a1);
}


/* Function: ret_func_ptr @ 0xFC4 */
__int64 (__fastcall *__fastcall ret_func_ptr(int a1))(int a1)
{
  if ( a1 )
    return func_b;
  else
    return func_a;
}


/* Function: call_ret_func_ptr @ 0xFE0 */
__int64 call_ret_func_ptr()
{
  return 10;
}


/* Function: ret_opaque_handle @ 0xFE8 */
int *__fastcall ret_opaque_handle(int a1)
{
  if ( a1 )
    return (int *)&ret_opaque_handle_handle2;
  else
    return &ret_opaque_handle_handle1;
}


/* Function: call_ret_opaque @ 0x1004 */
__int64 call_ret_opaque()
{
  return (unsigned int)ret_opaque_handle_handle1;
}


/* Function: ret_complex_expr @ 0x1010 */
__int64 __fastcall ret_complex_expr(int a1, int a2, int a3)
{
  if ( a1 <= a2 )
    return (unsigned int)(a3 + 10);
  else
    return (unsigned int)(2 * a3);
}


/* Function: call_ret_complex_expr @ 0x1024 */
__int64 call_ret_complex_expr()
{
  return 40;
}


/* Function: ret_multi_branch @ 0x102C */
__int64 __fastcall ret_multi_branch(unsigned int a1)
{
  if ( a1 >= 3 )
    return 0xFFFFFFFFLL;
  else
    return 10 * a1 + 10;
}


/* Function: call_ret_multi_branch @ 0x1044 */
__int64 call_ret_multi_branch()
{
  return 60;
}


/* Function: ret_void @ 0x104C */
__int64 __fastcall ret_void(__int64 result, _DWORD *a2)
{
  *a2 = 3 * result;
  return result;
}


/* Function: call_ret_void @ 0x1058 */
__int64 call_ret_void()
{
  return 21;
}


/* Function: test_return_values @ 0x1060 */
__int64 test_return_values()
{
  __int64 i; // x8
  _DWORD v2[16]; // [xsp+0h] [xbp-40h]

  puts(asc_1500);
  printf(aRetL101D, 42);
  printf(aRetL102D, 20);
  printf(aRetL103D, 7);
  for ( i = 0; i != 16; ++i )
    v2[i] = i + 100;
  printf(aRetL104D, (unsigned int)(v2[15] + v2[0]));
  printf(aRetL201D, 10);
  printf(aRetL202D, (unsigned int)ret_opaque_handle_handle1);
  printf(aRetL301D, 40);
  printf(aRetL302D, 60);
  return printf(aRetL303D, 21);
}


/* Function: main @ 0x113C */
int __fastcall main(int argc, const char **argv, const char **envp)
{
  test_calling_conventions();
  test_parameter_passing();
  test_return_values();
  return 0;
}


/* Function: .term_proc @ 0x115C */
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
