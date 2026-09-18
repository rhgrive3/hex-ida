/*
 * Decompiled by IDA Pro 9.1 with Hex-Rays
 * Binary: /Users/eren/Desktop/Antigravity/compiler/build/arm64/3/3_clang_O3_g
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
int __fastcall local_vars(int x)
{
  return 2 * x + 10;
}


/* Function: local_array @ 0xB60 */
int __fastcall local_array(int n)
{
  return 5 * n;
}


/* Function: local_struct @ 0xB68 */
int __fastcall local_struct(int x)
{
  return 3 * x;
}


/* Function: address_of_local @ 0xB70 */
int __fastcall address_of_local(int *out)
{
  int result; // w0

  result = 42;
  *out = 42;
  return result;
}


/* Function: address_of_array @ 0xB84 */
int __fastcall address_of_array(int *arr)
{
  return 2 * *arr;
}


/* Function: large_stack_frame @ 0xB90 */
int __cdecl large_stack_frame()
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
  v3 = (int8x16_t)xmmword_1CC0;
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
int __fastcall vla_stack(int n)
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

  if ( (unsigned int)(n - 1001) < 0xFFFFFC18 )
    return -1;
  v15[0] = v1;
  v15[1] = v2;
  v4 = (int32x4_t *)((char *)v15 - ((4LL * (unsigned int)n + 15) & 0x7FFFFFFF0LL));
  if ( (unsigned int)n < 8 )
  {
    v5 = 0;
LABEL_8:
    v11 = 2 * v5;
    v12 = (char *)v4 + 4 * v5;
    v13 = (unsigned int)n - v5;
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
  v5 = n & 0xFFFFFFF8;
  v6.n128_u64[0] = 0x800000008LL;
  v6.n128_u64[1] = 0x800000008LL;
  v7 = v5;
  v8 = (int32x4_t)xmmword_1CD0;
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
  if ( v5 != n )
    goto LABEL_8;
LABEL_10:
  if ( n >= 0 )
    v14 = n;
  else
    v14 = n + 1;
  return v4->n128_i32[v14 >> 1];
}


/* Function: alloca_usage @ 0xCA0 */
int __fastcall alloca_usage(int n)
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

  if ( n < 1 )
    return -1;
  v16[0] = v1;
  v16[1] = v2;
  v3 = (int32x4_t *)((char *)v16 - ((4LL * (unsigned int)n + 15) & 0x7FFFFFFF0LL));
  if ( (unsigned int)n >= 8 )
  {
    v4 = n & 0xFFFFFFF8;
    v6.n128_u64[0] = 0x300000003LL;
    v6.n128_u64[1] = 0x300000003LL;
    v7 = v4;
    v8.n128_u64[0] = 0xC0000000CLL;
    v8.n128_u64[1] = 0xC0000000CLL;
    v9.n128_u64[0] = 0x800000008LL;
    v9.n128_u64[1] = 0x800000008LL;
    v10 = (int32x4_t)xmmword_1CD0;
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
    if ( v4 == n )
      return v3->n128_i32[n >> 1];
  }
  else
  {
    v4 = 0;
  }
  v13 = 3 * v4;
  v14 = (char *)v3 + 4 * v4;
  v15 = (unsigned int)n - v4;
  do
  {
    *(_DWORD *)v14 = v13;
    v14 += 4;
    v13 += 3;
    --v15;
  }
  while ( v15 );
  return v3->n128_i32[n >> 1];
}


/* Function: stack_alias @ 0xD60 */
__int64 __fastcall stack_alias(int *p1, int *p2)
{
  return 20;
}


/* Function: test_stack_memory @ 0xD68 */
void __cdecl test_stack_memory()
{
  __int64 v0; // x8
  int8x16_t v1; // q0
  int8x16_t v2; // q1
  int8x16_t v3; // q2
  int8x16_t *v4; // x10
  _BYTE v5[2048]; // [xsp+0h] [xbp-800h] BYREF

  puts(asc_22B9);
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
  v3 = (int8x16_t)xmmword_1CC0;
  do
  {
    v4 = (int8x16_t *)&v5[v0];
    v0 += 32;
    *v4 = v3;
    v4[1] = vaddq_s8(v3, v1);
    v3 = vaddq_s8(v3, v2);
  }
  while ( v0 != 2048 );
  printf("MEM-L2-01 (large_stack_frame): %d\n", v5[1024]);
  printf("MEM-L2-02 (vla_stack): %d\n", 10);
  printf("MEM-L2-03 (alloca_usage): %d\n", 15);
  printf("MEM-L2-04 (stack_alias): %d\n", 20);
}


/* Function: heap_basic @ 0xE54 */
int __fastcall heap_basic(int n)
{
  int32x4_t *v2; // x0
  __int64 v3; // x9
  int32x4_t v5; // q0
  __int64 v6; // x11
  int32x4_t v7; // q1
  int32x4_t *v8; // x10
  int32x4_t v9; // q2
  int v10; // w10
  _DWORD *v11; // x11
  __int64 v12; // x8
  int v13; // w8
  int v14; // w19

  v2 = (int32x4_t *)malloc(4LL * n);
  if ( !v2 )
    return -1;
  if ( n >= 1 )
  {
    if ( (unsigned int)n < 8 )
    {
      v3 = 0;
LABEL_9:
      v10 = 2 * v3;
      v11 = (_DWORD *)v2 + v3;
      v12 = (unsigned int)n - v3;
      do
      {
        *v11++ = v10;
        v10 += 2;
        --v12;
      }
      while ( v12 );
      goto LABEL_11;
    }
    v3 = n & 0xFFFFFFF8;
    v5.n128_u64[0] = 0x800000008LL;
    v5.n128_u64[1] = 0x800000008LL;
    v6 = v3;
    v7 = (int32x4_t)xmmword_1CD0;
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
    if ( v3 != n )
      goto LABEL_9;
  }
LABEL_11:
  if ( n >= 0 )
    v13 = n;
  else
    v13 = n + 1;
  v14 = v2->n128_i32[v13 >> 1];
  free(v2);
  return v14;
}


/* Function: heap_calloc @ 0xF1C */
int __fastcall heap_calloc(int n)
{
  char *v2; // x0
  int v3; // w19
  __int64 v5; // x8
  unsigned __int64 v6; // x10
  unsigned __int64 v7; // x9
  int32x4_t *v8; // x12
  int32x4_t v9; // q0
  int32x4_t v10; // q1
  unsigned __int64 v11; // x13
  int32x4_t v12; // q2
  int32x4_t v13; // q3
  __int64 v14; // x8
  char *v15; // x9
  int v16; // t1

  v2 = (char *)calloc(n, 4u);
  if ( !v2 )
    return -1;
  if ( n > 1 )
  {
    v5 = (unsigned int)n;
    v6 = (unsigned int)n - 1LL;
    if ( v6 >= 8 )
    {
      v8 = (int32x4_t *)(v2 + 20);
      v9 = 0u;
      v7 = v6 & 0xFFFFFFFFFFFFFFF8LL | 1;
      v10 = 0u;
      v11 = v6 & 0xFFFFFFFFFFFFFFF8LL;
      do
      {
        v12 = v8[-1];
        v13 = *v8;
        v8 += 2;
        v11 -= 8LL;
        v9 = vaddq_s32(v12, v9);
        v10 = vaddq_s32(v13, v10);
      }
      while ( v11 );
      v3 = vaddvq_s32(vaddq_s32(v10, v9));
      if ( v6 == (v6 & 0xFFFFFFFFFFFFFFF8LL) )
        goto LABEL_12;
    }
    else
    {
      v3 = 0;
      v7 = 1;
    }
    v14 = v5 - v7;
    v15 = &v2[4 * v7];
    do
    {
      v16 = *(_DWORD *)v15;
      v15 += 4;
      --v14;
      v3 += v16;
    }
    while ( v14 );
  }
  else
  {
    v3 = 0;
  }
LABEL_12:
  free(v2);
  return v3;
}


/* Function: heap_realloc @ 0xFF4 */
int __cdecl heap_realloc()
{
  _OWORD *v0; // x0
  void *v1; // x19
  char *v2; // x0
  int v3; // w9
  int v4; // w20

  v0 = malloc(0x14u);
  if ( !v0 )
    return -1;
  v1 = v0;
  *v0 = xmmword_1CE0;
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
    *(_OWORD *)(v2 + 20) = xmmword_1CF0;
  }
  else
  {
    v4 = -2;
  }
  free(v1);
  return v4;
}


/* Function: heap_array @ 0x1090 */
int __fastcall heap_array(int n)
{
  int32x4_t *v2; // x0
  __int64 v3; // x9
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
  int v16; // w19

  v2 = (int32x4_t *)malloc(4LL * n);
  if ( !v2 )
    return -1;
  if ( n >= 1 )
  {
    if ( (unsigned int)n < 8 )
    {
      v3 = 0;
LABEL_9:
      v12 = 3 * v3;
      v13 = (_DWORD *)v2 + v3;
      v14 = (unsigned int)n - v3;
      do
      {
        *v13++ = v12;
        v12 += 3;
        --v14;
      }
      while ( v14 );
      goto LABEL_11;
    }
    v3 = n & 0xFFFFFFF8;
    v5.n128_u64[0] = 0x300000003LL;
    v5.n128_u64[1] = 0x300000003LL;
    v6 = v3;
    v7.n128_u64[0] = 0xC0000000CLL;
    v7.n128_u64[1] = 0xC0000000CLL;
    v8.n128_u64[0] = 0x800000008LL;
    v8.n128_u64[1] = 0x800000008LL;
    v9 = (int32x4_t)xmmword_1CD0;
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
    if ( v3 != n )
      goto LABEL_9;
  }
LABEL_11:
  if ( n >= 0 )
    v15 = n;
  else
    v15 = n + 1;
  v16 = v2->n128_i32[v15 >> 1];
  free(v2);
  return v16;
}


/* Function: heap_struct @ 0x1160 */
int __fastcall heap_struct(int x)
{
  return 3 * x;
}


/* Function: heap_nested @ 0x1168 */
int __fastcall heap_nested(Node **head)
{
  Node *v2; // x0
  Node *v3; // x19
  Node *v4; // x0
  Node *v5; // x8
  int result; // w0

  v2 = (Node *)malloc(0x10u);
  *head = v2;
  if ( !v2 )
    return -1;
  v3 = v2;
  v2->data = 10;
  v4 = (Node *)malloc(0x10u);
  v3->next = v4;
  if ( v4 )
  {
    v5 = v4;
    result = 0;
    v5->next = 0;
    v5->data = 20;
  }
  else
  {
    free(v3);
    return -2;
  }
  return result;
}


/* Function: linked_list_heap @ 0x11EC */
int __cdecl linked_list_heap()
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
  int v9; // w20
  _QWORD *v10; // x8
  int v11; // w9
  _QWORD *v12; // x21
  _QWORD *v14; // x20
  _QWORD *v15; // x20
  _QWORD *v16; // x20

  v0 = malloc(0x10u);
  if ( !v0 )
    return -1;
  v1 = v0;
  *v0 = 0;
  v2 = malloc(0x10u);
  if ( !v2 )
  {
    free(v1);
    return -1;
  }
  v3 = v2;
  v2[1] = 0;
  v1[1] = v2;
  *(_DWORD *)v2 = 10;
  v4 = malloc(0x10u);
  if ( v4 )
  {
    v5 = v4;
    v4[1] = 0;
    v3[1] = v4;
    *(_DWORD *)v4 = 20;
    v6 = malloc(0x10u);
    if ( v6 )
    {
      v7 = v6;
      v6[1] = 0;
      v5[1] = v6;
      *(_DWORD *)v6 = 30;
      v8 = malloc(0x10u);
      if ( v8 )
      {
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
      do
      {
        v16 = (_QWORD *)v1[1];
        free(v1);
        v1 = v16;
      }
      while ( v16 );
      return -1;
    }
    do
    {
      v15 = (_QWORD *)v1[1];
      free(v1);
      v1 = v15;
    }
    while ( v15 );
    return -1;
  }
  else
  {
    do
    {
      v14 = (_QWORD *)v1[1];
      free(v1);
      v1 = v14;
    }
    while ( v14 );
    return -1;
  }
}


/* Function: create_tree_node @ 0x1370 */
TreeNode *__fastcall create_tree_node(int data)
{
  TreeNode *result; // x0

  result = (TreeNode *)malloc(0x18u);
  if ( result )
  {
    result->data = data;
    result->left = 0;
    result->right = 0;
  }
  return result;
}


/* Function: tree_heap_traversal @ 0x13A0 */
int __cdecl tree_heap_traversal()
{
  return 60;
}


/* Function: memory_leak @ 0x13A8 */
int __fastcall memory_leak(int n)
{
  int32x4_t *v2; // x0
  __int64 v3; // x9
  int32x4_t v5; // q0
  __int64 v6; // x11
  int32x4_t v7; // q1
  int32x4_t v8; // q2
  int32x4_t *v9; // x10
  int v10; // w8

  v2 = (int32x4_t *)malloc(4LL * n);
  if ( !v2 )
    return -1;
  if ( n >= 1 )
  {
    if ( (unsigned int)n < 8 )
    {
      v3 = 0;
      do
      {
LABEL_9:
        v2->n128_u32[v3] = v3;
        ++v3;
      }
      while ( n != v3 );
      goto LABEL_10;
    }
    v3 = n & 0xFFFFFFF8;
    v5.n128_u64[0] = 0x400000004LL;
    v5.n128_u64[1] = 0x400000004LL;
    v6 = v3;
    v7.n128_u64[0] = 0x800000008LL;
    v7.n128_u64[1] = 0x800000008LL;
    v8 = (int32x4_t)xmmword_1CD0;
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
    if ( v3 != n )
      goto LABEL_9;
  }
LABEL_10:
  if ( n >= 0 )
    v10 = n;
  else
    v10 = n + 1;
  return v2->n128_i32[v10 >> 1];
}


/* Function: dangling_pointer @ 0x1458 */
int __cdecl dangling_pointer()
{
  _DWORD *v0; // x0
  _DWORD *v1; // x19

  v0 = malloc(4u);
  if ( !v0 )
    return -1;
  v1 = v0;
  printf("value before free: %d\n", 42);
  free(v1);
  return *v1;
}


/* Function: double_free @ 0x14AC */
int __fastcall double_free(int *p)
{
  if ( p )
    return *p;
  else
    return -2;
}


/* Function: heap_overflow @ 0x14C0 */
int __cdecl heap_overflow()
{
  return 0;
}


/* Function: test_heap_memory @ 0x14C8 */
void __cdecl test_heap_memory()
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
  int status; // [xsp+Ch] [xbp-4h] BYREF

  puts(asc_22D7);
  printf("HEAP-L2-01 (heap_basic): %d\n", 10);
  printf("HEAP-L2-02 (heap_calloc): %d\n", 0);
  v0 = malloc(0x14u);
  if ( v0 )
  {
    v1 = v0;
    *v0 = xmmword_1CE0;
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
      *(_OWORD *)(v2 + 20) = xmmword_1CF0;
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
    waitpid(v10, &status, 0);
    v11 = status & 0x7F;
    if ( (status & 0x7F) != 0 )
    {
      if ( ((_DWORD)v11 << 24) + 0x1000000 >= 0x2000000 )
        printf(byte_1F9A, v11);
    }
    else
    {
      printf(byte_1F75, BYTE1(status));
    }
  }
}


/* Function: global_var_access @ 0x16FC */
int __cdecl global_var_access()
{
  return ++global_counter;
}


/* Function: global_var_read @ 0x1710 */
int __cdecl global_var_read()
{
  return 2 * global_counter;
}


/* Function: global_array_access @ 0x1720 */
int __fastcall global_array_access(int idx)
{
  if ( (unsigned int)idx <= 9 )
    return global_array[idx];
  else
    return -1;
}


/* Function: static_local @ 0x1740 */
int __fastcall static_local(int reset)
{
  int result; // w0

  if ( reset )
    result = 0;
  else
    result = static_local_counter + 1;
  static_local_counter = result;
  return result;
}


/* Function: call_static_func @ 0x1758 */
int __fastcall call_static_func(int x)
{
  return (2 * x) | 1;
}


/* Function: access_extern_global @ 0x1768 */
int __cdecl access_extern_global()
{
  return extern_global_var + 100;
}


/* Function: call_extern_func @ 0x177C */
int __cdecl call_extern_func()
{
  return extern_function(5);
}


/* Function: read_const_data @ 0x1784 */
int __cdecl read_const_data()
{
  return (unsigned __int8)const_string[4] + 42;
}


/* Function: access_bss_var @ 0x1798 */
int __cdecl access_bss_var()
{
  return 0;
}


/* Function: access_bss_buffer @ 0x17A0 */
int __cdecl access_bss_buffer()
{
  return 0;
}


/* Function: global_struct_access @ 0x17A8 */
int __cdecl global_struct_access()
{
  return 30;
}


/* Function: set_file_static @ 0x17B0 */
void __fastcall set_file_static(int val)
{
  file_scope_static = val;
}


/* Function: get_file_static @ 0x17BC */
int __cdecl get_file_static()
{
  return file_scope_static;
}


/* Function: set_global_callback @ 0x17C8 */
void __fastcall set_global_callback(int (*f)(int))
{
  global_func_ptr = f;
}


/* Function: call_global_callback @ 0x17D4 */
int __fastcall call_global_callback(int x)
{
  if ( global_func_ptr )
    return global_func_ptr(x);
  else
    return -1;
}


/* Function: global_heap_store @ 0x17EC */
int __fastcall global_heap_store(int *p)
{
  global_heap_ptr = (__int64)p;
  if ( p )
    return *p;
  else
    return -1;
}


/* Function: static_complex_init @ 0x1808 */
int __cdecl static_complex_init()
{
  return 15;
}


/* Function: tls_access @ 0x1810 */
int __fastcall tls_access(int val)
{
  return 2 * val;
}


/* Function: init_order_test @ 0x1818 */
int __cdecl init_order_test()
{
  return 20;
}


/* Function: test_static_global @ 0x1820 */
void __cdecl test_static_global()
{
  int v0; // w0
  int heap_val; // [xsp+Ch] [xbp-4h] BYREF

  puts(asc_22F5);
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
  global_func_ptr = (__int64 (__fastcall *)(_QWORD))double_value;
  printf("STM-L2-07 (global_func_ptr): %d\n", 10);
  heap_val = 100;
  global_heap_ptr = (__int64)&heap_val;
  printf("STM-L2-08 (global_heap_store): %d\n", 100);
  printf("STM-L2-09 (static_complex_init): %d\n", 15);
  printf("STM-L3-01 (tls_access): %d\n", 20);
  printf("STM-L3-02 (init_order_test): %d\n", 20);
}


/* Function: double_value @ 0x19D8 */
int __fastcall double_value(int x)
{
  return 2 * x;
}


/* Function: memop_memset @ 0x19E0 */
int __fastcall memop_memset(void *buf, size_t size, int fill_value)
{
  int result; // w0

  result = -1;
  if ( buf )
  {
    if ( size )
    {
      memset(buf, fill_value, size);
      return *(unsigned __int8 *)buf;
    }
  }
  return result;
}


/* Function: memop_memcpy @ 0x1A20 */
int __fastcall memop_memcpy(void *dst, const void *src, size_t n)
{
  int result; // w0

  result = -1;
  if ( dst && src )
  {
    if ( n )
    {
      memcpy(dst, src, n);
      return *(_DWORD *)((char *)dst + (n & 0xFFFFFFFFFFFFFFFCLL) - 4);
    }
  }
  return result;
}


/* Function: memop_memmove @ 0x1A68 */
int __fastcall memop_memmove(void *buf, size_t n)
{
  int result; // w0

  result = -1;
  if ( buf )
  {
    if ( n >= 2 )
    {
      memmove((char *)buf + 1, buf, n - 1);
      return *((unsigned __int8 *)buf + 1);
    }
  }
  return result;
}


/* Function: memop_memcmp @ 0x1AA8 */
int __fastcall memop_memcmp(const void *p1, const void *p2, size_t n)
{
  int result; // w0
  int v5; // w0
  int v6; // w8

  result = 0;
  if ( p1 && p2 && n )
  {
    v5 = memcmp(p1, p2, n);
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


/* Function: memop_bzero @ 0x1AE4 */
int __fastcall memop_bzero(void *buf, size_t n)
{
  if ( !buf )
    return -1;
  memset(buf, 0, n);
  return *(unsigned __int8 *)buf;
}


/* Function: memop_bcopy @ 0x1B1C */
int __fastcall memop_bcopy(const void *src, void *dst, size_t n)
{
  int result; // w0

  result = -1;
  if ( src && dst )
  {
    if ( n )
    {
      memmove(dst, src, n);
      return *(unsigned __int8 *)dst;
    }
  }
  return result;
}


/* Function: memop_unaligned_access @ 0x1B58 */
int __fastcall memop_unaligned_access(const char *buf)
{
  if ( buf )
    return *(_DWORD *)(buf + 1);
  else
    return -1;
}


/* Function: memop_memory_barrier @ 0x1B6C */
int __fastcall memop_memory_barrier(volatile int *flag)
{
  volatile int v1; // w8

  if ( !flag )
    return -1;
  v1 = *flag;
  __dmb(0xBu);
  return *flag + v1;
}


/* Function: test_memory_op_functions @ 0x1B8C */
void __cdecl test_memory_op_functions()
{
  int v0; // [xsp+Ch] [xbp-14h]

  puts(asc_2319);
  printf("MEMOP-L2-01: %d\n", 65);
  printf("MEMOP-L2-02: %d\n", 50);
  printf("MEMOP-L2-03: %c\n", (unsigned __int8)aHelloworld[0]);
  printf("MEMOP-L2-04: %d\n", -1);
  printf("MEMOP-L2-05: %d\n", 0);
  printf("MEMOP-L2-06: %d\n", 1);
  printf("MEMOP-L3-01: 0x%x\n", 67305985);
  v0 = 5;
  __dmb(0xBu);
  printf("MEMOP-L3-02: %d\n", v0 + 5);
}


/* Function: main @ 0x1C68 */
int __fastcall main(int argc, const char **argv, const char **envp)
{
  test_stack_memory();
  test_heap_memory();
  test_static_global();
  test_memory_op_functions();
  return 0;
}


/* Function: extern_function @ 0x1C8C */
int __fastcall extern_function(int x)
{
  return 3 * x;
}


/* Function: .term_proc @ 0x1C94 */
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
