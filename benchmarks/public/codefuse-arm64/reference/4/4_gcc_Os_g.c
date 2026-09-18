/*
 * Decompiled by IDA Pro 9.1 with Hex-Rays
 * Binary: /Users/eren/Desktop/Antigravity/compiler/build/arm64/4/4_gcc_Os_g
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
  test_calling_conventions();
  test_parameter_passing();
  test_return_values();
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
int __fastcall func_a(int x)
{
  return x + 10;
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
int __fastcall cdecl_func(int a, int b)
{
  return a + b;
}


/* Function: call_cdecl @ 0x974 */
int __cdecl call_cdecl()
{
  return 15;
}


/* Function: stdcall_func @ 0x97C */
int __fastcall stdcall_func(int a, int b)
{
  return a * b;
}


/* Function: call_stdcall @ 0x984 */
int __cdecl call_stdcall()
{
  return 50;
}


/* Function: fastcall_func @ 0x98C */
int __fastcall fastcall_func(int a, int b, int c)
{
  return a + b + c;
}


/* Function: call_fastcall @ 0x998 */
int __cdecl call_fastcall()
{
  return 6;
}


/* Function: call_thiscall @ 0x9A0 */
__int64 call_thiscall()
{
  return 15;
}


/* Function: arm_aapcs_func @ 0x9A8 */
int __fastcall arm_aapcs_func(int a, int b, int c, int d, int e)
{
  return a + b + c + d + e;
}


/* Function: call_arm_aapcs @ 0x9BC */
__int64 call_arm_aapcs()
{
  return 15;
}


/* Function: mips_func @ 0x9C4 */
int __fastcall mips_func(int a, int b, int c, int d)
{
  return a + b + c + d;
}


/* Function: call_mips @ 0x9D4 */
int __cdecl call_mips()
{
  return 100;
}


/* Function: amd64_sysv_func @ 0x9DC */
int __fastcall amd64_sysv_func(int a, int b, int c, int d, int e, int f)
{
  return a + b + c + d + e + f;
}


/* Function: call_amd64_sysv @ 0x9F4 */
int __cdecl call_amd64_sysv()
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
int __cdecl call_vectorcall()
{
  return 10;
}


/* Function: mixed_conventions_test @ 0xA30 */
int __cdecl mixed_conventions_test()
{
  return 33;
}


/* Function: varargs_func @ 0xA38 */
int varargs_func(int count, ...)
{
  gcc_va_list va; // kr00_32
  char *v3; // x3
  int v4; // w4
  int v5; // w1
  int result; // w0
  int v7; // w5
  unsigned __int64 v8; // x2
  int v9; // w1
  __int64 vars0; // [xsp+48h] [xbp+48h]
  __int64 vars8; // [xsp+50h] [xbp+50h]
  __int64 vars10; // [xsp+58h] [xbp+58h]
  __int64 vars18; // [xsp+60h] [xbp+60h]
  __int64 vars20; // [xsp+68h] [xbp+68h]
  __int64 vars28; // [xsp+70h] [xbp+70h]
  char v16; // [xsp+80h] [xbp+80h] BYREF

  va_start(va, count);
  vars0 = va_arg(va, _QWORD);
  vars8 = va_arg(va, _QWORD);
  vars10 = va_arg(va, _QWORD);
  vars18 = va_arg(va, _QWORD);
  vars20 = va_arg(va, _QWORD);
  vars28 = va_arg(va, _QWORD);
  va_end(va);
  v3 = &v16;
  v4 = 0;
  v5 = -56;
  result = 0;
  while ( v4 < count )
  {
    if ( v5 < 0 )
    {
      v7 = v5 + 8;
      if ( v5 + 8 <= 0 )
      {
        v8 = (unsigned __int64)v3;
        v3 = &v16 + v5;
      }
      else
      {
        v8 = (unsigned __int64)(v3 + 11) & 0xFFFFFFFFFFFFFFF8LL;
      }
    }
    else
    {
      v7 = v5;
      v8 = (unsigned __int64)(v3 + 11) & 0xFFFFFFFFFFFFFFF8LL;
    }
    v9 = *(_DWORD *)v3;
    ++v4;
    v3 = (char *)v8;
    result += v9;
    v5 = v7;
  }
  return result;
}


/* Function: func_no_args @ 0xB0C */
int __cdecl func_no_args()
{
  return 42;
}


/* Function: func_many_args @ 0xB14 */
int __fastcall func_many_args(int a, int b, int c, int d, int e, int f, int g, int h)
{
  return a + b + c + d + e + f + g + h;
}


/* Function: func_mixed_args @ 0xB34 */
__int64 __fastcall func_mixed_args(int x, char *s, double d, __int64 ll)
{
  int v7; // w0

  if ( s )
    v7 = strlen(s);
  else
    v7 = 0;
  return (unsigned int)(int)((double)(v7 + x) + d + (double)ll);
}


/* Function: func_struct_byval @ 0xB8C */
__int64 __fastcall func_struct_byval(LargeStruct *s)
{
  __int64 v2; // x1
  __int64 result; // x0
  __int64 v4; // x3

  v2 = 0;
  result = 0;
  do
  {
    v4 = s->data[v2++];
    result += v4;
  }
  while ( v2 != 16 );
  return result;
}


/* Function: func_struct_byptr @ 0xBB0 */
int __fastcall func_struct_byptr(SmallStruct *p)
{
  if ( p )
    return p->x * p->y;
  else
    return -1;
}


/* Function: test_calling_conventions @ 0xBC8 */
void __cdecl test_calling_conventions()
{
  unsigned int v0; // w0
  unsigned int v1; // w0
  __int64 i; // x0
  __int64 v3; // x2
  __int64 v4; // x2
  __int64 j; // x1
  __int64 v6; // x3
  LargeStruct large; // [xsp+18h] [xbp+18h]
  LargeStruct v8; // [xsp+98h] [xbp+98h]

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
  v0 = varargs_func(5, 1, 2, 3, 4);
  __printf_chk(1, aCallL206, v0);
  __printf_chk(1, aCallL207, 42);
  __printf_chk(1, aCallL208, 36);
  v1 = func_mixed_args(10, "test", 3.14, 100);
  __printf_chk(1, aCallL209, v1);
  for ( i = 0; i != 16; large.data[v3] = i )
    v3 = i++;
  v4 = 0;
  v8 = large;
  for ( j = 0; j != 16; ++j )
  {
    v6 = v8.data[j];
    v4 += v6;
  }
  __printf_chk(1, aCallL210, v4);
  __printf_chk(1, aCallL211, 50);
}


/* Function: param_by_value_int @ 0xDE4 */
int __fastcall param_by_value_int(int x)
{
  return 2 * x;
}


/* Function: call_by_value_int @ 0xDEC */
__int64 call_by_value_int()
{
  return 15;
}


/* Function: param_by_value_ptr @ 0xDF4 */
int __fastcall param_by_value_ptr(int *p)
{
  *p *= 2;
  return 1;
}


/* Function: call_by_value_ptr @ 0xE08 */
int __cdecl call_by_value_ptr()
{
  return 11;
}


/* Function: param_array_decay @ 0xE10 */
int __fastcall param_array_decay(int *arr, int n)
{
  return 8;
}


/* Function: call_array_decay @ 0xE18 */
int __cdecl call_array_decay()
{
  return 8;
}


/* Function: param_string @ 0xE20 */
int __fastcall param_string(const char *str)
{
  return *(unsigned __int8 *)str + *((unsigned __int8 *)str + 1);
}


/* Function: call_string_param @ 0xE30 */
int __cdecl call_string_param()
{
  return 173;
}


/* Function: param_ptr_array @ 0xE38 */
int __fastcall param_ptr_array(char **arr, int n)
{
  __int64 v3; // x2
  int result; // w0
  char *v5; // x4

  v3 = 0;
  result = 0;
  while ( n > (int)v3 )
  {
    v5 = arr[v3++];
    result += (unsigned __int8)*v5;
  }
  return result;
}


/* Function: call_ptr_array @ 0xE64 */
int __cdecl call_ptr_array()
{
  char *strs[3]; // [xsp+10h] [xbp+10h] BYREF

  strs[0] = (char *)off_13010;
  strs[1] = (char *)off_13018;
  strs[2] = (char *)off_13020;
  return param_ptr_array(strs, 3);
}


/* Function: param_varargs @ 0xECC */
int param_varargs(int count, ...)
{
  gcc_va_list va; // kr00_32
  char *v3; // x3
  int v4; // w4
  int v5; // w1
  int result; // w0
  int v7; // w5
  unsigned __int64 v8; // x2
  int v9; // w1
  __int64 vars0; // [xsp+48h] [xbp+48h]
  __int64 vars8; // [xsp+50h] [xbp+50h]
  __int64 vars10; // [xsp+58h] [xbp+58h]
  __int64 vars18; // [xsp+60h] [xbp+60h]
  __int64 vars20; // [xsp+68h] [xbp+68h]
  __int64 vars28; // [xsp+70h] [xbp+70h]
  char v16; // [xsp+80h] [xbp+80h] BYREF

  va_start(va, count);
  vars0 = va_arg(va, _QWORD);
  vars8 = va_arg(va, _QWORD);
  vars10 = va_arg(va, _QWORD);
  vars18 = va_arg(va, _QWORD);
  vars20 = va_arg(va, _QWORD);
  vars28 = va_arg(va, _QWORD);
  va_end(va);
  v3 = &v16;
  v4 = 0;
  v5 = -56;
  result = 0;
  while ( v4 < count )
  {
    if ( v5 < 0 )
    {
      v7 = v5 + 8;
      if ( v5 + 8 <= 0 )
      {
        v8 = (unsigned __int64)v3;
        v3 = &v16 + v5;
      }
      else
      {
        v8 = (unsigned __int64)(v3 + 11) & 0xFFFFFFFFFFFFFFF8LL;
      }
    }
    else
    {
      v7 = v5;
      v8 = (unsigned __int64)(v3 + 11) & 0xFFFFFFFFFFFFFFF8LL;
    }
    v9 = *(_DWORD *)v3;
    ++v4;
    v3 = (char *)v8;
    result += v9;
    v5 = v7;
  }
  return result;
}


/* Function: call_varargs_param @ 0xFA0 */
int __cdecl call_varargs_param()
{
  return param_varargs(4, 10, 20, 30, 40);
}


/* Function: param_func_ptr @ 0xFB8 */
int __fastcall param_func_ptr(int (*callback)(int), int x)
{
  return ((__int64 (__fastcall *)(_QWORD))callback)((unsigned int)x) + 10;
}


/* Function: call_func_ptr_param @ 0xFD8 */
int __cdecl call_func_ptr_param()
{
  return param_func_ptr((int (*)(int))callback_func, 5);
}


/* Function: param_double_ptr @ 0xFE8 */
int __fastcall param_double_ptr(int **pp, int new_val)
{
  if ( !pp || !*pp )
    return -1;
  **pp = new_val;
  *pp = 0;
  return 1;
}


/* Function: call_double_ptr @ 0x100C */
__int64 call_double_ptr()
{
  return 21;
}


/* Function: param_complex_cast @ 0x1014 */
int __fastcall param_complex_cast(void *p, int type)
{
  if ( !type )
    return *(_DWORD *)p;
  if ( type == 1 )
    return *(_DWORD *)p + *((_DWORD *)p + 1);
  return -1;
}


/* Function: call_complex_cast @ 0x103C */
int __cdecl call_complex_cast()
{
  return 305419896;
}


/* Function: param_struct_byval @ 0x1048 */
__int64 __fastcall param_struct_byval(BigStruct *s)
{
  return (unsigned int)(s->data[0] + s->data[15]);
}


/* Function: call_struct_byval @ 0x1058 */
int __cdecl call_struct_byval()
{
  __int64 i; // x0
  BigStruct s; // [xsp+18h] [xbp+18h]

  for ( i = 0; i != 16; ++i )
    s.data[i] = i;
  return s.data[0] + s.data[15];
}


/* Function: param_order_dep @ 0x10C0 */
__int64 __fastcall param_order_dep(int a1, int a2)
{
  return (unsigned int)(a1 + a2);
}


/* Function: call_order_dep @ 0x10C8 */
int __cdecl call_order_dep()
{
  return 4;
}


/* Function: test_parameter_passing @ 0x10D0 */
void __cdecl test_parameter_passing()
{
  int v0; // w0
  int v1; // w0
  int v2; // w0
  int v3; // w0

  puts(asc_1614);
  __printf_chk(1, "PARAM-L1-01: %d\n", 15);
  __printf_chk(1, "PARAM-L1-02: %d\n", 11);
  __printf_chk(1, "PARAM-L2-01: %d\n", 8);
  __printf_chk(1, "PARAM-L2-02: %d\n", 173);
  v0 = call_ptr_array();
  __printf_chk(1, "PARAM-L2-03: %d\n", v0);
  v1 = call_varargs_param();
  __printf_chk(1, "PARAM-L2-04: %d\n", v1);
  v2 = call_func_ptr_param();
  __printf_chk(1, "PARAM-L3-01: %d\n", v2);
  __printf_chk(1, "PARAM-L3-02: %d\n", 21);
  __printf_chk(1, "PARAM-L3-03: %d\n", 305419896);
  v3 = call_struct_byval();
  __printf_chk(1, "PARAM-L3-04: %d\n", v3);
  __printf_chk(1, "PARAM-L3-05: %d\n", 4);
}


/* Function: ret_basic_type @ 0x11D8 */
__int64 __fastcall ret_basic_type(int a1)
{
  return (unsigned int)(2 * a1);
}


/* Function: call_ret_basic @ 0x11E0 */
int __cdecl call_ret_basic()
{
  return 42;
}


/* Function: ret_pointer @ 0x11E8 */
int *__fastcall ret_pointer(int *p)
{
  return p + 1;
}


/* Function: call_ret_pointer @ 0x11F0 */
int __cdecl call_ret_pointer()
{
  return 20;
}


/* Function: ret_small_struct @ 0x11F8 */
// local variable allocation has failed, the output may be wrong!
SmallPoint __fastcall ret_small_struct(int x, int y)
{
  return (SmallPoint)((unsigned int)x | (*(_QWORD *)&y << 32));
}


/* Function: call_ret_small_struct @ 0x1204 */
int __cdecl call_ret_small_struct()
{
  return 7;
}


/* Function: ret_large_struct @ 0x120C */
long double __usercall ret_large_struct@<Q0>(int a1@<W0>, _OWORD *a2@<X8>)
{
  __int64 i; // x2
  __int128 v3; // q1
  long double result; // q0
  __int128 v5; // q1
  LargeData d; // [xsp+18h] [xbp+18h]

  for ( i = 0; i != 16; ++i )
    d.data[i] = a1 + i;
  v3 = *(_OWORD *)&d.data[4];
  *a2 = *(_OWORD *)d.data;
  a2[1] = v3;
  result = *(long double *)&d.data[8];
  v5 = *(_OWORD *)&d.data[12];
  a2[2] = *(_OWORD *)&d.data[8];
  a2[3] = v5;
  return result;
}


/* Function: call_ret_large_struct @ 0x1278 */
int __cdecl call_ret_large_struct()
{
  LargeData d; // [xsp+18h] [xbp+18h] BYREF

  ret_large_struct(100, &d);
  return d.data[0] + d.data[15];
}


/* Function: ret_func_ptr @ 0x12D4 */
func_ptr_t __fastcall ret_func_ptr(int selector)
{
  bool v1; // zf
  func_ptr_t result; // x0

  v1 = selector == 0;
  result = (func_ptr_t)func_b;
  if ( v1 )
    return func_a;
  return result;
}


/* Function: call_ret_func_ptr @ 0x12F0 */
int __cdecl call_ret_func_ptr()
{
  return 10;
}


/* Function: ret_opaque_handle @ 0x12F8 */
void *__fastcall ret_opaque_handle(int type)
{
  if ( type )
    return &handle2_0;
  else
    return &handle1_1;
}


/* Function: call_ret_opaque @ 0x1314 */
int __cdecl call_ret_opaque()
{
  return handle1_1;
}


/* Function: ret_complex_expr @ 0x1320 */
int __fastcall ret_complex_expr(int x, int y, int z)
{
  int v3; // w3
  int v4; // w2

  v3 = 2 * z;
  v4 = z + 10;
  if ( x > y )
    return v3;
  else
    return v4;
}


/* Function: call_ret_complex_expr @ 0x1334 */
int __cdecl call_ret_complex_expr()
{
  return 40;
}


/* Function: ret_multi_branch @ 0x133C */
int __fastcall ret_multi_branch(int op)
{
  if ( (unsigned int)op >= 3 )
    return -1;
  else
    return 10 * op + 10;
}


/* Function: call_ret_multi_branch @ 0x1350 */
int __cdecl call_ret_multi_branch()
{
  return 60;
}


/* Function: ret_void @ 0x1358 */
void __fastcall ret_void(int x, int *out)
{
  *out = 3 * x;
}


/* Function: call_ret_void @ 0x1364 */
__int64 call_ret_void()
{
  return 21;
}


/* Function: test_return_values @ 0x136C */
void __cdecl test_return_values()
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
  __printf_chk(1, aRetL303D, 21);
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
