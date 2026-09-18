/*
 * Decompiled by IDA Pro 9.1 with Hex-Rays
 * Binary: /Users/eren/Desktop/Antigravity/compiler/build/arm64/1/1_gcc_Os_no_g
 * Processor: arm
 */

/* Function: .init_proc @ 0x928 */
__int64 init_proc()
{
  return call_weak_fn();
}


/* Function: sub_940 @ 0x940 */
void sub_940()
{
  JUMPOUT(0);
}


/* Function: main @ 0xA00 */
int __fastcall main(int argc, const char **argv, const char **envp)
{
  __int64 v3; // x0
  __int64 v4; // x0

  v3 = test_control_flow_l1(argc, argv, envp);
  v4 = test_control_flow_l2(v3);
  test_control_flow_l3(v4);
  return 0;
}


/* Function: _start @ 0xA40 */
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


/* Function: call_weak_fn @ 0xA74 */
void *call_weak_fn()
{
  void *result; // x0

  result = &_gmon_start__;
  if ( &_gmon_start__ )
    return (void *)__gmon_start__();
  return result;
}


/* Function: deregister_tm_clones @ 0xA90 */
char *deregister_tm_clones()
{
  return &_bss_start;
}


/* Function: register_tm_clones @ 0xAC0 */
char *register_tm_clones()
{
  return &_bss_start;
}


/* Function: __do_global_dtors_aux @ 0xB00 */
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


/* Function: frame_dummy @ 0xB50 */
// attributes: thunk
char *frame_dummy()
{
  return register_tm_clones();
}


/* Function: recursion_factorial @ 0xB54 */
__int64 __fastcall recursion_factorial(int a1)
{
  __int64 result; // x0

  result = 1;
  while ( a1 > 1 )
    result = (unsigned int)(result * a1--);
  return result;
}


/* Function: double_value @ 0xB74 */
__int64 __fastcall double_value(int a1)
{
  return (unsigned int)(2 * a1);
}


/* Function: triple_value @ 0xB7C */
__int64 __fastcall triple_value(int a1)
{
  return (unsigned int)(3 * a1);
}


/* Function: op_add @ 0xB84 */
__int64 __fastcall op_add(int a1, int a2)
{
  return (unsigned int)(a1 + a2);
}


/* Function: op_sub @ 0xB8C */
__int64 __fastcall op_sub(int a1, int a2)
{
  return (unsigned int)(a1 - a2);
}


/* Function: op_mul @ 0xB94 */
__int64 __fastcall op_mul(int a1, int a2)
{
  return (unsigned int)(a1 * a2);
}


/* Function: op_div @ 0xB9C */
__int64 __fastcall op_div(int a1, unsigned int a2)
{
  __int64 result; // x0

  result = a2;
  if ( a2 )
    return (unsigned int)(a1 / (int)a2);
  return result;
}


/* Function: op_mod @ 0xBB0 */
__int64 __fastcall op_mod(int a1, unsigned int a2)
{
  __int64 result; // x0

  result = a2;
  if ( a2 )
    return (unsigned int)(a1 % (int)a2);
  return result;
}


/* Function: op_and @ 0xBC8 */
__int64 __fastcall op_and(int a1, unsigned int a2)
{
  return a1 & a2;
}


/* Function: op_or @ 0xBD0 */
__int64 __fastcall op_or(int a1, unsigned int a2)
{
  return a1 | a2;
}


/* Function: op_xor @ 0xBD8 */
__int64 __fastcall op_xor(int a1, unsigned int a2)
{
  return a1 ^ a2;
}


/* Function: op_shl @ 0xBE0 */
__int64 __fastcall op_shl(int a1, char a2)
{
  return (unsigned int)(a1 << a2);
}


/* Function: op_shr @ 0xBE8 */
__int64 __fastcall op_shr(int a1, char a2)
{
  return (unsigned int)(a1 >> a2);
}


/* Function: state_idle @ 0xBF0 */
bool __fastcall state_idle(int a1)
{
  return a1 == 1;
}


/* Function: state_processing @ 0xBFC */
__int64 __fastcall state_processing(__int64 result)
{
  if ( (_DWORD)result != 2 )
  {
    if ( (_DWORD)result == 99 )
      return 3;
    else
      return 1;
  }
  return result;
}


/* Function: state_done @ 0xC14 */
__int64 state_done()
{
  return 2;
}


/* Function: state_error @ 0xC1C */
__int64 __fastcall state_error(int a1)
{
  if ( a1 )
    return 3;
  else
    return 0;
}


/* Function: sequential_ops @ 0xC2C */
__int64 __fastcall sequential_ops(int a1, int a2, int a3)
{
  return (unsigned int)(2 * (a1 + a2) - a3);
}


/* Function: single_if @ 0xC3C */
__int64 __fastcall single_if(__int64 result)
{
  if ( (int)result > 0 )
    return (unsigned int)(2 * result);
  return result;
}


/* Function: if_else @ 0xC4C */
bool __fastcall if_else(int a1)
{
  return a1 > 0;
}


/* Function: nested_if_2 @ 0xC58 */
__int64 __fastcall nested_if_2(__int64 result, int a2)
{
  if ( (int)result <= 0 )
    return 0;
  if ( a2 > 0 )
    return (unsigned int)(result + a2);
  return result;
}


/* Function: nested_if_deep @ 0xC78 */
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
  return (unsigned int)(a5 > 0) + 4;
}


/* Function: if_elseif_chain @ 0xCC8 */
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


/* Function: if_elseif_long @ 0xCF4 */
__int64 __fastcall if_elseif_long(unsigned int a1)
{
  if ( a1 >= 5 )
    return 0xFFFFFFFFLL;
  else
    return 100 * a1 + 100;
}


/* Function: switch_small @ 0xD08 */
__int64 __fastcall switch_small(unsigned int a1)
{
  if ( a1 > 3 )
    return 0xFFFFFFFFLL;
  else
    return (unsigned int)CSWTCH_55[a1];
}


/* Function: switch_large @ 0xD28 */
__int64 __fastcall switch_large(unsigned int a1)
{
  if ( a1 >= 0xA )
    return 0xFFFFFFFFLL;
  else
    return 10 * a1;
}


/* Function: switch_default @ 0xD3C */
__int64 __fastcall switch_default(int a1)
{
  unsigned int v1; // w1
  __int64 result; // x0

  v1 = a1 - 1;
  LODWORD(result) = 100 * a1;
  if ( v1 >= 3 )
    return 0;
  else
    return (unsigned int)result;
}


/* Function: switch_fallthrough @ 0xD54 */
__int64 __fastcall switch_fallthrough(int a1)
{
  int v2; // w1
  int v3; // w1

  if ( a1 == 2 )
  {
    v2 = 0;
LABEL_6:
    v3 = v2 + 2 * a1;
    return (unsigned int)(v3 + a1);
  }
  if ( a1 == 3 )
  {
    v2 = 12;
    goto LABEL_6;
  }
  if ( a1 != 1 )
    return 0xFFFFFFFFLL;
  v3 = 0;
  return (unsigned int)(v3 + a1);
}


/* Function: loop_for_fixed @ 0xD94 */
__int64 __fastcall loop_for_fixed(int a1)
{
  int v2; // w1
  __int64 result; // x0

  v2 = 0;
  result = 0;
  while ( v2 < a1 )
    result = (unsigned int)(result + v2++);
  return result;
}


/* Function: loop_while @ 0xDB8 */
__int64 __fastcall loop_while(int a1)
{
  int v1; // w1

  v1 = 0;
  while ( a1 )
  {
    a1 /= 10;
    ++v1;
  }
  if ( v1 <= 0 )
    return 1;
  else
    return (unsigned int)v1;
}


/* Function: loop_dowhile @ 0xDDC */
__int64 __fastcall loop_dowhile(int a1)
{
  __int64 result; // x0

  LODWORD(result) = 0;
  do
  {
    a1 /= 10;
    result = (unsigned int)(result + 1);
  }
  while ( a1 );
  return result;
}


/* Function: loop_nested @ 0xDF8 */
__int64 __fastcall loop_nested(int a1, int a2)
{
  int v3; // w3
  __int64 result; // x0
  int v5; // w4

  v3 = 0;
  result = 0;
  while ( v3 < a1 )
  {
    ++v3;
    if ( a2 < 0 )
      v5 = 0;
    else
      v5 = a2;
    result = (unsigned int)(result + v5);
  }
  return result;
}


/* Function: loop_break @ 0xE24 */
__int64 __fastcall loop_break(int a1)
{
  __int64 v2; // x1
  __int64 result; // x0
  _QWORD v4[2]; // [xsp+10h] [xbp+10h]
  int v5; // [xsp+20h] [xbp+20h]

  v2 = 0;
  v4[0] = 0x140000000ALL;
  v4[1] = 0x280000001ELL;
  v5 = 50;
  while ( 1 )
  {
    result = (unsigned int)v2;
    if ( *((_DWORD *)v4 + v2) == a1 )
      break;
    if ( ++v2 == 5 )
      return 0xFFFFFFFFLL;
  }
  return result;
}


/* Function: loop_continue @ 0xEB0 */
__int64 __fastcall loop_continue(int a1)
{
  int v2; // w1
  __int64 result; // x0

  v2 = 1;
  result = 0;
  while ( v2 <= a1 )
  {
    if ( (v2 & 1) != 0 )
      result = (unsigned int)(result + v2);
    ++v2;
  }
  return result;
}


/* Function: goto_forward @ 0xED8 */
__int64 __fastcall goto_forward(int a1)
{
  if ( a1 > 0 )
    a1 *= a1;
  return (unsigned int)(2 * a1);
}


/* Function: goto_backward @ 0xEEC */
__int64 __fastcall goto_backward(int a1)
{
  __int64 result; // x0
  int i; // w1

  result = 1;
  if ( a1 > 0 )
  {
    for ( i = 1; i <= a1; ++i )
      result = (unsigned int)(result * i);
  }
  return result;
}


/* Function: ternary_op @ 0xF14 */
__int64 __fastcall ternary_op(__int64 result, int a2)
{
  if ( a2 < (int)result )
    return (unsigned int)result;
  else
    return (unsigned int)a2;
}


/* Function: test_control_flow_l1 @ 0xF20 */
__int64 test_control_flow_l1()
{
  int v0; // w0
  int v1; // w0
  int v2; // w0
  int v3; // w0
  int v4; // w0
  int v5; // w0
  int v6; // w0

  puts(asc_1C70);
  __printf_chk(1, "CF-L1-01 (sequential_ops): %d\n", 21);
  __printf_chk(1, "CF-L1-02 (single_if): %d\n", 20);
  __printf_chk(1, "CF-L1-02 (single_if): %d\n", -5);
  __printf_chk(1, "CF-L1-03 (if_else): %d\n", 1);
  __printf_chk(1, "CF-L1-03 (if_else): %d\n", 0);
  __printf_chk(1, "CF-L1-04 (nested_if_2): %d\n", 15);
  __printf_chk(1, "CF-L1-04 (nested_if_2): %d\n", 10);
  __printf_chk(1, "CF-L1-04 (nested_if_2): %d\n", 0);
  __printf_chk(1, "CF-L1-05 (nested_if_deep): %d\n", 5);
  __printf_chk(1, "CF-L1-06 (if_elseif_chain): %d\n", 20);
  __printf_chk(1, "CF-L1-07 (if_elseif_long): %d\n", 400);
  __printf_chk(1, "CF-L1-08 (switch_small): %d\n", 50);
  __printf_chk(1, "CF-L1-09 (switch_large): %d\n", 70);
  __printf_chk(1, "CF-L1-10 (switch_default): %d\n", 0);
  __printf_chk(1, "CF-L1-11 (switch_fallthrough): %d\n", 21);
  v0 = loop_for_fixed(10);
  __printf_chk(1, "CF-L1-12 (loop_for_fixed): %d\n", v0);
  v1 = loop_while(12345);
  __printf_chk(1, "CF-L1-13 (loop_while): %d\n", v1);
  v2 = loop_dowhile(9876);
  __printf_chk(1, "CF-L1-14 (loop_dowhile): %d\n", v2);
  v3 = loop_nested(3, 4);
  __printf_chk(1, "CF-L1-15 (loop_nested): %d\n", v3);
  v4 = loop_break(30);
  __printf_chk(1, "CF-L1-16 (loop_break): %d\n", v4);
  v5 = loop_break(99);
  __printf_chk(1, "CF-L1-16 (loop_break): %d\n", v5);
  v6 = loop_continue(10);
  __printf_chk(1, "CF-L1-17 (loop_continue): %d\n", v6);
  __printf_chk(1, "CF-L1-18 (goto_forward): %d\n", 50);
  __printf_chk(1, "CF-L1-18 (goto_forward): %d\n", -6);
  __printf_chk(1, "CF-L1-19 (goto_backward): %d\n", 120);
  __printf_chk(1, "CF-L1-20 (ternary_op): %d\n", 10);
  return __printf_chk(1, "CF-L1-20 (ternary_op): %d\n", 8);
}


/* Function: loop_multi_exit @ 0x1194 */
__int64 __fastcall loop_multi_exit(int a1)
{
  _OWORD *v1; // x1
  int v2; // w2
  __int64 i; // x3
  _OWORD v5[3]; // [xsp+18h] [xbp+18h] BYREF

  v1 = v5;
  v5[0] = xmmword_2258;
  v5[1] = xmmword_2268;
  v2 = 0;
  v5[2] = xmmword_2278;
  do
  {
    for ( i = 0; i != 4; ++i )
    {
      if ( *((_DWORD *)v1 + i) == a1 )
        return (unsigned int)(i + 10 * v2);
    }
    ++v2;
    ++v1;
  }
  while ( v2 != 3 );
  return 0xFFFFFFFFLL;
}


/* Function: infinite_loop @ 0x1238 */
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


/* Function: multi_return @ 0x1264 */
__int64 __fastcall multi_return(int a1)
{
  __int64 result; // x0

  if ( a1 < 0 )
    return 0xFFFFFFFFLL;
  result = (unsigned int)(2 * a1);
  if ( (int)result > 100 )
    return 4294967294LL;
  if ( (a1 & 1) != 0 )
    return (unsigned int)(a1 + 1);
  return result;
}


/* Function: conditional_return @ 0x1294 */
__int64 __fastcall conditional_return(int a1)
{
  bool v1; // cc
  unsigned int v2; // w1
  __int64 result; // x0

  v1 = a1 <= 0;
  v2 = 2 * a1;
  if ( a1 )
    LODWORD(result) = -a1;
  else
    LODWORD(result) = 0;
  if ( v1 )
    return (unsigned int)result;
  else
    return v2;
}


/* Function: duffs_device @ 0x12A8 */
__int64 __fastcall duffs_device(int *a1, int *a2, int a3)
{
  __int64 result; // x0
  int v5; // w2
  int v6; // t1
  int v7; // t1
  int v8; // t1
  int v9; // t1
  int v10; // t1
  int v11; // t1
  int v12; // t1

  result = (unsigned int)a3;
  if ( a3 <= 0 )
    return 0xFFFFFFFFLL;
  v5 = (a3 + 7) >> 3;
  switch ( result & 7 )
  {
    case 1LL:
      goto LABEL_10;
    case 2LL:
      goto LABEL_9;
    case 3LL:
      goto LABEL_8;
    case 4LL:
      goto LABEL_7;
    case 5LL:
      goto LABEL_6;
    case 6LL:
      goto LABEL_5;
    case 7LL:
      goto LABEL_4;
    default:
      while ( 1 )
      {
        v6 = *a2++;
        *a1++ = v6;
LABEL_4:
        v7 = *a2++;
        *a1++ = v7;
LABEL_5:
        v8 = *a2++;
        *a1++ = v8;
LABEL_6:
        v9 = *a2++;
        *a1++ = v9;
LABEL_7:
        v10 = *a2++;
        *a1++ = v10;
LABEL_8:
        v11 = *a2++;
        *a1++ = v11;
LABEL_9:
        v12 = *a2++;
        *a1++ = v12;
LABEL_10:
        --v5;
        *a1 = *a2;
        if ( !v5 )
          break;
        ++a2;
        ++a1;
      }
      break;
  }
  return result;
}


/* Function: loop_complex_cond @ 0x1344 */
__int64 __fastcall loop_complex_cond(int a1)
{
  int i; // w1

  for ( i = 0; 2 * i < a1 - i && i <= 9; ++i )
    ;
  return (unsigned int)(2 * i + a1);
}


/* Function: loop_modify_var @ 0x1370 */
__int64 __fastcall loop_modify_var(int a1)
{
  int v2; // w1
  __int64 result; // x0

  v2 = 0;
  result = 0;
  while ( v2 < a1 )
  {
    result = (unsigned int)(result + v2);
    if ( v2 > 5 )
      v2 += 2;
    ++v2;
  }
  return result;
}


/* Function: loop_external_state @ 0x13A0 */
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


/* Function: tail_recursion @ 0x13C0 */
__int64 __fastcall tail_recursion(int a1, unsigned int a2)
{
  __int64 result; // x0

  result = a2;
  while ( a1 > 1 )
    result = (unsigned int)(result * a1--);
  return result;
}


/* Function: indirect_recursion_a @ 0x13E0 */
__int64 __fastcall indirect_recursion_a(__int64 result, int a2)
{
  int v2; // w0

  while ( a2 > 0 )
  {
    if ( (result & 1) != 0 )
    {
      v2 = 3 * result;
      if ( a2 == 1 )
        return (unsigned int)(v2 + 1);
      result = (unsigned int)(v2 + 2);
    }
    else
    {
      result = (unsigned int)((int)result / 2);
      if ( a2 == 1 )
        return result;
      result = (unsigned int)(result + 1);
    }
    a2 -= 2;
  }
  return result;
}


/* Function: call_func_ptr @ 0x1424 */
__int64 __fastcall call_func_ptr(__int64 (__fastcall *a1)(_QWORD), unsigned int a2)
{
  return a1(a2);
}


/* Function: call_func_ptr_array @ 0x1430 */
__int64 __fastcall call_func_ptr_array(unsigned int a1, unsigned int a2)
{
  _QWORD v3[3]; // [xsp+10h] [xbp+10h]

  v3[0] = off_13010[0];
  v3[1] = off_13018[0];
  v3[2] = off_13020[0];
  if ( a1 > 2 )
    return 0xFFFFFFFFLL;
  else
    return ((__int64 (__fastcall *)(_QWORD))v3[a1])(a2);
}


/* Function: call_virtual_func @ 0x14C8 */
__int64 __fastcall call_virtual_func(__int64 a1, int a2)
{
  return (unsigned int)(2 * a2);
}


/* Function: process_with_callback @ 0x14D0 */
__int64 __fastcall process_with_callback(__int64 a1, int a2, __int64 (__fastcall *a3)(__int64))
{
  __int64 v6; // x19
  unsigned int v7; // w20
  __int64 v9; // x0

  v6 = 0;
  v7 = 0;
  while ( a2 > (int)v6 )
  {
    v9 = *(unsigned int *)(a1 + 4 * v6++);
    v7 += a3(v9);
  }
  return v7;
}


/* Function: test_control_flow_l2 @ 0x152C */
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
  int v13; // [xsp+38h] [xbp+38h] BYREF
  int v14; // [xsp+3Ch] [xbp+3Ch] BYREF
  _QWORD v15[2]; // [xsp+40h] [xbp+40h] BYREF
  int v16; // [xsp+50h] [xbp+50h]
  _OWORD v17[2]; // [xsp+58h] [xbp+58h] BYREF
  _QWORD v18[4]; // [xsp+78h] [xbp+78h] BYREF

  puts(asc_1EDD);
  v0 = loop_multi_exit(7);
  __printf_chk(1, "CF-L2-01 (loop_multi_exit): %d\n", v0);
  v13 = 0;
  v1 = infinite_loop(&v13);
  __printf_chk(1, "CF-L2-02 (infinite_loop): %d\n", v1);
  __printf_chk(1, "CF-L2-03 (multi_return): %d\n", -1);
  __printf_chk(1, "CF-L2-03 (multi_return): %d\n", -2);
  __printf_chk(1, "CF-L2-03 (multi_return): %d\n", 4);
  __printf_chk(1, "CF-L2-04 (conditional_return): %d\n", 10);
  __printf_chk(1, "CF-L2-04 (conditional_return): %d\n", 5);
  memset(v18, 0, sizeof(v18));
  v17[0] = xmmword_2288;
  v17[1] = xmmword_2298;
  v2 = duffs_device((int *)v18, (int *)v17, 8);
  __printf_chk(1, "CF-L2-05 (duffs_device): %d\n", v2);
  v3 = loop_complex_cond(10);
  __printf_chk(1, "CF-L2-06 (loop_complex_cond): %d\n", v3);
  v4 = loop_modify_var(10);
  __printf_chk(1, "CF-L2-07 (loop_modify_var): %d\n", v4);
  v14 = 0;
  v5 = loop_external_state(&v14);
  __printf_chk(1, "CF-L2-08 (loop_external_state): %d\n", v5);
  v6 = recursion_factorial(5);
  __printf_chk(1, "CF-L2-09 (recursion_factorial): %d\n", v6);
  __printf_chk(1, "CF-L2-10 (tail_recursion): %d\n", 120);
  v7 = indirect_recursion_a(6, 1);
  __printf_chk(1, "CF-L2-11 (indirect_recursion): %d\n", v7);
  v8 = call_func_ptr((__int64 (__fastcall *)(_QWORD))double_value, 5u);
  __printf_chk(1, "CF-L2-12 (call_func_ptr): %d\n", v8);
  v9 = call_func_ptr_array(0, 5u);
  __printf_chk(1, "CF-L2-13 (call_func_ptr_array): %d\n", v9);
  v10 = call_func_ptr_array(2u, 5u);
  __printf_chk(1, "CF-L2-13 (call_func_ptr_array): %d\n", v10);
  v15[0] = 0x200000001LL;
  v15[1] = 0x400000003LL;
  v16 = 5;
  v11 = process_with_callback((__int64)v15, 5, (__int64 (__fastcall *)(__int64))double_value);
  __printf_chk(1, "CF-L2-15 (process_with_callback): %d\n", v11);
  return &_stack_chk_guard;
}


/* Function: non_local_jump @ 0x17AC */
__int64 __fastcall non_local_jump(int a1)
{
  __int64 v1; // x1
  __int64 result; // x0

  if ( _setjmp(&jump_buffer) )
    return 0xFFFFFFFFLL;
  if ( a1 < 0 )
  {
    v1 = 1;
    goto LABEL_4;
  }
  result = (unsigned int)(2 * a1);
  if ( a1 > 100 )
  {
    v1 = 2;
LABEL_4:
    __longjmp_chk(&jump_buffer, v1);
  }
  return result;
}


/* Function: cpp_exception @ 0x1808 */
__int64 __fastcall cpp_exception(int a1)
{
  if ( a1 < 0 )
    return 0xFFFFFFFFLL;
  if ( a1 >= 101 )
    return 4294967294LL;
  return (unsigned int)(2 * a1);
}


/* Function: large_jump_table @ 0x1828 */
__int64 __fastcall large_jump_table(unsigned int a1, unsigned int a2, unsigned int a3)
{
  _OWORD v4[5]; // [xsp+18h] [xbp+18h]

  v4[0] = *(_OWORD *)off_13028;
  v4[1] = *(_OWORD *)off_13038;
  v4[2] = *(_OWORD *)off_13048;
  v4[3] = *(_OWORD *)off_13058;
  v4[4] = *(_OWORD *)off_13068;
  if ( a1 > 9 )
    return 0xFFFFFFFFLL;
  else
    return (*((__int64 (__fastcall **)(_QWORD, _QWORD))v4 + (int)a1))(a2, a3);
}


/* Function: conditional_func_ptr @ 0x18D0 */
__int64 __fastcall conditional_func_ptr(int a1, unsigned int a2)
{
  __int64 (__fastcall *v2)(int); // x2

  if ( !a1 )
    return double_value(a2);
  v2 = triple_value;
  if ( a1 != 1 )
    v2 = recursion_factorial;
  return v2(a2);
}


/* Function: state_machine @ 0x1908 */
__int64 __fastcall state_machine(int a1, unsigned int a2)
{
  __int64 result; // x0

  result = a2;
  switch ( a2 )
  {
    case 0u:
      result = a1 == 1;
      break;
    case 1u:
      if ( a1 == 2 )
      {
        result = 2;
      }
      else if ( a1 == 99 )
      {
        result = 3;
      }
      else
      {
        result = a2;
      }
      break;
    case 2u:
      return result;
    case 3u:
      if ( a1 )
        result = a2;
      else
        result = 0;
      break;
    default:
      result = 3;
      break;
  }
  return result;
}


/* Function: fsm_func_table @ 0x1970 */
__int64 __fastcall fsm_func_table(__int64 a1, unsigned int a2)
{
  _OWORD v3[2]; // [xsp+18h] [xbp+18h]

  v3[0] = *(_OWORD *)off_13078;
  v3[1] = *(_OWORD *)off_13088;
  if ( a2 > 3 )
    return 3;
  else
    return (*((__int64 (__fastcall **)(__int64))v3 + (int)a2))(a1);
}


/* Function: computed_goto @ 0x19FC */
__int64 __fastcall computed_goto(__int64 a1, unsigned int a2)
{
  _OWORD v3[2]; // [xsp+18h] [xbp+18h]

  v3[0] = *(_OWORD *)&off_13098;
  v3[1] = *(_OWORD *)&off_130A8;
  if ( a2 <= 3 )
    __asm { BR              X0 }
  return 0xFFFFFFFFLL;
}


/* Function: obfuscated_cf @ 0x1A8C */
__int64 __fastcall obfuscated_cf(int a1)
{
  return (unsigned int)(2 * a1);
}


/* Function: opaque_predicate @ 0x1A94 */
__int64 __fastcall opaque_predicate(int a1)
{
  return (unsigned int)(2 * a1);
}


/* Function: overlapped_code @ 0x1A9C */
__int64 __fastcall overlapped_code(int a1)
{
  if ( (a1 & 1) != 0 )
    return (unsigned int)(3 * a1 + 1);
  else
    return (unsigned int)(a1 / 2);
}


/* Function: test_control_flow_l3 @ 0x1AB8 */
void *test_control_flow_l3()
{
  int v0; // w0
  int v1; // w0
  int v2; // w0
  int v3; // w0
  int v4; // w0
  int v5; // w0
  _QWORD v7[2]; // [xsp+28h] [xbp+28h] BYREF

  puts(asc_20D0);
  v0 = non_local_jump(5);
  __printf_chk(1, "CF-L3-01 (non_local_jump): %d\n", v0);
  v1 = non_local_jump(-5);
  __printf_chk(1, "CF-L3-01 (non_local_jump): %d\n", v1);
  __printf_chk(1, "CF-L3-02 (cpp_exception): %d\n", 10);
  __printf_chk(1, "CF-L3-02 (cpp_exception): %d\n", -1);
  v2 = large_jump_table(0, 0xAu, 5u);
  __printf_chk(1, "CF-L3-03 (large_jump_table): %d\n", v2);
  v3 = conditional_func_ptr(0, 5u);
  __printf_chk(1, "CF-L3-04 (conditional_func_ptr): %d\n", v3);
  __printf_chk(1, "CF-L3-05 (state_machine): %d\n", 1);
  v4 = fsm_func_table(2, 1u);
  __printf_chk(1, "CF-L3-06 (fsm_func_table): %d\n", v4);
  v7[0] = 0x100000000LL;
  v7[1] = 0x300000002LL;
  v5 = computed_goto((__int64)v7, 2u);
  __printf_chk(1, "CF-L3-07 (computed_goto): %d\n", v5);
  __printf_chk(1, "CF-L3-08 (obfuscated_cf): %d\n", 10);
  __printf_chk(1, "CF-L3-09 (opaque_predicate): %d\n", 10);
  __printf_chk(1, "CF-L3-10 (overlapped_code): %d\n", 16);
  return &_stack_chk_guard;
}


/* Function: .term_proc @ 0x1C58 */
void term_proc()
{
  ;
}


/* FAILED to decompile: _setjmp @ 0x13248 */

/* FAILED to decompile: __libc_start_main @ 0x13250 */

/* FAILED to decompile: __cxa_finalize @ 0x13258 */

/* FAILED to decompile: __printf_chk @ 0x13260 */

/* FAILED to decompile: __stack_chk_fail @ 0x13268 */

/* FAILED to decompile: abort @ 0x13278 */

/* FAILED to decompile: puts @ 0x13280 */

/* FAILED to decompile: __longjmp_chk @ 0x13288 */

/* FAILED to decompile: __gmon_start__ @ 0x13298 */

/* Total functions decompiled: 74, failed: 9 */
