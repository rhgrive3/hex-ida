/*
 * Decompiled by IDA Pro 9.1 with Hex-Rays
 * Binary: /Users/eren/Desktop/Antigravity/compiler/build/arm64/1/1_gcc_O0_no_g
 * Processor: arm
 */

/* Function: .init_proc @ 0x918 */
__int64 init_proc()
{
  return call_weak_fn();
}


/* Function: sub_930 @ 0x930 */
void sub_930()
{
  JUMPOUT(0);
}


/* Function: _start @ 0xA00 */
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


/* Function: call_weak_fn @ 0xA34 */
void *call_weak_fn()
{
  void *result; // x0

  result = &_gmon_start__;
  if ( &_gmon_start__ )
    return (void *)__gmon_start__();
  return result;
}


/* Function: deregister_tm_clones @ 0xA50 */
char *deregister_tm_clones()
{
  return &_bss_start;
}


/* Function: register_tm_clones @ 0xA80 */
char *register_tm_clones()
{
  return &_bss_start;
}


/* Function: __do_global_dtors_aux @ 0xAC0 */
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


/* Function: frame_dummy @ 0xB10 */
// attributes: thunk
char *frame_dummy()
{
  return register_tm_clones();
}


/* Function: sequential_ops @ 0xB14 */
__int64 __fastcall sequential_ops(int a1, int a2, int a3)
{
  return (unsigned int)(2 * (a1 + a2) - a3);
}


/* Function: single_if @ 0xB5C */
__int64 __fastcall single_if(int a1)
{
  unsigned int v2; // [xsp+Ch] [xbp-4h]

  v2 = a1;
  if ( a1 > 0 )
    return (unsigned int)(2 * a1);
  return v2;
}


/* Function: if_else @ 0xB88 */
bool __fastcall if_else(int a1)
{
  return a1 > 0;
}


/* Function: nested_if_2 @ 0xBB0 */
__int64 __fastcall nested_if_2(__int64 result, int a2)
{
  if ( (int)result <= 0 )
    return 0;
  if ( a2 <= 0 )
    return (unsigned int)result;
  return (unsigned int)(result + a2);
}


/* Function: nested_if_deep @ 0xBF8 */
__int64 __fastcall nested_if_deep(int a1, int a2, int a3, int a4, int a5)
{
  if ( a1 <= 0 )
    return 0;
  if ( a2 <= 0 )
    return 1;
  if ( a3 <= 0 )
    return 2;
  if ( a4 <= 0 )
    return 3;
  if ( a5 <= 0 )
    return 4;
  return 5;
}


/* Function: if_elseif_chain @ 0xC80 */
__int64 __fastcall if_elseif_chain(int a1)
{
  switch ( a1 )
  {
    case 0:
      return 10;
    case 1:
      return 20;
    case 2:
      return 30;
  }
  return 0xFFFFFFFFLL;
}


/* Function: if_elseif_long @ 0xCD0 */
__int64 __fastcall if_elseif_long(int a1)
{
  switch ( a1 )
  {
    case 0:
      return 100;
    case 1:
      return 200;
    case 2:
      return 300;
    case 3:
      return 400;
    case 4:
      return 500;
  }
  return 0xFFFFFFFFLL;
}


/* Function: switch_small @ 0xD48 */
__int64 __fastcall switch_small(int a1)
{
  if ( a1 == 3 )
    return 2;
  if ( a1 <= 3 )
  {
    switch ( a1 )
    {
      case 2:
        return 50;
      case 0:
        return 15;
      case 1:
        return 5;
    }
  }
  return 0xFFFFFFFFLL;
}


/* Function: switch_large @ 0xDF8 */
__int64 __fastcall switch_large(int a1)
{
  if ( a1 == 9 )
    return 90;
  if ( a1 <= 9 )
  {
    switch ( a1 )
    {
      case 8:
        return 80;
      case 7:
        return 70;
      case 6:
        return 60;
      case 5:
        return 50;
      case 4:
        return 40;
      case 3:
        return 30;
      case 2:
        return 20;
      case 0:
        return 0;
      case 1:
        return 10;
    }
  }
  return 0xFFFFFFFFLL;
}


/* Function: switch_default @ 0xF38 */
__int64 __fastcall switch_default(int a1)
{
  if ( a1 == 3 )
    return 300;
  if ( a1 > 3 )
    return 0;
  if ( a1 == 1 )
    return 100;
  if ( a1 == 2 )
    return 200;
  else
    return 0;
}


/* Function: switch_fallthrough @ 0xF98 */
__int64 __fastcall switch_fallthrough(int a1)
{
  int v2; // [xsp+1Ch] [xbp-4h]

  v2 = 0;
  if ( a1 == 3 )
  {
    v2 = 12;
LABEL_7:
    v2 += 2 * a1;
    return (unsigned int)(v2 + a1);
  }
  if ( a1 > 3 )
    return (unsigned int)-1;
  if ( a1 != 1 )
  {
    if ( a1 != 2 )
      return (unsigned int)-1;
    goto LABEL_7;
  }
  return (unsigned int)(v2 + a1);
}


/* Function: loop_for_fixed @ 0x1028 */
__int64 __fastcall loop_for_fixed(int a1)
{
  unsigned int v2; // [xsp+18h] [xbp-8h]
  int i; // [xsp+1Ch] [xbp-4h]

  v2 = 0;
  for ( i = 0; i < a1; ++i )
    v2 += i;
  return v2;
}


/* Function: loop_while @ 0x1074 */
__int64 __fastcall loop_while(int a1)
{
  int v3; // [xsp+1Ch] [xbp-4h]

  v3 = 0;
  while ( a1 )
  {
    a1 /= 10;
    ++v3;
  }
  if ( v3 <= 0 )
    return 1;
  else
    return (unsigned int)v3;
}


/* Function: loop_dowhile @ 0x10DC */
__int64 __fastcall loop_dowhile(int a1)
{
  unsigned int v3; // [xsp+1Ch] [xbp-4h]

  v3 = 0;
  do
  {
    a1 /= 10;
    ++v3;
  }
  while ( a1 );
  return v3;
}


/* Function: loop_nested @ 0x1130 */
__int64 __fastcall loop_nested(int a1, int a2)
{
  unsigned int v3; // [xsp+14h] [xbp-Ch]
  int i; // [xsp+18h] [xbp-8h]
  int j; // [xsp+1Ch] [xbp-4h]

  v3 = 0;
  for ( i = 0; i < a1; ++i )
  {
    for ( j = 0; j < a2; ++j )
      ++v3;
  }
  return v3;
}


/* Function: loop_break @ 0x11A0 */
__int64 __fastcall loop_break(int a1)
{
  __int64 result; // x0
  int i; // [xsp+28h] [xbp+28h]
  _QWORD v3[2]; // [xsp+30h] [xbp+30h]
  int v4; // [xsp+40h] [xbp+40h]

  v3[0] = 0x140000000ALL;
  v3[1] = 0x280000001ELL;
  v4 = 50;
  for ( i = 0; i < 5; ++i )
  {
    if ( a1 == *((_DWORD *)v3 + i) )
    {
      LODWORD(result) = i;
      return (unsigned int)result;
    }
  }
  LODWORD(result) = -1;
  return (unsigned int)result;
}


/* Function: loop_continue @ 0x1264 */
__int64 __fastcall loop_continue(int a1)
{
  unsigned int v2; // [xsp+18h] [xbp-8h]
  int i; // [xsp+1Ch] [xbp-4h]

  v2 = 0;
  for ( i = 1; i <= a1; ++i )
  {
    if ( (i & 1) != 0 )
      v2 += i;
  }
  return v2;
}


/* Function: goto_forward @ 0x12CC */
__int64 __fastcall goto_forward(int a1)
{
  int v2; // [xsp+1Ch] [xbp-4h]

  if ( a1 <= 0 )
    v2 = a1;
  else
    v2 = a1 * a1;
  return (unsigned int)(2 * v2);
}


/* Function: goto_backward @ 0x1310 */
__int64 __fastcall goto_backward(int a1)
{
  unsigned int v2; // [xsp+18h] [xbp-8h]
  int i; // [xsp+1Ch] [xbp-4h]

  if ( a1 <= 0 )
    return 1;
  v2 = 1;
  for ( i = 1; i <= a1; ++i )
    v2 *= i;
  return v2;
}


/* Function: ternary_op @ 0x137C */
__int64 __fastcall ternary_op(__int64 result, int a2)
{
  if ( a2 < (int)result )
    return (unsigned int)result;
  else
    return (unsigned int)a2;
}


/* Function: test_control_flow_l1 @ 0x13A4 */
__int64 test_control_flow_l1()
{
  int v0; // w0
  int v1; // w0
  int v2; // w0
  _BOOL4 v3; // w0
  _BOOL4 v4; // w0
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
  int v15; // w0
  int v16; // w0
  int v17; // w0
  int v18; // w0
  int v19; // w0
  int v20; // w0
  int v21; // w0
  int v22; // w0
  int v23; // w0
  int v24; // w0
  int v25; // w0
  int v26; // w0

  puts(asc_29E8);
  v0 = sequential_ops(5, 7, 3);
  printf("CF-L1-01 (sequential_ops): %d\n", v0);
  v1 = single_if(10);
  printf("CF-L1-02 (single_if): %d\n", v1);
  v2 = single_if(-5);
  printf("CF-L1-02 (single_if): %d\n", v2);
  v3 = if_else(5);
  printf("CF-L1-03 (if_else): %d\n", v3);
  v4 = if_else(-3);
  printf("CF-L1-03 (if_else): %d\n", v4);
  v5 = nested_if_2(10, 5);
  printf("CF-L1-04 (nested_if_2): %d\n", v5);
  v6 = nested_if_2(10, -5);
  printf("CF-L1-04 (nested_if_2): %d\n", v6);
  v7 = nested_if_2(4294967286LL, 5);
  printf("CF-L1-04 (nested_if_2): %d\n", v7);
  v8 = nested_if_deep(1, 1, 1, 1, 1);
  printf("CF-L1-05 (nested_if_deep): %d\n", v8);
  v9 = if_elseif_chain(1);
  printf("CF-L1-06 (if_elseif_chain): %d\n", v9);
  v10 = if_elseif_long(3);
  printf("CF-L1-07 (if_elseif_long): %d\n", v10);
  v11 = switch_small(2);
  printf("CF-L1-08 (switch_small): %d\n", v11);
  v12 = switch_large(7);
  printf("CF-L1-09 (switch_large): %d\n", v12);
  v13 = switch_default(5);
  printf("CF-L1-10 (switch_default): %d\n", v13);
  v14 = switch_fallthrough(3);
  printf("CF-L1-11 (switch_fallthrough): %d\n", v14);
  v15 = loop_for_fixed(10);
  printf("CF-L1-12 (loop_for_fixed): %d\n", v15);
  v16 = loop_while(12345);
  printf("CF-L1-13 (loop_while): %d\n", v16);
  v17 = loop_dowhile(9876);
  printf("CF-L1-14 (loop_dowhile): %d\n", v17);
  v18 = loop_nested(3, 4);
  printf("CF-L1-15 (loop_nested): %d\n", v18);
  v19 = loop_break(30);
  printf("CF-L1-16 (loop_break): %d\n", v19);
  v20 = loop_break(99);
  printf("CF-L1-16 (loop_break): %d\n", v20);
  v21 = loop_continue(10);
  printf("CF-L1-17 (loop_continue): %d\n", v21);
  v22 = goto_forward(5);
  printf("CF-L1-18 (goto_forward): %d\n", v22);
  v23 = goto_forward(-3);
  printf("CF-L1-18 (goto_forward): %d\n", v23);
  v24 = goto_backward(5);
  printf("CF-L1-19 (goto_backward): %d\n", v24);
  v25 = ternary_op(10, 5);
  printf("CF-L1-20 (ternary_op): %d\n", v25);
  v26 = ternary_op(3, 8);
  return printf("CF-L1-20 (ternary_op): %d\n", v26);
}


/* Function: loop_multi_exit @ 0x167C */
__int64 __fastcall loop_multi_exit(int a1)
{
  __int64 result; // x0
  int i; // [xsp+20h] [xbp+20h]
  int j; // [xsp+24h] [xbp+24h]
  _OWORD v4[3]; // [xsp+28h] [xbp+28h]

  v4[0] = xmmword_2C90;
  v4[1] = xmmword_2CA0;
  v4[2] = xmmword_2CB0;
  for ( i = 0; i <= 2; ++i )
  {
    for ( j = 0; j <= 3; ++j )
    {
      if ( a1 == *((_DWORD *)&v4[i] + j) )
      {
        LODWORD(result) = 10 * i + j;
        return (unsigned int)result;
      }
    }
  }
  LODWORD(result) = -1;
  return (unsigned int)result;
}


/* Function: infinite_loop @ 0x1778 */
__int64 __fastcall infinite_loop(_DWORD *a1)
{
  unsigned int v2; // [xsp+1Ch] [xbp-4h]

  v2 = 0;
  while ( *a1 != 1 )
  {
    if ( (int)++v2 > 1000 )
    {
      *a1 = 1;
      return v2;
    }
  }
  return v2;
}


/* Function: multi_return @ 0x17CC */
__int64 __fastcall multi_return(int a1)
{
  if ( a1 < 0 )
    return 0xFFFFFFFFLL;
  if ( 2 * a1 > 100 )
    return 4294967294LL;
  if ( (a1 & 1) != 0 )
    return (unsigned int)(a1 + 1);
  return (unsigned int)(2 * a1);
}


/* Function: conditional_return @ 0x1830 */
__int64 __fastcall conditional_return(int a1)
{
  if ( a1 > 0 )
    return (unsigned int)(2 * a1);
  if ( a1 >= 0 )
    return 0;
  return (unsigned int)-a1;
}


/* Function: duffs_device @ 0x1874 */
__int64 __fastcall duffs_device(_DWORD *a1, _DWORD *a2, int a3)
{
  int v4; // w0
  int v5; // w0
  _DWORD *v6; // x1
  _DWORD *v7; // x0
  _DWORD *v8; // x1
  _DWORD *v9; // x0
  _DWORD *v10; // x1
  _DWORD *v11; // x0
  _DWORD *v12; // x1
  _DWORD *v13; // x0
  _DWORD *v14; // x1
  _DWORD *v15; // x0
  _DWORD *v16; // x1
  _DWORD *v17; // x0
  _DWORD *v18; // x1
  _DWORD *v19; // x0
  _DWORD *v20; // x1
  _DWORD *v21; // x0
  int v24; // [xsp+2Ch] [xbp-4h]

  if ( a3 <= 0 )
    return 0xFFFFFFFFLL;
  v4 = a3 + 7;
  if ( a3 + 7 < 0 )
    v4 = a3 + 14;
  v24 = v4 >> 3;
  v5 = a3 & 7;
  switch ( v5 )
  {
    case 7:
      goto LABEL_13;
    case 6:
      goto LABEL_14;
    case 5:
      goto LABEL_15;
    case 4:
      goto LABEL_16;
    case 3:
      goto LABEL_17;
    case 2:
      goto LABEL_18;
  }
  if ( (a3 & 7) != 0 )
    goto LABEL_19;
  do
  {
    v6 = a2++;
    v7 = a1++;
    *v7 = *v6;
LABEL_13:
    v8 = a2++;
    v9 = a1++;
    *v9 = *v8;
LABEL_14:
    v10 = a2++;
    v11 = a1++;
    *v11 = *v10;
LABEL_15:
    v12 = a2++;
    v13 = a1++;
    *v13 = *v12;
LABEL_16:
    v14 = a2++;
    v15 = a1++;
    *v15 = *v14;
LABEL_17:
    v16 = a2++;
    v17 = a1++;
    *v17 = *v16;
LABEL_18:
    v18 = a2++;
    v19 = a1++;
    *v19 = *v18;
LABEL_19:
    v20 = a2++;
    v21 = a1++;
    *v21 = *v20;
    --v24;
  }
  while ( v24 > 0 );
  return (unsigned int)a3;
}


/* Function: loop_complex_cond @ 0x1A64 */
__int64 __fastcall loop_complex_cond(int a1)
{
  int v2; // [xsp+14h] [xbp-Ch]
  int i; // [xsp+1Ch] [xbp-4h]

  v2 = 0;
  for ( i = 0; v2 < a1 && i <= 9 && a1 > 0; ++i )
  {
    v2 += 2;
    --a1;
  }
  return (unsigned int)(v2 + a1 + i);
}


/* Function: loop_modify_var @ 0x1AE8 */
__int64 __fastcall loop_modify_var(int a1)
{
  unsigned int v2; // [xsp+18h] [xbp-8h]
  int i; // [xsp+1Ch] [xbp-4h]

  v2 = 0;
  for ( i = 0; i < a1; ++i )
  {
    v2 += i;
    if ( i > 5 )
      i += 2;
  }
  return v2;
}


/* Function: loop_external_state @ 0x1B4C */
__int64 __fastcall loop_external_state(_DWORD *a1)
{
  int i; // [xsp+1Ch] [xbp-4h]

  for ( i = 0; i <= 100; ++i )
  {
    if ( *a1 )
      break;
  }
  return (unsigned int)i;
}


/* Function: recursion_factorial @ 0x1B98 */
__int64 __fastcall recursion_factorial(int a1)
{
  if ( a1 > 1 )
    return (unsigned int)recursion_factorial((unsigned int)(a1 - 1)) * a1;
  else
    return 1;
}


/* Function: tail_recursion @ 0x1BD8 */
__int64 __fastcall tail_recursion(int a1, unsigned int a2)
{
  if ( a1 > 1 )
    return tail_recursion((unsigned int)(a1 - 1), a1 * a2);
  else
    return a2;
}


/* Function: indirect_recursion_a @ 0x1C24 */
__int64 __fastcall indirect_recursion_a(__int64 result, int a2)
{
  if ( a2 <= 0 )
    return (unsigned int)result;
  if ( (result & 1) != 0 )
    return indirect_recursion_b((unsigned int)(3 * result + 1), (unsigned int)(a2 - 1));
  return indirect_recursion_b((unsigned int)((int)result / 2), (unsigned int)(a2 - 1));
}


/* Function: indirect_recursion_b @ 0x1CB4 */
__int64 __fastcall indirect_recursion_b(__int64 result, int a2)
{
  if ( a2 > 0 )
    return indirect_recursion_a((unsigned int)(result + 1), a2 - 1);
  else
    return (unsigned int)result;
}


/* Function: call_func_ptr @ 0x1CFC */
__int64 __fastcall call_func_ptr(__int64 (__fastcall *a1)(_QWORD), unsigned int a2)
{
  return a1(a2);
}


/* Function: double_value @ 0x1D20 */
__int64 __fastcall double_value(int a1)
{
  return (unsigned int)(2 * a1);
}


/* Function: triple_value @ 0x1D38 */
__int64 __fastcall triple_value(int a1)
{
  return (unsigned int)(3 * a1);
}


/* Function: call_func_ptr_array @ 0x1D58 */
__int64 __fastcall call_func_ptr_array(unsigned int a1, unsigned int a2)
{
  __int64 result; // x0
  __int64 (__fastcall *v3[3])(); // [xsp+20h] [xbp+20h]

  v3[0] = off_14010[0];
  v3[1] = off_14018[0];
  v3[2] = off_14020[0];
  if ( a1 <= 2 )
    LODWORD(result) = ((__int64 (__fastcall *)(_QWORD))v3[a1])(a2);
  else
    LODWORD(result) = -1;
  return (unsigned int)result;
}


/* Function: call_virtual_func @ 0x1E04 */
__int64 __fastcall call_virtual_func(__int64 a1, int a2)
{
  return (unsigned int)(2 * a2);
}


/* Function: process_with_callback @ 0x1E20 */
__int64 __fastcall process_with_callback(__int64 a1, int a2, __int64 (__fastcall *a3)(_QWORD))
{
  unsigned int v7; // [xsp+38h] [xbp+38h]
  int i; // [xsp+3Ch] [xbp+3Ch]

  v7 = 0;
  for ( i = 0; i < a2; ++i )
    v7 += a3(*(unsigned int *)(a1 + 4LL * i));
  return v7;
}


/* Function: test_control_flow_l2 @ 0x1E94 */
void *test_control_flow_l2()
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
  int v15; // w0
  int v16; // w0
  int v17; // w0
  int v19; // [xsp+18h] [xbp+18h] BYREF
  int v20; // [xsp+1Ch] [xbp+1Ch] BYREF
  _QWORD v21[2]; // [xsp+20h] [xbp+20h] BYREF
  int v22; // [xsp+30h] [xbp+30h]
  _OWORD v23[2]; // [xsp+38h] [xbp+38h] BYREF
  _QWORD v24[4]; // [xsp+58h] [xbp+58h] BYREF

  puts(asc_2CC0);
  v0 = loop_multi_exit(7);
  printf("CF-L2-01 (loop_multi_exit): %d\n", v0);
  v19 = 0;
  v1 = infinite_loop(&v19);
  printf("CF-L2-02 (infinite_loop): %d\n", v1);
  v2 = multi_return(-5);
  printf("CF-L2-03 (multi_return): %d\n", v2);
  v3 = multi_return(100);
  printf("CF-L2-03 (multi_return): %d\n", v3);
  v4 = multi_return(3);
  printf("CF-L2-03 (multi_return): %d\n", v4);
  v5 = conditional_return(5);
  printf("CF-L2-04 (conditional_return): %d\n", v5);
  v6 = conditional_return(-5);
  printf("CF-L2-04 (conditional_return): %d\n", v6);
  v23[0] = xmmword_2EE0;
  v23[1] = xmmword_2EF0;
  memset(v24, 0, sizeof(v24));
  v7 = duffs_device(v24, v23, 8);
  printf("CF-L2-05 (duffs_device): %d\n", v7);
  v8 = loop_complex_cond(10);
  printf("CF-L2-06 (loop_complex_cond): %d\n", v8);
  v9 = loop_modify_var(10);
  printf("CF-L2-07 (loop_modify_var): %d\n", v9);
  v20 = 0;
  v10 = loop_external_state(&v20);
  printf("CF-L2-08 (loop_external_state): %d\n", v10);
  v11 = recursion_factorial(5);
  printf("CF-L2-09 (recursion_factorial): %d\n", v11);
  v12 = tail_recursion(5, 1u);
  printf("CF-L2-10 (tail_recursion): %d\n", v12);
  v13 = indirect_recursion_a(10, 3);
  printf("CF-L2-11 (indirect_recursion): %d\n", v13);
  v14 = call_func_ptr((__int64 (__fastcall *)(_QWORD))double_value, 5u);
  printf("CF-L2-12 (call_func_ptr): %d\n", v14);
  v15 = call_func_ptr_array(0, 5u);
  printf("CF-L2-13 (call_func_ptr_array): %d\n", v15);
  v16 = call_func_ptr_array(2u, 5u);
  printf("CF-L2-13 (call_func_ptr_array): %d\n", v16);
  v21[0] = 0x200000001LL;
  v21[1] = 0x400000003LL;
  v22 = 5;
  v17 = process_with_callback((__int64)v21, 5, (__int64 (__fastcall *)(_QWORD))double_value);
  printf("CF-L2-15 (process_with_callback): %d\n", v17);
  return &_stack_chk_guard;
}


/* Function: non_local_jump @ 0x210C */
__int64 __fastcall non_local_jump(int a1)
{
  if ( _setjmp(&jump_buffer) )
    return 0xFFFFFFFFLL;
  if ( a1 < 0 )
    longjmp(&jump_buffer, 1);
  if ( a1 > 100 )
    longjmp(&jump_buffer, 2);
  return (unsigned int)(2 * a1);
}


/* Function: cpp_exception @ 0x217C */
__int64 __fastcall cpp_exception(int a1)
{
  if ( a1 < 0 )
    return 0xFFFFFFFFLL;
  if ( a1 <= 100 )
    return (unsigned int)(2 * a1);
  return 4294967294LL;
}


/* Function: op_add @ 0x21BC */
__int64 __fastcall op_add(int a1, int a2)
{
  return (unsigned int)(a1 + a2);
}


/* Function: op_sub @ 0x21DC */
__int64 __fastcall op_sub(int a1, int a2)
{
  return (unsigned int)(a1 - a2);
}


/* Function: op_mul @ 0x21FC */
__int64 __fastcall op_mul(int a1, int a2)
{
  return (unsigned int)(a1 * a2);
}


/* Function: op_div @ 0x221C */
__int64 __fastcall op_div(int a1, int a2)
{
  if ( a2 )
    return (unsigned int)(a1 / a2);
  else
    return 0;
}


/* Function: op_mod @ 0x2250 */
__int64 __fastcall op_mod(int a1, int a2)
{
  if ( a2 )
    return (unsigned int)(a1 % a2);
  else
    return 0;
}


/* Function: op_and @ 0x2290 */
__int64 __fastcall op_and(int a1, unsigned int a2)
{
  return a1 & a2;
}


/* Function: op_or @ 0x22B0 */
__int64 __fastcall op_or(int a1, unsigned int a2)
{
  return a1 | a2;
}


/* Function: op_xor @ 0x22D0 */
__int64 __fastcall op_xor(int a1, unsigned int a2)
{
  return a1 ^ a2;
}


/* Function: op_shl @ 0x22F0 */
__int64 __fastcall op_shl(int a1, char a2)
{
  return (unsigned int)(a1 << a2);
}


/* Function: op_shr @ 0x2310 */
__int64 __fastcall op_shr(int a1, char a2)
{
  return (unsigned int)(a1 >> a2);
}


/* Function: large_jump_table @ 0x2330 */
__int64 __fastcall large_jump_table(unsigned int a1, unsigned int a2, unsigned int a3)
{
  __int64 result; // x0
  _OWORD v4[5]; // [xsp+28h] [xbp+28h]

  v4[0] = *(_OWORD *)off_14028;
  v4[1] = *(_OWORD *)off_14038;
  v4[2] = *(_OWORD *)off_14048;
  v4[3] = *(_OWORD *)off_14058;
  v4[4] = *(_OWORD *)off_14068;
  if ( a1 < 0xA )
    LODWORD(result) = (*((__int64 (__fastcall **)(_QWORD, _QWORD))v4 + (int)a1))(a2, a3);
  else
    LODWORD(result) = -1;
  return (unsigned int)result;
}


/* Function: conditional_func_ptr @ 0x23E8 */
__int64 __fastcall conditional_func_ptr(int a1, int a2)
{
  if ( !a1 )
    return double_value(a2);
  if ( a1 == 1 )
    return triple_value(a2);
  return recursion_factorial(a2);
}


/* Function: state_machine @ 0x2450 */
__int64 __fastcall state_machine(int a1, int a2)
{
  if ( a2 == 3 )
  {
    if ( a1 )
      return 3;
    else
      return 0;
  }
  else
  {
    if ( a2 > 3 )
      return 3;
    switch ( a2 )
    {
      case 2:
        return 2;
      case 0:
        return a1 == 1;
      case 1:
        if ( a1 == 2 )
        {
          return 2;
        }
        else if ( a1 == 99 )
        {
          return 3;
        }
        else
        {
          return 1;
        }
      default:
        return 3;
    }
  }
}


/* Function: state_idle @ 0x2524 */
bool __fastcall state_idle(int a1)
{
  return a1 == 1;
}


/* Function: state_processing @ 0x2544 */
__int64 __fastcall state_processing(int a1)
{
  if ( a1 == 2 )
    return 2;
  if ( a1 == 99 )
    return 3;
  return 1;
}


/* Function: state_done @ 0x2580 */
__int64 state_done()
{
  return 2;
}


/* Function: state_error @ 0x2594 */
__int64 __fastcall state_error(int a1)
{
  if ( a1 )
    return 3;
  else
    return 0;
}


/* Function: fsm_func_table @ 0x25BC */
__int64 __fastcall fsm_func_table(unsigned int a1, unsigned int a2)
{
  __int64 result; // x0
  _OWORD v3[2]; // [xsp+28h] [xbp+28h]

  v3[0] = *(_OWORD *)off_14078;
  v3[1] = *(_OWORD *)off_14088;
  if ( a2 < 4 )
    LODWORD(result) = (*((__int64 (__fastcall **)(_QWORD))v3 + (int)a2))(a1);
  else
    LODWORD(result) = 3;
  return (unsigned int)result;
}


/* Function: computed_goto @ 0x2660 */
__int64 __fastcall computed_goto(__int64 a1, unsigned int a2)
{
  _OWORD v3[2]; // [xsp+28h] [xbp+28h]

  v3[0] = *(_OWORD *)&off_14098;
  v3[1] = *(_OWORD *)&off_140A8;
  if ( a2 < 4 )
    __asm { BR              X0 }
  return 0xFFFFFFFFLL;
}


/* Function: obfuscated_cf @ 0x2720 */
__int64 __fastcall obfuscated_cf(int a1)
{
  int v2; // [xsp+1Ch] [xbp-4h]

  v2 = a1;
  if ( a1 * a1 < -1 )
    v2 = 2 * a1 + 1;
  return (unsigned int)(2 * v2);
}


/* Function: opaque_predicate @ 0x2768 */
__int64 __fastcall opaque_predicate(int a1)
{
  return (unsigned int)(2 * a1);
}


/* Function: overlapped_code @ 0x27A4 */
__int64 __fastcall overlapped_code(int a1)
{
  if ( (a1 & 1) != 0 )
    return (unsigned int)(3 * a1 + 1);
  else
    return (unsigned int)(a1 / 2);
}


/* Function: test_control_flow_l3 @ 0x27EC */
void *test_control_flow_l3()
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
  _DWORD v13[4]; // [xsp+18h] [xbp+18h] BYREF

  puts(asc_2F18);
  v0 = non_local_jump(5);
  printf("CF-L3-01 (non_local_jump): %d\n", v0);
  v1 = non_local_jump(-5);
  printf("CF-L3-01 (non_local_jump): %d\n", v1);
  v2 = cpp_exception(5);
  printf("CF-L3-02 (cpp_exception): %d\n", v2);
  v3 = cpp_exception(-5);
  printf("CF-L3-02 (cpp_exception): %d\n", v3);
  v4 = large_jump_table(0, 0xAu, 5u);
  printf("CF-L3-03 (large_jump_table): %d\n", v4);
  v5 = conditional_func_ptr(0, 5);
  printf("CF-L3-04 (conditional_func_ptr): %d\n", v5);
  v6 = state_machine(1, 0);
  printf("CF-L3-05 (state_machine): %d\n", v6);
  v7 = fsm_func_table(2u, 1u);
  printf("CF-L3-06 (fsm_func_table): %d\n", v7);
  v13[0] = 0;
  v13[1] = 1;
  v13[2] = 2;
  v13[3] = 3;
  v8 = computed_goto((__int64)v13, 2u);
  printf("CF-L3-07 (computed_goto): %d\n", v8);
  v9 = obfuscated_cf(5);
  printf("CF-L3-08 (obfuscated_cf): %d\n", v9);
  v10 = opaque_predicate(5);
  printf("CF-L3-09 (opaque_predicate): %d\n", v10);
  v11 = overlapped_code(5);
  printf("CF-L3-10 (overlapped_code): %d\n", v11);
  return &_stack_chk_guard;
}


/* Function: main @ 0x2994 */
int __fastcall main(int argc, const char **argv, const char **envp)
{
  test_control_flow_l1();
  test_control_flow_l2();
  test_control_flow_l3();
  return 0;
}


/* Function: .term_proc @ 0x29B4 */
void term_proc()
{
  ;
}


/* FAILED to decompile: _setjmp @ 0x14248 */

/* FAILED to decompile: __libc_start_main @ 0x14250 */

/* FAILED to decompile: __cxa_finalize @ 0x14258 */

/* FAILED to decompile: __stack_chk_fail @ 0x14260 */

/* FAILED to decompile: abort @ 0x14270 */

/* FAILED to decompile: puts @ 0x14278 */

/* FAILED to decompile: longjmp @ 0x14280 */

/* FAILED to decompile: printf @ 0x14288 */

/* FAILED to decompile: __gmon_start__ @ 0x14298 */

/* Total functions decompiled: 75, failed: 9 */
