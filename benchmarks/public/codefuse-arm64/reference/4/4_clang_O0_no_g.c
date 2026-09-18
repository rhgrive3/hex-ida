/*
 * Decompiled by IDA Pro 9.1 with Hex-Rays
 * Binary: /Users/eren/Desktop/Antigravity/compiler/build/arm64/4/4_clang_O0_no_g
 * Processor: arm
 */

/* Function: .init_proc @ 0x6B0 */
__int64 init_proc()
{
  return call_weak_fn();
}


/* Function: sub_6D0 @ 0x6D0 */
void sub_6D0()
{
  JUMPOUT(0);
}


/* Function: _start @ 0x780 */
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


/* Function: call_weak_fn @ 0x7B4 */
void *call_weak_fn()
{
  void *result; // x0

  result = &_gmon_start__;
  if ( &_gmon_start__ )
    return (void *)__gmon_start__();
  return result;
}


/* Function: deregister_tm_clones @ 0x7D0 */
char *deregister_tm_clones()
{
  return &_bss_start;
}


/* Function: register_tm_clones @ 0x800 */
char *register_tm_clones()
{
  return &_bss_start;
}


/* Function: __do_global_dtors_aux @ 0x840 */
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


/* Function: frame_dummy @ 0x890 */
// attributes: thunk
char *frame_dummy()
{
  return register_tm_clones();
}


/* Function: cdecl_func @ 0x894 */
__int64 __fastcall cdecl_func(int a1, int a2)
{
  return (unsigned int)(a1 + a2);
}


/* Function: call_cdecl @ 0x8B4 */
__int64 call_cdecl()
{
  return cdecl_func(5, 10);
}


/* Function: stdcall_func @ 0x8D0 */
__int64 __fastcall stdcall_func(int a1, int a2)
{
  return (unsigned int)(a1 * a2);
}


/* Function: call_stdcall @ 0x8F0 */
__int64 call_stdcall()
{
  return stdcall_func(5, 10);
}


/* Function: fastcall_func @ 0x90C */
__int64 __fastcall fastcall_func(int a1, int a2, int a3)
{
  return (unsigned int)(a1 + a2 + a3);
}


/* Function: call_fastcall @ 0x938 */
__int64 call_fastcall()
{
  return fastcall_func(1, 2, 3);
}


/* Function: call_thiscall @ 0x958 */
__int64 call_thiscall()
{
  return 15;
}


/* Function: arm_aapcs_func @ 0x960 */
__int64 __fastcall arm_aapcs_func(int a1, int a2, int a3, int a4, int a5)
{
  return (unsigned int)(a1 + a2 + a3 + a4 + a5);
}


/* Function: call_arm_aapcs @ 0x9A4 */
__int64 call_arm_aapcs()
{
  return arm_aapcs_func(1, 2, 3, 4, 5);
}


/* Function: mips_func @ 0x9CC */
__int64 __fastcall mips_func(int a1, int a2, int a3, int a4)
{
  return (unsigned int)(a1 + a2 + a3 + a4);
}


/* Function: call_mips @ 0xA04 */
__int64 call_mips()
{
  return mips_func(10, 20, 30, 40);
}


/* Function: amd64_sysv_func @ 0xA28 */
__int64 __fastcall amd64_sysv_func(int a1, int a2, int a3, int a4, int a5, int a6)
{
  return (unsigned int)(a1 + a2 + a3 + a4 + a5 + a6);
}


/* Function: call_amd64_sysv @ 0xA78 */
__int64 call_amd64_sysv()
{
  return amd64_sysv_func(1, 2, 3, 4, 5, 6);
}


/* Function: ms_x64_func @ 0xAA4 */
__int64 __fastcall ms_x64_func(int a1, int a2, int a3, int a4, int a5)
{
  return (unsigned int)(a1 + a2 + a3 + a4 + a5);
}


/* Function: call_ms_x64 @ 0xAE8 */
__int64 call_ms_x64()
{
  return ms_x64_func(1, 2, 3, 4, 5);
}


/* Function: vectorcall_func @ 0xB10 */
__int64 __fastcall vectorcall_func(int a1, int a2, int a3, int a4)
{
  return (unsigned int)(a1 + a2 + a3 + a4);
}


/* Function: call_vectorcall @ 0xB48 */
__int64 call_vectorcall()
{
  return vectorcall_func(1, 2, 3, 4);
}


/* Function: mixed_conventions_test @ 0xB6C */
__int64 mixed_conventions_test()
{
  int v1; // [xsp+Ch] [xbp-4h]
  int v2; // [xsp+Ch] [xbp-4h]

  v1 = cdecl_func(1, 2);
  v2 = v1 + stdcall_func(3, 4);
  return v2 + (unsigned int)fastcall_func(5, 6, 7);
}


/* Function: varargs_func @ 0xBD8 */
__int64 varargs_func(int a1, ...)
{
  _DWORD *stack; // x8
  _DWORD *v3; // [xsp+8h] [xbp-118h]
  int gr_offs; // [xsp+1Ch] [xbp-104h]
  int i; // [xsp+E0h] [xbp-40h]
  unsigned int v6; // [xsp+E4h] [xbp-3Ch]
  gcc_va_list va; // [xsp+E8h] [xbp-38h] BYREF
  int v8; // [xsp+10Ch] [xbp-14h]

  va_start(va, a1);
  v8 = a1;
  v6 = 0;
  for ( i = 0; i < v8; ++i )
  {
    gr_offs = va[0].__gr_offs;
    if ( va[0].__gr_offs < 0 && (va[0].__gr_offs += 8, gr_offs + 8 <= 0) )
    {
      v3 = (char *)va[0].__gr_top + gr_offs;
    }
    else
    {
      stack = va[0].__stack;
      va[0].__stack = (char *)va[0].__stack + 8;
      v3 = stack;
    }
    v6 += *v3;
  }
  return v6;
}


/* Function: func_no_args @ 0xD10 */
__int64 func_no_args()
{
  return 42;
}


/* Function: func_many_args @ 0xD18 */
__int64 __fastcall func_many_args(int a1, int a2, int a3, int a4, int a5, int a6, int a7, int a8)
{
  return (unsigned int)(a1 + a2 + a3 + a4 + a5 + a6 + a7 + a8);
}


/* Function: func_mixed_args @ 0xD80 */
__int64 __fastcall func_mixed_args(int a1, const char *a2, __int64 a3, double a4)
{
  int v5; // [xsp+0h] [xbp-30h]

  if ( a2 )
    v5 = strlen(a2);
  else
    v5 = 0;
  return (unsigned int)(int)((double)(a1 + v5) + a4 + (double)a3);
}


/* Function: func_struct_byval @ 0xE00 */
__int64 __fastcall func_struct_byval(__int64 a1)
{
  int i; // [xsp+14h] [xbp-Ch]
  __int64 v3; // [xsp+18h] [xbp-8h]

  v3 = 0;
  for ( i = 0; i < 16; ++i )
    v3 += *(_QWORD *)(a1 + 8LL * i);
  return (unsigned int)v3;
}


/* Function: func_struct_byptr @ 0xE60 */
__int64 __fastcall func_struct_byptr(_DWORD *a1)
{
  if ( a1 )
    return (unsigned int)(*a1 * a1[1]);
  else
    return (unsigned int)-1;
}


/* Function: test_calling_conventions @ 0xEA8 */
__int64 test_calling_conventions()
{
  int v0; // w0
  int v1; // w0
  int v2; // w0
  int v3; // w0
  int v4; // w0
  int v5; // w0
  int v6; // w0
  int v7; // w0
  int v8; // w0
  int v9; // w0
  unsigned int v11; // [xsp+2Ch] [xbp-134h]
  __int64 v12; // [xsp+30h] [xbp-130h] BYREF
  _BYTE dest[128]; // [xsp+38h] [xbp-128h] BYREF
  unsigned int v14; // [xsp+B8h] [xbp-A8h]
  int i; // [xsp+BCh] [xbp-A4h]
  _QWORD src[16]; // [xsp+C0h] [xbp-A0h] BYREF
  unsigned int v17; // [xsp+144h] [xbp-1Ch]
  const char *v18; // [xsp+148h] [xbp-18h]
  unsigned int v19; // [xsp+154h] [xbp-Ch]
  unsigned int v20; // [xsp+158h] [xbp-8h]
  unsigned int v21; // [xsp+15Ch] [xbp-4h]

  printf(asc_1DC0);
  v0 = call_cdecl();
  printf("CALL-L1-01: %d\n", v0);
  v1 = call_stdcall();
  printf("CALL-L1-02: %d\n", v1);
  v2 = call_fastcall();
  printf("CALL-L1-03: %d\n", v2);
  v3 = call_thiscall();
  printf("CALL-L1-04: %d\n", v3);
  v4 = call_arm_aapcs();
  printf("CALL-L1-05: %d\n", v4);
  v5 = call_mips();
  printf("CALL-L1-06: %d\n", v5);
  v6 = call_amd64_sysv();
  printf("CALL-L1-07: %d\n", v6);
  v7 = call_ms_x64();
  printf("CALL-L1-08: %d\n", v7);
  v8 = call_vectorcall();
  printf("CALL-L1-09: %d\n", v8);
  v9 = mixed_conventions_test();
  printf("CALL-L1-10: %d\n", v9);
  v21 = varargs_func(5);
  printf(aCallL206, v21);
  v20 = func_no_args();
  printf(aCallL207, v20);
  v19 = func_many_args(1, 2, 3, 4, 5, 6, 7, 8);
  printf(aCallL208, v19);
  v18 = "test";
  v17 = func_mixed_args(10, "test", 100, 3.14);
  printf(aCallL209, v17);
  for ( i = 0; i < 16; ++i )
    src[i] = i + 1;
  memcpy(dest, src, sizeof(dest));
  v14 = func_struct_byval((__int64)dest);
  printf(aCallL210, v14);
  v12 = 0xA00000005LL;
  v11 = func_struct_byptr(&v12);
  return printf(aCallL211, v11);
}


/* Function: param_by_value_int @ 0x1118 */
__int64 __fastcall param_by_value_int(int a1)
{
  return (unsigned int)(2 * a1);
}


/* Function: call_by_value_int @ 0x1138 */
__int64 call_by_value_int()
{
  return (unsigned int)param_by_value_int(5) + 5;
}


/* Function: param_by_value_ptr @ 0x1170 */
__int64 __fastcall param_by_value_ptr(_DWORD *a1)
{
  *a1 *= 2;
  return 1;
}


/* Function: call_by_value_ptr @ 0x11A8 */
__int64 call_by_value_ptr()
{
  int v1; // [xsp+Ch] [xbp-14h]
  int v2; // [xsp+1Ch] [xbp-4h] BYREF

  v2 = 5;
  v1 = param_by_value_ptr(&v2);
  return (unsigned int)(v2 + v1);
}


/* Function: param_array_decay @ 0x11E8 */
__int64 param_array_decay()
{
  return 8;
}


/* Function: call_array_decay @ 0x1200 */
__int64 call_array_decay()
{
  _BYTE s[40]; // [xsp+8h] [xbp-28h] BYREF

  memset(s, 0, sizeof(s));
  return param_array_decay();
}


/* Function: param_string @ 0x1238 */
__int64 __fastcall param_string(unsigned __int8 *a1)
{
  return *a1 + (unsigned int)a1[1];
}


/* Function: call_string_param @ 0x125C */
__int64 call_string_param()
{
  return param_string("Hello");
}


/* Function: param_ptr_array @ 0x1278 */
__int64 __fastcall param_ptr_array(__int64 a1, int a2)
{
  int i; // [xsp+Ch] [xbp-14h]
  unsigned int v4; // [xsp+10h] [xbp-10h]

  v4 = 0;
  for ( i = 0; i < a2; ++i )
    v4 += **(unsigned __int8 **)(a1 + 8LL * i);
  return v4;
}


/* Function: call_ptr_array @ 0x12E0 */
__int64 call_ptr_array()
{
  __int128 v1; // [xsp+0h] [xbp-20h] BYREF
  const char *v2; // [xsp+10h] [xbp-10h]

  v1 = *(_OWORD *)off_12DC0;
  v2 = "ghi";
  return param_ptr_array((__int64)&v1, 3);
}


/* Function: param_varargs @ 0x131C */
__int64 param_varargs(int a1, ...)
{
  _DWORD *stack; // x8
  _DWORD *v3; // [xsp+8h] [xbp-118h]
  int gr_offs; // [xsp+1Ch] [xbp-104h]
  int i; // [xsp+E0h] [xbp-40h]
  unsigned int v6; // [xsp+E4h] [xbp-3Ch]
  gcc_va_list va; // [xsp+E8h] [xbp-38h] BYREF
  int v8; // [xsp+10Ch] [xbp-14h]

  va_start(va, a1);
  v8 = a1;
  v6 = 0;
  for ( i = 0; i < v8; ++i )
  {
    gr_offs = va[0].__gr_offs;
    if ( va[0].__gr_offs < 0 && (va[0].__gr_offs += 8, gr_offs + 8 <= 0) )
    {
      v3 = (char *)va[0].__gr_top + gr_offs;
    }
    else
    {
      stack = va[0].__stack;
      va[0].__stack = (char *)va[0].__stack + 8;
      v3 = stack;
    }
    v6 += *v3;
  }
  return v6;
}


/* Function: call_varargs_param @ 0x1454 */
__int64 call_varargs_param()
{
  return param_varargs(4, 10, 20, 30, 40);
}


/* Function: param_func_ptr @ 0x147C */
__int64 __fastcall param_func_ptr(unsigned int (__fastcall *a1)(_QWORD), unsigned int a2)
{
  return a1(a2) + 10;
}


/* Function: call_func_ptr_param @ 0x14AC */
__int64 call_func_ptr_param()
{
  return param_func_ptr((unsigned int (__fastcall *)(_QWORD))callback_func, 5u);
}


/* Function: callback_func @ 0x14CC */
__int64 __fastcall callback_func(int a1)
{
  return (unsigned int)(2 * a1);
}


/* Function: param_double_ptr @ 0x14E4 */
__int64 __fastcall param_double_ptr(_DWORD **a1, int a2)
{
  if ( a1 && *a1 )
  {
    **a1 = a2;
    *a1 = 0;
    return 1;
  }
  else
  {
    return (unsigned int)-1;
  }
}


/* Function: call_double_ptr @ 0x1548 */
__int64 call_double_ptr()
{
  int *v1; // [xsp+10h] [xbp-10h] BYREF
  int v2; // [xsp+1Ch] [xbp-4h] BYREF

  v2 = 10;
  v1 = &v2;
  param_double_ptr(&v1, 20);
  return v2 + (unsigned int)(v1 == 0);
}


/* Function: param_complex_cast @ 0x1598 */
__int64 __fastcall param_complex_cast(unsigned int *a1, int a2)
{
  if ( a2 )
  {
    if ( a2 == 1 )
      return *a1 + a1[1];
    else
      return (unsigned int)-1;
  }
  else
  {
    return *a1;
  }
}


/* Function: call_complex_cast @ 0x1628 */
__int64 call_complex_cast()
{
  __int64 v1; // [xsp+10h] [xbp-10h] BYREF
  unsigned int v2; // [xsp+1Ch] [xbp-4h] BYREF

  v2 = 305419896;
  v1 = 0xC800000064LL;
  param_complex_cast((unsigned int *)&v1, 1);
  return param_complex_cast(&v2, 0);
}


/* Function: param_struct_byval @ 0x167C */
__int64 __fastcall param_struct_byval(_DWORD *a1)
{
  return (unsigned int)(*a1 + a1[15]);
}


/* Function: call_struct_byval @ 0x168C */
__int64 call_struct_byval()
{
  _DWORD dest[16]; // [xsp+Ch] [xbp-84h] BYREF
  int i; // [xsp+4Ch] [xbp-44h]
  _DWORD src[16]; // [xsp+50h] [xbp-40h] BYREF

  for ( i = 0; i < 16; ++i )
    src[i] = i;
  memcpy(dest, src, sizeof(dest));
  return param_struct_byval(dest);
}


/* Function: param_order_dep @ 0x16FC */
__int64 __fastcall param_order_dep(int a1, int a2)
{
  return (unsigned int)(a1 + a2);
}


/* Function: call_order_dep @ 0x171C */
__int64 call_order_dep()
{
  return param_order_dep(1, 2);
}


/* Function: test_parameter_passing @ 0x1754 */
__int64 test_parameter_passing()
{
  int v0; // w0
  int v1; // w0
  int v2; // w0
  int v3; // w0
  int v4; // w0
  int v5; // w0
  int v6; // w0
  int v7; // w0
  int v8; // w0
  int v9; // w0
  int v10; // w0

  printf(asc_1F8B);
  v0 = call_by_value_int();
  printf("PARAM-L1-01: %d\n", v0);
  v1 = call_by_value_ptr();
  printf("PARAM-L1-02: %d\n", v1);
  v2 = call_array_decay();
  printf("PARAM-L2-01: %d\n", v2);
  v3 = call_string_param();
  printf("PARAM-L2-02: %d\n", v3);
  v4 = call_ptr_array();
  printf("PARAM-L2-03: %d\n", v4);
  v5 = call_varargs_param();
  printf("PARAM-L2-04: %d\n", v5);
  v6 = call_func_ptr_param();
  printf("PARAM-L3-01: %d\n", v6);
  v7 = call_double_ptr();
  printf("PARAM-L3-02: %d\n", v7);
  v8 = call_complex_cast();
  printf("PARAM-L3-03: %d\n", v8);
  v9 = call_struct_byval();
  printf("PARAM-L3-04: %d\n", v9);
  v10 = call_order_dep();
  return printf("PARAM-L3-05: %d\n", v10);
}


/* Function: ret_basic_type @ 0x184C */
__int64 __fastcall ret_basic_type(int a1)
{
  return (unsigned int)(2 * a1);
}


/* Function: call_ret_basic @ 0x1864 */
__int64 call_ret_basic()
{
  return (unsigned int)ret_basic_type(21);
}


/* Function: ret_pointer @ 0x1894 */
__int64 __fastcall ret_pointer(__int64 a1)
{
  return a1 + 4;
}


/* Function: call_ret_pointer @ 0x18AC */
__int64 call_ret_pointer()
{
  __int64 v1; // [xsp+10h] [xbp-10h] BYREF
  int v2; // [xsp+18h] [xbp-8h]

  v1 = 0x140000000ALL;
  v2 = 30;
  return *(unsigned int *)ret_pointer((__int64)&v1);
}


/* Function: ret_small_struct @ 0x18F0 */
unsigned __int64 __fastcall ret_small_struct(unsigned int a1, unsigned int a2)
{
  return __PAIR64__(a2, a1);
}


/* Function: call_ret_small_struct @ 0x1918 */
__int64 call_ret_small_struct()
{
  unsigned __int64 v1; // [xsp+8h] [xbp-8h]

  v1 = ret_small_struct(3u, 4u);
  return (unsigned int)(v1 + HIDWORD(v1));
}


/* Function: ret_large_struct @ 0x194C */
__int64 __usercall ret_large_struct@<X0>(__int64 result@<X0>, __int64 a2@<X8>)
{
  int i; // [xsp+8h] [xbp-8h]

  for ( i = 0; i < 16; ++i )
    *(_DWORD *)(a2 + 4LL * i) = result + i;
  return result;
}


/* Function: call_ret_large_struct @ 0x19A4 */
__int64 call_ret_large_struct()
{
  _DWORD v1[16]; // [xsp+0h] [xbp-40h] BYREF

  ret_large_struct(100, (__int64)v1);
  return (unsigned int)(v1[0] + v1[15]);
}


/* Function: func_a @ 0x19D4 */
__int64 __fastcall func_a(int a1)
{
  return (unsigned int)(a1 + 10);
}


/* Function: func_b @ 0x19EC */
__int64 __fastcall func_b(int a1)
{
  return (unsigned int)(2 * a1);
}


/* Function: ret_func_ptr @ 0x1A04 */
__int64 (__fastcall *__fastcall ret_func_ptr(int a1))(int a1)
{
  if ( a1 )
    return func_b;
  else
    return func_a;
}


/* Function: call_ret_func_ptr @ 0x1A30 */
__int64 call_ret_func_ptr()
{
  __int64 (__fastcall *v1)(int); // [xsp+8h] [xbp-8h]

  v1 = ret_func_ptr(1);
  return v1(5);
}


/* Function: ret_opaque_handle @ 0x1A60 */
void *__fastcall ret_opaque_handle(int a1)
{
  if ( a1 )
    return &ret_opaque_handle_handle2;
  else
    return &ret_opaque_handle_handle1;
}


/* Function: call_ret_opaque @ 0x1A8C */
__int64 call_ret_opaque()
{
  return *(unsigned int *)ret_opaque_handle(0);
}


/* Function: ret_complex_expr @ 0x1AB8 */
__int64 __fastcall ret_complex_expr(int a1, int a2, int a3)
{
  if ( a1 <= a2 )
    return (unsigned int)(a3 + 10);
  else
    return (unsigned int)(2 * a3);
}


/* Function: call_ret_complex_expr @ 0x1B08 */
__int64 call_ret_complex_expr()
{
  int v1; // [xsp+1Ch] [xbp-4h]

  v1 = ret_complex_expr(5, 3, 10);
  return v1 + (unsigned int)ret_complex_expr(3, 5, 10);
}


/* Function: ret_multi_branch @ 0x1B64 */
__int64 __fastcall ret_multi_branch(int a1)
{
  if ( a1 )
  {
    if ( a1 == 1 )
    {
      return 20;
    }
    else if ( a1 == 2 )
    {
      return 30;
    }
    else
    {
      return (unsigned int)-1;
    }
  }
  else
  {
    return 10;
  }
}


/* Function: call_ret_multi_branch @ 0x1BD8 */
__int64 call_ret_multi_branch()
{
  int v1; // [xsp+Ch] [xbp-4h]
  int v2; // [xsp+Ch] [xbp-4h]

  v1 = ret_multi_branch(0);
  v2 = v1 + ret_multi_branch(1);
  return v2 + (unsigned int)ret_multi_branch(2);
}


/* Function: ret_void @ 0x1C34 */
__int64 __fastcall ret_void(__int64 result, _DWORD *a2)
{
  *a2 = 3 * result;
  return result;
}


/* Function: call_ret_void @ 0x1C5C */
__int64 call_ret_void()
{
  unsigned int v1; // [xsp+Ch] [xbp-4h] BYREF

  ret_void(7, &v1);
  return v1;
}


/* Function: test_return_values @ 0x1C84 */
__int64 test_return_values()
{
  unsigned int v0; // w0
  unsigned int v1; // w0
  unsigned int v2; // w0
  unsigned int v3; // w0
  unsigned int v4; // w0
  unsigned int v5; // w0
  unsigned int v6; // w0
  unsigned int v7; // w0
  unsigned int v8; // w0

  printf(asc_2068);
  v0 = call_ret_basic();
  printf(aRetL101D, v0);
  v1 = call_ret_pointer();
  printf(aRetL102D, v1);
  v2 = call_ret_small_struct();
  printf(aRetL103D, v2);
  v3 = call_ret_large_struct();
  printf(aRetL104D, v3);
  v4 = call_ret_func_ptr();
  printf(aRetL201D, v4);
  v5 = call_ret_opaque();
  printf(aRetL202D, v5);
  v6 = call_ret_complex_expr();
  printf(aRetL301D, v6);
  v7 = call_ret_multi_branch();
  printf(aRetL302D, v7);
  v8 = call_ret_void();
  return printf(aRetL303D, v8);
}


/* Function: main @ 0x1D54 */
int __fastcall main(int argc, const char **argv, const char **envp)
{
  test_calling_conventions();
  test_parameter_passing();
  test_return_values();
  return 0;
}


/* Function: .term_proc @ 0x1D88 */
void term_proc()
{
  ;
}


/* FAILED to decompile: memcpy @ 0x130B8 */

/* FAILED to decompile: strlen @ 0x130C0 */

/* FAILED to decompile: __libc_start_main @ 0x130C8 */

/* FAILED to decompile: __cxa_finalize @ 0x130D0 */

/* FAILED to decompile: memset @ 0x130D8 */

/* FAILED to decompile: abort @ 0x130E0 */

/* FAILED to decompile: printf @ 0x130E8 */

/* FAILED to decompile: __gmon_start__ @ 0x130F8 */

/* Total functions decompiled: 80, failed: 8 */
