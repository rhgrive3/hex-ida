/*
 * Decompiled by IDA Pro 9.1 with Hex-Rays
 * Binary: /Users/eren/Desktop/Antigravity/compiler/build/arm64/3/3_gcc_O3_no_g
 * Processor: arm
 */

/* Function: .init_proc @ 0x990 */
__int64 init_proc()
{
  return call_weak_fn();
}


/* Function: sub_9B0 @ 0x9B0 */
void sub_9B0()
{
  JUMPOUT(0);
}


/* Function: main @ 0xB00 */
int __fastcall main(int argc, const char **argv, const char **envp)
{
  __int64 v3; // x0
  __int64 v4; // x0
  __int64 v5; // x0

  v3 = test_stack_memory(argc, argv, envp);
  v4 = test_heap_memory(v3);
  v5 = test_static_global(v4);
  test_memory_op_functions(v5);
  return 0;
}


/* Function: _start @ 0xB40 */
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


/* Function: call_weak_fn @ 0xB74 */
void *call_weak_fn()
{
  void *result; // x0

  result = &_gmon_start__;
  if ( &_gmon_start__ )
    return (void *)__gmon_start__();
  return result;
}


/* Function: deregister_tm_clones @ 0xB90 */
char *deregister_tm_clones()
{
  return &completed_0;
}


/* Function: register_tm_clones @ 0xBC0 */
char *register_tm_clones()
{
  return &completed_0;
}


/* Function: __do_global_dtors_aux @ 0xC00 */
__int64 _do_global_dtors_aux()
{
  __int64 result; // x0

  result = (unsigned __int8)completed_0;
  if ( !completed_0 )
  {
    if ( &_cxa_finalize )
      __cxa_finalize(_dso_handle);
    deregister_tm_clones();
    result = 1;
    completed_0 = 1;
  }
  return result;
}


/* Function: frame_dummy @ 0xC50 */
// attributes: thunk
char *frame_dummy()
{
  return register_tm_clones();
}


/* Function: double_value @ 0xC60 */
__int64 __fastcall double_value(int a1)
{
  return (unsigned int)(2 * a1);
}


/* Function: alloca_usage.constprop.0 @ 0xC70 */
__int64 alloca_usage_constprop_0()
{
  return 15;
}


/* Function: local_vars @ 0xC80 */
__int64 __fastcall local_vars(int a1)
{
  return (unsigned int)(2 * a1 + 10);
}


/* Function: local_array @ 0xC90 */
__int64 __fastcall local_array(int a1)
{
  return vmulq_n_s32((int32x4_t)xmmword_29D0, a1).n128_u32[1];
}


/* Function: local_struct @ 0xCB0 */
__int64 __fastcall local_struct(int a1)
{
  return (unsigned int)(3 * a1);
}


/* Function: address_of_local @ 0xCC0 */
__int64 __fastcall address_of_local(_DWORD *a1)
{
  __int64 result; // x0

  result = 42;
  *a1 = 42;
  return result;
}


/* Function: address_of_array @ 0xCD0 */
__int64 __fastcall address_of_array(_DWORD *a1)
{
  return (unsigned int)(2 * *a1);
}


/* Function: large_stack_frame @ 0xCE0 */
__int64 large_stack_frame()
{
  int8x16_t *v0; // x0
  int32x4_t v1; // q17
  int32x4_t v2; // q16
  int32x4_t v3; // q7
  int32x4_t v4; // q6
  int32x4_t v5; // q1
  int32x4_t v6; // q0
  _BYTE v8[2048]; // [xsp+10h] [xbp+10h] BYREF
  char v9; // [xsp+810h] [xbp+810h] BYREF

  v0 = (int8x16_t *)v8;
  v1.n128_u64[0] = 0x1000000010LL;
  v1.n128_u64[1] = 0x1000000010LL;
  v2.n128_u64[0] = 0x400000004LL;
  v2.n128_u64[1] = 0x400000004LL;
  v3.n128_u64[0] = 0x800000008LL;
  v3.n128_u64[1] = 0x800000008LL;
  v4.n128_u64[0] = 0xC0000000CLL;
  v4.n128_u64[1] = 0xC0000000CLL;
  v5 = (int32x4_t)xmmword_29E0;
  do
  {
    v6 = v5;
    v5 = vaddq_s32(v5, v1);
    *v0++ = vmovn_hight_s16(
              vmovn_s16(vmovn_hight_s32(vmovn_s32(v6), vaddq_s32(v6, v2))),
              vmovn_hight_s32(vmovn_s32(vaddq_s32(v6, v3)), vaddq_s32(v6, v4)));
  }
  while ( &v9 != (char *)v0 );
  return v8[1024];
}


/* Function: vla_stack @ 0xD90 */
__int64 __fastcall vla_stack(int a1)
{
  __int64 v1; // x1
  unsigned __int64 v2; // x2
  unsigned __int16 v3; // w1
  __int64 *v4; // x2
  int32x4_t v5; // q2
  int32x4_t *v6; // x1
  int32x4_t v7; // q1
  int32x4_t v8; // q0
  unsigned int v9; // w1
  int v10; // w2
  _DWORD *v11; // x6
  __int64 v13; // [xsp+0h] [xbp-10010h] BYREF
  _BYTE v14[3]; // [xsp+10h] [xbp-10000h] BYREF
  __int64 v15; // [xsp+400h] [xbp-FC10h]
  _BYTE v16[16]; // [xsp+10000h] [xbp-10h] BYREF

  if ( (unsigned int)(a1 - 1) <= 0x3E7 )
  {
    v1 = 4LL * a1 + 15;
    v2 = v1 & 0xFFFFFFFFFFFF0000LL;
    v3 = v1 & 0xFFF0;
    v4 = (__int64 *)&v16[-v2];
    if ( v16 != (_BYTE *)v4 )
    {
      do
        v15 = 0;
      while ( &v13 != v4 );
    }
    v13 = 0;
    if ( v3 >= 0x400uLL )
      v15 = 0;
    if ( (unsigned int)(a1 - 1) <= 2 )
    {
      v9 = 0;
    }
    else
    {
      v5.n128_u64[0] = 0x400000004LL;
      v5.n128_u64[1] = 0x400000004LL;
      v6 = (int32x4_t *)v14;
      v7 = (int32x4_t)xmmword_29E0;
      do
      {
        v8 = v7;
        v7 = vaddq_s32(v7, v5);
        *v6++ = vshlq_n_s32(v8, 1u);
      }
      while ( v6 != (int32x4_t *)&v14[16 * ((unsigned int)a1 >> 2)] );
      v9 = a1 & 0xFFFFFFFC;
      if ( (a1 & 3) == 0 )
        return *(unsigned int *)&v14[4 * (a1 >> 1)];
    }
    v10 = 2 * v9;
    v11 = &v14[4 * v9];
    *v11 = 2 * v9;
    if ( (int)(v9 + 1) < a1 )
    {
      v11[1] = v10 + 2;
      if ( a1 > (int)(v9 + 2) )
        v11[2] = v10 + 4;
    }
    return *(unsigned int *)&v14[4 * (a1 >> 1)];
  }
  return 0xFFFFFFFFLL;
}


/* Function: alloca_usage @ 0xED0 */
__int64 __fastcall alloca_usage(int a1)
{
  __int64 v1; // x1
  unsigned __int64 v2; // x2
  unsigned __int16 v3; // w1
  __int64 *v4; // x2
  int32x4_t v5; // q3
  int32x4_t *v6; // x1
  int32x4_t v7; // q1
  int32x4_t v8; // q2
  int v9; // w1
  int v10; // w2
  _DWORD *v11; // x4
  __int64 v13; // [xsp+0h] [xbp-10010h] BYREF
  _DWORD v14[252]; // [xsp+10h] [xbp-10000h] BYREF
  __int64 v15; // [xsp+400h] [xbp-FC10h]
  _BYTE v16[16]; // [xsp+10000h] [xbp-10h] BYREF

  if ( a1 > 0 )
  {
    v1 = 4LL * a1 + 15;
    v2 = v1 & 0xFFFFFFFFFFFF0000LL;
    v3 = v1 & 0xFFF0;
    v4 = (__int64 *)&v16[-v2];
    if ( v16 != (_BYTE *)v4 )
    {
      do
        v15 = 0;
      while ( &v13 != v4 );
    }
    v13 = 0;
    if ( v3 >= 0x400uLL )
      v15 = 0;
    if ( (unsigned int)(a1 - 1) <= 2 )
    {
      v9 = 0;
    }
    else
    {
      v5.n128_u64[0] = 0x400000004LL;
      v5.n128_u64[1] = 0x400000004LL;
      v6 = (int32x4_t *)v14;
      v7 = (int32x4_t)xmmword_29E0;
      do
      {
        v8 = v7;
        v7 = vaddq_s32(v7, v5);
        *v6++ = vaddq_s32(vshlq_n_s32(v8, 1u), v8);
      }
      while ( v6 != (int32x4_t *)&v14[4 * ((unsigned int)a1 >> 2)] );
      v9 = a1 & 0x7FFFFFFC;
      if ( (a1 & 3) == 0 )
        return (unsigned int)v14[a1 >> 1];
    }
    v10 = 3 * v9;
    v14[v9] = 3 * v9;
    if ( v9 + 1 < a1 )
    {
      v11 = &v14[v9];
      v11[1] = v10 + 3;
      if ( a1 > v9 + 2 )
        v11[2] = v10 + 6;
    }
    return (unsigned int)v14[a1 >> 1];
  }
  return 0xFFFFFFFFLL;
}


/* Function: stack_alias @ 0x1010 */
__int64 stack_alias()
{
  return 20;
}


/* Function: test_stack_memory @ 0x1020 */
__int64 test_stack_memory()
{
  int v0; // w0
  int v1; // w0

  puts(asc_22B8);
  __printf_chk(1, "MEM-L1-01 (local_vars): %d\n", 20);
  __printf_chk(1, "MEM-L1-02 (local_array): %d\n", 10);
  __printf_chk(1, "MEM-L1-03 (local_struct): %d\n", 15);
  __printf_chk(1, "MEM-L1-04 (address_of_local): %d\n", 42);
  __printf_chk(1, "MEM-L1-05 (address_of_array): %d\n", 2);
  v0 = large_stack_frame();
  __printf_chk(1, "MEM-L2-01 (large_stack_frame): %d\n", v0);
  __printf_chk(1, "MEM-L2-02 (vla_stack): %d\n", 10);
  v1 = alloca_usage_constprop_0();
  __printf_chk(1, "MEM-L2-03 (alloca_usage): %d\n", v1);
  return __printf_chk(1, "MEM-L2-04 (stack_alias): %d\n", 20);
}


/* Function: heap_basic @ 0x10F4 */
__int64 __fastcall heap_basic(int a1)
{
  int32x4_t *v2; // x0
  int32x4_t v3; // q2
  int32x4_t *v4; // x1
  int32x4_t v5; // q1
  int32x4_t v6; // q0
  int v7; // w1
  int v8; // w2
  char *v9; // x3
  unsigned __int32 v10; // w19

  v2 = (int32x4_t *)malloc(4LL * a1);
  if ( !v2 )
    return (unsigned __int32)-1;
  if ( a1 > 0 )
  {
    if ( (unsigned int)(a1 - 1) <= 2 )
    {
      v7 = 0;
      goto LABEL_7;
    }
    v3.n128_u64[0] = 0x400000004LL;
    v3.n128_u64[1] = 0x400000004LL;
    v4 = v2;
    v5 = (int32x4_t)xmmword_29E0;
    do
    {
      v6 = v5;
      v5 = vaddq_s32(v5, v3);
      *v4++ = vshlq_n_s32(v6, 1u);
    }
    while ( v4 != &v2[(unsigned int)a1 >> 2] );
    v7 = a1 & 0x7FFFFFFC;
    if ( (a1 & 3) != 0 )
    {
LABEL_7:
      v8 = 2 * v7;
      v2->n128_u32[v7] = 2 * v7;
      if ( a1 > v7 + 1 )
      {
        v9 = (char *)v2 + 4 * v7;
        *((_DWORD *)v9 + 1) = v8 + 2;
        if ( a1 > v7 + 2 )
          *((_DWORD *)v9 + 2) = v8 + 4;
      }
    }
  }
  v10 = v2->n128_u32[a1 / 2];
  free(v2);
  return v10;
}


/* Function: heap_calloc @ 0x11D0 */
__int64 __fastcall heap_calloc(int a1)
{
  int32x4_t *v2; // x0
  int32x4_t *v3; // x1
  int32x4_t v4; // q0
  int32x4_t v5; // t1
  int v6; // w1
  unsigned int v7; // w19
  char *v8; // x2

  v2 = (int32x4_t *)calloc(a1, 4u);
  if ( !v2 )
    return (unsigned int)-1;
  if ( a1 <= 0 )
  {
    v7 = 0;
  }
  else
  {
    if ( (unsigned int)(a1 - 1) <= 2 )
    {
      v6 = 0;
      v7 = 0;
      goto LABEL_7;
    }
    v3 = v2;
    v4 = 0u;
    do
    {
      v5 = *v3++;
      v4 = vaddq_s32(v4, v5);
    }
    while ( v3 != &v2[(unsigned int)a1 >> 2] );
    v6 = a1 & 0x7FFFFFFC;
    v7 = vaddvq_s32(v4);
    if ( (a1 & 3) != 0 )
    {
LABEL_7:
      v7 += v2->n128_u32[v6];
      if ( a1 > v6 + 1 )
      {
        v8 = (char *)v2 + 4 * v6;
        v7 += *((_DWORD *)v8 + 1);
        if ( a1 > v6 + 2 )
          v7 += *((_DWORD *)v8 + 2);
      }
    }
  }
  free(v2);
  return v7;
}


/* Function: heap_realloc @ 0x12A4 */
__int64 heap_realloc()
{
  _DWORD *v0; // x0
  void *v1; // x19
  char *v2; // x0
  unsigned int v3; // w19
  void *v5; // x0

  v0 = malloc(0x14u);
  if ( v0 )
  {
    v0[4] = 5;
    v1 = v0;
    *(_OWORD *)v0 = xmmword_29F0;
    v2 = (char *)realloc(v0, 0x28u);
    if ( v2 )
    {
      if ( *((_DWORD *)v2 + 2) == 3 )
        v3 = 50;
      else
        v3 = -3;
      *(_OWORD *)(v2 + 20) = xmmword_2A00;
      free(v2);
    }
    else
    {
      v5 = v1;
      v3 = -2;
      free(v5);
    }
  }
  else
  {
    return (unsigned int)-1;
  }
  return v3;
}


/* Function: heap_array @ 0x1330 */
__int64 __fastcall heap_array(int a1)
{
  int32x4_t *v2; // x0
  int32x4_t v3; // q3
  int32x4_t *v4; // x1
  int32x4_t v5; // q1
  int32x4_t v6; // q2
  int v7; // w1
  int v8; // w2
  char *v9; // x3
  unsigned __int32 v10; // w19

  v2 = (int32x4_t *)malloc(4LL * a1);
  if ( !v2 )
    return (unsigned __int32)-1;
  if ( a1 > 0 )
  {
    if ( (unsigned int)(a1 - 1) <= 2 )
    {
      v7 = 0;
      goto LABEL_7;
    }
    v3.n128_u64[0] = 0x400000004LL;
    v3.n128_u64[1] = 0x400000004LL;
    v4 = v2;
    v5 = (int32x4_t)xmmword_29E0;
    do
    {
      v6 = v5;
      v5 = vaddq_s32(v5, v3);
      *v4++ = vaddq_s32(vshlq_n_s32(v6, 1u), v6);
    }
    while ( v4 != &v2[(unsigned int)a1 >> 2] );
    v7 = a1 & 0x7FFFFFFC;
    if ( (a1 & 3) != 0 )
    {
LABEL_7:
      v8 = 3 * v7;
      v2->n128_u32[v7] = 3 * v7;
      if ( a1 > v7 + 1 )
      {
        v9 = (char *)v2 + 4 * v7;
        *((_DWORD *)v9 + 1) = v8 + 3;
        if ( a1 > v7 + 2 )
          *((_DWORD *)v9 + 2) = v8 + 6;
      }
    }
  }
  v10 = v2->n128_u32[a1 / 2];
  free(v2);
  return v10;
}


/* Function: heap_struct @ 0x1410 */
__int64 __fastcall heap_struct(int a1)
{
  void *v2; // x0
  unsigned int v3; // w19

  v2 = malloc(8u);
  if ( v2 )
  {
    v3 = 3 * a1;
    free(v2);
  }
  else
  {
    return (unsigned int)-1;
  }
  return v3;
}


/* Function: heap_nested @ 0x1450 */
__int64 __fastcall heap_nested(_QWORD *a1)
{
  _DWORD *v2; // x0
  _QWORD *v3; // x19
  _QWORD *v4; // x0
  _QWORD *v5; // x1
  __int64 result; // x0

  v2 = malloc(0x10u);
  *a1 = v2;
  if ( !v2 )
    return 0xFFFFFFFFLL;
  v3 = v2;
  *v2 = 10;
  v4 = malloc(0x10u);
  v3[1] = v4;
  v5 = v4;
  if ( v4 )
  {
    result = 0;
    *(_DWORD *)v5 = 20;
    v5[1] = 0;
  }
  else
  {
    free(v3);
    return 4294967294LL;
  }
  return result;
}


/* Function: linked_list_heap @ 0x14C4 */
__int64 linked_list_heap()
{
  int v0; // w20
  _QWORD *v1; // x19
  _QWORD *i; // x21
  _QWORD *v3; // x0
  _QWORD *v4; // x0
  unsigned int v5; // w20
  int v6; // w1
  void *v7; // x0
  void *v9; // x0

  v0 = 0;
  v1 = 0;
  for ( i = 0; ; i = v3 )
  {
    v3 = malloc(0x10u);
    if ( !v3 )
      break;
    *(_DWORD *)v3 = v0;
    v3[1] = 0;
    if ( v1 )
    {
      v0 += 10;
      i[1] = v3;
      if ( v0 == 50 )
        goto LABEL_7;
    }
    else
    {
      v0 += 10;
      v1 = v3;
      if ( v0 == 50 )
      {
LABEL_7:
        v4 = v1;
        v5 = 0;
        do
        {
          v6 = *(_DWORD *)v4;
          v4 = (_QWORD *)v4[1];
          v5 += v6;
        }
        while ( v4 );
        do
        {
          v7 = v1;
          v1 = (_QWORD *)v1[1];
          free(v7);
        }
        while ( v1 );
        return v5;
      }
    }
  }
  while ( v1 )
  {
    v9 = v1;
    v1 = (_QWORD *)v1[1];
    free(v9);
  }
  return (unsigned int)-1;
}


/* Function: create_tree_node @ 0x1580 */
_QWORD *__fastcall create_tree_node(int a1)
{
  _QWORD *result; // x0

  result = malloc(0x18u);
  if ( result )
  {
    *(_DWORD *)result = a1;
    result[1] = 0;
    result[2] = 0;
  }
  return result;
}


/* Function: tree_heap_traversal @ 0x15B0 */
__int64 tree_heap_traversal()
{
  void *v0; // x0
  void *v1; // x19
  void *v2; // x20
  void *v3; // x21
  void *v5; // x0

  v0 = malloc(0x18u);
  if ( !v0 )
    return 0xFFFFFFFFLL;
  v1 = v0;
  v2 = malloc(0x18u);
  if ( !v2 )
  {
    v5 = malloc(0x18u);
    if ( v5 )
      free(v5);
    goto LABEL_7;
  }
  v3 = malloc(0x18u);
  if ( !v3 )
  {
    free(v2);
LABEL_7:
    free(v1);
    return 4294967294LL;
  }
  free(v2);
  free(v3);
  free(v1);
  return 60;
}


/* Function: memory_leak @ 0x1660 */
__int64 __fastcall memory_leak(int a1)
{
  int32x4_t *v2; // x0
  int32x4_t v3; // q2
  int32x4_t *v4; // x1
  int32x4_t v5; // q0
  int32x4_t v6; // q1
  int v7; // w1
  int v8; // w3
  char *v9; // x2
  int v10; // w1

  v2 = (int32x4_t *)malloc(4LL * a1);
  if ( !v2 )
    return 0xFFFFFFFFLL;
  if ( a1 > 0 )
  {
    if ( (unsigned int)(a1 - 1) <= 2 )
    {
      v7 = 0;
      goto LABEL_7;
    }
    v3.n128_u64[0] = 0x400000004LL;
    v3.n128_u64[1] = 0x400000004LL;
    v4 = v2;
    v5 = (int32x4_t)xmmword_29E0;
    do
    {
      v6 = v5;
      v5 = vaddq_s32(v5, v3);
      *v4++ = v6;
    }
    while ( v4 != &v2[(unsigned int)a1 >> 2] );
    v7 = a1 & 0x7FFFFFFC;
    if ( (a1 & 3) != 0 )
    {
LABEL_7:
      v8 = v7 + 1;
      v2->n128_u32[v7] = v7;
      if ( a1 > v7 + 1 )
      {
        v9 = (char *)v2 + 4 * v7;
        v10 = v7 + 2;
        *((_DWORD *)v9 + 1) = v8;
        if ( a1 > v10 )
          *((_DWORD *)v9 + 2) = v10;
      }
    }
  }
  return v2->n128_u32[a1 / 2];
}


/* Function: dangling_pointer @ 0x1720 */
__int64 dangling_pointer()
{
  unsigned int *v0; // x0
  unsigned int *v1; // x19

  v0 = (unsigned int *)malloc(4u);
  if ( !v0 )
    return 0xFFFFFFFFLL;
  v1 = v0;
  __printf_chk(1, "value before free: %d\n", 42);
  free(v1);
  return *v1;
}


/* Function: double_free @ 0x1770 */
__int64 __fastcall double_free(unsigned int *a1)
{
  void *v2; // x0
  void *v3; // x19

  if ( a1 )
    return *a1;
  v2 = malloc(4u);
  v3 = v2;
  if ( !v2 )
    return 0xFFFFFFFFLL;
  free(v2);
  free(v3);
  return 4294967294LL;
}


/* Function: heap_overflow @ 0x17C0 */
__int64 heap_overflow()
{
  void *v0; // x0

  v0 = malloc(0x28u);
  if ( !v0 )
    return 0xFFFFFFFFLL;
  free(v0);
  return 0;
}


/* Function: test_heap_memory @ 0x17F0 */
void test_heap_memory()
{
  _OWORD *v0; // x0
  int v1; // w2
  int32x4_t *v2; // x0
  int v3; // w19
  int v4; // w0
  _OWORD *v5; // x0
  int v6; // w2
  void *v7; // x0
  int v8; // w2
  void **v9; // x19
  _DWORD *v10; // x0
  int v11; // w2
  int v12; // w20
  _QWORD *v13; // x21
  _QWORD *v14; // x19
  _QWORD *v15; // x0
  _QWORD *v16; // x0
  int v17; // w20
  int v18; // w1
  void *v19; // x0
  int v20; // w0
  _DWORD *v21; // x0
  int v22; // w2
  int v23; // w0
  unsigned int *v24; // x19
  __int64 v25; // x2
  void *v26; // x0
  int stat_loc; // [xsp+34h] [xbp+34h] BYREF

  puts(asc_2428);
  v0 = malloc(0x28u);
  if ( v0 )
  {
    v0[1] = xmmword_2A10;
    *((_QWORD *)v0 + 4) = 0x1200000010LL;
    free(v0);
    v1 = 10;
  }
  else
  {
    v1 = -1;
  }
  __printf_chk(1, "HEAP-L2-01 (heap_basic): %d\n", v1);
  v2 = (int32x4_t *)calloc(5u, 4u);
  if ( v2 )
  {
    v3 = vaddvq_s32(*v2) + v2[1].n128_u32[0];
    free(v2);
  }
  else
  {
    v3 = -1;
  }
  __printf_chk(1, "HEAP-L2-02 (heap_calloc): %d\n", v3);
  v4 = heap_realloc();
  __printf_chk(1, "HEAP-L2-03 (heap_realloc): %d\n", v4);
  v5 = malloc(0x28u);
  if ( v5 )
  {
    v5[1] = xmmword_2A20;
    *((_QWORD *)v5 + 4) = 0x1B00000018LL;
    free(v5);
    v6 = 15;
  }
  else
  {
    v6 = -1;
  }
  __printf_chk(1, "HEAP-L2-04 (heap_array): %d\n", v6);
  v7 = malloc(8u);
  if ( v7 )
  {
    free(v7);
    v8 = 15;
  }
  else
  {
    v8 = -1;
  }
  __printf_chk(1, "HEAP-L2-05 (heap_struct): %d\n", v8);
  v9 = (void **)malloc(0x10u);
  if ( v9 )
  {
    v10 = malloc(0x10u);
    v9[1] = v10;
    if ( v10 )
    {
      v11 = 0;
      *v10 = 20;
      *((_QWORD *)v10 + 1) = 0;
    }
    else
    {
      free(v9);
      v11 = -2;
    }
    __printf_chk(1, "HEAP-L2-06 (heap_nested): %d\n", v11);
    free(v9[1]);
    free(v9);
  }
  else
  {
    __printf_chk(1, "HEAP-L2-06 (heap_nested): %d\n", -1);
  }
  v12 = 0;
  v13 = 0;
  v14 = 0;
  while ( 1 )
  {
    v15 = malloc(0x10u);
    if ( !v15 )
      break;
    *(_DWORD *)v15 = v12;
    v12 += 10;
    v15[1] = 0;
    if ( v14 )
    {
      v13[1] = v15;
      if ( v12 == 50 )
        goto LABEL_19;
    }
    else
    {
      v14 = v15;
      if ( v12 == 50 )
      {
LABEL_19:
        v16 = v14;
        v17 = 0;
        do
        {
          v18 = *(_DWORD *)v16;
          v16 = (_QWORD *)v16[1];
          v17 += v18;
        }
        while ( v16 );
        do
        {
          v19 = v14;
          v14 = (_QWORD *)v14[1];
          free(v19);
        }
        while ( v14 );
        goto LABEL_22;
      }
    }
    v13 = v15;
  }
  while ( v14 )
  {
    v26 = v14;
    v14 = (_QWORD *)v14[1];
    free(v26);
  }
  v17 = -1;
LABEL_22:
  __printf_chk(1, "HEAP-L3-01 (linked_list_heap): %d\n", v17);
  v20 = tree_heap_traversal();
  __printf_chk(1, "HEAP-L3-02 (tree_heap_traversal): %d\n", v20);
  v21 = malloc(0x14u);
  if ( v21 )
  {
    v22 = 2;
    v21[4] = 4;
    *(_OWORD *)v21 = xmmword_29E0;
  }
  else
  {
    v22 = -1;
  }
  __printf_chk(1, "HEAP-L3-03 (memory_leak): %d\n", v22);
  __printf_chk(1, "HEAP-L3-04 (dangling_pointer): ");
  v23 = fork();
  if ( !v23 )
  {
    v24 = (unsigned int *)malloc(4u);
    if ( v24 )
    {
      __printf_chk(1, "value before free: %d\n", 42);
      free(v24);
      v25 = *v24;
    }
    else
    {
      v25 = 0xFFFFFFFFLL;
    }
    __printf_chk(1, aD, v25);
    exit(0);
  }
  if ( v23 <= 0 )
  {
    perror(aFork_0);
  }
  else
  {
    waitpid(v23, &stat_loc, 0);
    if ( (stat_loc & 0x7F) != 0 )
    {
      if ( ((stat_loc & 0x7F) + 1) << 24 >> 25 > 0 )
        __printf_chk(1, byte_25B0);
    }
    else
    {
      __printf_chk(1, byte_2588, BYTE1(stat_loc));
    }
  }
}


/* Function: global_var_access @ 0x1BD0 */
__int64 global_var_access()
{
  return (unsigned int)++global_counter;
}


/* Function: global_var_read @ 0x1BE4 */
__int64 global_var_read()
{
  return (unsigned int)(2 * global_counter);
}


/* Function: global_array_access @ 0x1BF4 */
__int64 __fastcall global_array_access(unsigned int a1)
{
  if ( a1 > 9 )
    return 0xFFFFFFFFLL;
  else
    return global_array[a1];
}


/* Function: static_local @ 0x1C14 */
__int64 __fastcall static_local(int a1)
{
  __int64 result; // x0

  if ( a1 )
  {
    result = 0;
    counter_1 = 0;
  }
  else
  {
    return (unsigned int)++counter_1;
  }
  return result;
}


/* Function: call_static_func @ 0x1C50 */
__int64 __fastcall call_static_func(int a1)
{
  return (unsigned int)(2 * a1 + 1);
}


/* Function: access_extern_global @ 0x1C60 */
__int64 access_extern_global()
{
  return (unsigned int)(extern_global_var + 100);
}


/* Function: call_extern_func @ 0x1C74 */
__int64 call_extern_func()
{
  return extern_function(5);
}


/* Function: read_const_data @ 0x1C80 */
__int64 read_const_data()
{
  return (unsigned int)(unsigned __int8)const_string[4] + 42;
}


/* Function: access_bss_var @ 0x1C94 */
__int64 access_bss_var()
{
  return 0;
}


/* Function: access_bss_buffer @ 0x1CA0 */
__int64 access_bss_buffer()
{
  return 0;
}


/* Function: global_struct_access @ 0x1CB0 */
__int64 global_struct_access()
{
  return 30;
}


/* Function: set_file_static @ 0x1CC0 */
__int64 __fastcall set_file_static(__int64 result)
{
  file_scope_static = result;
  return result;
}


/* Function: get_file_static @ 0x1CD0 */
__int64 get_file_static()
{
  return (unsigned int)file_scope_static;
}


/* Function: set_global_callback @ 0x1CE0 */
void *__fastcall set_global_callback(void *result)
{
  global_func_ptr = result;
  return result;
}


/* Function: call_global_callback @ 0x1CF0 */
__int64 call_global_callback()
{
  if ( global_func_ptr )
    return global_func_ptr();
  else
    return 0xFFFFFFFFLL;
}


/* Function: global_heap_store @ 0x1D10 */
__int64 __fastcall global_heap_store(unsigned int *a1)
{
  if ( a1 )
    return *a1;
  else
    return 0xFFFFFFFFLL;
}


/* Function: static_complex_init @ 0x1D24 */
__int64 static_complex_init()
{
  return 15;
}


/* Function: tls_access @ 0x1D30 */
__int64 __fastcall tls_access(int a1)
{
  return (unsigned int)(2 * a1);
}


/* Function: init_order_test @ 0x1D40 */
__int64 init_order_test()
{
  return 20;
}


/* Function: test_static_global @ 0x1D50 */
__int64 test_static_global()
{
  int v0; // w0

  puts(asc_2628);
  __printf_chk(1, "STM-L1-01 (global_var_access): %d\n", ++global_counter);
  __printf_chk(1, "STM-L1-01 (global_var_read): %d\n", 2 * global_counter);
  __printf_chk(1, "STM-L1-02 (global_array_access): %d\n", 5);
  counter_1 = 1;
  __printf_chk(1, "STM-L1-03 (static_local): %d\n", 1);
  __printf_chk(1, "STM-L1-03 (static_local): %d\n", ++counter_1);
  __printf_chk(1, "STM-L1-04 (call_static_func): %d\n", 11);
  __printf_chk(1, "STM-L2-01 (access_extern_global): %d\n", extern_global_var + 100);
  v0 = extern_function(5);
  __printf_chk(1, "STM-L2-02 (call_extern_func): %d\n", v0);
  __printf_chk(1, "STM-L2-03 (read_const_data): %d\n", (unsigned __int8)const_string[4] + 42);
  __printf_chk(1, "STM-L2-04 (access_bss_var): %d\n", 0);
  __printf_chk(1, "STM-L2-04 (access_bss_buffer): %d\n", 0);
  __printf_chk(1, "STM-L2-05 (global_struct_access): %d\n", 30);
  file_scope_static = 50;
  __printf_chk(1, "STM-L2-06 (file_static): %d\n", 50);
  global_func_ptr = (__int64 (*)(void))double_value;
  __printf_chk(1, "STM-L2-07 (global_func_ptr): %d\n", 10);
  __printf_chk(1, "STM-L2-08 (global_heap_store): %d\n", 100);
  __printf_chk(1, "STM-L2-09 (static_complex_init): %d\n", 15);
  __printf_chk(1, "STM-L3-01 (tls_access): %d\n", 20);
  return __printf_chk(1, "STM-L3-02 (init_order_test): %d\n", 20);
}


/* Function: memop_memset @ 0x1F40 */
__int64 __fastcall memop_memset(unsigned __int8 *a1, size_t n, int c)
{
  bool v3; // zf

  if ( a1 )
    v3 = n == 0;
  else
    v3 = 1;
  if ( v3 )
    return 0xFFFFFFFFLL;
  memset(a1, c, n);
  return *a1;
}


/* Function: memop_memcpy @ 0x1F84 */
__int64 __fastcall memop_memcpy(char *a1, const void *a2, size_t a3)
{
  bool v3; // zf
  unsigned __int64 v6; // x20

  if ( a2 )
    v3 = a3 == 0;
  else
    v3 = 1;
  if ( v3 || a1 == 0 )
    return 0xFFFFFFFFLL;
  v6 = a3 & 0xFFFFFFFFFFFFFFFCLL;
  memcpy(a1, a2, a3);
  return *(unsigned int *)&a1[v6 - 4];
}


/* Function: memop_memmove @ 0x1FD0 */
__int64 __fastcall memop_memmove(char *src, unsigned __int64 a2)
{
  bool v2; // cc

  if ( src )
    v2 = a2 > 1;
  else
    v2 = 0;
  if ( !v2 )
    return 0xFFFFFFFFLL;
  memmove(src + 1, src, a2 - 1);
  return (unsigned __int8)src[1];
}


/* Function: memop_memcmp @ 0x2014 */
__int64 __fastcall memop_memcmp(const void *a1, const void *a2, size_t a3)
{
  bool v3; // zf
  __int64 result; // x0
  int v6; // w0
  bool v7; // cc

  if ( a2 )
    v3 = a3 == 0;
  else
    v3 = 1;
  if ( v3 || a1 == 0 )
    return 0;
  v6 = memcmp(a1, a2, a3);
  v7 = v6 <= 0;
  if ( v6 )
    LODWORD(result) = -1;
  else
    LODWORD(result) = 0;
  if ( v7 )
    return (unsigned int)result;
  else
    return 1;
}


/* Function: memop_bzero @ 0x2050 */
__int64 __fastcall memop_bzero(unsigned __int8 *a1, size_t n)
{
  if ( !a1 )
    return 0xFFFFFFFFLL;
  memset(a1, 0, n);
  return *a1;
}


/* Function: memop_bcopy @ 0x2090 */
__int64 __fastcall memop_bcopy(void *src, void *dest, size_t a3)
{
  bool v3; // zf

  if ( dest )
    v3 = a3 == 0;
  else
    v3 = 1;
  if ( v3 || src == 0 )
    return 0xFFFFFFFFLL;
  else
    return *(unsigned __int8 *)memmove(dest, src, a3);
}


/* Function: memop_unaligned_access @ 0x20D0 */
__int64 __fastcall memop_unaligned_access(__int64 a1)
{
  if ( a1 )
    return *(unsigned int *)(a1 + 1);
  else
    return 0xFFFFFFFFLL;
}


/* Function: memop_memory_barrier @ 0x20E4 */
__int64 __fastcall memop_memory_barrier(int *a1)
{
  int v1; // w1

  if ( !a1 )
    return 0xFFFFFFFFLL;
  v1 = *a1;
  __dmb(0xBu);
  return (unsigned int)(*a1 + v1);
}


/* Function: test_memory_op_functions @ 0x2104 */
__int64 test_memory_op_functions()
{
  int v0; // w0
  int v1; // w2
  int v3; // [xsp+24h] [xbp+24h]
  __int64 s1; // [xsp+28h] [xbp+28h] BYREF
  int v5; // [xsp+30h] [xbp+30h]
  __int64 s2; // [xsp+38h] [xbp+38h] BYREF
  int v7; // [xsp+40h] [xbp+40h]
  __int64 v8; // [xsp+48h] [xbp+48h]
  __int16 v9; // [xsp+50h] [xbp+50h]
  _QWORD dest[34]; // [xsp+58h] [xbp+58h] BYREF

  puts(asc_28D8);
  memset(&dest[2], 65, 10);
  __printf_chk(1, "MEMOP-L2-01: %d\n", 65);
  __printf_chk(1, "MEMOP-L2-02: %d\n", 50);
  strcpy((char *)dest, "HelloWorld");
  memmove((char *)dest + 1, dest, 9u);
  __printf_chk(1, "MEMOP-L2-03: %c\n", 72);
  v5 = 3;
  v7 = 4;
  s1 = 0x200000001LL;
  s2 = 0x200000001LL;
  v0 = memcmp(&s1, &s2, 0xCu);
  if ( v0 )
    v1 = -1;
  else
    v1 = 0;
  if ( v0 > 0 )
    v1 = 1;
  __printf_chk(1, "MEMOP-L2-04: %d\n", v1);
  v8 = 0;
  v9 = 0;
  __printf_chk(1, "MEMOP-L2-05: %d\n", 0);
  __printf_chk(1, "MEMOP-L2-06: %d\n", 1);
  __printf_chk(1, "MEMOP-L3-01: 0x%x\n", 67305985);
  v3 = 5;
  __dmb(0xBu);
  return __printf_chk(1, "MEMOP-L3-02: %d\n", v3 + 5);
}


/* Function: extern_function @ 0x2290 */
__int64 __fastcall extern_function(int a1)
{
  return (unsigned int)(3 * a1);
}


/* Function: .term_proc @ 0x2298 */
void term_proc()
{
  ;
}


/* FAILED to decompile: memcpy @ 0x14098 */

/* FAILED to decompile: memmove @ 0x140A0 */

/* FAILED to decompile: exit @ 0x140A8 */

/* FAILED to decompile: __libc_start_main @ 0x140B0 */

/* FAILED to decompile: perror @ 0x140B8 */

/* FAILED to decompile: __cxa_finalize @ 0x140C0 */

/* FAILED to decompile: fork @ 0x140C8 */

/* FAILED to decompile: malloc @ 0x140D0 */

/* FAILED to decompile: __printf_chk @ 0x140D8 */

/* FAILED to decompile: memset @ 0x140E0 */

/* FAILED to decompile: calloc @ 0x140E8 */

/* FAILED to decompile: realloc @ 0x140F0 */

/* FAILED to decompile: __stack_chk_fail @ 0x140F8 */

/* FAILED to decompile: abort @ 0x14108 */

/* FAILED to decompile: puts @ 0x14110 */

/* FAILED to decompile: memcmp @ 0x14118 */

/* FAILED to decompile: free @ 0x14120 */

/* FAILED to decompile: waitpid @ 0x14128 */

/* FAILED to decompile: __gmon_start__ @ 0x14138 */

/* Total functions decompiled: 66, failed: 19 */
