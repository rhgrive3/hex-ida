/*
 * Decompiled by IDA Pro 9.1 with Hex-Rays
 * Binary: /Users/eren/Desktop/Antigravity/compiler/build/arm64/3/3_clang_O1_no_g
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
  __int64 v1; // x8
  int v2; // w9
  _BYTE v4[20]; // [xsp+8h] [xbp-28h]
  unsigned int v5; // [xsp+1Ch] [xbp-14h]

  v1 = 0;
  v2 = 0;
  do
  {
    *(_DWORD *)&v4[v1] = v2;
    v2 += a1;
    v1 += 4;
  }
  while ( v1 != 40 );
  return v5;
}


/* Function: local_struct @ 0xB90 */
__int64 __fastcall local_struct(int a1)
{
  return (unsigned int)(3 * a1);
}


/* Function: address_of_local @ 0xB98 */
__int64 __fastcall address_of_local(_DWORD *a1)
{
  __int64 result; // x0

  result = 42;
  *a1 = 42;
  return result;
}


/* Function: address_of_array @ 0xBAC */
__int64 __fastcall address_of_array(_DWORD *a1)
{
  return (unsigned int)(2 * *a1);
}


/* Function: large_stack_frame @ 0xBB8 */
__int64 large_stack_frame()
{
  __int64 i; // x8
  _BYTE v2[2048]; // [xsp+0h] [xbp-810h]

  for ( i = 0; i != 2048; ++i )
    v2[i] = i;
  return v2[1024];
}


/* Function: vla_stack @ 0xBE8 */
__int64 __fastcall vla_stack(int a1)
{
  __int64 v1; // x29
  __int64 v2; // x30
  __int64 v4; // x9
  _DWORD *v5; // x11
  int v6; // w9
  _QWORD v7[2]; // [xsp+0h] [xbp-10h] BYREF

  if ( (unsigned int)(a1 - 1001) < 0xFFFFFC18 )
    return 0xFFFFFFFFLL;
  v7[0] = v1;
  v7[1] = v2;
  if ( a1 >= 1 )
  {
    v4 = 0;
    v5 = (_DWORD *)((char *)v7 - ((4LL * (unsigned int)a1 + 15) & 0x7FFFFFFF0LL));
    do
    {
      *v5++ = v4;
      v4 += 2;
    }
    while ( 2LL * (unsigned int)a1 != v4 );
  }
  if ( a1 >= 0 )
    v6 = a1;
  else
    v6 = a1 + 1;
  return *(unsigned int *)((char *)v7 + 4 * (unsigned int)(v6 >> 1) - ((4LL * (unsigned int)a1 + 15) & 0x7FFFFFFF0LL));
}


/* Function: alloca_usage @ 0xC68 */
__int64 __fastcall alloca_usage(int a1)
{
  __int64 v1; // x29
  __int64 v2; // x30
  __int64 v3; // x9
  _DWORD *v4; // x11
  _QWORD v6[2]; // [xsp+0h] [xbp-10h] BYREF

  if ( a1 < 1 )
    return 0xFFFFFFFFLL;
  v6[0] = v1;
  v6[1] = v2;
  v3 = 0;
  v4 = (_DWORD *)((char *)v6 - ((4LL * a1 + 15) & 0xFFFFFFFFFFFFFFF0LL));
  do
  {
    *v4++ = v3;
    v3 += 3;
  }
  while ( 3LL * (unsigned int)a1 != v3 );
  return *(unsigned int *)((char *)v6 + 4 * (unsigned int)(a1 >> 1) - ((4LL * a1 + 15) & 0xFFFFFFFFFFFFFFF0LL));
}


/* Function: stack_alias @ 0xCD4 */
__int64 stack_alias()
{
  return 20;
}


/* Function: test_stack_memory @ 0xCDC */
__int64 test_stack_memory()
{
  __int64 v0; // x8
  _DWORD *v1; // x9
  __int64 i; // x8
  __int64 v3; // x8
  _DWORD *v4; // x9
  __int64 v5; // x8
  _DWORD *v6; // x9
  _BYTE v8[20]; // [xsp+0h] [xbp-800h] BYREF
  int v9; // [xsp+14h] [xbp-7ECh]
  unsigned __int8 v10; // [xsp+400h] [xbp-400h]

  puts(asc_2225);
  printf("MEM-L1-01 (local_vars): %d\n", 20);
  v0 = 0;
  v1 = v8;
  do
  {
    *v1++ = v0;
    v0 += 2;
  }
  while ( v0 != 20 );
  printf("MEM-L1-02 (local_array): %d\n", v9);
  printf("MEM-L1-03 (local_struct): %d\n", 15);
  printf("MEM-L1-04 (address_of_local): %d\n", 42);
  printf("MEM-L1-05 (address_of_array): %d\n", 2);
  for ( i = 0; i != 2048; ++i )
    v8[i] = i;
  printf("MEM-L2-01 (large_stack_frame): %d\n", v10);
  v3 = 0;
  v4 = v8;
  do
  {
    *v4++ = v3;
    v3 += 2;
  }
  while ( v3 != 20 );
  printf("MEM-L2-02 (vla_stack): %d\n", v9);
  v5 = 0;
  v6 = v8;
  do
  {
    *v6++ = v5;
    v5 += 3;
  }
  while ( v5 != 30 );
  printf("MEM-L2-03 (alloca_usage): %d\n", v9);
  return printf("MEM-L2-04 (stack_alias): %d\n", 20);
}


/* Function: heap_basic @ 0xE00 */
__int64 __fastcall heap_basic(int a1)
{
  _DWORD *v2; // x0
  __int64 v3; // x8
  _DWORD *v4; // x10
  int v5; // w8
  unsigned int v6; // w19

  v2 = malloc(4LL * a1);
  if ( v2 )
  {
    if ( a1 >= 1 )
    {
      v3 = 0;
      v4 = v2;
      do
      {
        *v4++ = v3;
        v3 += 2;
      }
      while ( 2LL * (unsigned int)a1 != v3 );
    }
    if ( a1 >= 0 )
      v5 = a1;
    else
      v5 = a1 + 1;
    v6 = v2[v5 >> 1];
    free(v2);
  }
  else
  {
    return (unsigned int)-1;
  }
  return v6;
}


/* Function: heap_calloc @ 0xE70 */
__int64 __fastcall heap_calloc(int a1)
{
  int *v2; // x0
  unsigned int v3; // w19
  __int64 v4; // x8
  int *v5; // x9
  int v6; // t1

  v2 = (int *)calloc(a1, 4u);
  if ( v2 )
  {
    if ( a1 < 1 )
    {
      v3 = 0;
    }
    else
    {
      v3 = 0;
      v4 = (unsigned int)a1;
      v5 = v2;
      do
      {
        v6 = *v5++;
        --v4;
        v3 += v6;
      }
      while ( v4 );
    }
    free(v2);
  }
  else
  {
    return (unsigned int)-1;
  }
  return v3;
}


/* Function: heap_realloc @ 0xED8 */
__int64 heap_realloc()
{
  _DWORD *v0; // x0
  void *v1; // x19
  __int64 v2; // x8
  bool v3; // zf
  int v4; // w20
  _DWORD *v5; // x0
  int v6; // w8
  __int64 i; // x9
  unsigned int v8; // w20

  v0 = malloc(0x14u);
  if ( v0 )
  {
    v1 = v0;
    v2 = 0;
    do
    {
      v3 = v2 == 4;
      v0[v2] = v2 + 1;
      ++v2;
    }
    while ( !v3 );
    v4 = v0[2];
    v5 = realloc(v0, 0x28u);
    if ( v5 )
    {
      v6 = 50;
      for ( i = 5; i != 10; ++i )
      {
        v5[i] = v6;
        v6 += 10;
      }
      if ( v5[2] == v4 )
        v8 = v5[5];
      else
        v8 = -3;
      v1 = v5;
    }
    else
    {
      v8 = -2;
    }
    free(v1);
  }
  else
  {
    return (unsigned int)-1;
  }
  return v8;
}


/* Function: heap_array @ 0xF80 */
__int64 __fastcall heap_array(int a1)
{
  _DWORD *v2; // x0
  __int64 v3; // x8
  _DWORD *v4; // x10
  int v5; // w8
  unsigned int v6; // w19

  v2 = malloc(4LL * a1);
  if ( v2 )
  {
    if ( a1 >= 1 )
    {
      v3 = 0;
      v4 = v2;
      do
      {
        *v4++ = v3;
        v3 += 3;
      }
      while ( 3LL * (unsigned int)a1 != v3 );
    }
    if ( a1 >= 0 )
      v5 = a1;
    else
      v5 = a1 + 1;
    v6 = v2[v5 >> 1];
    free(v2);
  }
  else
  {
    return (unsigned int)-1;
  }
  return v6;
}


/* Function: heap_struct @ 0xFF0 */
__int64 __fastcall heap_struct(int a1)
{
  return (unsigned int)(3 * a1);
}


/* Function: heap_nested @ 0xFF8 */
__int64 __fastcall heap_nested(void **a1)
{
  _DWORD *v2; // x0
  __int64 v3; // x8
  __int64 result; // x0

  v2 = malloc(0x10u);
  *a1 = v2;
  if ( !v2 )
    return 0xFFFFFFFFLL;
  *v2 = 10;
  *((_QWORD *)*a1 + 1) = malloc(0x10u);
  v3 = *((_QWORD *)*a1 + 1);
  if ( v3 )
  {
    result = 0;
    *(_QWORD *)(v3 + 8) = 0;
    *(_DWORD *)v3 = 20;
  }
  else
  {
    free(*a1);
    return 4294967294LL;
  }
  return result;
}


/* Function: linked_list_heap @ 0x106C */
__int64 linked_list_heap()
{
  _QWORD *v0; // x19
  _QWORD *v1; // x21
  unsigned int v2; // w23
  bool v3; // w22
  _QWORD *v4; // x0
  _QWORD *v5; // x24
  unsigned int v6; // w20
  _QWORD *v7; // x8
  int v8; // w9
  _QWORD *v9; // x21

  v0 = 0;
  v1 = 0;
  v2 = 0;
  v3 = 1;
  while ( 1 )
  {
    v4 = malloc(0x10u);
    if ( !v4 )
      break;
    v4[1] = 0;
    *(_DWORD *)v4 = 10 * v2;
    if ( v0 )
    {
      v1[1] = v4;
      v1 = v4;
    }
    else
    {
      v1 = v4;
      v0 = v4;
    }
    v3 = v2++ < 4;
    if ( v2 == 5 )
      goto LABEL_11;
  }
  if ( v0 )
  {
    do
    {
      v5 = (_QWORD *)v0[1];
      free(v0);
      v0 = v5;
    }
    while ( v5 );
  }
LABEL_11:
  if ( v3 )
  {
    return (unsigned int)-1;
  }
  else
  {
    v6 = 0;
    if ( v0 )
    {
      v7 = v0;
      do
      {
        v8 = *(_DWORD *)v7;
        v7 = (_QWORD *)v7[1];
        v6 += v8;
      }
      while ( v7 );
    }
    if ( v0 )
    {
      do
      {
        v9 = (_QWORD *)v0[1];
        free(v0);
        v0 = v9;
      }
      while ( v9 );
    }
  }
  return v6;
}


/* Function: create_tree_node @ 0x1160 */
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


/* Function: tree_heap_traversal @ 0x1190 */
__int64 tree_heap_traversal()
{
  _DWORD *v0; // x0
  _QWORD *v1; // x19
  _DWORD *v2; // x0
  _DWORD *v3; // x20
  _DWORD *v4; // x0
  void *v5; // x21
  unsigned int v6; // w22

  v0 = malloc(0x18u);
  if ( v0 )
  {
    v1 = v0;
    *((_QWORD *)v0 + 1) = 0;
    *((_QWORD *)v0 + 2) = 0;
    *v0 = 10;
    v2 = malloc(0x18u);
    v3 = v2;
    if ( v2 )
    {
      *((_QWORD *)v2 + 1) = 0;
      *((_QWORD *)v2 + 2) = 0;
      *v2 = 20;
    }
    v1[1] = v2;
    v4 = malloc(0x18u);
    v5 = v4;
    if ( v4 )
    {
      *((_QWORD *)v4 + 1) = 0;
      *((_QWORD *)v4 + 2) = 0;
      *v4 = 30;
    }
    v1[2] = v4;
    if ( v3 && v4 )
    {
      v6 = *v3 + *(_DWORD *)v1 + *v4;
      free(v3);
      v5 = (void *)v1[2];
    }
    else
    {
      if ( v3 )
        free(v3);
      v6 = -2;
      if ( !v5 )
        goto LABEL_14;
    }
    free(v5);
LABEL_14:
    free(v1);
    return v6;
  }
  return (unsigned int)-1;
}


/* Function: memory_leak @ 0x1268 */
__int64 __fastcall memory_leak(int a1)
{
  _DWORD *v2; // x0
  __int64 v3; // x8
  int v4; // w8

  v2 = malloc(4LL * a1);
  if ( !v2 )
    return 0xFFFFFFFFLL;
  if ( a1 >= 1 )
  {
    v3 = 0;
    do
    {
      v2[v3] = v3;
      ++v3;
    }
    while ( a1 != v3 );
  }
  if ( a1 >= 0 )
    v4 = a1;
  else
    v4 = a1 + 1;
  return (unsigned int)v2[v4 >> 1];
}


/* Function: dangling_pointer @ 0x12C8 */
__int64 dangling_pointer()
{
  _DWORD *v0; // x0
  unsigned int *v1; // x19

  v0 = malloc(4u);
  if ( !v0 )
    return 0xFFFFFFFFLL;
  v1 = v0;
  *v0 = 42;
  printf("value before free: %d\n", 42);
  free(v1);
  return *v1;
}


/* Function: double_free @ 0x131C */
__int64 __fastcall double_free(unsigned int *a1)
{
  if ( a1 )
    return *a1;
  else
    return 4294967294LL;
}


/* Function: heap_overflow @ 0x1330 */
__int64 heap_overflow()
{
  unsigned int *v0; // x0
  __int64 v1; // x8
  unsigned int v2; // w9
  unsigned int v3; // w19

  v0 = (unsigned int *)malloc(0x28u);
  if ( v0 )
  {
    v1 = 0;
    v2 = 0;
    do
    {
      v0[v1] = v2;
      v2 += 100;
      ++v1;
    }
    while ( v1 != 11 );
    v3 = *v0;
    free(v0);
  }
  else
  {
    return (unsigned int)-1;
  }
  return v3;
}


/* Function: test_heap_memory @ 0x1384 */
void test_heap_memory()
{
  _DWORD *v0; // x0
  __int64 v1; // x8
  _DWORD *v2; // x9
  int v3; // w19
  char *v4; // x0
  __int64 v5; // x8
  int v6; // w19
  int v7; // w9
  _DWORD *v8; // x0
  void *v9; // x19
  __int64 v10; // x8
  bool v11; // zf
  int v12; // w20
  _DWORD *v13; // x0
  int v14; // w8
  __int64 i; // x9
  int v16; // w20
  _DWORD *v17; // x0
  __int64 v18; // x8
  _DWORD *v19; // x9
  int v20; // w19
  void **v21; // x19
  _DWORD *v22; // x0
  int v23; // w1
  int v24; // w0
  int v25; // w0
  _DWORD *v26; // x0
  __int64 j; // x8
  int v28; // w1
  int v29; // w0
  __int64 v30; // x1
  unsigned int v31; // w0
  int stat_loc; // [xsp+Ch] [xbp-4h] BYREF

  puts(asc_2243);
  v0 = malloc(0x28u);
  if ( v0 )
  {
    v1 = 0;
    v2 = v0;
    do
    {
      *v2++ = v1;
      v1 += 2;
    }
    while ( v1 != 20 );
    v3 = v0[5];
    free(v0);
  }
  else
  {
    v3 = -1;
  }
  printf("HEAP-L2-01 (heap_basic): %d\n", v3);
  v4 = (char *)calloc(5u, 4u);
  if ( v4 )
  {
    v5 = 0;
    v6 = 0;
    do
    {
      v7 = *(_DWORD *)&v4[v5];
      v5 += 4;
      v6 += v7;
    }
    while ( v5 != 20 );
    free(v4);
  }
  else
  {
    v6 = -1;
  }
  printf("HEAP-L2-02 (heap_calloc): %d\n", v6);
  v8 = malloc(0x14u);
  if ( v8 )
  {
    v9 = v8;
    v10 = 0;
    do
    {
      v11 = v10 == 4;
      v8[v10] = v10 + 1;
      ++v10;
    }
    while ( !v11 );
    v12 = v8[2];
    v13 = realloc(v8, 0x28u);
    if ( v13 )
    {
      v14 = 50;
      for ( i = 5; i != 10; ++i )
      {
        v13[i] = v14;
        v14 += 10;
      }
      if ( v13[2] == v12 )
        v16 = v13[5];
      else
        v16 = -3;
      v9 = v13;
    }
    else
    {
      v16 = -2;
    }
    free(v9);
  }
  else
  {
    v16 = -1;
  }
  printf("HEAP-L2-03 (heap_realloc): %d\n", v16);
  v17 = malloc(0x28u);
  if ( v17 )
  {
    v18 = 0;
    v19 = v17;
    do
    {
      *v19++ = v18;
      v18 += 3;
    }
    while ( v18 != 30 );
    v20 = v17[5];
    free(v17);
  }
  else
  {
    v20 = -1;
  }
  printf("HEAP-L2-04 (heap_array): %d\n", v20);
  printf("HEAP-L2-05 (heap_struct): %d\n", 15);
  v21 = (void **)malloc(0x10u);
  if ( v21 )
  {
    *(_DWORD *)v21 = 10;
    v22 = malloc(0x10u);
    v21[1] = v22;
    if ( v22 )
    {
      v23 = 0;
      *((_QWORD *)v22 + 1) = 0;
      *v22 = 20;
    }
    else
    {
      free(v21);
      v23 = -2;
    }
  }
  else
  {
    v23 = -1;
  }
  printf("HEAP-L2-06 (heap_nested): %d\n", v23);
  if ( v21 )
  {
    free(v21[1]);
    free(v21);
  }
  v24 = linked_list_heap();
  printf("HEAP-L3-01 (linked_list_heap): %d\n", v24);
  v25 = tree_heap_traversal();
  printf("HEAP-L3-02 (tree_heap_traversal): %d\n", v25);
  v26 = malloc(0x14u);
  if ( v26 )
  {
    for ( j = 0; j != 5; ++j )
      v26[j] = j;
    v28 = v26[2];
  }
  else
  {
    v28 = -1;
  }
  printf("HEAP-L3-03 (memory_leak): %d\n", v28);
  printf("HEAP-L3-04 (dangling_pointer): ");
  v29 = fork();
  if ( !v29 )
  {
    v31 = dangling_pointer();
    printf(aD, v31);
    exit(0);
  }
  if ( v29 < 1 )
  {
    perror(aFork_0);
  }
  else
  {
    waitpid(v29, &stat_loc, 0);
    v30 = stat_loc & 0x7F;
    if ( (stat_loc & 0x7F) != 0 )
    {
      if ( ((_DWORD)v30 << 24) + 0x1000000 >= 0x2000000 )
        printf(byte_1F06, v30);
    }
    else
    {
      printf(byte_1EE1, BYTE1(stat_loc));
    }
  }
}


/* Function: global_var_access @ 0x168C */
__int64 global_var_access()
{
  return (unsigned int)++global_counter;
}


/* Function: global_var_read @ 0x16A0 */
__int64 global_var_read()
{
  return (unsigned int)(2 * global_counter);
}


/* Function: global_array_access @ 0x16B0 */
__int64 __fastcall global_array_access(unsigned int a1)
{
  if ( a1 <= 9 )
    return global_array[a1];
  else
    return 0xFFFFFFFFLL;
}


/* Function: static_local @ 0x16D0 */
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


/* Function: call_static_func @ 0x16E8 */
__int64 __fastcall call_static_func(int a1)
{
  return (2 * a1) | 1u;
}


/* Function: access_extern_global @ 0x16F8 */
__int64 access_extern_global()
{
  return (unsigned int)(extern_global_var + 100);
}


/* Function: call_extern_func @ 0x170C */
__int64 call_extern_func()
{
  return extern_function(5);
}


/* Function: read_const_data @ 0x1724 */
__int64 read_const_data()
{
  return (unsigned int)(unsigned __int8)const_string[4] + 42;
}


/* Function: access_bss_var @ 0x1738 */
__int64 access_bss_var()
{
  return 0;
}


/* Function: access_bss_buffer @ 0x1740 */
__int64 access_bss_buffer()
{
  return 0;
}


/* Function: global_struct_access @ 0x1748 */
__int64 global_struct_access()
{
  return 30;
}


/* Function: set_file_static @ 0x1750 */
__int64 __fastcall set_file_static(__int64 result)
{
  file_scope_static = result;
  return result;
}


/* Function: get_file_static @ 0x175C */
__int64 get_file_static()
{
  return (unsigned int)file_scope_static;
}


/* Function: set_global_callback @ 0x1768 */
void *__fastcall set_global_callback(void *result)
{
  global_func_ptr = result;
  return result;
}


/* Function: call_global_callback @ 0x1774 */
__int64 call_global_callback()
{
  if ( global_func_ptr )
    return global_func_ptr();
  else
    return 0xFFFFFFFFLL;
}


/* Function: global_heap_store @ 0x17A0 */
__int64 __fastcall global_heap_store(unsigned int *a1)
{
  global_heap_ptr = (__int64)a1;
  if ( a1 )
    return *a1;
  else
    return 0xFFFFFFFFLL;
}


/* Function: static_complex_init @ 0x17BC */
__int64 static_complex_init()
{
  return 15;
}


/* Function: tls_access @ 0x17C4 */
__int64 __fastcall tls_access(int a1)
{
  return (unsigned int)(2 * a1);
}


/* Function: init_order_test @ 0x17CC */
__int64 init_order_test()
{
  return 20;
}


/* Function: test_static_global @ 0x17D4 */
__int64 test_static_global()
{
  int v0; // w0
  int v2; // [xsp+Ch] [xbp-4h] BYREF

  puts(asc_2261);
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


/* Function: double_value @ 0x1994 */
__int64 __fastcall double_value(int a1)
{
  return (unsigned int)(2 * a1);
}


/* Function: memop_memset @ 0x199C */
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


/* Function: memop_memcpy @ 0x19DC */
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


/* Function: memop_memmove @ 0x1A24 */
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


/* Function: memop_memcmp @ 0x1A64 */
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


/* Function: memop_bzero @ 0x1AA0 */
__int64 __fastcall memop_bzero(unsigned __int8 *a1, size_t n)
{
  if ( !a1 )
    return 0xFFFFFFFFLL;
  memset(a1, 0, n);
  return *a1;
}


/* Function: memop_bcopy @ 0x1AD8 */
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


/* Function: memop_unaligned_access @ 0x1B14 */
__int64 __fastcall memop_unaligned_access(__int64 a1)
{
  if ( a1 )
    return *(unsigned int *)(a1 + 1);
  else
    return 0xFFFFFFFFLL;
}


/* Function: memop_memory_barrier @ 0x1B28 */
__int64 __fastcall memop_memory_barrier(int *a1)
{
  int v1; // w8

  if ( !a1 )
    return 0xFFFFFFFFLL;
  v1 = *a1;
  __dmb(0xBu);
  return (unsigned int)(*a1 + v1);
}


/* Function: test_memory_op_functions @ 0x1B48 */
__int64 test_memory_op_functions()
{
  int v1; // [xsp+Ch] [xbp-14h]

  puts(asc_2285);
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


/* Function: main @ 0x1C28 */
int __fastcall main(int argc, const char **argv, const char **envp)
{
  test_stack_memory();
  test_heap_memory();
  test_static_global();
  test_memory_op_functions();
  return 0;
}


/* Function: extern_function @ 0x1C4C */
__int64 __fastcall extern_function(int a1)
{
  return (unsigned int)(3 * a1);
}


/* Function: .term_proc @ 0x1C54 */
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
