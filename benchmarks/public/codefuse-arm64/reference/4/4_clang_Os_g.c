/*
 * Decompiled by IDA Pro 9.1 with Hex-Rays
 * Binary: /Users/eren/Desktop/Antigravity/compiler/build/arm64/4/4_clang_Os_g
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
int __fastcall cdecl_func(int a, int b)
{
  return b + a;
}


/* Function: call_cdecl @ 0x85C */
int __cdecl call_cdecl()
{
  return 15;
}


/* Function: stdcall_func @ 0x864 */
int __fastcall stdcall_func(int a, int b)
{
  return b * a;
}


/* Function: call_stdcall @ 0x86C */
int __cdecl call_stdcall()
{
  return 50;
}


/* Function: fastcall_func @ 0x874 */
int __fastcall fastcall_func(int a, int b, int c)
{
  return b + a + c;
}


/* Function: call_fastcall @ 0x880 */
int __cdecl call_fastcall()
{
  return 6;
}


/* Function: call_thiscall @ 0x888 */
int __cdecl call_thiscall()
{
  return 15;
}


/* Function: arm_aapcs_func @ 0x890 */
int __fastcall arm_aapcs_func(int a, int b, int c, int d, int e)
{
  return b + a + c + d + e;
}


/* Function: call_arm_aapcs @ 0x8A4 */
int __cdecl call_arm_aapcs()
{
  return 15;
}


/* Function: mips_func @ 0x8AC */
int __fastcall mips_func(int a, int b, int c, int d)
{
  return b + a + c + d;
}


/* Function: call_mips @ 0x8BC */
int __cdecl call_mips()
{
  return 100;
}


/* Function: amd64_sysv_func @ 0x8C4 */
int __fastcall amd64_sysv_func(int a, int b, int c, int d, int e, int f)
{
  return b + a + c + d + e + f;
}


/* Function: call_amd64_sysv @ 0x8DC */
int __cdecl call_amd64_sysv()
{
  return 21;
}


/* Function: ms_x64_func @ 0x8E4 */
int __fastcall ms_x64_func(int a, int b, int c, int d, int e)
{
  return b + a + c + d + e;
}


/* Function: call_ms_x64 @ 0x8F8 */
int __cdecl call_ms_x64()
{
  return 15;
}


/* Function: vectorcall_func @ 0x900 */
int __fastcall vectorcall_func(int a, int b, int c, int d)
{
  return b + a + c + d;
}


/* Function: call_vectorcall @ 0x910 */
int __cdecl call_vectorcall()
{
  return 10;
}


/* Function: mixed_conventions_test @ 0x918 */
int __cdecl mixed_conventions_test()
{
  return 33;
}


/* Function: varargs_func @ 0x920 */
int varargs_func(int count, ...)
{
  gcc_va_list va; // kr00_32
  int v2; // w8
  unsigned int v3; // w11
  unsigned int v4; // w10
  _DWORD *v5; // x11
  _QWORD v7[8]; // [xsp+80h] [xbp-60h] BYREF
  _DWORD *v8; // [xsp+C0h] [xbp-20h] BYREF
  _QWORD *v9; // [xsp+C8h] [xbp-18h]
  _QWORD *v10; // [xsp+D0h] [xbp-10h]
  unsigned __int64 v11; // [xsp+D8h] [xbp-8h]

  va_start(va, count);
  v7[1] = va_arg(va, _QWORD);
  v7[2] = va_arg(va, _QWORD);
  v7[3] = va_arg(va, _QWORD);
  v7[4] = va_arg(va, _QWORD);
  v7[5] = va_arg(va, _QWORD);
  v7[6] = va_arg(va, _QWORD);
  v7[7] = va_arg(va, _QWORD);
  va_end(va);
  v10 = v7;
  v11 = 0xFFFFFF80FFFFFFC8LL;
  v2 = 0;
  v9 = &v8;
  if ( count >= 1 )
  {
    v3 = v11;
    while ( (v3 & 0x80000000) != 0 )
    {
      v4 = v3 + 8;
      LODWORD(v11) = v3 + 8;
      if ( v3 > 0xFFFFFFF8 )
        goto LABEL_7;
      v5 = (_DWORD *)((char *)v9 + (int)v3);
LABEL_8:
      --count;
      v2 += *v5;
      v3 = v4;
      if ( !count )
        return v2;
    }
    v4 = v3;
LABEL_7:
    v5 = v8;
    v8 += 2;
    goto LABEL_8;
  }
  return v2;
}


/* Function: func_no_args @ 0x9CC */
int __cdecl func_no_args()
{
  return 42;
}


/* Function: func_many_args @ 0x9D4 */
int __fastcall func_many_args(int a, int b, int c, int d, int e, int f, int g, int h)
{
  return b + a + c + d + e + f + g + h;
}


/* Function: func_mixed_args @ 0x9F4 */
__int64 __fastcall func_mixed_args(int x, char *s, double d, __int64 ll)
{
  int v7; // w0

  if ( s )
    v7 = strlen(s);
  else
    v7 = 0;
  return (unsigned int)(int)((double)(v7 + x) + d + (double)ll);
}


/* Function: func_struct_byval @ 0xA4C */
__int64 __fastcall func_struct_byval(LargeStruct *s)
{
  int64x2_t v1; // q0
  __int64 i; // x8
  int64x2_t v3; // q1

  v1 = 0u;
  for ( i = 0; i != 16; i += 2 )
  {
    v3 = *(int64x2_t *)&s->data[i];
    v1 = vaddq_s64(v3, v1);
  }
  return vaddvq_s64(v1);
}


/* Function: func_struct_byptr @ 0xA74 */
int __fastcall func_struct_byptr(SmallStruct *p)
{
  if ( p )
    return p->y * p->x;
  else
    return -1;
}


/* Function: test_calling_conventions @ 0xA8C */
void __cdecl test_calling_conventions()
{
  unsigned int v0; // w0
  __int64 v1; // x8
  int64x2_t v2; // q0
  int64x2_t v3; // q1
  int64x2_t v4; // q0
  __int64 i; // x8
  int64x2_t v6; // q1
  _BYTE v7[128]; // [xsp+0h] [xbp-100h] BYREF
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
  v0 = varargs_func(5, 1, 2, 3, 4, 5);
  printf(aCallL206, v0);
  printf(aCallL207, 42);
  printf(aCallL208, 36);
  printf(aCallL209, 117);
  v1 = 0;
  v2 = (int64x2_t)xmmword_11E0;
  do
  {
    v3 = vaddq_s64(v2, vdupq_n_s64(1u));
    v2 = vaddq_s64(v2, vdupq_n_s64(2u));
    *(int64x2_t *)&src[v1] = v3;
    v1 += 16;
  }
  while ( v1 != 128 );
  memcpy(v7, src, sizeof(v7));
  v4 = 0u;
  for ( i = 0; i != 128; i += 16 )
  {
    v6 = *(int64x2_t *)&v7[i];
    v4 = vaddq_s64(v6, v4);
  }
  printf(aCallL210, vaddvq_s64(v4));
  printf(aCallL211, 50);
}


/* Function: param_by_value_int @ 0xC44 */
int __fastcall param_by_value_int(int x)
{
  return 2 * x;
}


/* Function: call_by_value_int @ 0xC4C */
int __cdecl call_by_value_int()
{
  return 15;
}


/* Function: param_by_value_ptr @ 0xC54 */
int __fastcall param_by_value_ptr(int *p)
{
  int result; // w0

  result = 1;
  *p *= 2;
  return result;
}


/* Function: call_by_value_ptr @ 0xC6C */
int __cdecl call_by_value_ptr()
{
  return 11;
}


/* Function: param_array_decay @ 0xC74 */
__int64 __fastcall param_array_decay(int *arr, int n)
{
  return 8;
}


/* Function: call_array_decay @ 0xC7C */
int __cdecl call_array_decay()
{
  return 8;
}


/* Function: param_string @ 0xC84 */
int __fastcall param_string(const char *str)
{
  return *((unsigned __int8 *)str + 1) + *(unsigned __int8 *)str;
}


/* Function: call_string_param @ 0xC94 */
int __cdecl call_string_param()
{
  return 173;
}


/* Function: param_ptr_array @ 0xC9C */
int __fastcall param_ptr_array(char **arr, int n)
{
  int result; // w0
  __int64 v4; // x9
  unsigned __int8 *v5; // t1

  if ( n < 1 )
    return 0;
  result = 0;
  v4 = (unsigned int)n;
  do
  {
    v5 = (unsigned __int8 *)*arr++;
    --v4;
    result += *v5;
  }
  while ( v4 );
  return result;
}


/* Function: call_ptr_array @ 0xCD0 */
int __cdecl call_ptr_array()
{
  return 300;
}


/* Function: param_varargs @ 0xCD8 */
int param_varargs(int count, ...)
{
  gcc_va_list va; // kr00_32
  int v2; // w8
  unsigned int v3; // w11
  unsigned int v4; // w10
  _DWORD *v5; // x11
  _QWORD v7[8]; // [xsp+80h] [xbp-60h] BYREF
  _DWORD *v8; // [xsp+C0h] [xbp-20h] BYREF
  _QWORD *v9; // [xsp+C8h] [xbp-18h]
  _QWORD *v10; // [xsp+D0h] [xbp-10h]
  unsigned __int64 v11; // [xsp+D8h] [xbp-8h]

  va_start(va, count);
  v7[1] = va_arg(va, _QWORD);
  v7[2] = va_arg(va, _QWORD);
  v7[3] = va_arg(va, _QWORD);
  v7[4] = va_arg(va, _QWORD);
  v7[5] = va_arg(va, _QWORD);
  v7[6] = va_arg(va, _QWORD);
  v7[7] = va_arg(va, _QWORD);
  va_end(va);
  v10 = v7;
  v11 = 0xFFFFFF80FFFFFFC8LL;
  v2 = 0;
  v9 = &v8;
  if ( count >= 1 )
  {
    v3 = v11;
    while ( (v3 & 0x80000000) != 0 )
    {
      v4 = v3 + 8;
      LODWORD(v11) = v3 + 8;
      if ( v3 > 0xFFFFFFF8 )
        goto LABEL_7;
      v5 = (_DWORD *)((char *)v9 + (int)v3);
LABEL_8:
      --count;
      v2 += *v5;
      v3 = v4;
      if ( !count )
        return v2;
    }
    v4 = v3;
LABEL_7:
    v5 = v8;
    v8 += 2;
    goto LABEL_8;
  }
  return v2;
}


/* Function: call_varargs_param @ 0xD84 */
int __cdecl call_varargs_param()
{
  return param_varargs(4, 10, 20, 30, 40);
}


/* Function: param_func_ptr @ 0xD9C */
int __fastcall param_func_ptr(int (*callback)(int), int x)
{
  return ((__int64 (__fastcall *)(_QWORD))callback)((unsigned int)x) + 10;
}


/* Function: call_func_ptr_param @ 0xDBC */
int __cdecl call_func_ptr_param()
{
  return 20;
}


/* Function: param_double_ptr @ 0xDC4 */
int __fastcall param_double_ptr(int **pp, int new_val)
{
  int *v3; // x9
  int result; // w0

  if ( !pp )
    return -1;
  v3 = *pp;
  if ( !*pp )
    return -1;
  result = 1;
  *v3 = new_val;
  *pp = 0;
  return result;
}


/* Function: call_double_ptr @ 0xDEC */
int __cdecl call_double_ptr()
{
  return 21;
}


/* Function: param_complex_cast @ 0xDF4 */
int __fastcall param_complex_cast(void *p, int type)
{
  if ( type == 1 )
    return *((_DWORD *)p + 1) + *(_DWORD *)p;
  if ( type )
    return -1;
  return *(_DWORD *)p;
}


/* Function: call_complex_cast @ 0xE1C */
int __cdecl call_complex_cast()
{
  return 305419896;
}


/* Function: param_struct_byval @ 0xE28 */
__int64 __fastcall param_struct_byval(BigStruct *s)
{
  return (unsigned int)(s->data[15] + s->data[0]);
}


/* Function: call_struct_byval @ 0xE38 */
int __cdecl call_struct_byval()
{
  int v1; // [xsp+0h] [xbp-40h]

  return v1 + 15;
}


/* Function: param_order_dep @ 0xE64 */
int __fastcall param_order_dep(int a, int b)
{
  return b + a;
}


/* Function: call_order_dep @ 0xE6C */
int __cdecl call_order_dep()
{
  return 3;
}


/* Function: test_parameter_passing @ 0xE74 */
void __cdecl test_parameter_passing()
{
  int v0; // w0

  puts(asc_159B);
  printf("PARAM-L1-01: %d\n", 15);
  printf("PARAM-L1-02: %d\n", 11);
  printf("PARAM-L2-01: %d\n", 8);
  printf("PARAM-L2-02: %d\n", 173);
  printf("PARAM-L2-03: %d\n", 300);
  v0 = param_varargs(4, 10, 20, 30, 40);
  printf("PARAM-L2-04: %d\n", v0);
  printf("PARAM-L3-01: %d\n", 20);
  printf("PARAM-L3-02: %d\n", 21);
  printf("PARAM-L3-03: %d\n", 305419896);
  printf("PARAM-L3-04: %d\n", 15);
  printf("PARAM-L3-05: %d\n", 3);
}


/* Function: ret_basic_type @ 0xF80 */
int __fastcall ret_basic_type(int x)
{
  return 2 * x;
}


/* Function: call_ret_basic @ 0xF88 */
int __cdecl call_ret_basic()
{
  return 42;
}


/* Function: ret_pointer @ 0xF90 */
int *__fastcall ret_pointer(int *p)
{
  return p + 1;
}


/* Function: call_ret_pointer @ 0xF98 */
int __cdecl call_ret_pointer()
{
  return 20;
}


/* Function: ret_small_struct @ 0xFA0 */
SmallPoint __fastcall ret_small_struct(int x, int y)
{
  return (SmallPoint)((unsigned int)x | ((unsigned __int64)(unsigned int)y << 32));
}


/* Function: call_ret_small_struct @ 0xFAC */
int __cdecl call_ret_small_struct()
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
int __cdecl call_ret_large_struct()
{
  int v1; // [xsp+0h] [xbp-40h]

  return v1 + 115;
}


/* Function: func_a @ 0x1010 */
int __fastcall func_a(int x)
{
  return x + 10;
}


/* Function: func_b @ 0x1018 */
int __fastcall func_b(int x)
{
  return 2 * x;
}


/* Function: ret_func_ptr @ 0x1020 */
func_ptr_t __fastcall ret_func_ptr(int selector)
{
  if ( selector )
    return func_b;
  else
    return func_a;
}


/* Function: call_ret_func_ptr @ 0x103C */
int __cdecl call_ret_func_ptr()
{
  return 10;
}


/* Function: ret_opaque_handle @ 0x1044 */
void *__fastcall ret_opaque_handle(int type)
{
  if ( type )
    return &ret_opaque_handle_handle2;
  else
    return &ret_opaque_handle_handle1;
}


/* Function: call_ret_opaque @ 0x1060 */
int __cdecl call_ret_opaque()
{
  return ret_opaque_handle_handle1;
}


/* Function: ret_complex_expr @ 0x106C */
int __fastcall ret_complex_expr(int x, int y, int z)
{
  if ( x <= y )
    return z + 10;
  else
    return 2 * z;
}


/* Function: call_ret_complex_expr @ 0x1080 */
int __cdecl call_ret_complex_expr()
{
  return 40;
}


/* Function: ret_multi_branch @ 0x1088 */
int __fastcall ret_multi_branch(int op)
{
  if ( (unsigned int)op >= 3 )
    return -1;
  else
    return 10 * op + 10;
}


/* Function: call_ret_multi_branch @ 0x10A0 */
int __cdecl call_ret_multi_branch()
{
  return 60;
}


/* Function: ret_void @ 0x10A8 */
void __fastcall ret_void(int x, int *out)
{
  *out = 3 * x;
}


/* Function: call_ret_void @ 0x10B4 */
int __cdecl call_ret_void()
{
  return 21;
}


/* Function: test_return_values @ 0x10BC */
void __cdecl test_return_values()
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
  printf(aRetL303D, 21);
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
