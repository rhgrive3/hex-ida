/*
 * Decompiled by IDA Pro 9.1 with Hex-Rays
 * Binary: /Users/eren/Desktop/Antigravity/compiler/build/arm64/2/2_clang_O0_no_g
 * Processor: arm
 */

/* Function: .init_proc @ 0x660 */
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


/* Function: process_char @ 0x854 */
__int64 __fastcall process_char(unsigned __int8 a1)
{
  if ( a1 < 0x41u || a1 > 0x5Au )
    return a1;
  else
    return (unsigned __int8)(a1 + 32);
}


/* Function: process_short @ 0x8A4 */
__int64 __fastcall process_short(__int16 a1, __int16 a2)
{
  return (unsigned int)(a1 + a2);
}


/* Function: process_int @ 0x8C4 */
__int64 __fastcall process_int(int a1)
{
  return (unsigned int)(2 * a1 + 1);
}


/* Function: process_long @ 0x8E0 */
__int64 __fastcall process_long(__int64 a1)
{
  return 2 * a1;
}


/* Function: process_ll @ 0x8F8 */
__int64 __fastcall process_ll(__int64 a1)
{
  return a1 * a1;
}


/* Function: process_float @ 0x914 */
float __fastcall process_float(float a1)
{
  return (float)(a1 * 1.5) + 0.5;
}


/* Function: process_double @ 0x934 */
double __fastcall process_double(double a1)
{
  return a1 / 2.0 + 0.1;
}


/* Function: process_ld @ 0x95C */
long double __fastcall process_ld(long double a1)
{
  return a1 * a1 + *(long double *)&xmmword_3620;
}


/* Function: process_bool @ 0x98C */
bool __fastcall process_bool(int a1)
{
  bool v2; // [xsp+8h] [xbp-8h]

  v2 = 0;
  if ( a1 > 0 )
    return a1 % 2 == 0;
  return v2;
}


/* Function: const_param @ 0x9E0 */
__int64 __fastcall const_param(_DWORD *a1)
{
  return (unsigned int)(*a1 + 10);
}


/* Function: volatile_access @ 0x9FC */
__int64 __fastcall volatile_access(_DWORD *a1)
{
  return (unsigned int)(2 * *a1);
}


/* Function: test_data_types_l1 @ 0xA30 */
__int64 test_data_types_l1()
{
  unsigned __int8 v0; // w0
  unsigned __int8 v1; // w0
  __int16 v2; // w0
  int v3; // w0
  __int64 v4; // x0
  __int64 v5; // x0
  float v6; // s0
  double v7; // d0
  long double v8; // q0
  bool v9; // w0
  bool v10; // w0
  bool v11; // w0
  int v12; // w0
  int v13; // w0
  int v15; // [xsp+28h] [xbp-8h] BYREF
  int v16; // [xsp+2Ch] [xbp-4h] BYREF

  printf(asc_3758);
  v0 = process_char(0x41u);
  printf("DT-L1-01 (process_char): %c\n", v0);
  v1 = process_char(0x62u);
  printf("DT-L1-01 (process_char): %c\n", v1);
  v2 = process_short(100, 200);
  printf("DT-L1-02 (process_short): %d\n", v2);
  v3 = process_int(5);
  printf("DT-L1-03 (process_int): %d\n", v3);
  v4 = process_long(100);
  printf("DT-L1-04 (process_long): %ld\n", v4);
  v5 = process_ll(100);
  printf("DT-L1-05 (process_ll): %lld\n", v5);
  v6 = process_float(2.0);
  printf("DT-L1-06 (process_float): %.2f\n", v6);
  v7 = process_double(4.0);
  printf("DT-L1-07 (process_double): %.2f\n", v7);
  v8 = process_ld(*(long double *)&xmmword_3630);
  printf("DT-L1-08 (process_ld): %.2Lf\n", v8);
  v9 = process_bool(4);
  printf("DT-L1-09 (process_bool): %d\n", v9);
  v10 = process_bool(3);
  printf("DT-L1-09 (process_bool): %d\n", v10);
  v11 = process_bool(-2);
  printf("DT-L1-09 (process_bool): %d\n", v11);
  v16 = 5;
  v12 = const_param(&v16);
  printf("DT-L1-10 (const_param): %d\n", v12);
  v15 = 10;
  v13 = volatile_access(&v15);
  return printf("DT-L1-11 (volatile_access): %d\n", v13);
}


/* Function: array_1d_stack @ 0xBC4 */
__int64 __fastcall array_1d_stack(__int64 a1, int a2)
{
  int i; // [xsp+Ch] [xbp-14h]
  unsigned int v4; // [xsp+10h] [xbp-10h]

  v4 = 0;
  for ( i = 0; i < a2; ++i )
    v4 += *(_DWORD *)(a1 + 4LL * i);
  return v4;
}


/* Function: array_string @ 0xC28 */
__int64 __fastcall array_string(__int64 a1)
{
  unsigned int i; // [xsp+4h] [xbp-Ch]

  for ( i = 0; *(_BYTE *)(a1 + (int)i); ++i )
    ;
  return i;
}


/* Function: array_2d_stack @ 0xC68 */
__int64 __fastcall array_2d_stack(__int64 a1)
{
  int i; // [xsp+0h] [xbp-10h]
  unsigned int v3; // [xsp+4h] [xbp-Ch]

  v3 = 0;
  for ( i = 0; i < 10; ++i )
    v3 += *(_DWORD *)(a1 + 40LL * i + 4LL * i);
  return v3;
}


/* Function: array_3d @ 0xCD4 */
__int64 __fastcall array_3d(__int64 a1)
{
  int k; // [xsp+8h] [xbp-18h]
  int j; // [xsp+Ch] [xbp-14h]
  int i; // [xsp+10h] [xbp-10h]
  unsigned int v5; // [xsp+14h] [xbp-Ch]

  v5 = 0;
  for ( i = 0; i < 5; ++i )
  {
    for ( j = 0; j < 5; ++j )
    {
      for ( k = 0; k < 5; ++k )
        v5 += *(_DWORD *)(a1 + 100LL * i + 20LL * j + 4LL * k);
    }
  }
  return v5;
}


/* Function: array_vla @ 0xDA8 */
__int64 __fastcall array_vla(int a1, __int64 a2)
{
  int i; // [xsp+8h] [xbp-18h]
  unsigned int v4; // [xsp+Ch] [xbp-14h]

  v4 = 0;
  for ( i = 0; i < a1; ++i )
    v4 += *(_DWORD *)(a2 + 4LL * i);
  return v4;
}


/* Function: array_pointer @ 0xE0C */
__int64 __fastcall array_pointer(__int64 a1, int a2)
{
  int i; // [xsp+Ch] [xbp-14h]
  unsigned int v4; // [xsp+10h] [xbp-10h]

  v4 = 0;
  for ( i = 0; i < a2; ++i )
    v4 += *(_DWORD *)(a1 + 40LL * i);
  return v4;
}


/* Function: pointer_array @ 0xE78 */
__int64 __fastcall pointer_array(__int64 a1, int a2)
{
  int v3; // [xsp+4h] [xbp-1Ch]
  int i; // [xsp+8h] [xbp-18h]
  unsigned int v5; // [xsp+10h] [xbp-10h]

  v5 = 0;
  if ( a2 >= 10 )
    v3 = 10;
  else
    v3 = a2;
  for ( i = 0; i < v3; ++i )
  {
    if ( *(_QWORD *)(a1 + 8LL * i) )
      v5 += **(_DWORD **)(a1 + 8LL * i);
  }
  return v5;
}


/* Function: array_complex_index @ 0xF28 */
__int64 __fastcall array_complex_index(__int64 a1, int a2, int a3, int a4, int a5)
{
  if ( a4 < 0 || a4 >= a2 || a5 < 0 || a5 >= a3 )
    return (unsigned int)-1;
  else
    return *(unsigned int *)(a1 + 4LL * (a5 * a2 + a4));
}


/* Function: array_oob @ 0xFBC */
__int64 __fastcall array_oob(__int64 a1, int a2)
{
  int i; // [xsp+Ch] [xbp-14h]
  unsigned int v4; // [xsp+10h] [xbp-10h]

  v4 = 0;
  for ( i = 0; i <= a2; ++i )
    v4 += *(_DWORD *)(a1 + 4LL * i);
  return v4;
}


/* Function: test_array_types @ 0x1020 */
__int64 test_array_types()
{
  int v0; // w0
  int v1; // w0
  int v2; // w0
  int v3; // w0
  int v4; // w0
  int v5; // w0
  int v7; // w0
  int v8; // w0
  __int64 *v10; // [xsp+8h] [xbp-568h]
  int v11; // [xsp+14h] [xbp-55Ch]
  int jj; // [xsp+24h] [xbp-54Ch]
  _DWORD v13[20]; // [xsp+28h] [xbp-548h] BYREF
  _QWORD v14[4]; // [xsp+78h] [xbp-4F8h] BYREF
  __int64 v15; // [xsp+98h] [xbp-4D8h] BYREF
  int v16; // [xsp+C8h] [xbp-4A8h] BYREF
  int v17; // [xsp+CCh] [xbp-4A4h] BYREF
  int v18; // [xsp+D0h] [xbp-4A0h] BYREF
  int ii; // [xsp+D4h] [xbp-49Ch]
  _DWORD v20[50]; // [xsp+D8h] [xbp-498h] BYREF
  __int64 v21; // [xsp+1A0h] [xbp-3D0h] BYREF
  int v22; // [xsp+1A8h] [xbp-3C8h]
  int n; // [xsp+1B0h] [xbp-3C0h]
  int m; // [xsp+1B4h] [xbp-3BCh]
  int k; // [xsp+1B8h] [xbp-3B8h]
  _DWORD v26[125]; // [xsp+1BCh] [xbp-3B4h] BYREF
  int j; // [xsp+3B0h] [xbp-1C0h]
  int i; // [xsp+3B4h] [xbp-1BCh]
  _QWORD v29[50]; // [xsp+3B8h] [xbp-1B8h] BYREF
  char v30[8]; // [xsp+548h] [xbp-28h] BYREF
  __int128 v31; // [xsp+550h] [xbp-20h] BYREF
  int v32; // [xsp+560h] [xbp-10h]

  printf(asc_38C4);
  v31 = xmmword_3670;
  v32 = 5;
  v0 = array_1d_stack((__int64)&v31, 5);
  printf("ARR-L1-01 (array_1d_stack): %d\n", v0);
  strcpy(v30, "hello");
  v1 = array_string((__int64)v30);
  printf("ARR-L1-02 (array_string): %d\n", v1);
  for ( i = 0; i < 10; ++i )
  {
    for ( j = 0; j < 10; ++j )
    {
      if ( i == j )
        v11 = i;
      else
        v11 = 0;
      *((_DWORD *)&v29[5 * i] + j) = v11;
    }
  }
  v2 = array_2d_stack((__int64)v29);
  printf("ARR-L1-03 (array_2d_stack): %d\n", v2);
  for ( k = 0; k < 5; ++k )
  {
    for ( m = 0; m < 5; ++m )
    {
      for ( n = 0; n < 5; ++n )
        v26[25 * k + 5 * m + n] = 1;
    }
  }
  v3 = array_3d((__int64)v26);
  printf("ARR-L1-04 (array_3d): %d\n", v3);
  v21 = 0x140000000ALL;
  v22 = 30;
  v4 = array_vla(3, (__int64)&v21);
  printf("ARR-L2-01 (array_vla): %d\n", v4);
  for ( ii = 0; ii < 5; ++ii )
    v20[10 * ii] = 10 * ii;
  v5 = array_pointer((__int64)v20, 5);
  printf("ARR-L2-02 (array_pointer): %d\n", v5);
  v18 = 10;
  v17 = 20;
  v16 = 30;
  v14[0] = &v18;
  v14[1] = &v17;
  v14[2] = &v16;
  v14[3] = 0;
  v10 = &v15;
  do
    *v10 = 0;
  while ( (char *)++v10 - (char *)&v16 );
  v7 = pointer_array((__int64)v14, 3);
  printf("ARR-L2-03 (pointer_array): %d\n", v7);
  for ( jj = 0; jj < 20; ++jj )
    v13[jj] = jj;
  v8 = array_complex_index((__int64)v13, 5, 4, 2, 3);
  return printf("ARR-L2-04 (array_complex_index): %d\n", v8);
}


/* Function: ptr_single @ 0x13D0 */
__int64 __fastcall ptr_single(_DWORD *a1)
{
  return (unsigned int)(*a1 + 10);
}


/* Function: ptr_double @ 0x13EC */
__int64 __fastcall ptr_double(_DWORD **a1)
{
  return (unsigned int)(**a1 + 5);
}


/* Function: ptr_triple @ 0x140C */
__int64 __fastcall ptr_triple(_DWORD ***a1)
{
  return (unsigned int)(***a1 + 1);
}


/* Function: ptr_increment @ 0x1430 */
__int64 __fastcall ptr_increment(_DWORD *a1, int a2)
{
  int i; // [xsp+Ch] [xbp-14h]
  unsigned int v4; // [xsp+10h] [xbp-10h]

  v4 = 0;
  for ( i = 0; i < a2; ++i )
    v4 += *a1++;
  return v4;
}


/* Function: ptr_offset @ 0x149C */
__int64 __fastcall ptr_offset(__int64 a1, int a2)
{
  return *(unsigned int *)(a1 + 4LL * a2);
}


/* Function: ptr_diff @ 0x14BC */
__int64 __fastcall ptr_diff(__int64 a1, __int64 a2)
{
  return (unsigned int)((a1 - a2) / 4);
}


/* Function: ptr_void @ 0x14E8 */
__int64 __fastcall ptr_void(unsigned __int8 *a1, int a2)
{
  if ( a2 )
  {
    if ( a2 == 1 )
      return *a1;
    else
      return (unsigned int)-1;
  }
  else
  {
    return *(unsigned int *)a1;
  }
}


/* Function: ptr_const @ 0x154C */
__int64 __fastcall ptr_const(_DWORD *a1)
{
  return (unsigned int)(2 * *a1);
}


/* Function: ptr_const_ptr @ 0x1570 */
__int64 __fastcall ptr_const_ptr(unsigned int *a1)
{
  *a1 += 5;
  return *a1;
}


/* Function: ptr_func_simple @ 0x159C */
__int64 __fastcall ptr_func_simple(__int64 (__fastcall *a1)(_QWORD), unsigned int a2)
{
  return a1(a2);
}


/* Function: ptr_func_complex @ 0x15C8 */
__int64 __fastcall ptr_func_complex(__int64 (__fastcall *a1)(_QWORD, _QWORD), __int64 a2)
{
  __int128 v3; // [xsp+0h] [xbp-20h] BYREF
  __int64 v4; // [xsp+10h] [xbp-10h]
  __int64 (__fastcall *v5)(_QWORD, _QWORD); // [xsp+18h] [xbp-8h]

  v5 = a1;
  v4 = a2;
  v3 = *(_OWORD *)&off_14DB8;
  return a1(a2, &v3);
}


/* Function: ptr_cast @ 0x1608 */
__int64 __fastcall ptr_cast(unsigned int *a1)
{
  return *a1;
}


/* Function: opaque_handle_create @ 0x1638 */
__int64 __fastcall opaque_handle_create(__int64 result)
{
  return (int)result;
}


/* Function: opaque_handle_op @ 0x164C */
__int64 __fastcall opaque_handle_op(int a1)
{
  return (unsigned int)(2 * a1);
}


/* Function: test_pointer_types @ 0x1664 */
__int64 test_pointer_types()
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
  int v11; // w0
  int v12; // w0
  int v13; // w0
  int v15; // [xsp+20h] [xbp-B0h]
  unsigned int v16; // [xsp+28h] [xbp-A8h] BYREF
  int v17; // [xsp+2Ch] [xbp-A4h] BYREF
  unsigned int v18; // [xsp+30h] [xbp-A0h] BYREF
  int v19; // [xsp+34h] [xbp-9Ch] BYREF
  unsigned __int8 v20; // [xsp+3Bh] [xbp-95h] BYREF
  int v21; // [xsp+3Ch] [xbp-94h] BYREF
  __int128 v22; // [xsp+40h] [xbp-90h] BYREF
  int v23[4]; // [xsp+50h] [xbp-80h] BYREF
  __int128 v24; // [xsp+60h] [xbp-70h] BYREF
  int v25; // [xsp+70h] [xbp-60h]
  __int128 v26; // [xsp+80h] [xbp-50h] BYREF
  int v27; // [xsp+90h] [xbp-40h]
  int ***v28; // [xsp+98h] [xbp-38h]
  int **v29; // [xsp+A0h] [xbp-30h] BYREF
  int *v30; // [xsp+A8h] [xbp-28h] BYREF
  int v31; // [xsp+B4h] [xbp-1Ch] BYREF
  int **v32; // [xsp+B8h] [xbp-18h]
  int *v33; // [xsp+C0h] [xbp-10h] BYREF
  int v34; // [xsp+C8h] [xbp-8h] BYREF
  int v35; // [xsp+CCh] [xbp-4h] BYREF

  printf(asc_39E1);
  v35 = 5;
  v0 = ptr_single(&v35);
  printf("PTR-L2-01 (ptr_single): %d\n", v0);
  v34 = 10;
  v33 = &v34;
  v32 = &v33;
  v1 = ptr_double(&v33);
  printf("PTR-L2-02 (ptr_double): %d\n", v1);
  v31 = 5;
  v30 = &v31;
  v29 = &v30;
  v28 = &v29;
  v2 = ptr_triple(&v29);
  printf("PTR-L2-03 (ptr_triple): %d\n", v2);
  v26 = xmmword_3690;
  v27 = 5;
  v3 = ptr_increment(&v26, 5);
  printf("PTR-L2-04 (ptr_increment): %d\n", v3);
  v24 = xmmword_36A4;
  v25 = 50;
  v4 = ptr_offset((__int64)&v24, 2);
  printf("PTR-L2-05 (ptr_offset): %d\n", v4);
  v22 = xmmword_36B8;
  v23[0] = 40;
  v5 = ptr_diff((__int64)v23, (__int64)&v22);
  printf("PTR-L2-06 (ptr_diff): %d\n", v5);
  v21 = 42;
  v20 = 65;
  v6 = ptr_void((unsigned __int8 *)&v21, 0);
  printf("PTR-L2-07 (ptr_void): %d\n", v6);
  v7 = ptr_void(&v20, 1);
  printf("PTR-L2-07 (ptr_void): %d\n", v7);
  v19 = 10;
  v8 = ptr_const(&v19);
  printf("PTR-L2-08 (ptr_const): %d\n", v8);
  v18 = 10;
  v9 = ptr_const_ptr(&v18);
  printf("PTR-L2-09 (ptr_const_ptr): %d\n", v9);
  v10 = ptr_func_simple((__int64 (__fastcall *)(_QWORD))double_value, 5u);
  printf("PTR-L2-10 (ptr_func_simple): %d\n", v10);
  v17 = 5;
  v11 = ptr_func_complex((__int64 (__fastcall *)(_QWORD, _QWORD))complex_callback, (__int64)&v17);
  printf("PTR-L2-11 (ptr_func_complex): %d\n", v11);
  v16 = 305419896;
  v12 = ptr_cast(&v16);
  printf("PTR-L2-12 (ptr_cast): 0x%x\n", v12);
  v15 = opaque_handle_create(10);
  v13 = opaque_handle_op(v15);
  return printf("PTR-L2-13 (opaque_handle_op): %d\n", v13);
}


/* Function: double_value @ 0x18D4 */
__int64 __fastcall double_value(int a1)
{
  return (unsigned int)(2 * a1);
}


/* Function: complex_callback @ 0x18EC */
bool __fastcall complex_callback(_DWORD *a1, _QWORD *a2)
{
  *a1 += 10;
  return *a2 != 0;
}


/* Function: struct_simple @ 0x1928 */
__int64 __fastcall struct_simple(_DWORD *a1)
{
  return (unsigned int)(*a1 + a1[1] + a1[2]);
}


/* Function: struct_array @ 0x1958 */
__int64 __fastcall struct_array(__int64 a1, int a2)
{
  int i; // [xsp+Ch] [xbp-14h]
  unsigned int v4; // [xsp+10h] [xbp-10h]

  v4 = 0;
  for ( i = 0; i < a2; ++i )
    v4 += *(_DWORD *)(a1 + 12LL * i) + *(_DWORD *)(a1 + 12LL * i + 4) + *(_DWORD *)(a1 + 12LL * i + 8);
  return v4;
}


/* Function: struct_nested @ 0x19F4 */
__int64 __fastcall struct_nested(_DWORD *a1)
{
  return (unsigned int)(*a1 + a1[3]);
}


/* Function: struct_deep @ 0x1A18 */
__int64 __fastcall struct_deep(__int64 a1)
{
  return (unsigned int)(*(_DWORD *)(a1 + 8) + *(_DWORD *)(a1 + 20));
}


/* Function: struct_with_ptr @ 0x1A3C */
__int64 __fastcall struct_with_ptr(__int64 a1)
{
  int v2; // [xsp+0h] [xbp-10h]

  if ( *(_QWORD *)(a1 + 8) )
    v2 = **(_DWORD **)(a1 + 8);
  else
    v2 = 0;
  return (unsigned int)(*(_DWORD *)a1 + v2);
}


/* Function: struct_bitfields @ 0x1A94 */
__int64 __fastcall struct_bitfields(_WORD *a1)
{
  return ((*a1 >> 1) & 3) + (*a1 & 1) + ((*a1 >> 3) & 7) + (unsigned int)(*a1 >> 6);
}


/* Function: union_type @ 0x1AEC */
__int64 __fastcall union_type(unsigned __int8 *a1, int a2)
{
  if ( a2 )
  {
    if ( a2 == 1 )
      return (unsigned int)(int)*(float *)a1;
    else
      return *a1;
  }
  else
  {
    return *(unsigned int *)a1;
  }
}


/* Function: union_array @ 0x1B54 */
__int64 __fastcall union_array(__int64 a1, int a2)
{
  int i; // [xsp+Ch] [xbp-14h]
  unsigned int v4; // [xsp+10h] [xbp-10h]

  v4 = 0;
  for ( i = 0; i < a2; ++i )
    v4 += *(_DWORD *)(a1 + 4LL * i);
  return v4;
}


/* Function: enum_type @ 0x1BB8 */
__int64 __fastcall enum_type(int a1)
{
  return (unsigned int)(10 * a1);
}


/* Function: enum_switch @ 0x1BD4 */
__int64 __fastcall enum_switch(int a1)
{
  unsigned int v2; // [xsp+Ch] [xbp-4h]

  switch ( a1 )
  {
    case 0:
      v2 = 0;
      break;
    case 1:
      v2 = 100;
      break;
    case 2:
      v2 = 50;
      break;
    case 3:
      v2 = -1;
      break;
    default:
      v2 = -99;
      break;
  }
  return v2;
}


/* Function: struct_func_ptr @ 0x1C50 */
__int64 __fastcall struct_func_ptr(unsigned int *a1)
{
  return (*((__int64 (__fastcall **)(_QWORD))a1 + 1))(*a1);
}


/* Function: linked_list @ 0x1C80 */
__int64 __fastcall linked_list(__int64 a1)
{
  unsigned int v3; // [xsp+14h] [xbp-Ch]

  v3 = 0;
  while ( a1 )
  {
    v3 += *(_DWORD *)a1;
    a1 = *(_QWORD *)(a1 + 8);
  }
  return v3;
}


/* Function: doubly_linked_list @ 0x1CD4 */
__int64 __fastcall doubly_linked_list(__int64 a1)
{
  unsigned int v3; // [xsp+14h] [xbp-Ch]

  v3 = 0;
  while ( a1 )
  {
    v3 += *(_DWORD *)a1;
    a1 = *(_QWORD *)(a1 + 8);
  }
  return v3;
}


/* Function: binary_tree_sum @ 0x1D28 */
__int64 __fastcall binary_tree_sum(int *a1)
{
  int v2; // [xsp+8h] [xbp-18h]
  int v3; // [xsp+Ch] [xbp-14h]

  if ( a1 )
  {
    v2 = *a1;
    v3 = v2 + binary_tree_sum(*((_QWORD *)a1 + 1));
    return (unsigned int)(v3 + binary_tree_sum(*((_QWORD *)a1 + 2)));
  }
  else
  {
    return 0;
  }
}


/* Function: binary_tree @ 0x1D9C */
__int64 __fastcall binary_tree(int *a1)
{
  return binary_tree_sum(a1);
}


/* Function: graph_traverse @ 0x1DC0 */
__int64 __fastcall graph_traverse(__int64 a1)
{
  __int64 j; // [xsp+8h] [xbp-18h]
  int i; // [xsp+10h] [xbp-10h]
  unsigned int v4; // [xsp+14h] [xbp-Ch]

  v4 = 0;
  for ( i = 0; i < *(_DWORD *)(a1 + 80); ++i )
  {
    for ( j = *(_QWORD *)(a1 + 8LL * i); j; j = *(_QWORD *)(j + 8) )
      v4 += *(_DWORD *)j;
  }
  return v4;
}


/* Function: test_composite_types @ 0x1E50 */
__int64 test_composite_types()
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
  int v11; // w0
  int v12; // w0
  int v13; // w0
  int v14; // w0
  _QWORD s[10]; // [xsp+38h] [xbp-1B8h] BYREF
  int v17; // [xsp+88h] [xbp-168h]
  __int128 v18; // [xsp+90h] [xbp-160h] BYREF
  __int128 v19; // [xsp+A0h] [xbp-150h] BYREF
  __int64 v20; // [xsp+B0h] [xbp-140h]
  int v21; // [xsp+C0h] [xbp-130h] BYREF
  int *v22; // [xsp+C8h] [xbp-128h]
  __int64 v23; // [xsp+D0h] [xbp-120h]
  int v24; // [xsp+D8h] [xbp-118h] BYREF
  __int64 v25; // [xsp+E0h] [xbp-110h]
  int *v26; // [xsp+E8h] [xbp-108h]
  int v27; // [xsp+F0h] [xbp-100h] BYREF
  int *v28; // [xsp+F8h] [xbp-F8h]
  int v29; // [xsp+100h] [xbp-F0h] BYREF
  int *v30; // [xsp+108h] [xbp-E8h]
  int v31; // [xsp+110h] [xbp-E0h] BYREF
  __int64 v32; // [xsp+118h] [xbp-D8h]
  unsigned int v33[6]; // [xsp+120h] [xbp-D0h] BYREF
  __int64 v34; // [xsp+138h] [xbp-B8h] BYREF
  int v35; // [xsp+140h] [xbp-B0h]
  int v36; // [xsp+144h] [xbp-ACh] BYREF
  __int64 v37; // [xsp+148h] [xbp-A8h] BYREF
  int v38; // [xsp+150h] [xbp-A0h] BYREF
  __int128 *v39; // [xsp+158h] [xbp-98h]
  __int128 v40; // [xsp+160h] [xbp-90h] BYREF
  _BYTE dest[48]; // [xsp+170h] [xbp-80h] BYREF
  __int128 v42; // [xsp+1A0h] [xbp-50h] BYREF
  int v43; // [xsp+1B0h] [xbp-40h]
  __int128 v44; // [xsp+1C0h] [xbp-30h] BYREF
  __int64 v45; // [xsp+1D0h] [xbp-20h]
  __int64 v46; // [xsp+1E0h] [xbp-10h] BYREF
  int v47; // [xsp+1E8h] [xbp-8h]

  printf(asc_3B7B);
  v46 = 0x200000001LL;
  v47 = 3;
  v0 = struct_simple(&v46);
  printf("CMP-L2-01 (struct_simple): %d\n", v0);
  v44 = xmmword_36D8;
  v45 = 0x200000002LL;
  v1 = struct_array((__int64)&v44, 2);
  printf("CMP-L2-02 (struct_array): %d\n", v1);
  v42 = xmmword_36F0;
  v43 = 200;
  v2 = struct_nested(&v42);
  printf("CMP-L2-03 (struct_nested): %d\n", v2);
  memcpy(dest, &unk_3704, sizeof(dest));
  v3 = struct_deep((__int64)dest);
  printf("CMP-L2-04 (struct_deep): %d\n", v3);
  v40 = xmmword_3640;
  v38 = 10;
  v39 = &v40;
  v4 = struct_with_ptr((__int64)&v38);
  printf("CMP-L2-05 (struct_with_ptr): %d\n", v4);
  v37 = 6429;
  v5 = struct_bitfields(&v37);
  printf("CMP-L2-06 (struct_bitfields): %d\n", v5);
  v36 = 305419896;
  v6 = union_type((unsigned __int8 *)&v36, 0);
  printf("CMP-L2-07 (union_type): %d\n", v6);
  v34 = 0x140000000ALL;
  v35 = 30;
  v7 = union_array((__int64)&v34, 3);
  printf("CMP-L2-08 (union_array): %d\n", v7);
  v8 = enum_type(1);
  printf("CMP-L2-09 (enum_type): %d\n", v8);
  v9 = enum_switch(2);
  printf("CMP-L2-10 (enum_switch): %d\n", v9);
  *(_OWORD *)v33 = unk_14DC8;
  v10 = struct_func_ptr(v33);
  printf("CMP-L2-11 (struct_func_ptr): %d\n", v10);
  v27 = 10;
  v28 = &v29;
  v29 = 20;
  v30 = &v31;
  v31 = 30;
  v32 = 0;
  v11 = linked_list((__int64)&v27);
  printf("CMP-L2-12 (linked_list): %d\n", v11);
  v21 = 10;
  v23 = 0;
  v24 = 20;
  v25 = 0;
  v26 = &v21;
  v22 = &v24;
  v12 = doubly_linked_list((__int64)&v21);
  printf("CMP-L2-13 (doubly_linked_list): %d\n", v12);
  v19 = xmmword_3740;
  v20 = 0;
  v13 = binary_tree((int *)&v19);
  printf("CMP-L2-14 (binary_tree): %d\n", v13);
  v18 = xmmword_3650;
  memset(s, 0, 0x58u);
  v17 = 2;
  s[0] = &v18;
  v14 = graph_traverse((__int64)s);
  return printf("CMP-L2-15 (graph_traverse): %d\n", v14);
}


/* Function: main @ 0x2194 */
int __fastcall main(int argc, const char **argv, const char **envp)
{
  test_data_types_l1();
  test_array_types();
  test_pointer_types();
  test_composite_types();
  return 0;
}


/* Function: __addtf3 @ 0x21D0 */
__n128 __fastcall _addtf3(long double a1, long double a2)
{
  unsigned __int64 StatusReg; // x16
  __int64 v3; // x6
  unsigned __int64 v4; // x13
  __int64 v5; // x8
  __int64 v6; // x7
  __int64 v7; // x15
  int v8; // w14
  unsigned __int64 v9; // x3
  __int64 v10; // x2
  unsigned __int64 v11; // x9
  __int64 v12; // x1
  unsigned __int64 v13; // x11
  int v14; // w0
  unsigned __int64 v15; // x4
  unsigned __int64 v16; // x3
  unsigned __int64 v17; // x0
  unsigned __int64 v18; // x4
  int v19; // w1
  unsigned __int64 v20; // x3
  unsigned __int64 v21; // x0
  int v22; // w1
  int v23; // w7
  __int64 v24; // x6
  __int64 v25; // x0
  int v26; // w4
  __int64 v27; // x1
  __int64 v28; // x1
  __int64 v29; // x2
  __int64 v30; // x1
  unsigned __int64 v31; // x9
  __int128 v32; // t2
  __int16 v33; // w2
  __n128 result; // q0
  int v35; // w0
  unsigned __int64 v36; // x1
  unsigned __int64 v37; // x3
  unsigned __int64 v38; // x0
  unsigned __int64 v39; // x7
  unsigned __int128 v40; // kr30_16
  __int64 v41; // x1
  __int128 v42; // t2
  __int64 v43; // x1
  int v44; // w0
  int v45; // w0
  unsigned __int64 v46; // x4
  unsigned __int64 v47; // x0
  bool v48; // cf
  char v49; // w1
  unsigned __int64 v50; // x4
  unsigned __int64 v51; // x0
  unsigned __int64 v52; // x1
  char v53; // w1
  char v54; // w1
  int v55; // w0
  unsigned __int64 v56; // x1
  char v57; // w1
  int v58; // w0
  unsigned __int64 v59; // x1
  signed __int128 v60; // kr70_16
  unsigned __int64 v61; // x9
  char v62; // w2
  int v63; // w0
  unsigned __int64 v64; // x2
  char v65; // w2
  int v66; // w0
  unsigned __int64 v67; // x2
  unsigned __int64 v68; // x2
  unsigned __int64 v69; // x1
  __int128 v70; // t2
  unsigned __int64 v71; // x2
  unsigned __int64 v72; // x1
  unsigned __int64 v73; // x9
  unsigned __int64 v74; // x1
  __int128 v75; // t2
  __n128 v76; // [xsp+10h] [xbp+10h]

  StatusReg = _ReadStatusReg(FPCR);
  v3 = *((_QWORD *)&a1 + 1) >> 63;
  v4 = *(__int128 *)&a1 >> 61;
  v5 = HIWORD(*((_QWORD *)&a1 + 1)) & 0x7FFFLL;
  v6 = HIWORD(*((_QWORD *)&a2 + 1)) & 0x7FFFLL;
  v7 = *((_QWORD *)&a1 + 1) >> 63;
  v8 = *((_QWORD *)&a1 + 1) >> 63;
  v9 = *(__int128 *)&a2 >> 61;
  v10 = v5;
  v11 = 8LL * *(_QWORD *)&a1;
  v12 = v6;
  v13 = 8LL * *(_QWORD *)&a2;
  if ( *((_QWORD *)&a1 + 1) >> 63 == *((_QWORD *)&a2 + 1) >> 63 )
  {
    v14 = v5 - v6;
    if ( (int)v5 - (int)v6 > 0 )
    {
      if ( v6 )
      {
        v9 |= 0x8000000000000uLL;
        if ( v5 == 0x7FFF )
        {
LABEL_100:
          if ( v4 | v11 )
          {
            v31 = *(_QWORD *)&a1 & 0x1FFFFFFFFFFFFFFFLL | ((unsigned __int64)(unsigned __int8)v4 << 61);
            v41 = v4 >> 3;
            v14 = ((unsigned __int8)(v4 >> 50) ^ 1) & 1;
            goto LABEL_102;
          }
          goto LABEL_132;
        }
      }
      else
      {
        if ( __PAIR128__(v9, v13) == 0 )
        {
          if ( v5 != 0x7FFF )
            goto LABEL_46;
          if ( __PAIR128__(v4, v11) == 0 )
            goto LABEL_120;
          v14 = (v4 >> 50) ^ 1;
          goto LABEL_61;
        }
        if ( !--v14 )
        {
          v48 = __CFADD__(v11, v13);
          v11 += v13;
          v4 += v48 + v9;
          goto LABEL_85;
        }
        if ( v5 == 0x7FFF )
        {
          if ( __PAIR128__(v4, v11) == 0 )
            goto LABEL_132;
LABEL_60:
          v14 = ((unsigned __int8)(v4 >> 50) ^ 1) & 1;
          goto LABEL_61;
        }
      }
      if ( v14 > 116 )
      {
        v38 = (v9 | v13) != 0;
      }
      else if ( v14 > 63 )
      {
        v57 = 0x80 - v14;
        v58 = v14 - 64;
        v59 = v13 | (v9 << v57);
        if ( v58 )
          v13 = v59;
        v38 = (v13 != 0) | (v9 >> v58);
      }
      else
      {
        v36 = (v9 << (64 - (unsigned __int8)v14)) | (v13 >> v14);
        v37 = v9 >> v14;
        v38 = v36 | (v13 << (64 - (unsigned __int8)v14) != 0);
        v4 += v37;
      }
      v48 = __CFADD__(v38, v11);
      v11 += v38;
      if ( v48 )
        ++v4;
LABEL_85:
      if ( (v4 & 0x8000000000000LL) == 0 )
        goto LABEL_46;
      if ( ++v10 != 0x7FFF )
      {
        v26 = 0;
        v11 = v11 & 1 | (v11 >> 1) | (v4 << 63);
        v4 = (v4 & 0xFFF7FFFFFFFFFFFFLL) >> 1;
        v25 = v11 & 7;
        goto LABEL_20;
      }
      v43 = StatusReg & 0xC00000;
      if ( (StatusReg & 0xC00000) == 0 )
        goto LABEL_71;
      if ( v43 != 0x400000 || a1 < 0.0 )
      {
        if ( v43 != 0x800000 )
          goto LABEL_161;
        if ( a1 >= 0.0 )
          goto LABEL_222;
        goto LABEL_195;
      }
      goto LABEL_231;
    }
    if ( (_DWORD)v5 != (_DWORD)v6 )
    {
      if ( v5 )
      {
        v45 = v6 - v5;
        v4 |= 0x8000000000000uLL;
      }
      else
      {
        if ( __PAIR128__(v4, v11) == 0 )
        {
          if ( v6 != 0x7FFF )
          {
            v4 = *(__int128 *)&a2 >> 61;
            v11 = 8LL * *(_QWORD *)&a2;
            v10 = HIWORD(*((_QWORD *)&a2 + 1)) & 0x7FFFLL;
            goto LABEL_46;
          }
          if ( __PAIR128__(v9, v13) == 0 )
            goto LABEL_120;
          v11 = 8LL * *(_QWORD *)&a2;
          v4 = *(__int128 *)&a2 >> 61;
          v14 = ((unsigned __int8)(v9 >> 50) ^ 1) & 1;
          goto LABEL_61;
        }
        v45 = ~v14;
        if ( !v45 )
        {
          v48 = __CFADD__(v11, v13);
          v10 = HIWORD(*((_QWORD *)&a2 + 1)) & 0x7FFFLL;
          v11 += v13;
          v4 += v48 + v9;
          goto LABEL_85;
        }
      }
      if ( v6 == 0x7FFF )
      {
        if ( v9 | v13 )
        {
          v31 = *(_QWORD *)&a2 & 0x1FFFFFFFFFFFFFFFLL | ((unsigned __int64)(unsigned __int8)v9 << 61);
          v41 = v9 >> 3;
          v14 = ((unsigned __int8)(v9 >> 50) ^ 1) & 1;
          goto LABEL_102;
        }
        goto LABEL_132;
      }
      if ( v45 > 116 )
      {
        v47 = (v4 | v11) != 0;
      }
      else if ( v45 > 63 )
      {
        v65 = 0x80 - v45;
        v66 = v45 - 64;
        v67 = v11 | (v4 << v65);
        if ( v66 )
          v11 = v67;
        v47 = (v11 != 0) | (v4 >> v66);
      }
      else
      {
        v46 = v4 >> v45;
        v47 = (v4 << (64 - (unsigned __int8)v45)) | (v11 >> v45) | (v11 << (64 - (unsigned __int8)v45) != 0);
        v9 += v46;
      }
      v10 = HIWORD(*((_QWORD *)&a2 + 1)) & 0x7FFFLL;
      v11 = v47 + v13;
      if ( __CFADD__(v47, v13) )
        v4 = v9 + 1;
      else
        v4 = v9;
      goto LABEL_85;
    }
    if ( ((v5 + 1) & 0x7FFE) != 0 )
    {
      if ( v5 != 32766 )
      {
        v10 = v5 + 1;
        v60 = __PAIR128__(v9, v11) + __PAIR128__(v4, v13);
        v26 = 0;
        v25 = ((v11 + v13) >> 1) & 7;
        v4 = (unsigned __int64)((__PAIR128__(v9, v11) + __PAIR128__(v4, v13)) >> 64) >> 1;
        v11 = v60 >> 1;
        goto LABEL_20;
      }
      v43 = StatusReg & 0xC00000;
      if ( (StatusReg & 0xC00000) == 0 )
        goto LABEL_71;
      if ( v43 != 0x400000 || a1 < 0.0 )
      {
        if ( v43 != 0x800000 )
        {
LABEL_161:
          v14 = 20;
          if ( v43 != 0x400000 )
          {
LABEL_65:
            if ( v43 )
            {
              if ( v43 == 0x400000 )
              {
                if ( v7 )
                  goto LABEL_68;
              }
              else if ( ((v43 == 0x800000) & (unsigned __int8)v7) == 0 )
              {
LABEL_68:
                v31 = -1;
                v14 |= 0x14u;
                v24 = 0x1FFFFFFFFFFFFFFFLL;
                LOWORD(v10) = 32766;
                goto LABEL_49;
              }
            }
            v3 = (unsigned __int8)v8;
LABEL_71:
            result.n128_u64[0] = 0;
            result.n128_u64[1] = (v3 << 63) | 0x7FFF000000000000LL;
            goto LABEL_72;
          }
          v4 = -1;
          v10 = 32766;
          v11 = -1;
          v26 = 0;
          v14 = 20;
          if ( a1 < 0.0 )
            goto LABEL_91;
          goto LABEL_89;
        }
        if ( a1 >= 0.0 )
        {
LABEL_222:
          v4 = -1;
          LOWORD(v8) = 0;
          v11 = -1;
          v10 = 32766;
          v14 = 20;
          goto LABEL_27;
        }
LABEL_195:
        v3 = 1;
        goto LABEL_71;
      }
LABEL_231:
      v3 = 0;
      goto LABEL_71;
    }
    if ( !v5 )
    {
      v24 = v9 | v13;
      if ( __PAIR128__(v4, v11) == 0 )
      {
        if ( __PAIR128__(v9, v13) == 0 )
        {
          v31 = 0;
          goto LABEL_49;
        }
        v4 = *(__int128 *)&a2 >> 61;
        v11 = 8LL * *(_QWORD *)&a2;
      }
      else if ( __PAIR128__(v9, v13) != 0 )
      {
        v48 = __CFADD__(v11, v13);
        v49 = v11 + v13;
        v11 += v13;
        v4 += v48 + v9;
        if ( (v4 & 0x8000000000000LL) != 0 )
        {
          v4 &= ~0x8000000000000uLL;
          v25 = v49 & 7;
          v26 = 0;
          v10 = 1;
          goto LABEL_20;
        }
        goto LABEL_17;
      }
      goto LABEL_168;
    }
    if ( v5 == 0x7FFF )
    {
      if ( __PAIR128__(v4, v11) == 0 )
      {
        if ( v6 != 0x7FFF )
          goto LABEL_182;
        if ( __PAIR128__(v9, v13) == 0 )
          goto LABEL_132;
      }
      else
      {
        v14 = ((unsigned __int8)(v4 >> 50) ^ 1) & 1;
        if ( v6 != 0x7FFF )
          goto LABEL_216;
        if ( __PAIR128__(v9, v13) == 0 )
          goto LABEL_230;
      }
    }
    else
    {
      if ( v6 != 0x7FFF )
      {
        if ( __PAIR128__(v4, v11) == 0 )
        {
LABEL_182:
          v41 = v9 >> 3;
          v31 = *(_QWORD *)&a2 & 0x1FFFFFFFFFFFFFFFLL | ((unsigned __int64)(unsigned __int8)v9 << 61);
          goto LABEL_102;
        }
LABEL_216:
        if ( v9 | v13 )
          goto LABEL_217;
LABEL_230:
        v41 = v4 >> 3;
        v31 = *(_QWORD *)&a1 & 0x1FFFFFFFFFFFFFFFLL | ((unsigned __int64)(unsigned __int8)v4 << 61);
        goto LABEL_102;
      }
      if ( __PAIR128__(v9, v13) == 0 )
      {
        if ( __PAIR128__(v4, v11) == 0 )
          goto LABEL_132;
        goto LABEL_230;
      }
    }
    if ( (v9 & 0x4000000000000LL) == 0 )
      v14 = 1;
    if ( !(v4 | v11) )
      goto LABEL_182;
LABEL_217:
    v72 = v4 >> 3;
    v73 = *(_QWORD *)&a1 & 0x1FFFFFFFFFFFFFFFLL | ((unsigned __int64)(unsigned __int8)v4 << 61);
    if ( (v4 & 0x4000000000000LL) != 0 && (v9 & 0x4000000000000LL) == 0 )
    {
      LOWORD(v8) = *((_QWORD *)&a2 + 1) >> 63;
      v73 = *(_QWORD *)&a2 & 0x1FFFFFFFFFFFFFFFLL | (v9 << 61);
      v72 = v9 >> 3;
    }
    *((_QWORD *)&v75 + 1) = v72;
    *(_QWORD *)&v75 = v73;
    v74 = v75 >> 61;
    v31 = v73 & 0x1FFFFFFFFFFFFFFFLL | ((unsigned __int64)(unsigned __int8)v74 << 61);
    v41 = v74 >> 3;
    goto LABEL_102;
  }
  v14 = v5 - v6;
  if ( (int)v5 - (int)v6 > 0 )
  {
    if ( v6 )
    {
      v9 |= 0x8000000000000uLL;
      goto LABEL_5;
    }
    if ( __PAIR128__(v9, v13) != 0 )
    {
      if ( !--v14 )
      {
        v4 = (__PAIR128__(v4, v11) - __PAIR128__(v9, v13)) >> 64;
        v11 -= v13;
        goto LABEL_10;
      }
LABEL_5:
      if ( v5 != 0x7FFF )
      {
        if ( v14 > 116 )
        {
          v17 = (v9 | v13) != 0;
        }
        else if ( v14 > 63 )
        {
          v54 = 0x80 - v14;
          v55 = v14 - 64;
          v56 = v13 | (v9 << v54);
          if ( v55 )
            v13 = v56;
          v17 = (v13 != 0) | (v9 >> v55);
        }
        else
        {
          v15 = (v9 << (64 - (unsigned __int8)v14)) | (v13 >> v14);
          v16 = v9 >> v14;
          v17 = v15 | (v13 << (64 - (unsigned __int8)v14) != 0);
          v4 -= v16;
        }
        v4 = (__PAIR128__(v4, v11) - v17) >> 64;
        v11 -= v17;
        goto LABEL_10;
      }
      goto LABEL_100;
    }
    if ( v5 != 0x7FFF )
      goto LABEL_46;
    if ( __PAIR128__(v4, v11) == 0 )
    {
LABEL_120:
      v31 = 0;
      v41 = 0;
      v14 = 0;
      goto LABEL_102;
    }
    goto LABEL_60;
  }
  if ( (_DWORD)v5 == (_DWORD)v6 )
  {
    if ( ((v5 + 1) & 0x7FFE) != 0 )
    {
      v18 = (__PAIR128__(v4, v11) - __PAIR128__(v9, v13)) >> 64;
      v52 = v11 - v13;
      if ( (v18 & 0x8000000000000LL) != 0 )
      {
        LOWORD(v8) = *((_QWORD *)&a2 + 1) >> 63;
        v18 = (__PAIR128__(v9, v13) - __PAIR128__(v4, v11)) >> 64;
        v11 = v13 - v11;
        v7 = *((_QWORD *)&a2 + 1) >> 63;
      }
      else
      {
        v24 = v52 | v18;
        if ( __PAIR128__(v18, v52) == 0 )
        {
          v31 = 0;
          LOWORD(v10) = 0;
          LOWORD(v8) = (StatusReg & 0xC00000) == 0x800000;
          goto LABEL_49;
        }
        v11 -= v13;
      }
      goto LABEL_11;
    }
    v39 = v4 | v11;
    v24 = v9 | v13;
    if ( !v5 )
    {
      if ( __PAIR128__(v4, v11) == 0 )
      {
        if ( __PAIR128__(v9, v13) == 0 )
          goto LABEL_187;
        LOWORD(v8) = *((_QWORD *)&a2 + 1) >> 63;
        v4 = *(__int128 *)&a2 >> 61;
        v11 = 8LL * *(_QWORD *)&a2;
        v7 = *((_QWORD *)&a2 + 1) >> 63;
      }
      else if ( __PAIR128__(v9, v13) != 0 )
      {
        v40 = __PAIR128__(v4, v11) - __PAIR128__(v9, v13);
        if ( (((__PAIR128__(v4, v11) - __PAIR128__(v9, v13)) >> 64) & 0x8000000000000LL) != 0 )
        {
          LOWORD(v8) = *((_QWORD *)&a2 + 1) >> 63;
          v4 = (__PAIR128__(v9, v13) - __PAIR128__(v4, v11)) >> 64;
          v11 = v13 - v11;
          v7 = *((_QWORD *)&a2 + 1) >> 63;
          v24 = v11 | v4;
          goto LABEL_18;
        }
        v24 = v40 | *((_QWORD *)&v40 + 1);
        if ( v40 != 0 )
        {
          v25 = v40 & 7;
          v4 = (__PAIR128__(v4, v11) - __PAIR128__(v9, v13)) >> 64;
          v11 -= v13;
          v26 = 1;
          goto LABEL_20;
        }
LABEL_187:
        v31 = 0;
        LOWORD(v8) = (StatusReg & 0xC00000) == 0x800000;
        goto LABEL_49;
      }
LABEL_168:
      v28 = 0;
      v10 = 0;
      goto LABEL_169;
    }
    if ( v5 == 0x7FFF )
    {
      if ( __PAIR128__(v4, v11) == 0 )
      {
        if ( v12 != 0x7FFF )
          goto LABEL_153;
      }
      else
      {
        v14 = ((unsigned __int8)(v4 >> 50) ^ 1) & 1;
        if ( v12 != 0x7FFF )
          goto LABEL_149;
      }
    }
    else if ( v12 != 0x7FFF )
    {
      if ( __PAIR128__(v4, v11) != 0 )
        goto LABEL_149;
LABEL_153:
      if ( !v24 )
      {
LABEL_154:
        v31 = -1;
        v41 = 0xFFFFFFFFFFFFLL;
        LOWORD(v8) = 0;
        v14 = 1;
        goto LABEL_103;
      }
LABEL_213:
      v41 = v9 >> 3;
      v31 = *(_QWORD *)&a2 & 0x1FFFFFFFFFFFFFFFLL | ((unsigned __int64)(unsigned __int8)v9 << 61);
      LOWORD(v8) = *((_QWORD *)&a2 + 1) >> 63;
      goto LABEL_102;
    }
    if ( v24 )
    {
      if ( (v9 & 0x4000000000000LL) == 0 )
        v14 = 1;
      if ( v39 )
      {
        v61 = v4 << 61;
        v41 = v4 >> 3;
LABEL_205:
        v68 = *(_QWORD *)&a1 & 0x1FFFFFFFFFFFFFFFLL | v61;
        if ( (v41 & 0x800000000000LL) != 0 && (v9 & 0x4000000000000LL) == 0 )
        {
          LOWORD(v8) = *((_QWORD *)&a2 + 1) >> 63;
          v68 = *(_QWORD *)&a2 & 0x1FFFFFFFFFFFFFFFLL | ((unsigned __int64)(unsigned __int8)v9 << 61);
          v41 = v9 >> 3;
        }
        *((_QWORD *)&v70 + 1) = v41;
        *(_QWORD *)&v70 = v68;
        v69 = v70 >> 61;
        v71 = v68 & 0x1FFFFFFFFFFFFFFFLL | ((unsigned __int64)(unsigned __int8)v69 << 61);
        v41 = v69 >> 3;
        v31 = v71;
        goto LABEL_102;
      }
      goto LABEL_213;
    }
    if ( !v39 )
      goto LABEL_154;
LABEL_149:
    v61 = v4 << 61;
    v41 = v4 >> 3;
    if ( !v24 )
    {
      v31 = *(_QWORD *)&a1 & 0x1FFFFFFFFFFFFFFFLL | v61;
      goto LABEL_102;
    }
    goto LABEL_205;
  }
  if ( v5 )
  {
    v35 = v6 - v5;
    v4 |= 0x8000000000000uLL;
LABEL_111:
    if ( v6 != 0x7FFF )
    {
      if ( v35 > 116 )
      {
        v51 = (v4 | v11) != 0;
      }
      else if ( v35 > 63 )
      {
        v62 = 0x80 - v35;
        v63 = v35 - 64;
        v64 = v11 | (v4 << v62);
        if ( v63 )
          v11 = v64;
        v51 = (v11 != 0) | (v4 >> v63);
      }
      else
      {
        v50 = v4 >> v35;
        v51 = (v4 << (64 - (unsigned __int8)v35)) | (v11 >> v35) | (v11 << (64 - (unsigned __int8)v35) != 0);
        v9 -= v50;
      }
      LOWORD(v8) = *((_QWORD *)&a2 + 1) >> 63;
      v4 = (__PAIR128__(v9, v13) - v51) >> 64;
      v11 = v13 - v51;
      v10 = HIWORD(*((_QWORD *)&a2 + 1)) & 0x7FFFLL;
      v7 = *((_QWORD *)&a2 + 1) >> 63;
LABEL_10:
      v18 = v4 & 0x7FFFFFFFFFFFFLL;
      if ( (v4 & 0x8000000000000LL) == 0 )
        goto LABEL_46;
LABEL_11:
      if ( v18 )
      {
        v19 = __clz(v18) - 12;
      }
      else
      {
        v44 = __clz(v11);
        v19 = v44 + 52;
        if ( v44 + 52 > 63 )
        {
          v21 = v11 << ((unsigned __int8)v44 - 12);
          goto LABEL_14;
        }
      }
      v20 = v18 << v19;
      v18 = v11 << v19;
      v21 = (v11 >> -(char)v19) | v20;
LABEL_14:
      if ( v19 >= v10 )
      {
        v22 = v19 - v10;
        v23 = v22 + 1;
        if ( v22 + 1 <= 63 )
        {
          v4 = v21 >> v23;
          v11 = (v21 << (63 - (unsigned __int8)v22))
              | (v18 >> ((unsigned __int8)v22 + 1))
              | (v18 << (63 - (unsigned __int8)v22) != 0);
LABEL_17:
          v24 = v11 | v4;
          goto LABEL_18;
        }
        v53 = v22 - 63;
        if ( v23 != 64 )
          v18 |= v21 << (0x80 - (unsigned __int8)v23);
        v4 = 0;
        v11 = (v18 != 0) | (v21 >> v53);
        v24 = v11;
LABEL_18:
        if ( v24 )
          goto LABEL_19;
        goto LABEL_48;
      }
      v10 -= v19;
      v4 = v21 & 0xFFF7FFFFFFFFFFFFLL;
      v11 = v18;
LABEL_46:
      v24 = v11 | v4;
      v25 = v11 & 7;
      v26 = 0;
      if ( v10 )
        goto LABEL_20;
      if ( v24 )
      {
LABEL_19:
        v25 = v11 & 7;
        v10 = 0;
        v26 = 1;
LABEL_20:
        if ( v25 )
        {
          v27 = StatusReg & 0xC00000;
          if ( (StatusReg & 0xC00000) == 0x400000 )
          {
            v14 = 16;
            if ( !v7 )
            {
LABEL_89:
              v48 = __CFADD__(v11, 8);
              v11 += 8LL;
              if ( v48 )
                ++v4;
            }
          }
          else
          {
            if ( v27 != 0x800000 )
            {
              if ( v27 )
              {
                v28 = v4 & 0x8000000000000LL;
                v14 = 16;
                if ( v26 )
                  v14 = 24;
                goto LABEL_26;
              }
              v14 = 16;
              if ( (v11 & 0xF) != 4 )
              {
                v48 = __CFADD__(v11, 4);
                v11 += 4LL;
                if ( v48 )
                  ++v4;
              }
              goto LABEL_91;
            }
            v14 = 16;
            if ( v7 )
              goto LABEL_89;
          }
LABEL_91:
          v28 = v4 & 0x8000000000000LL;
          if ( v26 )
            v14 |= 8u;
          goto LABEL_26;
        }
        v28 = v4 & 0x8000000000000LL;
        v14 = 0;
        if ( !v26 )
          goto LABEL_26;
LABEL_169:
        v14 = 0;
        if ( (StatusReg & 0x800) != 0 )
          v14 = 8;
LABEL_26:
        if ( v28 )
        {
LABEL_27:
          v29 = v10 + 1;
          if ( v29 != 0x7FFF )
          {
            v30 = (v4 >> 3) & 0xFFFFFFFFFFFFLL;
            *((_QWORD *)&v32 + 1) = v4;
            *(_QWORD *)&v32 = v11;
            v31 = v32 >> 3;
            v33 = v29 & 0x7FFF;
            goto LABEL_29;
          }
          v43 = StatusReg & 0xC00000;
          goto LABEL_65;
        }
        goto LABEL_62;
      }
LABEL_48:
      v31 = 0;
      LOWORD(v10) = 0;
      v14 = 0;
LABEL_49:
      v30 = v24 & 0xFFFFFFFFFFFFLL;
      v33 = v10 & 0x7FFF;
      goto LABEL_29;
    }
    if ( v9 | v13 )
    {
      v31 = *(_QWORD *)&a2 & 0x1FFFFFFFFFFFFFFFLL | ((unsigned __int64)(unsigned __int8)v9 << 61);
      LOWORD(v8) = *((_QWORD *)&a2 + 1) >> 63;
      v14 = ((unsigned __int8)(v9 >> 50) ^ 1) & 1;
      v41 = v9 >> 3;
      goto LABEL_102;
    }
    v3 = *((_QWORD *)&a2 + 1) >> 63;
LABEL_132:
    result.n128_u64[0] = 0;
    result.n128_u64[1] = (v3 << 63) | 0x7FFF000000000000LL;
    return result;
  }
  if ( __PAIR128__(v4, v11) != 0 )
  {
    v35 = ~v14;
    if ( !v35 )
    {
      LOWORD(v8) = *((_QWORD *)&a2 + 1) >> 63;
      v4 = (__PAIR128__(v9, v13) - __PAIR128__(v4, v11)) >> 64;
      v11 = v13 - v11;
      v10 = HIWORD(*((_QWORD *)&a2 + 1)) & 0x7FFFLL;
      v7 = *((_QWORD *)&a2 + 1) >> 63;
      goto LABEL_10;
    }
    goto LABEL_111;
  }
  if ( v6 != 0x7FFF )
  {
    LOWORD(v8) = *((_QWORD *)&a2 + 1) >> 63;
    v4 = *(__int128 *)&a2 >> 61;
    v11 = 8LL * *(_QWORD *)&a2;
    v10 = HIWORD(*((_QWORD *)&a2 + 1)) & 0x7FFFLL;
    v7 = *((_QWORD *)&a2 + 1) >> 63;
    goto LABEL_46;
  }
  if ( __PAIR128__(v9, v13) == 0 )
  {
    LOWORD(v8) = *((_QWORD *)&a2 + 1) >> 63;
    goto LABEL_120;
  }
  LOWORD(v8) = *((_QWORD *)&a2 + 1) >> 63;
  v11 = 8LL * *(_QWORD *)&a2;
  v14 = ((unsigned __int8)(v9 >> 50) ^ 1) & 1;
  v4 = *(__int128 *)&a2 >> 61;
LABEL_61:
  v10 = 0x7FFF;
LABEL_62:
  v41 = v4 >> 3;
  *((_QWORD *)&v42 + 1) = v4;
  *(_QWORD *)&v42 = v11;
  v31 = v42 >> 3;
  v24 = v4 >> 3;
  if ( v10 != 0x7FFF )
    goto LABEL_49;
LABEL_102:
  if ( v41 | v31 )
  {
LABEL_103:
    v33 = 0x7FFF;
    v30 = v41 & 0x7FFFFFFFFFFFLL | 0x800000000000LL;
    goto LABEL_29;
  }
  v31 = 0;
  v33 = 0x7FFF;
  v30 = 0;
LABEL_29:
  result.n128_u64[0] = v31;
  result.n128_u64[1] = v30 & 0xFFFFFFFFFFFFLL | ((unsigned __int64)(unsigned __int16)(v33 | ((_WORD)v8 << 15)) << 48);
  if ( v14 )
  {
LABEL_72:
    v76 = result;
    _sfp_handle_exceptions();
    return v76;
  }
  return result;
}


/* Function: __multf3 @ 0x2D70 */
__n128 __fastcall _multf3(long double a1, long double a2)
{
  unsigned __int64 v2; // x7
  unsigned __int64 StatusReg; // x6
  unsigned __int64 v4; // x9
  __int64 v5; // x3
  __int128 v6; // t2
  __int64 v7; // x3
  unsigned __int64 v8; // x8
  __int64 v9; // x17
  __int64 v10; // x1
  int v11; // w0
  unsigned __int64 v12; // x12
  int v13; // w16
  unsigned __int64 v14; // x5
  __int64 v15; // x13
  __int128 v16; // t2
  __int64 v17; // x13
  int v18; // w11
  __int64 v19; // x10
  unsigned __int64 v20; // x2
  __int64 v21; // x3
  __int64 v22; // x4
  __int16 v23; // w1
  __int64 v24; // x4
  __n128 result; // q0
  __int64 v26; // x1
  __int64 v27; // x30
  unsigned __int64 v28; // x17
  __int64 v29; // x1
  unsigned __int64 v30; // x21
  unsigned __int64 v31; // x3
  unsigned __int64 v32; // x19
  unsigned __int64 v33; // x20
  unsigned __int64 v34; // x7
  __int64 v35; // x5
  unsigned __int64 v36; // x15
  __int64 v37; // x16
  unsigned __int64 v38; // x12
  __int64 v39; // x18
  unsigned __int64 v40; // x4
  unsigned __int64 v41; // x8
  bool v42; // cc
  unsigned __int64 v43; // x12
  unsigned __int64 v44; // x19
  unsigned __int64 v45; // x30
  unsigned __int64 v46; // x1
  unsigned __int64 v47; // x17
  unsigned __int64 v48; // x15
  unsigned __int64 v49; // x9
  unsigned __int64 v50; // x7
  unsigned __int64 v51; // x5
  unsigned __int64 v52; // x3
  __int64 v53; // x16
  unsigned __int64 v54; // x4
  unsigned __int64 v55; // x4
  unsigned __int64 v56; // x12
  unsigned __int64 v57; // x1
  bool v58; // cf
  unsigned __int64 v59; // x1
  __int64 v60; // x14
  _BOOL8 v61; // x12
  unsigned __int64 v62; // x8
  unsigned __int64 v63; // x1
  unsigned __int64 v64; // x5
  __int64 v65; // x12
  bool v66; // zf
  unsigned __int64 v67; // x7
  unsigned __int64 v68; // x4
  __int64 v69; // x8
  unsigned __int64 v70; // x1
  __int64 v71; // x9
  unsigned __int64 v72; // x1
  __int64 v73; // x7
  bool v74; // zf
  __int64 v75; // x16
  unsigned __int64 v76; // x4
  __int128 v77; // t2
  __int64 v78; // x1
  __int64 v79; // x3
  __int128 v80; // t2
  unsigned __int64 v81; // x13
  __int64 v82; // x2
  unsigned __int64 v83; // x0
  __int64 v84; // x3
  __int64 v85; // x1
  unsigned __int64 v86; // x8
  unsigned __int64 v87; // x4
  __int64 v88; // x6
  __int128 v89; // t2
  unsigned __int64 v90; // x0
  unsigned __int64 v91; // x13
  __int64 v92; // x6
  __int128 v93; // t2
  __int64 v94; // x2
  __n128 v95; // [xsp+30h] [xbp+30h]

  v2 = *(_QWORD *)&a2;
  StatusReg = _ReadStatusReg(FPCR);
  v4 = *((_QWORD *)&a1 + 1) & 0xFFFFFFFFFFFFLL;
  v5 = HIWORD(*((_QWORD *)&a1 + 1)) & 0x7FFFLL;
  if ( !(_DWORD)v5 )
  {
    v8 = *(_QWORD *)&a1 | v4;
    if ( !(*(_QWORD *)&a1 | v4) )
    {
      v4 = 0;
      v10 = 4;
      v7 = 0;
      v9 = 1;
      v11 = 0;
      goto LABEL_4;
    }
    if ( v4 )
    {
      v83 = __clz(v4);
      LOBYTE(v84) = v83 - 15;
    }
    else
    {
      v90 = __clz(*(unsigned __int64 *)&a1);
      v84 = v90 + 49;
      v83 = v90 + 64;
      if ( v84 > 60 )
      {
        v8 = 0;
        v4 = *(_QWORD *)&a1 << ((unsigned __int8)v84 - 61);
        goto LABEL_87;
      }
    }
    v4 = (*(_QWORD *)&a1 >> (61 - (unsigned __int8)v84)) | (v4 << ((unsigned __int8)v84 + 3));
    v8 = *(_QWORD *)&a1 << ((unsigned __int8)v84 + 3);
LABEL_87:
    v10 = 0;
    v7 = -16367LL - v83;
    v9 = 0;
    v11 = 0;
    goto LABEL_4;
  }
  if ( (_DWORD)v5 == 0x7FFF )
  {
    v8 = *(_QWORD *)&a1 | v4;
    if ( *(_QWORD *)&a1 | v4 )
    {
      v8 = *(_QWORD *)&a1;
      v10 = 12;
      v11 = ((unsigned __int8)(v4 >> 47) ^ 1) & 1;
      v7 = 0x7FFF;
      v9 = 3;
    }
    else
    {
      v4 = 0;
      v10 = 8;
      v7 = 0x7FFF;
      v9 = 2;
      v11 = 0;
    }
  }
  else
  {
    *((_QWORD *)&v6 + 1) = *((_QWORD *)&a1 + 1) & 0xFFFFFFFFFFFFLL;
    *(_QWORD *)&v6 = *(_QWORD *)&a1;
    v4 = (v6 >> 61) | 0x8000000000000LL;
    v7 = (HIWORD(a1) & 0x7FFF) - 0x3FFFLL;
    v8 = 8LL * *(_QWORD *)&a1;
    v9 = 0;
    v10 = 0;
    v11 = 0;
  }
LABEL_4:
  v12 = *((_QWORD *)&a2 + 1) & 0xFFFFFFFFFFFFLL;
  v13 = *((_QWORD *)&a2 + 1) >> 63;
  v14 = *((_QWORD *)&a2 + 1) >> 63;
  v15 = HIWORD(*((_QWORD *)&a2 + 1)) & 0x7FFFLL;
  if ( !(_DWORD)v15 )
  {
    if ( !(*(_QWORD *)&a2 | v12) )
    {
      v17 = v7;
      v10 |= 1uLL;
      LOWORD(v18) = (a1 < 0.0) ^ (a2 < 0.0);
      v19 = v7 + 1;
      v20 = (a1 < 0.0) ^ (unsigned __int8)(a2 < 0.0);
      v12 = 0;
      v2 = 0;
      v21 = 1;
      if ( v10 <= 10 )
        goto LABEL_12;
LABEL_7:
      if ( v10 == 11 )
      {
        v18 = *((_QWORD *)&a2 + 1) >> 63;
        v20 = *((_QWORD *)&a2 + 1) >> 63;
LABEL_29:
        if ( v21 == 3 )
        {
          v8 = v2;
          v24 = v12 & 0x7FFFFFFFFFFFLL | 0x800000000000LL;
          v23 = 0x7FFF;
          goto LABEL_17;
        }
        goto LABEL_15;
      }
      goto LABEL_8;
    }
    if ( v12 )
    {
      v81 = __clz(v12);
      LOBYTE(v82) = v81 - 15;
    }
    else
    {
      v91 = __clz(*(unsigned __int64 *)&a2);
      v82 = v91 + 49;
      v81 = v91 + 64;
      if ( v82 > 60 )
      {
        v2 = 0;
        v12 = *(_QWORD *)&a2 << ((unsigned __int8)v82 - 61);
LABEL_81:
        v17 = v7 - v81 - 16367;
        LOWORD(v18) = (a1 < 0.0) ^ (a2 < 0.0);
        v19 = v17 + 1;
        v20 = (a1 < 0.0) ^ (unsigned __int8)(a2 < 0.0);
        v21 = 0;
        if ( v10 <= 10 )
          goto LABEL_12;
        goto LABEL_7;
      }
    }
    v12 = (*(_QWORD *)&a2 >> (61 - (unsigned __int8)v82)) | (v12 << ((unsigned __int8)v82 + 3));
    v2 = *(_QWORD *)&a2 << ((unsigned __int8)v82 + 3);
    goto LABEL_81;
  }
  if ( (_DWORD)v15 == 0x7FFF )
  {
    v22 = *(_QWORD *)&a2 | v12;
    v17 = v7 + 0x7FFF;
    if ( *(_QWORD *)&a2 | v12 )
    {
      v10 |= 3uLL;
      v19 = v7 + 0x8000;
      LOWORD(v18) = (a1 < 0.0) ^ (a2 < 0.0);
      if ( (*((_QWORD *)&a2 + 1) & 0x800000000000LL) == 0 )
        v11 = 1;
      v20 = (a1 < 0.0) ^ (unsigned __int8)(a2 < 0.0);
      v21 = 3;
      if ( v10 <= 10 )
      {
LABEL_22:
        v26 = 1LL << v10;
        if ( (v26 & 0x530) != 0 )
        {
          LOWORD(v13) = v18;
          v14 = v20;
        }
        else
        {
          if ( (v26 & 0x240) != 0 )
          {
            v11 = 1;
            LOWORD(v18) = 0;
            v24 = 0xFFFFFFFFFFFFLL;
            v8 = -1;
            v23 = 0x7FFF;
            goto LABEL_17;
          }
          if ( (v26 & 0x88) == 0 )
            goto LABEL_33;
          v4 = v12;
          v8 = v2;
          v9 = v21;
        }
LABEL_27:
        LOWORD(v18) = v13;
        if ( v9 != 2 )
        {
          v12 = v4;
          v2 = v8;
          v21 = v9;
          v20 = v14;
          goto LABEL_29;
        }
LABEL_32:
        v23 = 0x7FFF;
        v24 = 0;
        v8 = 0;
        goto LABEL_17;
      }
      v22 = *((_QWORD *)&a2 + 1) & 0xFFFFFFFFFFFFLL;
      v94 = 3;
    }
    else
    {
      v10 |= 2uLL;
      LOWORD(v18) = (a1 < 0.0) ^ (a2 < 0.0);
      v19 = v7 + 0x8000;
      v20 = (a1 < 0.0) ^ (unsigned __int8)(a2 < 0.0);
      v2 = 0;
      if ( v10 <= 10 )
      {
        v12 = 0;
        v21 = 2;
        goto LABEL_12;
      }
      v94 = 2;
    }
    if ( v10 == 15 )
    {
      if ( (v4 & 0x800000000000LL) == 0 || (v22 & 0x800000000000LL) != 0 )
      {
        v18 = *((_QWORD *)&a1 + 1) >> 63;
        v24 = v4 & 0x7FFFFFFFFFFFLL | 0x800000000000LL;
        v23 = 0x7FFF;
      }
      else
      {
        v18 = *((_QWORD *)&a2 + 1) >> 63;
        v24 = v22 & 0x7FFFFFFFFFFFLL | 0x800000000000LL;
        v8 = v2;
        v23 = 0x7FFF;
      }
      goto LABEL_17;
    }
    if ( v10 != 11 )
    {
LABEL_8:
      v13 = *((_QWORD *)&a1 + 1) >> 63;
      v14 = *((_QWORD *)&a1 + 1) >> 63;
      goto LABEL_27;
    }
    v4 = v22;
    v8 = v2;
    v9 = v94;
    goto LABEL_27;
  }
  *((_QWORD *)&v16 + 1) = *((_QWORD *)&a2 + 1) & 0xFFFFFFFFFFFFLL;
  *(_QWORD *)&v16 = *(_QWORD *)&a2;
  v17 = (HIWORD(a2) & 0x7FFF) - 0x3FFFLL + v7;
  LOWORD(v18) = (a1 < 0.0) ^ (a2 < 0.0);
  v12 = (v16 >> 61) | 0x8000000000000LL;
  v2 = 8LL * *(_QWORD *)&a2;
  v19 = v17 + 1;
  v20 = (a1 < 0.0) ^ (unsigned __int8)(a2 < 0.0);
  v21 = 0;
  if ( v10 > 10 )
    goto LABEL_7;
LABEL_12:
  if ( v10 > 2 )
    goto LABEL_22;
  if ( (unsigned __int64)(v10 - 1) <= 1 )
  {
    if ( v21 != 2 )
    {
LABEL_15:
      if ( v21 == 1 )
      {
        v23 = 0;
        v24 = 0;
        v8 = 0;
        goto LABEL_17;
      }
      goto LABEL_68;
    }
    goto LABEL_32;
  }
LABEL_33:
  v27 = (unsigned int)v2;
  v28 = HIDWORD(v8);
  v29 = (unsigned int)v12;
  v8 = (unsigned int)v8;
  v30 = HIDWORD(v2);
  v31 = HIDWORD(v12);
  v32 = v28 * (unsigned int)v2;
  v33 = HIDWORD(v4);
  v34 = v28 * (unsigned int)v12;
  v35 = (unsigned int)v4;
  v36 = (unsigned int)v8 * (unsigned __int64)(unsigned int)v12;
  v37 = (unsigned int)(v27 * v8);
  v38 = v34 + HIDWORD(v12) * (unsigned int)v8;
  v39 = v28 * v30;
  v40 = v32 + v30 * v8 + ((v27 * v8) >> 32);
  v41 = v27 * (unsigned int)v4;
  v42 = v32 > v40;
  v43 = v38 + HIDWORD(v36);
  v44 = HIDWORD(v4) * v27;
  v45 = HIDWORD(v4) * v29;
  if ( v42 )
    v39 = v28 * v30 + 0x100000000LL;
  v46 = (unsigned int)v4 * v29;
  v42 = v34 > v43;
  v47 = v28 * v31;
  v48 = (unsigned int)v36 + (v43 << 32);
  v49 = v30 * v33;
  v50 = v44 + v30 * v35 + HIDWORD(v41);
  v51 = v45 + v31 * v35 + HIDWORD(v46);
  v52 = v31 * v33;
  v53 = v37 + (v40 << 32);
  v54 = v48 + HIDWORD(v40);
  if ( v42 )
    v47 += 0x100000000LL;
  v55 = v54 + v39;
  if ( v44 > v50 )
    v49 += 0x100000000LL;
  v56 = v47 + HIDWORD(v43);
  v57 = (unsigned int)v46 + (v51 << 32);
  if ( v45 > v51 )
    v52 += 0x100000000LL;
  v58 = __CFADD__(v57, v56);
  v59 = v57 + v56;
  v60 = v58;
  v61 = v55 < v48;
  v62 = (unsigned int)v41 + (v50 << 32);
  v58 = __CFADD__(v59, v61);
  v63 = v59 + v61;
  v64 = HIDWORD(v51);
  v65 = v58;
  if ( v60 )
    v66 = 0;
  else
    v66 = v65 == 0;
  v67 = v49 + HIDWORD(v50);
  if ( !v66 )
    ++v64;
  v58 = __CFADD__(v55, v62);
  v68 = v55 + v62;
  v69 = v58;
  v58 = __CFADD__(v63, v67);
  v70 = v63 + v67;
  v71 = v58;
  v58 = __CFADD__(v70, v69);
  v72 = v70 + v69;
  v73 = v58;
  if ( v71 )
    v74 = 0;
  else
    v74 = v73 == 0;
  v75 = v53 | (v68 << 13);
  if ( !v74 )
    ++v52;
  v76 = (v75 != 0) | (v68 >> 51);
  v2 = v76 | (v72 << 13);
  *((_QWORD *)&v77 + 1) = v52 + v64;
  *(_QWORD *)&v77 = v72;
  v12 = v77 >> 51;
  if ( ((v52 + v64) & 0x8000000000LL) != 0 )
  {
    v2 = v76 & 1 | ((v76 | (v72 << 13)) >> 1) | (v12 << 63);
    v12 >>= 1;
  }
  else
  {
    v19 = v17;
  }
LABEL_68:
  v78 = v19 + 0x3FFF;
  if ( v19 + 0x3FFF > 0 )
  {
    if ( (v2 & 7) != 0 )
    {
      v79 = StatusReg & 0xC00000;
      v11 |= 0x10u;
      if ( (StatusReg & 0xC00000) == 0x400000 )
      {
        if ( !v20 )
          goto LABEL_137;
      }
      else
      {
        if ( v79 != 0x800000 )
        {
          if ( !v79 && (v2 & 0xF) != 4 )
          {
            v58 = __CFADD__(v2, 4);
            v2 += 4LL;
            if ( v58 )
              ++v12;
          }
          goto LABEL_73;
        }
        if ( v20 )
        {
LABEL_137:
          v58 = __CFADD__(v2, 8);
          v2 += 8LL;
          if ( v58 )
            ++v12;
        }
      }
    }
LABEL_73:
    if ( (v12 & 0x10000000000000LL) != 0 )
    {
      v12 &= ~0x10000000000000uLL;
      v78 = v19 + 0x4000;
    }
    if ( v78 <= 32766 )
    {
      v24 = (v12 >> 3) & 0xFFFFFFFFFFFFLL;
      *((_QWORD *)&v80 + 1) = v12;
      *(_QWORD *)&v80 = v2;
      v8 = v80 >> 3;
      v23 = v78 & 0x7FFF;
      goto LABEL_17;
    }
    v8 = StatusReg & 0xC00000;
    if ( (StatusReg & 0xC00000) == 0x400000 )
    {
      v24 = 0xFFFFFFFFFFFFLL;
      if ( v20 )
        v23 = 32766;
      else
        v23 = 0x7FFF;
      if ( v20 )
      {
        v8 = -1;
      }
      else
      {
        v24 = 0;
        v8 = 0;
      }
    }
    else if ( v8 == 0x800000 )
    {
      v24 = 0xFFFFFFFFFFFFLL;
      if ( v20 )
        v23 = 0x7FFF;
      else
        v23 = 32766;
      if ( v20 )
      {
        v24 = 0;
        v8 = 0;
      }
      else
      {
        v8 = -1;
      }
    }
    else
    {
      v23 = 0x7FFF;
      v24 = 0;
      if ( v8 )
      {
        v23 = 32766;
        v24 = 0xFFFFFFFFFFFFLL;
        v8 = -1;
      }
    }
LABEL_110:
    result.n128_u64[0] = v8;
    result.n128_u64[1] = v24 & 0xFFFFFFFFFFFFLL
                       | ((unsigned __int64)(v23 & 0x7FFF) << 48) & 0x7FFFFFFFFFFFFFFFLL
                       | ((unsigned __int64)(unsigned __int8)v18 << 63);
    goto LABEL_111;
  }
  v85 = -16382 - v19;
  if ( -16382 - v19 > 116 )
  {
    v8 = v2 | v12;
    if ( v2 | v12 )
    {
      v92 = StatusReg & 0xC00000;
      v8 = 1 - v20;
      if ( v92 != 0x400000 )
      {
        if ( v92 == 0x800000 )
          v8 = v20;
        else
          v8 = 0;
      }
    }
    v23 = 0;
    v24 = 0;
    goto LABEL_110;
  }
  if ( v85 <= 63 )
  {
    v87 = v12 >> v85;
    v86 = (v12 << ((unsigned __int8)v19 + 62))
        | (v2 >> (2 - (unsigned __int8)v19))
        | (v2 << ((unsigned __int8)v19 + 62) != 0);
    if ( ((v12 << ((unsigned __int8)v19 + 62)) | (v2 >> (2 - (unsigned __int8)v19))) & 7
       | (v2 << ((unsigned __int8)v19 + 62) != 0) )
    {
LABEL_101:
      v88 = StatusReg & 0xC00000;
      if ( v88 == 0x400000 )
      {
        if ( v20 )
          goto LABEL_143;
      }
      else
      {
        if ( v88 != 0x800000 )
        {
          if ( v88 )
          {
            if ( (v87 & 0x8000000000000LL) == 0 )
            {
LABEL_105:
              *((_QWORD *)&v89 + 1) = v87;
              *(_QWORD *)&v89 = v86;
              v8 = v89 >> 3;
              v23 = 0;
              v24 = (v87 >> 3) & 0xFFFFFFFFFFFFLL;
              goto LABEL_110;
            }
LABEL_144:
            v23 = 1;
            v24 = 0;
            v8 = 0;
            goto LABEL_110;
          }
          if ( (v86 & 0xF) != 4 )
          {
            v58 = __CFADD__(v86, 4);
            v86 += 4LL;
            if ( v58 )
              ++v87;
            if ( (v87 & 0x8000000000000LL) == 0 )
              goto LABEL_105;
            goto LABEL_144;
          }
LABEL_143:
          if ( (v87 & 0x8000000000000LL) == 0 )
            goto LABEL_105;
          goto LABEL_144;
        }
        if ( !v20 )
        {
          if ( (v87 & 0x8000000000000LL) == 0 )
            goto LABEL_105;
          goto LABEL_144;
        }
      }
      v58 = __CFADD__(v86, 8);
      v86 += 8LL;
      if ( v58 )
        ++v87;
      goto LABEL_143;
    }
    if ( (v87 & 0x8000000000000LL) != 0 )
      goto LABEL_144;
  }
  else
  {
    if ( v85 != 64 )
      v2 |= v12 << ((unsigned __int8)v19 + 126);
    v86 = (v2 != 0) | (v12 >> (-62 - (unsigned __int8)v19));
    v87 = (v2 != 0) | (v12 >> (-62 - (unsigned __int8)v19)) & 7;
    if ( v87 )
    {
      v87 = 0;
      goto LABEL_101;
    }
  }
  v23 = 0;
  *((_QWORD *)&v93 + 1) = v87;
  *(_QWORD *)&v93 = v86;
  v8 = v93 >> 3;
  v24 = (v87 >> 3) & 0xFFFFFFFFFFFFLL;
  if ( (StatusReg & 0x800) != 0 )
    goto LABEL_110;
LABEL_17:
  result.n128_u64[0] = v8;
  result.n128_u64[1] = v24 & 0xFFFFFFFFFFFFLL | ((unsigned __int64)(unsigned __int16)(v23 | ((_WORD)v18 << 15)) << 48);
  if ( v11 )
  {
LABEL_111:
    v95 = result;
    _sfp_handle_exceptions();
    return v95;
  }
  return result;
}


/* Function: __sfp_handle_exceptions @ 0x3570 */
unsigned __int64 __fastcall _sfp_handle_exceptions(unsigned __int64 result)
{
  if ( (result & 1) != 0 )
    _ReadStatusReg(FPSR);
  if ( (result & 2) != 0 )
    _ReadStatusReg(FPSR);
  if ( (result & 4) != 0 )
    _ReadStatusReg(FPSR);
  if ( (result & 8) != 0 )
    _ReadStatusReg(FPSR);
  if ( (result & 0x10) != 0 )
    return _ReadStatusReg(FPSR);
  return result;
}


/* Function: .term_proc @ 0x35E0 */
void term_proc()
{
  ;
}


/* FAILED to decompile: memcpy @ 0x150B8 */

/* FAILED to decompile: __libc_start_main @ 0x150C0 */

/* FAILED to decompile: __cxa_finalize @ 0x150C8 */

/* FAILED to decompile: memset @ 0x150D0 */

/* FAILED to decompile: abort @ 0x150D8 */

/* FAILED to decompile: printf @ 0x150E0 */

/* FAILED to decompile: __gmon_start__ @ 0x150F0 */

/* Total functions decompiled: 69, failed: 7 */
