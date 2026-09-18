/*
 * Decompiled by IDA Pro 9.1 with Hex-Rays
 * Binary: /Users/eren/Desktop/Antigravity/compiler/build/arm64/1/1_clang_O1_no_g
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
  return (unsigned int)(2 * (a2 + a1) - a3);
}


/* Function: single_if @ 0xA64 */
__int64 __fastcall single_if(int a1)
{
  return (unsigned int)(a1 << (a1 > 0));
}


/* Function: if_else @ 0xA74 */
bool __fastcall if_else(int a1)
{
  return a1 > 0;
}


/* Function: nested_if_2 @ 0xA80 */
__int64 __fastcall nested_if_2(int a1, int a2)
{
  if ( a1 <= 0 )
    return 0;
  else
    return (a2 & (unsigned int)~(a2 >> 31)) + a1;
}


/* Function: nested_if_deep @ 0xA94 */
__int64 __fastcall nested_if_deep(int a1, int a2, int a3, int a4, int a5)
{
  if ( a1 < 1 )
    return 0;
  if ( a2 < 1 )
    return 1;
  if ( a3 < 1 )
    return 2;
  if ( a4 < 1 )
    return 3;
  if ( a5 <= 0 )
    return 4;
  return 5;
}


/* Function: if_elseif_chain @ 0xAE4 */
__int64 __fastcall if_elseif_chain(unsigned int a1)
{
  if ( a1 >= 3 )
    return 0xFFFFFFFFLL;
  else
    return 10 * a1 + 10;
}


/* Function: if_elseif_long @ 0xAFC */
__int64 __fastcall if_elseif_long(unsigned int a1)
{
  if ( a1 >= 5 )
    return 0xFFFFFFFFLL;
  else
    return 100 * a1 + 100;
}


/* Function: switch_small @ 0xB14 */
__int64 __fastcall switch_small(unsigned int a1)
{
  if ( a1 > 3 )
    return 0xFFFFFFFFLL;
  else
    return dword_1EE0[a1];
}


/* Function: switch_large @ 0xB34 */
__int64 __fastcall switch_large(unsigned int a1)
{
  if ( a1 >= 0xA )
    return 0xFFFFFFFFLL;
  else
    return 10 * a1;
}


/* Function: switch_default @ 0xB48 */
__int64 __fastcall switch_default(int a1)
{
  if ( (unsigned int)(a1 - 1) >= 3 )
    return 0;
  else
    return (unsigned int)(100 * (a1 - 1) + 100);
}


/* Function: switch_fallthrough @ 0xB64 */
__int64 __fastcall switch_fallthrough(int a1)
{
  int v1; // w8

  v1 = 0;
  switch ( a1 )
  {
    case 1:
      return (unsigned int)(v1 + a1);
    case 2:
LABEL_5:
      v1 += 2 * a1;
      return (unsigned int)(v1 + a1);
    case 3:
      v1 = 12;
      goto LABEL_5;
  }
  return 0xFFFFFFFFLL;
}


/* Function: loop_for_fixed @ 0xB98 */
__int64 __fastcall loop_for_fixed(int a1)
{
  if ( a1 < 1 )
    return 0;
  else
    return (unsigned int)(((unsigned int)(a1 - 1) * (unsigned __int64)(unsigned int)(a1 - 2)) >> 1) + a1 - 1;
}


/* Function: loop_while @ 0xBC0 */
__int64 __fastcall loop_while(int a1)
{
  unsigned int v1; // w8
  unsigned int v2; // w11

  v1 = 0;
  if ( a1 )
  {
    do
    {
      ++v1;
      v2 = a1 + 9;
      a1 /= 10;
    }
    while ( v2 > 0x12 );
  }
  if ( v1 )
    return v1;
  else
    return 1;
}


/* Function: loop_dowhile @ 0xC00 */
__int64 __fastcall loop_dowhile(int a1)
{
  __int64 result; // x0
  unsigned int v3; // w11

  LODWORD(result) = 0;
  do
  {
    result = (unsigned int)(result + 1);
    v3 = a1 + 9;
    a1 /= 10;
  }
  while ( v3 > 0x12 );
  return result;
}


/* Function: loop_nested @ 0xC38 */
__int64 __fastcall loop_nested(int a1, int a2)
{
  int v2; // w8
  unsigned int v3; // w8

  if ( a2 <= 0 )
    v2 = 0;
  else
    v2 = a2;
  v3 = v2 * a1;
  if ( a1 <= 0 )
    return 0;
  else
    return v3;
}


/* Function: loop_break @ 0xC50 */
__int64 __fastcall loop_break(int a1)
{
  __int64 result; // x0

  result = 0;
  while ( dword_18D8[result] != a1 )
  {
    if ( ++result == 5 )
      return 0xFFFFFFFFLL;
  }
  return result;
}


/* Function: loop_continue @ 0xC80 */
__int64 __fastcall loop_continue(int a1)
{
  int v1; // w9
  unsigned int v2; // w8

  if ( a1 < 1 )
    return 0;
  v1 = 0;
  v2 = 0;
  do
  {
    ++v1;
    v2 += (v1 << 31 >> 31) & v1;
  }
  while ( a1 != v1 );
  return v2;
}


/* Function: goto_forward @ 0xCBC */
__int64 __fastcall goto_forward(int a1)
{
  int v1; // w8

  if ( a1 <= 1 )
    v1 = 1;
  else
    v1 = a1;
  return (unsigned int)(2 * a1 * v1);
}


/* Function: goto_backward @ 0xCD0 */
__int64 __fastcall goto_backward(int a1)
{
  int v2; // w9
  __int64 result; // x0

  if ( a1 < 1 )
    return 1;
  v2 = 0;
  LODWORD(result) = 1;
  do
    result = (unsigned int)(++v2 * result);
  while ( a1 != v2 );
  return result;
}


/* Function: ternary_op @ 0xD00 */
__int64 __fastcall ternary_op(__int64 result, int a2)
{
  if ( (int)result <= a2 )
    return (unsigned int)a2;
  else
    return (unsigned int)result;
}


/* Function: test_control_flow_l1 @ 0xD0C */
__int64 test_control_flow_l1()
{
  puts(asc_1E71);
  printf("CF-L1-01 (sequential_ops): %d\n", 21);
  printf("CF-L1-02 (single_if): %d\n", 20);
  printf("CF-L1-02 (single_if): %d\n", -5);
  printf("CF-L1-03 (if_else): %d\n", 1);
  printf("CF-L1-03 (if_else): %d\n", 0);
  printf("CF-L1-04 (nested_if_2): %d\n", 15);
  printf("CF-L1-04 (nested_if_2): %d\n", 10);
  printf("CF-L1-04 (nested_if_2): %d\n", 0);
  printf("CF-L1-05 (nested_if_deep): %d\n", 5);
  printf("CF-L1-06 (if_elseif_chain): %d\n", 20);
  printf("CF-L1-07 (if_elseif_long): %d\n", 400);
  printf("CF-L1-08 (switch_small): %d\n", 50);
  printf("CF-L1-09 (switch_large): %d\n", 70);
  printf("CF-L1-10 (switch_default): %d\n", 0);
  printf("CF-L1-11 (switch_fallthrough): %d\n", 21);
  printf("CF-L1-12 (loop_for_fixed): %d\n", 45);
  printf("CF-L1-13 (loop_while): %d\n", 5);
  printf("CF-L1-14 (loop_dowhile): %d\n", 4);
  printf("CF-L1-15 (loop_nested): %d\n", 12);
  printf("CF-L1-16 (loop_break): %d\n", 2);
  printf("CF-L1-16 (loop_break): %d\n", -1);
  printf("CF-L1-17 (loop_continue): %d\n", 25);
  printf("CF-L1-18 (goto_forward): %d\n", 50);
  printf("CF-L1-18 (goto_forward): %d\n", -6);
  printf("CF-L1-19 (goto_backward): %d\n", 120);
  printf("CF-L1-20 (ternary_op): %d\n", 10);
  return printf("CF-L1-20 (ternary_op): %d\n", 8);
}


/* Function: loop_multi_exit @ 0xEDC */
__int64 __fastcall loop_multi_exit(int a1)
{
  unsigned int v1; // w12
  __int64 v2; // x8
  _DWORD *v3; // x10
  __int64 v4; // x14
  _BOOL4 v5; // w13
  int v6; // w13
  int v7; // w14

  v2 = 0;
  v3 = &unk_18F0;
  do
  {
    if ( *((_DWORD *)&unk_18EC + 4 * v2) == a1 )
    {
      LODWORD(v4) = 0;
      v5 = 1;
LABEL_8:
      v1 = v4 + 10 * v2;
      v7 = 1;
      if ( v5 )
        goto LABEL_11;
    }
    else
    {
      v4 = 0;
      while ( v4 != 3 )
      {
        v6 = v3[v4++];
        if ( v6 == a1 )
        {
          v5 = (unsigned __int64)(v4 - 1) < 3;
          goto LABEL_8;
        }
      }
    }
    ++v2;
    v3 += 4;
  }
  while ( v2 != 3 );
  v7 = 2;
LABEL_11:
  if ( v7 == 2 )
    return 0xFFFFFFFFLL;
  else
    return v1;
}


/* Function: infinite_loop @ 0xF74 */
__int64 __fastcall infinite_loop(_DWORD *a1)
{
  __int64 result; // x0

  result = 0;
  while ( *a1 != 1 )
  {
    result = (unsigned int)(result + 1);
    if ( (_DWORD)result == 1001 )
    {
      *a1 = 1;
      return result;
    }
  }
  return result;
}


/* Function: multi_return @ 0xFA0 */
__int64 __fastcall multi_return(int a1)
{
  unsigned int v1; // w9

  if ( a1 < 0 )
    return 0xFFFFFFFFLL;
  v1 = 2 * a1;
  if ( (a1 & 1) != 0 )
    v1 = a1 + 1;
  if ( a1 <= 50 )
    return v1;
  else
    return 4294967294LL;
}


/* Function: conditional_return @ 0xFC8 */
__int64 __fastcall conditional_return(int a1)
{
  if ( a1 <= 0 )
    return (unsigned int)-a1;
  else
    return (unsigned int)(2 * a1);
}


/* Function: duffs_device @ 0xFD8 */
__int64 __fastcall duffs_device(_DWORD *a1, int *a2, int a3)
{
  unsigned int v3; // w8
  int v4; // w9
  int v5; // w8
  int v6; // t1
  int v7; // t1
  int v8; // t1
  int v9; // t1
  int v10; // t1
  int v11; // t1
  int v12; // t1
  int v13; // t1
  bool v14; // vf

  v3 = -1;
  if ( a3 >= 1 )
  {
    v4 = a3 + 14;
    if ( a3 + 7 >= 0 )
      v4 = a3 + 7;
    v5 = v4 >> 3;
    switch ( a3 - (a3 & 0x7FFFFFF8) )
    {
      case 0:
        goto LABEL_5;
      case 1:
        goto LABEL_12;
      case 2:
        goto LABEL_11;
      case 3:
        goto LABEL_10;
      case 4:
        goto LABEL_9;
      case 5:
        goto LABEL_8;
      case 6:
        goto LABEL_7;
      case 7:
        while ( 1 )
        {
          v7 = *a2++;
          *a1++ = v7;
LABEL_7:
          v8 = *a2++;
          *a1++ = v8;
LABEL_8:
          v9 = *a2++;
          *a1++ = v9;
LABEL_9:
          v10 = *a2++;
          *a1++ = v10;
LABEL_10:
          v11 = *a2++;
          *a1++ = v11;
LABEL_11:
          v12 = *a2++;
          *a1++ = v12;
LABEL_12:
          v13 = *a2++;
          v14 = __OFSUB__(v5--, 1);
          *a1++ = v13;
          if ( (v5 < 0) ^ v14 | (v5 == 0) )
            break;
LABEL_5:
          v6 = *a2++;
          *a1++ = v6;
        }
        break;
      default:
        return (unsigned int)a3;
    }
    return (unsigned int)a3;
  }
  return v3;
}


/* Function: loop_complex_cond @ 0x107C */
__int64 __fastcall loop_complex_cond(int a1)
{
  unsigned int v1; // w10
  int v2; // w8
  int v3; // w11
  unsigned int v4; // w9

  if ( a1 < 1 )
  {
    v2 = 0;
    v4 = 0;
  }
  else
  {
    v1 = 0;
    v2 = 0;
    do
    {
      v3 = a1;
      v2 += 2;
      --a1;
      v4 = v1 + 1;
      if ( v3 < 2 )
        break;
      if ( v2 >= a1 )
        break;
    }
    while ( v1++ < 9 );
  }
  return a1 + v2 + v4;
}


/* Function: loop_modify_var @ 0x10D0 */
__int64 __fastcall loop_modify_var(int a1)
{
  int v1; // w9
  unsigned int v2; // w8
  int v3; // w10

  if ( a1 < 1 )
    return 0;
  v1 = 0;
  v2 = 0;
  do
  {
    v3 = v1 + 2;
    if ( v1 <= 5 )
      v3 = v1;
    v2 += v1;
    v1 = v3 + 1;
  }
  while ( v3 + 1 < a1 );
  return v2;
}


/* Function: loop_external_state @ 0x1110 */
__int64 __fastcall loop_external_state(_DWORD *a1)
{
  __int64 result; // x0

  result = 0;
  do
  {
    if ( *a1 )
      break;
    result = (unsigned int)(result + 1);
  }
  while ( (_DWORD)result != 101 );
  return result;
}


/* Function: recursion_factorial @ 0x1130 */
__int64 __fastcall recursion_factorial(int a1)
{
  if ( a1 >= 2 )
    return (unsigned int)recursion_factorial((unsigned int)(a1 - 1)) * a1;
  else
    return 1;
}


/* Function: tail_recursion @ 0x1168 */
__int64 __fastcall tail_recursion(int a1, unsigned int a2)
{
  if ( a1 >= 2 )
    return (unsigned int)tail_recursion((unsigned int)(a1 - 1), a2 * a1);
  return a2;
}


/* Function: indirect_recursion_a @ 0x1194 */
__int64 __fastcall indirect_recursion_a(__int64 result, int a2)
{
  int v2; // w8
  __int64 v3; // x0
  int v4; // w8

  if ( a2 >= 1 )
  {
    if ( (result & 1) != 0 )
    {
      v4 = 3 * result;
      if ( a2 < 2 )
        return (unsigned int)(v4 + 1);
      v3 = (unsigned int)(v4 + 2);
      return indirect_recursion_a(v3, (unsigned int)(a2 - 2));
    }
    if ( (int)result >= 0 )
      v2 = result;
    else
      v2 = result + 1;
    result = (unsigned int)(v2 >> 1);
    if ( a2 >= 2 )
    {
      v3 = (unsigned int)(result + 1);
      return indirect_recursion_a(v3, (unsigned int)(a2 - 2));
    }
  }
  return result;
}


/* Function: call_func_ptr @ 0x11EC */
__int64 __fastcall call_func_ptr(__int64 (__fastcall *a1)(_QWORD), unsigned int a2)
{
  return a1(a2);
}


/* Function: call_func_ptr_array @ 0x1208 */
__int64 __fastcall call_func_ptr_array(unsigned int a1, unsigned int a2)
{
  if ( a1 <= 2 )
    return ((__int64 (__fastcall *)(_QWORD))off_12D30[a1])(a2);
  else
    return 0xFFFFFFFFLL;
}


/* Function: double_value @ 0x123C */
__int64 __fastcall double_value(int a1)
{
  return (unsigned int)(2 * a1);
}


/* Function: triple_value @ 0x1244 */
__int64 __fastcall triple_value(int a1)
{
  return (unsigned int)(3 * a1);
}


/* Function: call_virtual_func @ 0x124C */
__int64 __fastcall call_virtual_func(__int64 a1, int a2)
{
  return (unsigned int)(2 * a2);
}


/* Function: process_with_callback @ 0x1254 */
__int64 __fastcall process_with_callback(unsigned int *a1, int a2, __int64 (__fastcall *a3)(_QWORD))
{
  unsigned int v5; // w20
  __int64 v6; // x22
  unsigned int v7; // t1

  if ( a2 < 1 )
  {
    return 0;
  }
  else
  {
    v5 = 0;
    v6 = (unsigned int)a2;
    do
    {
      v7 = *a1++;
      --v6;
      v5 += a3(v7);
    }
    while ( v6 );
  }
  return v5;
}


/* Function: test_control_flow_l2 @ 0x12AC */
__int64 test_control_flow_l2()
{
  int v0; // w11
  int v1; // w8
  __int64 v2; // x9
  _DWORD *v3; // x10
  __int64 v4; // x12
  int v5; // w13
  _BOOL4 v6; // w13
  int v7; // w12
  int v8; // w1
  int i; // w1
  unsigned int v10; // w21
  int v11; // w19
  int v12; // w8
  unsigned int v13; // w9
  int j; // w1
  int v15; // w0
  int v16; // w0
  int v17; // w0
  int v18; // w0

  puts(asc_1E95);
  v1 = 0;
  v2 = 0;
  v3 = &unk_18F0;
  do
  {
    v4 = 0;
    while ( v4 != 3 )
    {
      v5 = v3[v4++];
      if ( v5 == 7 )
      {
        v0 = v4 - v1;
        v6 = (unsigned __int64)(v4 - 1) < 3;
        v7 = 1;
        if ( v6 )
          goto LABEL_8;
        break;
      }
    }
    ++v2;
    v1 -= 10;
    v3 += 4;
  }
  while ( v2 != 3 );
  v7 = 2;
LABEL_8:
  if ( v7 == 2 )
    v8 = -1;
  else
    v8 = v0;
  printf("CF-L2-01 (loop_multi_exit): %d\n", v8);
  for ( i = 0; i != 1001; ++i )
    ;
  printf("CF-L2-02 (infinite_loop): %d\n", 1001);
  v10 = -1;
  printf("CF-L2-03 (multi_return): %d\n", -1);
  printf("CF-L2-03 (multi_return): %d\n", -2);
  printf("CF-L2-03 (multi_return): %d\n", 4);
  v11 = 10;
  printf("CF-L2-04 (conditional_return): %d\n", 10);
  printf("CF-L2-04 (conditional_return): %d\n", 5);
  printf("CF-L2-05 (duffs_device): %d\n", 8);
  v12 = 11;
  do
  {
    v13 = v11 - 8;
    v11 += 2;
    if ( v13 >= v12 - 2 )
      break;
    ++v10;
    --v12;
  }
  while ( v10 < 9 );
  printf("CF-L2-06 (loop_complex_cond): %d\n", v11);
  printf("CF-L2-07 (loop_modify_var): %d\n", 30);
  for ( j = 0; j != 101; ++j )
    ;
  printf("CF-L2-08 (loop_external_state): %d\n", 101);
  v15 = recursion_factorial(5);
  printf("CF-L2-09 (recursion_factorial): %d\n", v15);
  v16 = tail_recursion(5, 1u);
  printf("CF-L2-10 (tail_recursion): %d\n", v16);
  v17 = indirect_recursion_a(10, 3);
  printf("CF-L2-11 (indirect_recursion): %d\n", v17);
  printf("CF-L2-12 (call_func_ptr): %d\n", 10);
  printf("CF-L2-13 (call_func_ptr_array): %d\n", 10);
  v18 = recursion_factorial(5);
  printf("CF-L2-13 (call_func_ptr_array): %d\n", v18);
  return printf("CF-L2-15 (process_with_callback): %d\n", 30);
}


/* Function: non_local_jump @ 0x14F8 */
__int64 __fastcall non_local_jump(int a1)
{
  if ( _setjmp(&jump_buffer) )
    return 0xFFFFFFFFLL;
  if ( a1 < 0 )
    longjmp(&jump_buffer, 1);
  if ( a1 >= 101 )
    longjmp(&jump_buffer, 2);
  return (unsigned int)(2 * a1);
}


/* Function: cpp_exception @ 0x155C */
__int64 __fastcall cpp_exception(int a1)
{
  unsigned int v1; // w8

  if ( a1 <= 100 )
    v1 = 2 * a1;
  else
    v1 = -2;
  if ( a1 < 0 )
    return 0xFFFFFFFFLL;
  else
    return v1;
}


/* Function: large_jump_table @ 0x1578 */
__int64 __fastcall large_jump_table(unsigned int a1, unsigned int a2, unsigned int a3)
{
  if ( a1 <= 9 )
    return ((__int64 (__fastcall *)(_QWORD, _QWORD))off_12D48[a1])(a2, a3);
  else
    return 0xFFFFFFFFLL;
}


/* Function: op_add @ 0x15B0 */
__int64 __fastcall op_add(int a1, int a2)
{
  return (unsigned int)(a2 + a1);
}


/* Function: op_sub @ 0x15B8 */
__int64 __fastcall op_sub(int a1, int a2)
{
  return (unsigned int)(a1 - a2);
}


/* Function: op_mul @ 0x15C0 */
__int64 __fastcall op_mul(int a1, int a2)
{
  return (unsigned int)(a2 * a1);
}


/* Function: op_div @ 0x15C8 */
__int64 __fastcall op_div(int a1, int a2)
{
  if ( a2 )
    return (unsigned int)(a1 / a2);
  else
    return 0;
}


/* Function: op_mod @ 0x15DC */
__int64 __fastcall op_mod(int a1, int a2)
{
  if ( a2 )
    return (unsigned int)(a1 % a2);
  else
    return 0;
}


/* Function: op_and @ 0x15F4 */
__int64 __fastcall op_and(unsigned int a1, int a2)
{
  return a2 & a1;
}


/* Function: op_or @ 0x15FC */
__int64 __fastcall op_or(unsigned int a1, int a2)
{
  return a2 | a1;
}


/* Function: op_xor @ 0x1604 */
__int64 __fastcall op_xor(unsigned int a1, int a2)
{
  return a2 ^ a1;
}


/* Function: op_shl @ 0x160C */
__int64 __fastcall op_shl(int a1, char a2)
{
  return (unsigned int)(a1 << a2);
}


/* Function: op_shr @ 0x1614 */
__int64 __fastcall op_shr(int a1, char a2)
{
  return (unsigned int)(a1 >> a2);
}


/* Function: conditional_func_ptr @ 0x161C */
__int64 __fastcall conditional_func_ptr(int a1, int a2)
{
  __int64 (__fastcall *v2)(int); // x8

  v2 = recursion_factorial;
  if ( a1 == 1 )
    v2 = triple_value;
  if ( !a1 )
    v2 = double_value;
  return v2(a2);
}


/* Function: state_machine @ 0x165C */
__int64 __fastcall state_machine(int a1, unsigned int a2)
{
  __int64 result; // x0
  unsigned int v3; // w8

  switch ( a2 )
  {
    case 0u:
      result = a1 == 1;
      break;
    case 1u:
      if ( a1 == 99 )
        v3 = 3;
      else
        v3 = 1;
      if ( a1 == 2 )
        result = 2;
      else
        result = v3;
      break;
    case 2u:
      goto LABEL_4;
    case 3u:
      if ( a1 )
        result = 3;
      else
        result = 0;
      break;
    default:
      a2 = 3;
LABEL_4:
      result = a2;
      break;
  }
  return result;
}


/* Function: fsm_func_table @ 0x16C0 */
__int64 __fastcall fsm_func_table(__int64 a1, __int64 a2)
{
  if ( (unsigned int)a2 <= 3 )
    return ((__int64 (__fastcall *)(__int64, __int64))off_12D98[(int)a2])(a1, a2);
  else
    return 3;
}


/* Function: state_idle @ 0x16F0 */
bool __fastcall state_idle(int a1)
{
  return a1 == 1;
}


/* Function: state_processing @ 0x16FC */
__int64 __fastcall state_processing(int a1)
{
  unsigned int v1; // w8

  if ( a1 == 99 )
    v1 = 3;
  else
    v1 = 1;
  if ( a1 == 2 )
    return 2;
  else
    return v1;
}


/* Function: state_done @ 0x1714 */
__int64 state_done()
{
  return 2;
}


/* Function: state_error @ 0x171C */
__int64 __fastcall state_error(int a1)
{
  if ( a1 )
    return 3;
  else
    return 0;
}


/* Function: computed_goto @ 0x172C */
__int64 __fastcall computed_goto(__int64 a1, unsigned int a2)
{
  if ( a2 <= 3 )
    return off_12DB8[a2]();
  else
    return 0xFFFFFFFFLL;
}


/* Function: sub_174C @ 0x174C */
__int64 sub_174C()
{
  return 0;
}


/* Function: sub_1754 @ 0x1754 */
__int64 sub_1754()
{
  return 20;
}


/* Function: sub_175C @ 0x175C */
__int64 sub_175C()
{
  return 30;
}


/* Function: sub_1764 @ 0x1764 */
__int64 sub_1764()
{
  return 10;
}


/* Function: obfuscated_cf @ 0x176C */
__int64 __fastcall obfuscated_cf(int a1)
{
  return (unsigned int)(2 * a1);
}


/* Function: opaque_predicate @ 0x1774 */
__int64 __fastcall opaque_predicate(int a1)
{
  return (unsigned int)(2 * a1);
}


/* Function: overlapped_code @ 0x177C */
__int64 __fastcall overlapped_code(int a1)
{
  int v1; // w8
  unsigned int v2; // w8

  if ( a1 >= 0 )
    v1 = a1;
  else
    v1 = a1 + 1;
  v2 = v1 >> 1;
  if ( (a1 & 1) != 0 )
    return (unsigned int)(3 * a1 + 1);
  else
    return v2;
}


/* Function: test_control_flow_l3 @ 0x1798 */
__int64 test_control_flow_l3()
{
  int v0; // w0
  int v1; // w0
  __int64 v2; // x0
  int v3; // w0

  puts(asc_1EB9);
  v0 = non_local_jump(5);
  printf("CF-L3-01 (non_local_jump): %d\n", v0);
  v1 = non_local_jump(-5);
  printf("CF-L3-01 (non_local_jump): %d\n", v1);
  printf("CF-L3-02 (cpp_exception): %d\n", 10);
  printf("CF-L3-02 (cpp_exception): %d\n", -1);
  printf("CF-L3-03 (large_jump_table): %d\n", 15);
  printf("CF-L3-04 (conditional_func_ptr): %d\n", 10);
  printf("CF-L3-05 (state_machine): %d\n", 1);
  v2 = printf("CF-L3-06 (fsm_func_table): %d\n", 2);
  v3 = computed_goto(v2, 2u);
  printf("CF-L3-07 (computed_goto): %d\n", v3);
  printf("CF-L3-08 (obfuscated_cf): %d\n", 10);
  printf("CF-L3-09 (opaque_predicate): %d\n", 10);
  return printf("CF-L3-10 (overlapped_code): %d\n", 16);
}


/* Function: main @ 0x1894 */
int __fastcall main(int argc, const char **argv, const char **envp)
{
  test_control_flow_l1();
  test_control_flow_l2();
  test_control_flow_l3();
  return 0;
}


/* Function: .term_proc @ 0x18B4 */
void term_proc()
{
  ;
}


/* FAILED to decompile: _setjmp @ 0x131E0 */

/* FAILED to decompile: __libc_start_main @ 0x131E8 */

/* FAILED to decompile: __cxa_finalize @ 0x131F0 */

/* FAILED to decompile: abort @ 0x131F8 */

/* FAILED to decompile: puts @ 0x13200 */

/* FAILED to decompile: longjmp @ 0x13208 */

/* FAILED to decompile: printf @ 0x13210 */

/* FAILED to decompile: __gmon_start__ @ 0x13220 */

/* Total functions decompiled: 78, failed: 8 */
