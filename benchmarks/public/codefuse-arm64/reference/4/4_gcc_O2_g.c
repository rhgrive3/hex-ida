/*
 * Decompiled by IDA Pro 9.1 with Hex-Rays
 * Binary: /Users/eren/Desktop/Antigravity/compiler/build/arm64/4/4_gcc_O2_g
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
  test_calling_conventions();
  test_parameter_passing();
  test_return_values();
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
int __fastcall func_a(int x)
{
  return x + 10;
}


/* Function: func_b @ 0x930 */
__int64 __fastcall func_b(int a1)
{
  return (unsigned int)(2 * a1);
}


/* Function: cdecl_func @ 0x940 */
int __fastcall cdecl_func(int a, int b)
{
  return a + b;
}


/* Function: call_cdecl @ 0x950 */
int __cdecl call_cdecl()
{
  return 15;
}


/* Function: stdcall_func @ 0x960 */
int __fastcall stdcall_func(int a, int b)
{
  return a * b;
}


/* Function: call_stdcall @ 0x970 */
int __cdecl call_stdcall()
{
  return 50;
}


/* Function: fastcall_func @ 0x980 */
int __fastcall fastcall_func(int a, int b, int c)
{
  return a + b + c;
}


/* Function: call_fastcall @ 0x990 */
int __cdecl call_fastcall()
{
  return 6;
}


/* Function: call_thiscall @ 0x9A0 */
__int64 call_thiscall()
{
  return 15;
}


/* Function: arm_aapcs_func @ 0x9B0 */
int __fastcall arm_aapcs_func(int a, int b, int c, int d, int e)
{
  return a + b + c + d + e;
}


/* Function: call_arm_aapcs @ 0x9C4 */
__int64 call_arm_aapcs()
{
  return 15;
}


/* Function: mips_func @ 0x9D0 */
int __fastcall mips_func(int a, int b, int c, int d)
{
  return a + b + c + d;
}


/* Function: call_mips @ 0x9E0 */
int __cdecl call_mips()
{
  return 100;
}


/* Function: amd64_sysv_func @ 0x9F0 */
int __fastcall amd64_sysv_func(int a, int b, int c, int d, int e, int f)
{
  return a + b + c + d + e + f;
}


/* Function: call_amd64_sysv @ 0xA10 */
int __cdecl call_amd64_sysv()
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
int __cdecl call_vectorcall()
{
  return 10;
}


/* Function: mixed_conventions_test @ 0xA60 */
int __cdecl mixed_conventions_test()
{
  return 33;
}


/* Function: varargs_func @ 0xA70 */
int varargs_func(int count, ...)
{
  gcc_va_list va; // kr00_32
  int v3; // w3
  char *v4; // x2
  int result; // w0
  int v6; // w1
  char *v7; // x4
  __int64 vars0; // [xsp+48h] [xbp+48h]
  __int64 vars8; // [xsp+50h] [xbp+50h]
  __int64 vars10; // [xsp+58h] [xbp+58h]
  __int64 vars18; // [xsp+60h] [xbp+60h]
  __int64 vars20; // [xsp+68h] [xbp+68h]
  __int64 vars28; // [xsp+70h] [xbp+70h]
  char v14; // [xsp+80h] [xbp+80h] BYREF

  va_start(va, count);
  vars0 = va_arg(va, _QWORD);
  vars8 = va_arg(va, _QWORD);
  vars10 = va_arg(va, _QWORD);
  vars18 = va_arg(va, _QWORD);
  vars20 = va_arg(va, _QWORD);
  vars28 = va_arg(va, _QWORD);
  va_end(va);
  v3 = -56;
  if ( count > 0 )
  {
    v4 = &v14;
    result = 0;
    v6 = 0;
    while ( 1 )
    {
      if ( v3 < 0 )
      {
        if ( v3 + 8 <= 0 )
        {
          v7 = &v14 + v3;
          v3 += 8;
          goto LABEL_5;
        }
        v3 += 8;
      }
      v7 = v4;
      v4 += 8;
LABEL_5:
      ++v6;
      result += *(_DWORD *)v7;
      if ( count == v6 )
        return result;
    }
  }
  return 0;
}


/* Function: func_no_args @ 0xB40 */
int __cdecl func_no_args()
{
  return 42;
}


/* Function: func_many_args @ 0xB50 */
int __fastcall func_many_args(int a, int b, int c, int d, int e, int f, int g, int h)
{
  return a + b + c + d + e + f + g + h;
}


/* Function: func_mixed_args @ 0xB70 */
__int64 __fastcall func_mixed_args(int x, char *s, double d, __int64 ll)
{
  int v4; // w19

  v4 = x;
  if ( s )
    v4 = x + strlen(s);
  return (unsigned int)(int)((double)v4 + d + (double)ll);
}


/* Function: func_struct_byval @ 0xBC0 */
__int64 __fastcall func_struct_byval(LargeStruct *s)
{
  LargeStruct *v1; // x1
  unsigned int v2; // w2
  __int64 v3; // t1

  v1 = s;
  v2 = 0;
  do
  {
    v3 = v1->data[0];
    v1 = (LargeStruct *)((char *)v1 + 8);
    v2 += v3;
  }
  while ( v1 != &s[1] );
  return v2;
}


/* Function: func_struct_byptr @ 0xBF0 */
int __fastcall func_struct_byptr(SmallStruct *p)
{
  if ( p )
    return p->x * p->y;
  else
    return -1;
}


/* Function: test_calling_conventions @ 0xC10 */
void __cdecl test_calling_conventions()
{
  unsigned int v0; // w0
  __int64 i; // x0
  LargeStruct *v2; // x0
  __int64 v3; // x2
  __int64 v4; // t1
  LargeStruct large; // [xsp+18h] [xbp+18h] BYREF
  LargeStruct v6; // [xsp+98h] [xbp+98h] BYREF
  __int64 v7; // [xsp+118h] [xbp+118h] BYREF

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
  v0 = varargs_func(5, 1, 2, 3, 4);
  __printf_chk(1, aCallL206, v0);
  __printf_chk(1, aCallL207, 42);
  __printf_chk(1, aCallL208, 36);
  __printf_chk(1, aCallL209, 117);
  for ( i = 1; i != 17; ++i )
    large.data[i - 1] = i;
  v6 = large;
  v2 = &v6;
  v3 = 0;
  do
  {
    v4 = v2->data[0];
    v2 = (LargeStruct *)((char *)v2 + 8);
    v3 += v4;
  }
  while ( &v7 != (__int64 *)v2 );
  __printf_chk(1, aCallL210, v3, &large, &v7);
  __printf_chk(1, aCallL211, 50);
}


/* Function: param_by_value_int @ 0xE20 */
int __fastcall param_by_value_int(int x)
{
  return 2 * x;
}


/* Function: call_by_value_int @ 0xE30 */
__int64 call_by_value_int()
{
  return 15;
}


/* Function: param_by_value_ptr @ 0xE40 */
int __fastcall param_by_value_ptr(int *p)
{
  int result; // w0

  result = 1;
  *p *= 2;
  return result;
}


/* Function: call_by_value_ptr @ 0xE60 */
int __cdecl call_by_value_ptr()
{
  return 11;
}


/* Function: param_array_decay @ 0xE70 */
int __fastcall param_array_decay(int *arr, int n)
{
  return 8;
}


/* Function: call_array_decay @ 0xE80 */
int __cdecl call_array_decay()
{
  return 8;
}


/* Function: param_string @ 0xE90 */
int __fastcall param_string(const char *str)
{
  return *(unsigned __int8 *)str + *((unsigned __int8 *)str + 1);
}


/* Function: call_string_param @ 0xEA0 */
int __cdecl call_string_param()
{
  return 173;
}


/* Function: param_ptr_array @ 0xEB0 */
int __fastcall param_ptr_array(char **arr, int n)
{
  __int64 v3; // x2
  int result; // w0
  char *v5; // x3

  if ( n <= 0 )
    return 0;
  v3 = 0;
  result = 0;
  do
  {
    v5 = arr[v3++];
    result += (unsigned __int8)*v5;
  }
  while ( n > (int)v3 );
  return result;
}


/* Function: call_ptr_array @ 0xEF0 */
int __cdecl call_ptr_array()
{
  return 300;
}


/* Function: param_varargs @ 0xF00 */
int param_varargs(int count, ...)
{
  gcc_va_list va; // kr00_32
  int v3; // w3
  char *v4; // x2
  int result; // w0
  int v6; // w1
  char *v7; // x4
  __int64 vars0; // [xsp+48h] [xbp+48h]
  __int64 vars8; // [xsp+50h] [xbp+50h]
  __int64 vars10; // [xsp+58h] [xbp+58h]
  __int64 vars18; // [xsp+60h] [xbp+60h]
  __int64 vars20; // [xsp+68h] [xbp+68h]
  __int64 vars28; // [xsp+70h] [xbp+70h]
  char v14; // [xsp+80h] [xbp+80h] BYREF

  va_start(va, count);
  vars0 = va_arg(va, _QWORD);
  vars8 = va_arg(va, _QWORD);
  vars10 = va_arg(va, _QWORD);
  vars18 = va_arg(va, _QWORD);
  vars20 = va_arg(va, _QWORD);
  vars28 = va_arg(va, _QWORD);
  va_end(va);
  v3 = -56;
  if ( count > 0 )
  {
    v4 = &v14;
    result = 0;
    v6 = 0;
    while ( 1 )
    {
      if ( v3 < 0 )
      {
        if ( v3 + 8 <= 0 )
        {
          v7 = &v14 + v3;
          v3 += 8;
          goto LABEL_5;
        }
        v3 += 8;
      }
      v7 = v4;
      v4 += 8;
LABEL_5:
      ++v6;
      result += *(_DWORD *)v7;
      if ( count == v6 )
        return result;
    }
  }
  return 0;
}


/* Function: call_varargs_param @ 0xFD0 */
int __cdecl call_varargs_param()
{
  return param_varargs(4, 10, 20, 30, 40);
}


/* Function: param_func_ptr @ 0xFF0 */
int __fastcall param_func_ptr(int (*callback)(int), int x)
{
  return ((__int64 (__fastcall *)(_QWORD))callback)((unsigned int)x) + 10;
}


/* Function: call_func_ptr_param @ 0x1010 */
int __cdecl call_func_ptr_param()
{
  return 20;
}


/* Function: param_double_ptr @ 0x1020 */
int __fastcall param_double_ptr(int **pp, int new_val)
{
  int *v3; // x0
  int result; // w0

  if ( !pp )
    return -1;
  v3 = *pp;
  if ( !v3 )
    return -1;
  *v3 = new_val;
  result = 1;
  *pp = 0;
  return result;
}


/* Function: call_double_ptr @ 0x1050 */
__int64 call_double_ptr()
{
  return 21;
}


/* Function: param_complex_cast @ 0x1060 */
int __fastcall param_complex_cast(void *p, int type)
{
  if ( !type )
    return *(_DWORD *)p;
  if ( type == 1 )
    return *(_DWORD *)p + *((_DWORD *)p + 1);
  return -1;
}


/* Function: call_complex_cast @ 0x1090 */
int __cdecl call_complex_cast()
{
  return 305419896;
}


/* Function: param_struct_byval @ 0x10A0 */
__int64 __fastcall param_struct_byval(BigStruct *s)
{
  return (unsigned int)(s->data[0] + s->data[15]);
}


/* Function: call_struct_byval @ 0x10B0 */
int __cdecl call_struct_byval()
{
  int v0; // w0
  BigStruct *p_s; // x1
  BigStruct s; // [xsp+18h] [xbp+18h] BYREF

  v0 = 0;
  p_s = &s;
  do
  {
    p_s->data[0] = v0;
    p_s = (BigStruct *)((char *)p_s + 4);
    ++v0;
  }
  while ( v0 != 16 );
  return s.data[0] + s.data[15];
}


/* Function: param_order_dep @ 0x1120 */
__int64 __fastcall param_order_dep(int a1, int a2)
{
  return (unsigned int)(a1 + a2);
}


/* Function: call_order_dep @ 0x1130 */
int __cdecl call_order_dep()
{
  return 4;
}


/* Function: test_parameter_passing @ 0x1140 */
void __cdecl test_parameter_passing()
{
  int v0; // w0
  _DWORD *v1; // x1
  int i; // w0
  _DWORD v3[16]; // [xsp+18h] [xbp+18h] BYREF

  puts(asc_1778);
  __printf_chk(1, "PARAM-L1-01: %d\n", 15);
  __printf_chk(1, "PARAM-L1-02: %d\n", 11);
  __printf_chk(1, "PARAM-L2-01: %d\n", 8);
  __printf_chk(1, "PARAM-L2-02: %d\n", 173);
  __printf_chk(1, "PARAM-L2-03: %d\n", 300);
  v0 = param_varargs(4, 10, 20, 30, 40);
  __printf_chk(1, "PARAM-L2-04: %d\n", v0);
  __printf_chk(1, "PARAM-L3-01: %d\n", 20);
  __printf_chk(1, "PARAM-L3-02: %d\n", 21);
  __printf_chk(1, "PARAM-L3-03: %d\n", 305419896);
  v1 = v3;
  for ( i = 0; i != 16; ++i )
    *v1++ = i;
  __printf_chk(1, "PARAM-L3-04: %d\n", v3[0] + v3[15]);
  __printf_chk(1, "PARAM-L3-05: %d\n", 4);
}


/* Function: ret_basic_type @ 0x12A4 */
__int64 __fastcall ret_basic_type(int a1)
{
  return (unsigned int)(2 * a1);
}


/* Function: call_ret_basic @ 0x12B0 */
int __cdecl call_ret_basic()
{
  return 42;
}


/* Function: ret_pointer @ 0x12C0 */
int *__fastcall ret_pointer(int *p)
{
  return p + 1;
}


/* Function: call_ret_pointer @ 0x12D0 */
int __cdecl call_ret_pointer()
{
  return 20;
}


/* Function: ret_small_struct @ 0x12E0 */
// local variable allocation has failed, the output may be wrong!
SmallPoint __fastcall ret_small_struct(int x, int y)
{
  return (SmallPoint)((unsigned int)x | (*(_QWORD *)&y << 32));
}


/* Function: call_ret_small_struct @ 0x12F0 */
int __cdecl call_ret_small_struct()
{
  return 7;
}


/* Function: ret_large_struct @ 0x1300 */
void *__usercall ret_large_struct@<X0>(int a1@<W0>, _OWORD *a2@<X8>)
{
  int v2; // w0
  __int64 i; // x1
  int *v4; // x2
  int v5; // w3
  __int128 v6; // q3
  __int128 v7; // q0
  __int128 v8; // q1
  void *result; // x0
  LargeData d; // [xsp+18h] [xbp+18h] BYREF

  v2 = a1 - 1;
  for ( i = 1; i != 17; ++i )
  {
    v4 = &d.data[i];
    v5 = v2 + i;
    *(v4 - 1) = v5;
  }
  v6 = *(_OWORD *)&d.data[4];
  v7 = *(_OWORD *)&d.data[8];
  v8 = *(_OWORD *)&d.data[12];
  result = &_stack_chk_guard;
  *a2 = *(_OWORD *)d.data;
  a2[1] = v6;
  a2[2] = v7;
  a2[3] = v8;
  return result;
}


/* Function: call_ret_large_struct @ 0x1380 */
int __cdecl call_ret_large_struct()
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
  return v4[15] + v4[0];
}


/* Function: ret_func_ptr @ 0x13F4 */
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


/* Function: call_ret_func_ptr @ 0x1410 */
int __cdecl call_ret_func_ptr()
{
  return 10;
}


/* Function: ret_opaque_handle @ 0x1420 */
void *__fastcall ret_opaque_handle(int type)
{
  bool v1; // zf
  void *result; // x0

  v1 = type == 0;
  result = &handle2_0;
  if ( v1 )
    return &handle1_1;
  return result;
}


/* Function: call_ret_opaque @ 0x1440 */
int __cdecl call_ret_opaque()
{
  return handle1_1;
}


/* Function: ret_complex_expr @ 0x1450 */
int __fastcall ret_complex_expr(int x, int y, int z)
{
  bool v3; // cc
  int result; // w0
  int v5; // w2

  v3 = x <= y;
  result = z + 10;
  v5 = 2 * z;
  if ( !v3 )
    return v5;
  return result;
}


/* Function: call_ret_complex_expr @ 0x1464 */
int __cdecl call_ret_complex_expr()
{
  return 40;
}


/* Function: ret_multi_branch @ 0x1470 */
int __fastcall ret_multi_branch(int op)
{
  bool v1; // cf
  int result; // w0

  v1 = (unsigned int)op >= 3;
  result = 10 * (op + 1);
  if ( v1 )
    return -1;
  return result;
}


/* Function: call_ret_multi_branch @ 0x1490 */
int __cdecl call_ret_multi_branch()
{
  return 60;
}


/* Function: ret_void @ 0x14A0 */
void __fastcall ret_void(int x, int *out)
{
  *out = 3 * x;
}


/* Function: call_ret_void @ 0x14B0 */
__int64 call_ret_void()
{
  return 21;
}


/* Function: test_return_values @ 0x14C0 */
void __cdecl test_return_values()
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
  __printf_chk(1, aRetL303D, 21);
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
