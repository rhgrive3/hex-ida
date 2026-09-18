/*
 * Decompiled by IDA Pro 9.1 with Hex-Rays
 * Binary: /Users/eren/Desktop/Antigravity/compiler/build/arm64/3/3_clang_O2_no_g
 * Processor: arm
 */

/* Function: .init_proc @ 0x8C8 */
__int64 init_proc()
{
  return call_weak_fn();
}


/* Function: sub_8E0 @ 0x8E0 */
void sub_8E0()
{
  JUMPOUT(0);
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


/* Function: local_vars @ 0xB54 */
__int64 __fastcall local_vars(int a1)
{
  return (unsigned int)(2 * a1 + 10);
}


/* Function: local_array @ 0xB60 */
__int64 __fastcall local_array(int a1)
{
  return (unsigned int)(5 * a1);
}


/* Function: local_struct @ 0xB68 */
__int64 __fastcall local_struct(int a1)
{
  return (unsigned int)(3 * a1);
}


/* Function: address_of_local @ 0xB70 */
__int64 __fastcall address_of_local(_DWORD *a1)
{
  __int64 result; // x0

  result = 42;
  *a1 = 42;
  return result;
}


/* Function: address_of_array @ 0xB84 */
__int64 __fastcall address_of_array(_DWORD *a1)
{
  return (unsigned int)(2 * *a1);
}


/* Function: large_stack_frame @ 0xB90 */
__int64 large_stack_frame()
{
  __int64 v0; // x8
  int8x16_t v1; // q0
  int8x16_t v2; // q1
  int8x16_t v3; // q2
  int8x16_t *v4; // x10
  _BYTE v6[2048]; // [xsp+0h] [xbp-810h] BYREF

  v0 = 0;
  v1.n128_u64[0] = 0x1010101010101010LL;
  v1.n128_u64[1] = 0x1010101010101010LL;
  v2.n128_u64[0] = 0x2020202020202020LL;
  v2.n128_u64[1] = 0x2020202020202020LL;
  v3 = (int8x16_t)xmmword_1C30;
  do
  {
    v4 = (int8x16_t *)&v6[v0];
    v0 += 32;
    *v4 = v3;
    v4[1] = vaddq_s8(v3, v1);
    v3 = vaddq_s8(v3, v2);
  }
  while ( v0 != 2048 );
  return v6[1024];
}


/* Function: vla_stack @ 0xBDC */
__int64 __fastcall vla_stack(unsigned int a1)
{
  __int64 v1; // x29
  __int64 v2; // x30
  int32x4_t *v4; // x8
  __int64 v5; // x10
  int32x4_t v6; // q0
  __int64 v7; // x12
  int32x4_t v8; // q1
  int32x4_t *v9; // x11
  int32x4_t v10; // q2
  int v11; // w11
  char *v12; // x12
  __int64 v13; // x9
  int v14; // w9
  _QWORD v15[2]; // [xsp+0h] [xbp-10h] BYREF

  if ( a1 - 1001 < 0xFFFFFC18 )
    return 0xFFFFFFFFLL;
  v15[0] = v1;
  v15[1] = v2;
  v4 = (int32x4_t *)((char *)v15 - ((4LL * a1 + 15) & 0x7FFFFFFF0LL));
  if ( a1 < 8 )
  {
    v5 = 0;
LABEL_8:
    v11 = 2 * v5;
    v12 = (char *)v4 + 4 * v5;
    v13 = a1 - v5;
    do
    {
      *(_DWORD *)v12 = v11;
      v12 += 4;
      v11 += 2;
      --v13;
    }
    while ( v13 );
    goto LABEL_10;
  }
  v5 = a1 & 0xFFFFFFF8;
  v6.n128_u64[0] = 0x800000008LL;
  v6.n128_u64[1] = 0x800000008LL;
  v7 = v5;
  v8 = (int32x4_t)xmmword_1C40;
  v9 = v4 + 1;
  do
  {
    v10 = vshlq_n_s32(v8, 1u);
    v7 -= 8;
    v8 = vaddq_s32(v8, v6);
    v9[-1] = v10;
    *v9 = vaddq_s32(v10, v6);
    v9 += 2;
  }
  while ( v7 );
  if ( v5 != a1 )
    goto LABEL_8;
LABEL_10:
  if ( (a1 & 0x80000000) == 0 )
    v14 = a1;
  else
    v14 = a1 + 1;
  return v4->n128_u32[v14 >> 1];
}


/* Function: alloca_usage @ 0xCA0 */
__int64 __fastcall alloca_usage(int a1)
{
  __int64 v1; // x29
  __int64 v2; // x30
  int32x4_t *v3; // x8
  __int64 v4; // x10
  int32x4_t v6; // q0
  __int64 v7; // x12
  int32x4_t v8; // q1
  int32x4_t v9; // q2
  int32x4_t v10; // q3
  int32x4_t *v11; // x11
  int32x4_t v12; // q4
  int v13; // w11
  char *v14; // x12
  __int64 v15; // x9
  _QWORD v16[2]; // [xsp+0h] [xbp-10h] BYREF

  if ( a1 < 1 )
    return 0xFFFFFFFFLL;
  v16[0] = v1;
  v16[1] = v2;
  v3 = (int32x4_t *)((char *)v16 - ((4LL * (unsigned int)a1 + 15) & 0x7FFFFFFF0LL));
  if ( (unsigned int)a1 >= 8 )
  {
    v4 = a1 & 0xFFFFFFF8;
    v6.n128_u64[0] = 0x300000003LL;
    v6.n128_u64[1] = 0x300000003LL;
    v7 = v4;
    v8.n128_u64[0] = 0xC0000000CLL;
    v8.n128_u64[1] = 0xC0000000CLL;
    v9.n128_u64[0] = 0x800000008LL;
    v9.n128_u64[1] = 0x800000008LL;
    v10 = (int32x4_t)xmmword_1C40;
    v11 = v3 + 1;
    do
    {
      v12 = vmulq_s32(v10, v6);
      v7 -= 8;
      v10 = vaddq_s32(v10, v9);
      v11[-1] = v12;
      *v11 = vaddq_s32(v12, v8);
      v11 += 2;
    }
    while ( v7 );
    if ( v4 == a1 )
      return v3->n128_u32[a1 >> 1];
  }
  else
  {
    v4 = 0;
  }
  v13 = 3 * v4;
  v14 = (char *)v3 + 4 * v4;
  v15 = (unsigned int)a1 - v4;
  do
  {
    *(_DWORD *)v14 = v13;
    v14 += 4;
    v13 += 3;
    --v15;
  }
  while ( v15 );
  return v3->n128_u32[a1 >> 1];
}


/* Function: stack_alias @ 0xD60 */
__int64 stack_alias()
{
  return 20;
}


/* Function: test_stack_memory @ 0xD68 */
__int64 test_stack_memory()
{
  __int64 v0; // x8
  int8x16_t v1; // q0
  int8x16_t v2; // q1
  int8x16_t v3; // q2
  int8x16_t *v4; // x10
  _BYTE v6[2048]; // [xsp+0h] [xbp-800h] BYREF

  puts(asc_2229);
  printf("MEM-L1-01 (local_vars): %d\n", 20);
  printf("MEM-L1-02 (local_array): %d\n", 10);
  printf("MEM-L1-03 (local_struct): %d\n", 15);
  printf("MEM-L1-04 (address_of_local): %d\n", 42);
  printf("MEM-L1-05 (address_of_array): %d\n", 2);
  v0 = 0;
  v1.n128_u64[0] = 0x1010101010101010LL;
  v1.n128_u64[1] = 0x1010101010101010LL;
  v2.n128_u64[0] = 0x2020202020202020LL;
  v2.n128_u64[1] = 0x2020202020202020LL;
  v3 = (int8x16_t)xmmword_1C30;
  do
  {
    v4 = (int8x16_t *)&v6[v0];
    v0 += 32;
    *v4 = v3;
    v4[1] = vaddq_s8(v3, v1);
    v3 = vaddq_s8(v3, v2);
  }
  while ( v0 != 2048 );
  printf("MEM-L2-01 (large_stack_frame): %d\n", v6[1024]);
  printf("MEM-L2-02 (vla_stack): %d\n", 10);
  printf("MEM-L2-03 (alloca_usage): %d\n", 15);
  return printf("MEM-L2-04 (stack_alias): %d\n", 20);
}


/* Function: heap_basic @ 0xE54 */
__int64 __fastcall heap_basic(int a1)
{
  int32x4_t *v2; // x0
  __int64 v3; // x9
  unsigned __int32 v4; // w19
  int32x4_t v5; // q0
  __int64 v6; // x11
  int32x4_t v7; // q1
  int32x4_t *v8; // x10
  int32x4_t v9; // q2
  int v10; // w10
  _DWORD *v11; // x11
  __int64 v12; // x8
  int v13; // w8

  v2 = (int32x4_t *)malloc(4LL * a1);
  if ( !v2 )
    return (unsigned __int32)-1;
  if ( a1 >= 1 )
  {
    if ( (unsigned int)a1 < 8 )
    {
      v3 = 0;
LABEL_9:
      v10 = 2 * v3;
      v11 = (_DWORD *)v2 + v3;
      v12 = (unsigned int)a1 - v3;
      do
      {
        *v11++ = v10;
        v10 += 2;
        --v12;
      }
      while ( v12 );
      goto LABEL_11;
    }
    v3 = a1 & 0xFFFFFFF8;
    v5.n128_u64[0] = 0x800000008LL;
    v5.n128_u64[1] = 0x800000008LL;
    v6 = v3;
    v7 = (int32x4_t)xmmword_1C40;
    v8 = v2 + 1;
    do
    {
      v9 = vshlq_n_s32(v7, 1u);
      v6 -= 8;
      v7 = vaddq_s32(v7, v5);
      v8[-1] = v9;
      *v8 = vaddq_s32(v9, v5);
      v8 += 2;
    }
    while ( v6 );
    if ( v3 != a1 )
      goto LABEL_9;
  }
LABEL_11:
  if ( a1 >= 0 )
    v13 = a1;
  else
    v13 = a1 + 1;
  v4 = v2->n128_u32[v13 >> 1];
  free(v2);
  return v4;
}


/* Function: heap_calloc @ 0xF10 */
__int64 __fastcall heap_calloc(int a1)
{
  char *v2; // x0
  unsigned int v3; // w19
  __int64 v4; // x8
  unsigned __int64 v5; // x10
  unsigned __int64 v6; // x9
  int32x4_t *v7; // x12
  int32x4_t v8; // q0
  int32x4_t v9; // q1
  unsigned __int64 v10; // x13
  int32x4_t v11; // q2
  int32x4_t v12; // q3
  __int64 v13; // x8
  char *v14; // x9
  int v15; // t1

  v2 = (char *)calloc(a1, 4u);
  if ( v2 )
  {
    if ( a1 > 1 )
    {
      v4 = (unsigned int)a1;
      v5 = (unsigned int)a1 - 1LL;
      if ( v5 >= 8 )
      {
        v7 = (int32x4_t *)(v2 + 20);
        v8 = 0u;
        v6 = v5 & 0xFFFFFFFFFFFFFFF8LL | 1;
        v9 = 0u;
        v10 = v5 & 0xFFFFFFFFFFFFFFF8LL;
        do
        {
          v11 = v7[-1];
          v12 = *v7;
          v7 += 2;
          v10 -= 8LL;
          v8 = vaddq_s32(v11, v8);
          v9 = vaddq_s32(v12, v9);
        }
        while ( v10 );
        v3 = vaddvq_s32(vaddq_s32(v9, v8));
        if ( v5 == (v5 & 0xFFFFFFFFFFFFFFF8LL) )
          goto LABEL_12;
      }
      else
      {
        v3 = 0;
        v6 = 1;
      }
      v13 = v4 - v6;
      v14 = &v2[4 * v6];
      do
      {
        v15 = *(_DWORD *)v14;
        v14 += 4;
        --v13;
        v3 += v15;
      }
      while ( v13 );
    }
    else
    {
      v3 = 0;
    }
LABEL_12:
    free(v2);
    return v3;
  }
  return (unsigned int)-1;
}


/* Function: heap_realloc @ 0xFDC */
__int64 heap_realloc()
{
  _OWORD *v0; // x0
  void *v1; // x19
  char *v2; // x0
  int v3; // w9
  unsigned int v4; // w20

  v0 = malloc(0x14u);
  if ( v0 )
  {
    v1 = v0;
    *v0 = xmmword_1C50;
    *((_DWORD *)v0 + 4) = 5;
    v2 = (char *)realloc(v0, 0x28u);
    if ( v2 )
    {
      v3 = *((_DWORD *)v2 + 2);
      v1 = v2;
      *((_DWORD *)v2 + 9) = 90;
      if ( v3 == 3 )
        v4 = 50;
      else
        v4 = -3;
      *(_OWORD *)(v2 + 20) = xmmword_1C60;
    }
    else
    {
      v4 = -2;
    }
    free(v1);
  }
  else
  {
    return (unsigned int)-1;
  }
  return v4;
}


/* Function: heap_array @ 0x106C */
__int64 __fastcall heap_array(int a1)
{
  int32x4_t *v2; // x0
  __int64 v3; // x9
  unsigned __int32 v4; // w19
  int32x4_t v5; // q0
  __int64 v6; // x11
  int32x4_t v7; // q1
  int32x4_t v8; // q2
  int32x4_t v9; // q3
  int32x4_t *v10; // x10
  int32x4_t v11; // q4
  int v12; // w10
  _DWORD *v13; // x11
  __int64 v14; // x8
  int v15; // w8

  v2 = (int32x4_t *)malloc(4LL * a1);
  if ( !v2 )
    return (unsigned __int32)-1;
  if ( a1 >= 1 )
  {
    if ( (unsigned int)a1 < 8 )
    {
      v3 = 0;
LABEL_9:
      v12 = 3 * v3;
      v13 = (_DWORD *)v2 + v3;
      v14 = (unsigned int)a1 - v3;
      do
      {
        *v13++ = v12;
        v12 += 3;
        --v14;
      }
      while ( v14 );
      goto LABEL_11;
    }
    v3 = a1 & 0xFFFFFFF8;
    v5.n128_u64[0] = 0x300000003LL;
    v5.n128_u64[1] = 0x300000003LL;
    v6 = v3;
    v7.n128_u64[0] = 0xC0000000CLL;
    v7.n128_u64[1] = 0xC0000000CLL;
    v8.n128_u64[0] = 0x800000008LL;
    v8.n128_u64[1] = 0x800000008LL;
    v9 = (int32x4_t)xmmword_1C40;
    v10 = v2 + 1;
    do
    {
      v11 = vmulq_s32(v9, v5);
      v6 -= 8;
      v9 = vaddq_s32(v9, v8);
      v10[-1] = v11;
      *v10 = vaddq_s32(v11, v7);
      v10 += 2;
    }
    while ( v6 );
    if ( v3 != a1 )
      goto LABEL_9;
  }
LABEL_11:
  if ( a1 >= 0 )
    v15 = a1;
  else
    v15 = a1 + 1;
  v4 = v2->n128_u32[v15 >> 1];
  free(v2);
  return v4;
}


/* Function: heap_struct @ 0x1130 */
__int64 __fastcall heap_struct(int a1)
{
  return (unsigned int)(3 * a1);
}


/* Function: heap_nested @ 0x1138 */
__int64 __fastcall heap_nested(_QWORD *a1)
{
  _DWORD *v2; // x0
  _QWORD *v3; // x19
  _QWORD *v4; // x0
  _QWORD *v5; // x8
  __int64 result; // x0

  v2 = malloc(0x10u);
  *a1 = v2;
  if ( !v2 )
    return 0xFFFFFFFFLL;
  v3 = v2;
  *v2 = 10;
  v4 = malloc(0x10u);
  v3[1] = v4;
  if ( v4 )
  {
    v5 = v4;
    result = 0;
    v5[1] = 0;
    *(_DWORD *)v5 = 20;
  }
  else
  {
    free(v3);
    return 4294967294LL;
  }
  return result;
}


/* Function: linked_list_heap @ 0x11AC */
__int64 linked_list_heap()
{
  _DWORD *v0; // x0
  _QWORD *v1; // x19
  _QWORD *v2; // x0
  _QWORD *v3; // x20
  _QWORD *v4; // x0
  _QWORD *v5; // x22
  _QWORD *v6; // x0
  _QWORD *v7; // x21
  _QWORD *v8; // x0
  unsigned int v9; // w20
  _QWORD *v10; // x8
  int v11; // w9
  _QWORD *v12; // x21
  _QWORD *v13; // x20
  _QWORD *v14; // x20
  _QWORD *v15; // x20

  v0 = malloc(0x10u);
  if ( !v0 )
    return (unsigned int)-1;
  v1 = v0;
  *v0 = 0;
  v2 = malloc(0x10u);
  if ( !v2 )
  {
    free(v1);
    return (unsigned int)-1;
  }
  v3 = v2;
  v2[1] = 0;
  v1[1] = v2;
  *(_DWORD *)v2 = 10;
  v4 = malloc(0x10u);
  if ( !v4 )
  {
    do
    {
      v13 = (_QWORD *)v1[1];
      free(v1);
      v1 = v13;
    }
    while ( v13 );
    return (unsigned int)-1;
  }
  v5 = v4;
  v4[1] = 0;
  v3[1] = v4;
  *(_DWORD *)v4 = 20;
  v6 = malloc(0x10u);
  if ( !v6 )
  {
    do
    {
      v14 = (_QWORD *)v1[1];
      free(v1);
      v1 = v14;
    }
    while ( v14 );
    return (unsigned int)-1;
  }
  v7 = v6;
  v6[1] = 0;
  v5[1] = v6;
  *(_DWORD *)v6 = 30;
  v8 = malloc(0x10u);
  if ( !v8 )
  {
    do
    {
      v15 = (_QWORD *)v1[1];
      free(v1);
      v1 = v15;
    }
    while ( v15 );
    return (unsigned int)-1;
  }
  v9 = 0;
  v10 = v1;
  v8[1] = 0;
  v7[1] = v8;
  *(_DWORD *)v8 = 40;
  do
  {
    v11 = *(_DWORD *)v10;
    v10 = (_QWORD *)v10[1];
    v9 += v11;
  }
  while ( v10 );
  do
  {
    v12 = (_QWORD *)v1[1];
    free(v1);
    v1 = v12;
  }
  while ( v12 );
  return v9;
}


/* Function: create_tree_node @ 0x12E4 */
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


/* Function: tree_heap_traversal @ 0x1314 */
__int64 tree_heap_traversal()
{
  return 60;
}


/* Function: memory_leak @ 0x131C */
__int64 __fastcall memory_leak(int a1)
{
  int32x4_t *v2; // x0
  __int64 v3; // x9
  int32x4_t v5; // q0
  __int64 v6; // x11
  int32x4_t v7; // q1
  int32x4_t v8; // q2
  int32x4_t *v9; // x10
  int v10; // w8

  v2 = (int32x4_t *)malloc(4LL * a1);
  if ( !v2 )
    return 0xFFFFFFFFLL;
  if ( a1 >= 1 )
  {
    if ( (unsigned int)a1 < 8 )
    {
      v3 = 0;
      do
      {
LABEL_9:
        v2->n128_u32[v3] = v3;
        ++v3;
      }
      while ( a1 != v3 );
      goto LABEL_10;
    }
    v3 = a1 & 0xFFFFFFF8;
    v5.n128_u64[0] = 0x400000004LL;
    v5.n128_u64[1] = 0x400000004LL;
    v6 = v3;
    v7.n128_u64[0] = 0x800000008LL;
    v7.n128_u64[1] = 0x800000008LL;
    v8 = (int32x4_t)xmmword_1C40;
    v9 = v2 + 1;
    do
    {
      v6 -= 8;
      v9[-1] = v8;
      *v9 = vaddq_s32(v8, v5);
      v9 += 2;
      v8 = vaddq_s32(v8, v7);
    }
    while ( v6 );
    if ( v3 != a1 )
      goto LABEL_9;
  }
LABEL_10:
  if ( a1 >= 0 )
    v10 = a1;
  else
    v10 = a1 + 1;
  return v2->n128_u32[v10 >> 1];
}


/* Function: dangling_pointer @ 0x13C4 */
__int64 dangling_pointer()
{
  unsigned int *v0; // x0
  unsigned int *v1; // x19

  v0 = (unsigned int *)malloc(4u);
  if ( !v0 )
    return 0xFFFFFFFFLL;
  v1 = v0;
  printf("value before free: %d\n", 42);
  free(v1);
  return *v1;
}


/* Function: double_free @ 0x1410 */
__int64 __fastcall double_free(unsigned int *a1)
{
  if ( a1 )
    return *a1;
  else
    return 4294967294LL;
}


/* Function: heap_overflow @ 0x1424 */
__int64 heap_overflow()
{
  return 0;
}


/* Function: test_heap_memory @ 0x142C */
void test_heap_memory()
{
  _OWORD *v0; // x0
  void *v1; // x19
  char *v2; // x0
  int v3; // w9
  int v4; // w20
  _DWORD *v5; // x0
  void **v6; // x19
  _DWORD *v7; // x0
  int v8; // w1
  int v9; // w0
  int v10; // w0
  __int64 v11; // x1
  unsigned int v12; // w0
  int stat_loc; // [xsp+Ch] [xbp-4h] BYREF

  puts(asc_2247);
  printf("HEAP-L2-01 (heap_basic): %d\n", 10);
  printf("HEAP-L2-02 (heap_calloc): %d\n", 0);
  v0 = malloc(0x14u);
  if ( v0 )
  {
    v1 = v0;
    *v0 = xmmword_1C50;
    *((_DWORD *)v0 + 4) = 5;
    v2 = (char *)realloc(v0, 0x28u);
    if ( v2 )
    {
      v3 = *((_DWORD *)v2 + 2);
      v1 = v2;
      *((_DWORD *)v2 + 9) = 90;
      if ( v3 == 3 )
        v4 = 50;
      else
        v4 = -3;
      *(_OWORD *)(v2 + 20) = xmmword_1C60;
    }
    else
    {
      v4 = -2;
    }
    free(v1);
  }
  else
  {
    v4 = -1;
  }
  printf("HEAP-L2-03 (heap_realloc): %d\n", v4);
  printf("HEAP-L2-04 (heap_array): %d\n", 15);
  printf("HEAP-L2-05 (heap_struct): %d\n", 15);
  v5 = malloc(0x10u);
  if ( v5 )
  {
    v6 = (void **)v5;
    *v5 = 10;
    v7 = malloc(0x10u);
    v6[1] = v7;
    if ( v7 )
    {
      v8 = 0;
      *((_QWORD *)v7 + 1) = 0;
      *v7 = 20;
    }
    else
    {
      free(v6);
      v8 = -2;
    }
    printf("HEAP-L2-06 (heap_nested): %d\n", v8);
    free(v6[1]);
    free(v6);
  }
  else
  {
    printf("HEAP-L2-06 (heap_nested): %d\n", -1);
  }
  v9 = linked_list_heap();
  printf("HEAP-L3-01 (linked_list_heap): %d\n", v9);
  printf("HEAP-L3-02 (tree_heap_traversal): %d\n", 60);
  printf("HEAP-L3-03 (memory_leak): %d\n", 2);
  printf("HEAP-L3-04 (dangling_pointer): ");
  v10 = fork();
  if ( !v10 )
  {
    v12 = dangling_pointer();
    printf(aD, v12);
    exit(0);
  }
  if ( v10 < 1 )
  {
    perror(aFork_0);
  }
  else
  {
    waitpid(v10, &stat_loc, 0);
    v11 = stat_loc & 0x7F;
    if ( (stat_loc & 0x7F) != 0 )
    {
      if ( ((_DWORD)v11 << 24) + 0x1000000 >= 0x2000000 )
        printf(byte_1F0A, v11);
    }
    else
    {
      printf(byte_1EE5, BYTE1(stat_loc));
    }
  }
}


/* Function: global_var_access @ 0x1660 */
__int64 global_var_access()
{
  return (unsigned int)++global_counter;
}


/* Function: global_var_read @ 0x1674 */
__int64 global_var_read()
{
  return (unsigned int)(2 * global_counter);
}


/* Function: global_array_access @ 0x1684 */
__int64 __fastcall global_array_access(unsigned int a1)
{
  if ( a1 <= 9 )
    return global_array[a1];
  else
    return 0xFFFFFFFFLL;
}


/* Function: static_local @ 0x16A4 */
__int64 __fastcall static_local(int a1)
{
  __int64 result; // x0

  if ( a1 )
    result = 0;
  else
    result = (unsigned int)(static_local_counter + 1);
  static_local_counter = result;
  return result;
}


/* Function: call_static_func @ 0x16BC */
__int64 __fastcall call_static_func(int a1)
{
  return (2 * a1) | 1u;
}


/* Function: access_extern_global @ 0x16CC */
__int64 access_extern_global()
{
  return (unsigned int)(extern_global_var + 100);
}


/* Function: call_extern_func @ 0x16E0 */
__int64 call_extern_func()
{
  return extern_function(5);
}


/* Function: read_const_data @ 0x16E8 */
__int64 read_const_data()
{
  return (unsigned int)(unsigned __int8)const_string[4] + 42;
}


/* Function: access_bss_var @ 0x16FC */
__int64 access_bss_var()
{
  return 0;
}


/* Function: access_bss_buffer @ 0x1704 */
__int64 access_bss_buffer()
{
  return 0;
}


/* Function: global_struct_access @ 0x170C */
__int64 global_struct_access()
{
  return 30;
}


/* Function: set_file_static @ 0x1714 */
__int64 __fastcall set_file_static(__int64 result)
{
  file_scope_static = result;
  return result;
}


/* Function: get_file_static @ 0x1720 */
__int64 get_file_static()
{
  return (unsigned int)file_scope_static;
}


/* Function: set_global_callback @ 0x172C */
void *__fastcall set_global_callback(void *result)
{
  global_func_ptr = result;
  return result;
}


/* Function: call_global_callback @ 0x1738 */
__int64 call_global_callback()
{
  if ( global_func_ptr )
    return global_func_ptr();
  else
    return 0xFFFFFFFFLL;
}


/* Function: global_heap_store @ 0x1750 */
__int64 __fastcall global_heap_store(unsigned int *a1)
{
  global_heap_ptr = (__int64)a1;
  if ( a1 )
    return *a1;
  else
    return 0xFFFFFFFFLL;
}


/* Function: static_complex_init @ 0x176C */
__int64 static_complex_init()
{
  return 15;
}


/* Function: tls_access @ 0x1774 */
__int64 __fastcall tls_access(int a1)
{
  return (unsigned int)(2 * a1);
}


/* Function: init_order_test @ 0x177C */
__int64 init_order_test()
{
  return 20;
}


/* Function: test_static_global @ 0x1784 */
__int64 test_static_global()
{
  int v0; // w0
  int v2; // [xsp+Ch] [xbp-4h] BYREF

  puts(asc_2265);
  printf("STM-L1-01 (global_var_access): %d\n", ++global_counter);
  printf("STM-L1-01 (global_var_read): %d\n", 2 * global_counter);
  printf("STM-L1-02 (global_array_access): %d\n", 5);
  static_local_counter = 1;
  printf("STM-L1-03 (static_local): %d\n", 1);
  printf("STM-L1-03 (static_local): %d\n", ++static_local_counter);
  printf("STM-L1-04 (call_static_func): %d\n", 11);
  printf("STM-L2-01 (access_extern_global): %d\n", extern_global_var + 100);
  v0 = extern_function(5);
  printf("STM-L2-02 (call_extern_func): %d\n", v0);
  printf("STM-L2-03 (read_const_data): %d\n", (unsigned __int8)const_string[4] + 42);
  printf("STM-L2-04 (access_bss_var): %d\n", 0);
  printf("STM-L2-04 (access_bss_buffer): %d\n", 0);
  printf("STM-L2-05 (global_struct_access): %d\n", 30);
  file_scope_static = 50;
  printf("STM-L2-06 (file_static): %d\n", 50);
  global_func_ptr = double_value;
  printf("STM-L2-07 (global_func_ptr): %d\n", 10);
  v2 = 100;
  global_heap_ptr = (__int64)&v2;
  printf("STM-L2-08 (global_heap_store): %d\n", 100);
  printf("STM-L2-09 (static_complex_init): %d\n", 15);
  printf("STM-L3-01 (tls_access): %d\n", 20);
  return printf("STM-L3-02 (init_order_test): %d\n", 20);
}


/* Function: double_value @ 0x1944 */
__int64 __fastcall double_value(int a1)
{
  return (unsigned int)(2 * a1);
}


/* Function: memop_memset @ 0x194C */
__int64 __fastcall memop_memset(unsigned __int8 *s, size_t n, int c)
{
  __int64 result; // x0

  result = 0xFFFFFFFFLL;
  if ( s )
  {
    if ( n )
    {
      memset(s, c, n);
      return *s;
    }
  }
  return result;
}


/* Function: memop_memcpy @ 0x198C */
__int64 __fastcall memop_memcpy(char *dest, const void *a2, size_t n)
{
  __int64 result; // x0

  result = 0xFFFFFFFFLL;
  if ( dest && a2 )
  {
    if ( n )
    {
      memcpy(dest, a2, n);
      return *(unsigned int *)&dest[(n & 0xFFFFFFFFFFFFFFFCLL) - 4];
    }
  }
  return result;
}


/* Function: memop_memmove @ 0x19D4 */
__int64 __fastcall memop_memmove(char *src, unsigned __int64 a2)
{
  __int64 result; // x0

  result = 0xFFFFFFFFLL;
  if ( src )
  {
    if ( a2 >= 2 )
    {
      memmove(src + 1, src, a2 - 1);
      return (unsigned __int8)src[1];
    }
  }
  return result;
}


/* Function: memop_memcmp @ 0x1A14 */
__int64 __fastcall memop_memcmp(void *s1, const void *a2, size_t a3)
{
  __int64 result; // x0
  int v5; // w0
  unsigned int v6; // w8

  result = 0;
  if ( s1 && a2 && a3 )
  {
    v5 = memcmp(s1, a2, a3);
    if ( v5 )
      v6 = -1;
    else
      v6 = 0;
    if ( v5 >= 1 )
      return 1;
    else
      return v6;
  }
  return result;
}


/* Function: memop_bzero @ 0x1A50 */
__int64 __fastcall memop_bzero(unsigned __int8 *a1, size_t n)
{
  if ( !a1 )
    return 0xFFFFFFFFLL;
  memset(a1, 0, n);
  return *a1;
}


/* Function: memop_bcopy @ 0x1A88 */
__int64 __fastcall memop_bcopy(void *src, unsigned __int8 *dest, size_t a3)
{
  __int64 result; // x0

  result = 0xFFFFFFFFLL;
  if ( src && dest )
  {
    if ( a3 )
    {
      memmove(dest, src, a3);
      return *dest;
    }
  }
  return result;
}


/* Function: memop_unaligned_access @ 0x1AC4 */
__int64 __fastcall memop_unaligned_access(__int64 a1)
{
  if ( a1 )
    return *(unsigned int *)(a1 + 1);
  else
    return 0xFFFFFFFFLL;
}


/* Function: memop_memory_barrier @ 0x1AD8 */
__int64 __fastcall memop_memory_barrier(int *a1)
{
  int v1; // w8

  if ( !a1 )
    return 0xFFFFFFFFLL;
  v1 = *a1;
  __dmb(0xBu);
  return (unsigned int)(*a1 + v1);
}


/* Function: test_memory_op_functions @ 0x1AF8 */
__int64 test_memory_op_functions()
{
  int v1; // [xsp+Ch] [xbp-14h]

  puts(asc_2289);
  printf("MEMOP-L2-01: %d\n", 65);
  printf("MEMOP-L2-02: %d\n", 50);
  printf("MEMOP-L2-03: %c\n", (unsigned __int8)aHelloworld[0]);
  printf("MEMOP-L2-04: %d\n", -1);
  printf("MEMOP-L2-05: %d\n", 0);
  printf("MEMOP-L2-06: %d\n", 1);
  printf("MEMOP-L3-01: 0x%x\n", 67305985);
  v1 = 5;
  __dmb(0xBu);
  return printf("MEMOP-L3-02: %d\n", v1 + 5);
}


/* Function: main @ 0x1BD4 */
int __fastcall main(int argc, const char **argv, const char **envp)
{
  test_stack_memory();
  test_heap_memory();
  test_static_global();
  test_memory_op_functions();
  return 0;
}


/* Function: extern_function @ 0x1BF8 */
__int64 __fastcall extern_function(int a1)
{
  return (unsigned int)(3 * a1);
}


/* Function: .term_proc @ 0x1C00 */
void term_proc()
{
  ;
}


/* FAILED to decompile: memcpy @ 0x13128 */

/* FAILED to decompile: memmove @ 0x13130 */

/* FAILED to decompile: exit @ 0x13138 */

/* FAILED to decompile: __libc_start_main @ 0x13140 */

/* FAILED to decompile: perror @ 0x13148 */

/* FAILED to decompile: __cxa_finalize @ 0x13150 */

/* FAILED to decompile: fork @ 0x13158 */

/* FAILED to decompile: malloc @ 0x13160 */

/* FAILED to decompile: memset @ 0x13168 */

/* FAILED to decompile: calloc @ 0x13170 */

/* FAILED to decompile: realloc @ 0x13178 */

/* FAILED to decompile: abort @ 0x13180 */

/* FAILED to decompile: puts @ 0x13188 */

/* FAILED to decompile: memcmp @ 0x13190 */

/* FAILED to decompile: free @ 0x13198 */

/* FAILED to decompile: printf @ 0x131A0 */

/* FAILED to decompile: waitpid @ 0x131A8 */

/* FAILED to decompile: __gmon_start__ @ 0x131B8 */

/* Total functions decompiled: 65, failed: 18 */
