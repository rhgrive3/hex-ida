/*
 * Decompiled by IDA Pro 9.1 with Hex-Rays
 * Binary: /Users/eren/Desktop/Antigravity/compiler/build/arm64/1/1_clang_O0_no_g
 * Processor: arm
 */

/* Function: .init_proc @ 0x860 */
__int64 init_proc()
{
  return call_weak_fn();
}


/* Function: sub_880 @ 0x880 */
void sub_880()
{
  JUMPOUT(0);
}


/* Function: _start @ 0x940 */
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


/* Function: call_weak_fn @ 0x974 */
void *call_weak_fn()
{
  void *result; // x0

  result = &_gmon_start__;
  if ( &_gmon_start__ )
    return (void *)__gmon_start__();
  return result;
}


/* Function: deregister_tm_clones @ 0x990 */
char *deregister_tm_clones()
{
  return &_bss_start;
}


/* Function: register_tm_clones @ 0x9C0 */
char *register_tm_clones()
{
  return &_bss_start;
}


/* Function: __do_global_dtors_aux @ 0xA00 */
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


/* Function: frame_dummy @ 0xA50 */
// attributes: thunk
char *frame_dummy()
{
  return register_tm_clones();
}


/* Function: sequential_ops @ 0xA54 */
__int64 __fastcall sequential_ops(int a1, int a2, int a3)
{
  return (unsigned int)(2 * (a1 + a2) - a3);
}


/* Function: single_if @ 0xA9C */
__int64 __fastcall single_if(int a1)
{
  unsigned int v2; // [xsp+Ch] [xbp-4h]

  v2 = a1;
  if ( a1 > 0 )
    return (unsigned int)(2 * a1);
  return v2;
}


/* Function: if_else @ 0xAD0 */
bool __fastcall if_else(int a1)
{
  return a1 > 0;
}


/* Function: nested_if_2 @ 0xB08 */
__int64 __fastcall nested_if_2(int a1, int a2)
{
  if ( a1 <= 0 )
  {
    return 0;
  }
  else if ( a2 <= 0 )
  {
    return (unsigned int)a1;
  }
  else
  {
    return (unsigned int)(a1 + a2);
  }
}


/* Function: nested_if_deep @ 0xB68 */
__int64 __fastcall nested_if_deep(int a1, int a2, int a3, int a4, int a5)
{
  if ( a1 <= 0 )
  {
    return 0;
  }
  else if ( a2 <= 0 )
  {
    return 1;
  }
  else if ( a3 <= 0 )
  {
    return 2;
  }
  else if ( a4 <= 0 )
  {
    return 3;
  }
  else if ( a5 <= 0 )
  {
    return 4;
  }
  else
  {
    return 5;
  }
}


/* Function: if_elseif_chain @ 0xC20 */
__int64 __fastcall if_elseif_chain(int a1)
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


/* Function: if_elseif_long @ 0xC90 */
__int64 __fastcall if_elseif_long(int a1)
{
  if ( a1 )
  {
    switch ( a1 )
    {
      case 1:
        return 200;
      case 2:
        return 300;
      case 3:
        return 400;
      case 4:
        return 500;
      default:
        return (unsigned int)-1;
    }
  }
  else
  {
    return 100;
  }
}


/* Function: switch_small @ 0xD38 */
__int64 __fastcall switch_small(int a1)
{
  unsigned int v2; // [xsp+1Ch] [xbp-4h]

  switch ( a1 )
  {
    case 0:
      v2 = 15;
      break;
    case 1:
      v2 = 5;
      break;
    case 2:
      v2 = 50;
      break;
    case 3:
      v2 = 2;
      break;
    default:
      v2 = -1;
      break;
  }
  return v2;
}


/* Function: switch_large @ 0xDE8 */
__int64 __fastcall switch_large(int a1)
{
  unsigned int v2; // [xsp+Ch] [xbp-4h]

  switch ( a1 )
  {
    case 0:
      v2 = 0;
      break;
    case 1:
      v2 = 10;
      break;
    case 2:
      v2 = 20;
      break;
    case 3:
      v2 = 30;
      break;
    case 4:
      v2 = 40;
      break;
    case 5:
      v2 = 50;
      break;
    case 6:
      v2 = 60;
      break;
    case 7:
      v2 = 70;
      break;
    case 8:
      v2 = 80;
      break;
    case 9:
      v2 = 90;
      break;
    default:
      v2 = -1;
      break;
  }
  return v2;
}


/* Function: switch_default @ 0xEAC */
__int64 __fastcall switch_default(int a1)
{
  switch ( a1 )
  {
    case 1:
      return 100;
    case 2:
      return 200;
    case 3:
      return 300;
    default:
      return 0;
  }
}


/* Function: switch_fallthrough @ 0xF20 */
__int64 __fastcall switch_fallthrough(int a1)
{
  int v2; // [xsp+8h] [xbp-8h]

  v2 = 0;
  if ( a1 != 1 )
  {
    if ( a1 != 2 )
    {
      if ( a1 != 3 )
        return (unsigned int)-1;
      v2 = 12;
    }
    v2 += 2 * a1;
  }
  return (unsigned int)(v2 + a1);
}


/* Function: loop_for_fixed @ 0xFB4 */
__int64 __fastcall loop_for_fixed(int a1)
{
  int i; // [xsp+4h] [xbp-Ch]
  unsigned int v3; // [xsp+8h] [xbp-8h]

  v3 = 0;
  for ( i = 0; i < a1; ++i )
    v3 += i;
  return v3;
}


/* Function: loop_while @ 0x100C */
__int64 __fastcall loop_while(int a1)
{
  int v3; // [xsp+8h] [xbp-8h]

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


/* Function: loop_dowhile @ 0x107C */
__int64 __fastcall loop_dowhile(int a1)
{
  unsigned int v2; // [xsp+8h] [xbp-8h]

  v2 = 0;
  do
  {
    a1 /= 10;
    ++v2;
  }
  while ( a1 );
  return v2;
}


/* Function: loop_nested @ 0x10C4 */
__int64 __fastcall loop_nested(int a1, int a2)
{
  int j; // [xsp+Ch] [xbp-14h]
  int i; // [xsp+10h] [xbp-10h]
  unsigned int v5; // [xsp+14h] [xbp-Ch]

  v5 = 0;
  for ( i = 0; i < a1; ++i )
  {
    for ( j = 0; j < a2; ++j )
      ++v5;
  }
  return v5;
}


/* Function: loop_break @ 0x114C */
__int64 __fastcall loop_break(int a1)
{
  int i; // [xsp+8h] [xbp-28h]
  __int128 v3; // [xsp+10h] [xbp-20h]
  int v4; // [xsp+20h] [xbp-10h]
  int v5; // [xsp+28h] [xbp-8h]

  v5 = a1;
  v3 = xmmword_2B04;
  v4 = 50;
  for ( i = 0; i < 5; ++i )
  {
    if ( *((_DWORD *)&v3 + i) == v5 )
      return (unsigned int)i;
  }
  return (unsigned int)-1;
}


/* Function: loop_continue @ 0x11E4 */
__int64 __fastcall loop_continue(int a1)
{
  int i; // [xsp+4h] [xbp-Ch]
  unsigned int v3; // [xsp+8h] [xbp-8h]

  v3 = 0;
  for ( i = 1; i <= a1; ++i )
  {
    if ( i % 2 )
      v3 += i;
  }
  return v3;
}


/* Function: goto_forward @ 0x1260 */
__int64 __fastcall goto_forward(int a1)
{
  int v2; // [xsp+8h] [xbp-8h]

  if ( a1 <= 0 )
    v2 = a1;
  else
    v2 = a1 * a1;
  return (unsigned int)(2 * v2);
}


/* Function: goto_backward @ 0x12B4 */
__int64 __fastcall goto_backward(int a1)
{
  int i; // [xsp+0h] [xbp-10h]
  unsigned int v3; // [xsp+4h] [xbp-Ch]

  if ( a1 > 0 )
  {
    v3 = 1;
    for ( i = 1; i <= a1; ++i )
      v3 *= i;
    return v3;
  }
  else
  {
    return 1;
  }
}


/* Function: ternary_op @ 0x1338 */
__int64 __fastcall ternary_op(unsigned int a1, unsigned int a2)
{
  if ( (int)a1 <= (int)a2 )
    return a2;
  else
    return a1;
}


/* Function: test_control_flow_l1 @ 0x137C */
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

  printf(asc_2B5C);
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
  v7 = nested_if_2(-10, 5);
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
  v25 = ternary_op(0xAu, 5u);
  printf("CF-L1-20 (ternary_op): %d\n", v25);
  v26 = ternary_op(3u, 8u);
  return printf("CF-L1-20 (ternary_op): %d\n", v26);
}


/* Function: loop_multi_exit @ 0x1670 */
__int64 __fastcall loop_multi_exit(int a1)
{
  int j; // [xsp+0h] [xbp-40h]
  int i; // [xsp+4h] [xbp-3Ch]
  _OWORD dest[3]; // [xsp+8h] [xbp-38h] BYREF
  int v5; // [xsp+38h] [xbp-8h]

  v5 = a1;
  memcpy(dest, &unk_2B18, sizeof(dest));
  for ( i = 0; i < 3; ++i )
  {
    for ( j = 0; j < 4; ++j )
    {
      if ( *((_DWORD *)&dest[i] + j) == v5 )
        return (unsigned int)(10 * i + j);
    }
  }
  return (unsigned int)-1;
}


/* Function: infinite_loop @ 0x1748 */
__int64 __fastcall infinite_loop(_DWORD *a1)
{
  unsigned int v2; // [xsp+4h] [xbp-Ch]

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


/* Function: multi_return @ 0x17AC */
__int64 __fastcall multi_return(int a1)
{
  if ( a1 >= 0 )
  {
    if ( 2 * a1 <= 100 )
    {
      if ( a1 % 2 )
        return (unsigned int)(a1 + 1);
      else
        return (unsigned int)(2 * a1);
    }
    else
    {
      return (unsigned int)-2;
    }
  }
  else
  {
    return (unsigned int)-1;
  }
}


/* Function: conditional_return @ 0x183C */
__int64 __fastcall conditional_return(int a1)
{
  if ( a1 <= 0 )
  {
    if ( a1 >= 0 )
      return 0;
    else
      return (unsigned int)-a1;
  }
  else
  {
    return (unsigned int)(2 * a1);
  }
}


/* Function: duffs_device @ 0x18AC */
__int64 __fastcall duffs_device(_DWORD *a1, _DWORD *a2, int a3)
{
  _DWORD *v3; // x8
  _DWORD *v4; // x9
  _DWORD *v5; // x8
  _DWORD *v6; // x9
  _DWORD *v7; // x8
  _DWORD *v8; // x9
  _DWORD *v9; // x8
  _DWORD *v10; // x9
  _DWORD *v11; // x8
  _DWORD *v12; // x9
  _DWORD *v13; // x8
  _DWORD *v14; // x9
  _DWORD *v15; // x8
  _DWORD *v16; // x9
  _DWORD *v17; // x8
  _DWORD *v18; // x9
  int v20; // [xsp+10h] [xbp-20h]

  if ( a3 > 0 )
  {
    v20 = (a3 + 7) / 8;
    switch ( a3 % 8 )
    {
      case 0:
        goto LABEL_4;
      case 1:
        goto LABEL_11;
      case 2:
        goto LABEL_10;
      case 3:
        goto LABEL_9;
      case 4:
        goto LABEL_8;
      case 5:
        goto LABEL_7;
      case 6:
        goto LABEL_6;
      case 7:
        while ( 1 )
        {
          v5 = a2++;
          v6 = a1++;
          *v6 = *v5;
LABEL_6:
          v7 = a2++;
          v8 = a1++;
          *v8 = *v7;
LABEL_7:
          v9 = a2++;
          v10 = a1++;
          *v10 = *v9;
LABEL_8:
          v11 = a2++;
          v12 = a1++;
          *v12 = *v11;
LABEL_9:
          v13 = a2++;
          v14 = a1++;
          *v14 = *v13;
LABEL_10:
          v15 = a2++;
          v16 = a1++;
          *v16 = *v15;
LABEL_11:
          v17 = a2++;
          v18 = a1++;
          *v18 = *v17;
          if ( --v20 <= 0 )
            break;
LABEL_4:
          v3 = a2++;
          v4 = a1++;
          *v4 = *v3;
        }
        break;
      default:
        break;
    }
    return (unsigned int)a3;
  }
  else
  {
    return (unsigned int)-1;
  }
}


/* Function: loop_complex_cond @ 0x1A80 */
__int64 __fastcall loop_complex_cond(int a1)
{
  bool v2; // [xsp+Ch] [xbp-14h]
  int i; // [xsp+10h] [xbp-10h]
  int v5; // [xsp+18h] [xbp-8h]

  v5 = 0;
  for ( i = 0; ; ++i )
  {
    v2 = 0;
    if ( v5 < a1 )
    {
      v2 = 0;
      if ( i < 10 )
        v2 = a1 > 0;
    }
    if ( !v2 )
      break;
    v5 += 2;
    --a1;
  }
  return (unsigned int)(v5 + a1 + i);
}


/* Function: loop_modify_var @ 0x1B34 */
__int64 __fastcall loop_modify_var(int a1)
{
  int i; // [xsp+4h] [xbp-Ch]
  unsigned int v3; // [xsp+8h] [xbp-8h]

  v3 = 0;
  for ( i = 0; i < a1; ++i )
  {
    v3 += i;
    if ( i > 5 )
      i += 2;
  }
  return v3;
}


/* Function: loop_external_state @ 0x1BAC */
__int64 __fastcall loop_external_state(_DWORD *a1)
{
  int i; // [xsp+4h] [xbp-Ch]

  for ( i = 0; i <= 100; ++i )
  {
    if ( *a1 )
      break;
  }
  return (unsigned int)i;
}


/* Function: recursion_factorial @ 0x1BFC */
__int64 __fastcall recursion_factorial(int a1)
{
  if ( a1 > 1 )
    return (unsigned int)(a1 * recursion_factorial((unsigned int)(a1 - 1)));
  else
    return 1;
}


/* Function: tail_recursion @ 0x1C5C */
__int64 __fastcall tail_recursion(int a1, unsigned int a2)
{
  if ( a1 > 1 )
    return (unsigned int)tail_recursion((unsigned int)(a1 - 1), a1 * a2);
  else
    return a2;
}


/* Function: indirect_recursion_a @ 0x1CBC */
__int64 __fastcall indirect_recursion_a(signed int a1, int a2)
{
  if ( a2 > 0 )
  {
    if ( a1 % 2 )
      return (unsigned int)indirect_recursion_b((unsigned int)(3 * a1 + 1), (unsigned int)(a2 - 1));
    else
      return (unsigned int)indirect_recursion_b((unsigned int)(a1 / 2), (unsigned int)(a2 - 1));
  }
  else
  {
    return (unsigned int)a1;
  }
}


/* Function: indirect_recursion_b @ 0x1D5C */
__int64 __fastcall indirect_recursion_b(unsigned int a1, int a2)
{
  if ( a2 > 0 )
    return (unsigned int)indirect_recursion_a(a1 + 1, a2 - 1);
  else
    return a1;
}


/* Function: call_func_ptr @ 0x1DB8 */
__int64 __fastcall call_func_ptr(__int64 (__fastcall *a1)(_QWORD), unsigned int a2)
{
  return a1(a2);
}


/* Function: call_func_ptr_array @ 0x1DE4 */
__int64 __fastcall call_func_ptr_array(int a1, unsigned int a2)
{
  __int128 v3; // [xsp+0h] [xbp-30h]
  __int64 (__fastcall *v4)(int); // [xsp+10h] [xbp-20h]
  unsigned int v5; // [xsp+24h] [xbp-Ch]
  int v6; // [xsp+28h] [xbp-8h]

  v6 = a1;
  v5 = a2;
  v3 = *(_OWORD *)off_13D30;
  v4 = recursion_factorial;
  if ( a1 < 0 || v6 >= 3 )
    return (unsigned int)-1;
  else
    return (unsigned int)(*((__int64 (__fastcall **)(_QWORD))&v3 + v6))(v5);
}


/* Function: double_value @ 0x1E64 */
__int64 __fastcall double_value(int a1)
{
  return (unsigned int)(2 * a1);
}


/* Function: triple_value @ 0x1E7C */
__int64 __fastcall triple_value(int a1)
{
  return (unsigned int)(3 * a1);
}


/* Function: call_virtual_func @ 0x1E98 */
__int64 __fastcall call_virtual_func(__int64 a1, int a2)
{
  return (unsigned int)(2 * a2);
}


/* Function: process_with_callback @ 0x1EB4 */
__int64 __fastcall process_with_callback(__int64 a1, int a2, __int64 (__fastcall *a3)(_QWORD))
{
  int i; // [xsp+0h] [xbp-20h]
  unsigned int v5; // [xsp+4h] [xbp-1Ch]

  v5 = 0;
  for ( i = 0; i < a2; ++i )
    v5 += a3(*(unsigned int *)(a1 + 4LL * i));
  return v5;
}


/* Function: test_control_flow_l2 @ 0x1F30 */
__int64 test_control_flow_l2()
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
  __int128 v19; // [xsp+40h] [xbp-70h] BYREF
  int v20; // [xsp+50h] [xbp-60h]
  int v21; // [xsp+5Ch] [xbp-54h] BYREF
  _OWORD v22[2]; // [xsp+60h] [xbp-50h] BYREF
  _OWORD v23[2]; // [xsp+80h] [xbp-30h] BYREF
  int v24; // [xsp+ACh] [xbp-4h] BYREF

  printf(asc_2DCA);
  v0 = loop_multi_exit(7);
  printf("CF-L2-01 (loop_multi_exit): %d\n", v0);
  v24 = 0;
  v1 = infinite_loop(&v24);
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
  v23[0] = xmmword_3120;
  v23[1] = xmmword_3130;
  memset(v22, 0, sizeof(v22));
  v7 = duffs_device(v22, v23, 8);
  printf("CF-L2-05 (duffs_device): %d\n", v7);
  v8 = loop_complex_cond(10);
  printf("CF-L2-06 (loop_complex_cond): %d\n", v8);
  v9 = loop_modify_var(10);
  printf("CF-L2-07 (loop_modify_var): %d\n", v9);
  v21 = 0;
  v10 = loop_external_state(&v21);
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
  v16 = call_func_ptr_array(2, 5u);
  printf("CF-L2-13 (call_func_ptr_array): %d\n", v16);
  v19 = xmmword_2B48;
  v20 = 5;
  v17 = process_with_callback((__int64)&v19, 5, (__int64 (__fastcall *)(_QWORD))double_value);
  return printf("CF-L2-15 (process_with_callback): %d\n", v17);
}


/* Function: non_local_jump @ 0x2188 */
__int64 __fastcall non_local_jump(int a1)
{
  if ( _setjmp(&jump_buffer) )
  {
    return (unsigned int)-1;
  }
  else
  {
    if ( a1 < 0 )
      longjmp(&jump_buffer, 1);
    if ( a1 > 100 )
      longjmp(&jump_buffer, 2);
    return (unsigned int)(2 * a1);
  }
}


/* Function: cpp_exception @ 0x2218 */
__int64 __fastcall cpp_exception(int a1)
{
  if ( a1 >= 0 )
  {
    if ( a1 <= 100 )
      return (unsigned int)(2 * a1);
    else
      return (unsigned int)-2;
  }
  else
  {
    return (unsigned int)-1;
  }
}


/* Function: large_jump_table @ 0x2274 */
__int64 __fastcall large_jump_table(int a1, unsigned int a2, unsigned int a3)
{
  _QWORD v4[10]; // [xsp+0h] [xbp-60h] BYREF
  unsigned int v5; // [xsp+50h] [xbp-10h]
  unsigned int v6; // [xsp+54h] [xbp-Ch]
  int v7; // [xsp+58h] [xbp-8h]

  v7 = a1;
  v6 = a2;
  v5 = a3;
  memcpy(v4, off_13D48, sizeof(v4));
  if ( v7 < 0 || v7 >= 10 )
    return (unsigned int)-1;
  else
    return ((unsigned int (__fastcall *)(_QWORD, _QWORD))v4[v7])(v6, v5);
}


/* Function: op_add @ 0x22F8 */
__int64 __fastcall op_add(int a1, int a2)
{
  return (unsigned int)(a1 + a2);
}


/* Function: op_sub @ 0x2318 */
__int64 __fastcall op_sub(int a1, int a2)
{
  return (unsigned int)(a1 - a2);
}


/* Function: op_mul @ 0x2338 */
__int64 __fastcall op_mul(int a1, int a2)
{
  return (unsigned int)(a1 * a2);
}


/* Function: op_div @ 0x2358 */
__int64 __fastcall op_div(int a1, int a2)
{
  if ( a2 )
    return (unsigned int)(a1 / a2);
  else
    return 0;
}


/* Function: op_mod @ 0x239C */
__int64 __fastcall op_mod(int a1, int a2)
{
  if ( a2 )
    return (unsigned int)(a1 % a2);
  else
    return 0;
}


/* Function: op_and @ 0x23E8 */
__int64 __fastcall op_and(int a1, unsigned int a2)
{
  return a1 & a2;
}


/* Function: op_or @ 0x2408 */
__int64 __fastcall op_or(int a1, unsigned int a2)
{
  return a1 | a2;
}


/* Function: op_xor @ 0x2428 */
__int64 __fastcall op_xor(int a1, unsigned int a2)
{
  return a1 ^ a2;
}


/* Function: op_shl @ 0x2448 */
__int64 __fastcall op_shl(int a1, char a2)
{
  return (unsigned int)(a1 << a2);
}


/* Function: op_shr @ 0x2468 */
__int64 __fastcall op_shr(int a1, char a2)
{
  return (unsigned int)(a1 >> a2);
}


/* Function: conditional_func_ptr @ 0x2488 */
__int64 __fastcall conditional_func_ptr(int a1, int a2)
{
  if ( !a1 )
    return double_value(a2);
  if ( a1 == 1 )
    return triple_value(a2);
  return recursion_factorial(a2);
}


/* Function: state_machine @ 0x2504 */
__int64 __fastcall state_machine(int a1, int a2)
{
  unsigned int v3; // [xsp+1Ch] [xbp-4h]

  switch ( a2 )
  {
    case 0:
      v3 = a1 == 1;
      break;
    case 1:
      if ( a1 == 2 )
      {
        v3 = 2;
      }
      else if ( a1 == 99 )
      {
        v3 = 3;
      }
      else
      {
        v3 = 1;
      }
      break;
    case 2:
      v3 = 2;
      break;
    case 3:
      if ( a1 )
        v3 = 3;
      else
        v3 = 0;
      break;
    default:
      v3 = 3;
      break;
  }
  return v3;
}


/* Function: fsm_func_table @ 0x25EC */
__int64 __fastcall fsm_func_table(unsigned int a1, int a2)
{
  _OWORD v3[2]; // [xsp+0h] [xbp-30h]
  int v4; // [xsp+24h] [xbp-Ch]
  unsigned int v5; // [xsp+28h] [xbp-8h]

  v5 = a1;
  v4 = a2;
  v3[0] = *(_OWORD *)off_13D98;
  v3[1] = *(_OWORD *)off_13DA8;
  if ( a2 < 0 || v4 >= 4 )
    return 3;
  else
    return (unsigned int)(*((__int64 (__fastcall **)(_QWORD))v3 + v4))(v5);
}


/* Function: state_idle @ 0x266C */
bool __fastcall state_idle(int a1)
{
  return a1 == 1;
}


/* Function: state_processing @ 0x268C */
__int64 __fastcall state_processing(int a1)
{
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
}


/* Function: state_done @ 0x26E4 */
__int64 state_done()
{
  return 2;
}


/* Function: state_error @ 0x26F8 */
__int64 __fastcall state_error(int a1)
{
  if ( a1 )
    return 3;
  else
    return 0;
}


/* Function: computed_goto @ 0x271C */
__int64 __fastcall computed_goto(__int64 a1, int a2)
{
  _OWORD v3[2]; // [xsp+10h] [xbp-40h]
  int v4; // [xsp+3Ch] [xbp-14h]
  __int64 v5; // [xsp+40h] [xbp-10h]

  v5 = a1;
  v4 = a2;
  v3[0] = *(_OWORD *)&off_13DB8;
  v3[1] = *(_OWORD *)&off_13DC8;
  if ( (a2 & 0x80000000) == 0 && v4 <= 3 )
    __asm { BR              X8 }
  return 0xFFFFFFFFLL;
}


/* Function: obfuscated_cf @ 0x27BC */
__int64 __fastcall obfuscated_cf(int a1)
{
  int v2; // [xsp+8h] [xbp-8h]

  v2 = a1;
  if ( a1 * a1 + 1 < 0 )
    v2 = 2 * a1 + 1;
  return (unsigned int)(2 * v2);
}


/* Function: opaque_predicate @ 0x2814 */
__int64 __fastcall opaque_predicate(int a1)
{
  if ( 305419896 * a1 % 2u )
    return (unsigned int)(3 * a1);
  else
    return (unsigned int)(2 * a1);
}


/* Function: overlapped_code @ 0x2884 */
__int64 __fastcall overlapped_code(int a1)
{
  if ( (a1 & 1) != 0 )
    return (unsigned int)(3 * a1 + 1);
  else
    return (unsigned int)(a1 / 2);
}


/* Function: test_control_flow_l3 @ 0x28D0 */
__int64 test_control_flow_l3()
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
  __int128 v13; // [xsp+30h] [xbp-10h] BYREF

  printf(asc_2FBE);
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
  v7 = fsm_func_table(2u, 1);
  printf("CF-L3-06 (fsm_func_table): %d\n", v7);
  v13 = xmmword_3140;
  v8 = computed_goto((__int64)&v13, 2);
  printf("CF-L3-07 (computed_goto): %d\n", v8);
  v9 = obfuscated_cf(5);
  printf("CF-L3-08 (obfuscated_cf): %d\n", v9);
  v10 = opaque_predicate(5);
  printf("CF-L3-09 (opaque_predicate): %d\n", v10);
  v11 = overlapped_code(5);
  return printf("CF-L3-10 (overlapped_code): %d\n", v11);
}


/* Function: main @ 0x2A50 */
int __fastcall main(int argc, const char **argv, const char **envp)
{
  test_control_flow_l1();
  test_control_flow_l2();
  test_control_flow_l3();
  return 0;
}


/* Function: .term_proc @ 0x2A84 */
void term_proc()
{
  ;
}


/* FAILED to decompile: memcpy @ 0x141E0 */

/* FAILED to decompile: _setjmp @ 0x141E8 */

/* FAILED to decompile: __libc_start_main @ 0x141F0 */

/* FAILED to decompile: __cxa_finalize @ 0x141F8 */

/* FAILED to decompile: abort @ 0x14200 */

/* FAILED to decompile: longjmp @ 0x14208 */

/* FAILED to decompile: printf @ 0x14210 */

/* FAILED to decompile: __gmon_start__ @ 0x14220 */

/* Total functions decompiled: 75, failed: 8 */
