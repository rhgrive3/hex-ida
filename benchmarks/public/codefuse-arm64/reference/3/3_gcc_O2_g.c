/*
 * Decompiled by IDA Pro 9.1 with Hex-Rays
 * Binary: /Users/eren/Desktop/Antigravity/compiler/build/arm64/3/3_gcc_O2_g
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
  test_stack_memory();
  test_heap_memory();
  test_static_global();
  test_memory_op_functions();
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
int __fastcall double_value(int x)
{
  return 2 * x;
}


/* Function: local_vars @ 0xC70 */
int __fastcall local_vars(int x)
{
  return 2 * x + 10;
}


/* Function: local_array @ 0xC80 */
int __fastcall local_array(int n)
{
  int *v1; // x2
  int v2; // w1
  int arr[10]; // [xsp+10h] [xbp+10h] BYREF
  __int64 v5; // [xsp+38h] [xbp+38h] BYREF

  v1 = arr;
  v2 = 0;
  do
  {
    *v1++ = v2;
    v2 += n;
  }
  while ( v1 != (int *)&v5 );
  return arr[5];
}


/* Function: local_struct @ 0xCE4 */
int __fastcall local_struct(int x)
{
  return 3 * x;
}


/* Function: address_of_local @ 0xCF0 */
int __fastcall address_of_local(int *out)
{
  int result; // w0

  result = 42;
  *out = 42;
  return result;
}


/* Function: address_of_array @ 0xD00 */
int __fastcall address_of_array(int *arr)
{
  return 2 * *arr;
}


/* Function: large_stack_frame @ 0xD10 */
int __cdecl large_stack_frame()
{
  char *v0; // x1
  int i; // w0
  char large_buf[2048]; // [xsp+18h] [xbp+18h] BYREF

  v0 = large_buf;
  for ( i = 0; i != 2048; ++i )
    *v0++ = i;
  return (unsigned __int8)large_buf[1024];
}


/* Function: vla_stack @ 0xD80 */
int __fastcall vla_stack(int n)
{
  __int64 v1; // x1
  unsigned __int64 v2; // x2
  unsigned __int16 v3; // w1
  _QWORD *v4; // x2
  __int64 v5; // x1
  _QWORD v7[128]; // [xsp+0h] [xbp-10010h] BYREF
  __int64 v8; // [xsp+400h] [xbp-FC10h]
  _BYTE v9[16]; // [xsp+10000h] [xbp-10h] BYREF

  if ( (unsigned int)(n - 1) > 0x3E7 )
    return -1;
  v1 = 4LL * n + 15;
  v2 = v1 & 0xFFFFFFFFFFFF0000LL;
  v3 = v1 & 0xFFF0;
  v4 = &v9[-v2];
  if ( v9 != (_BYTE *)v4 )
  {
    do
      v8 = 0;
    while ( v7 != v4 );
  }
  v7[0] = 0;
  if ( v3 >= 0x400uLL )
    v8 = 0;
  v5 = 0;
  do
  {
    *((_DWORD *)&v7[2] + v5) = 2 * v5;
    ++v5;
  }
  while ( n > (int)v5 );
  return *((_DWORD *)&v7[2] + (n >> 1));
}


/* Function: alloca_usage @ 0xE50 */
int __fastcall alloca_usage(int n)
{
  __int64 v1; // x1
  unsigned __int64 v2; // x2
  unsigned __int16 v3; // w1
  __int64 *v4; // x2
  _DWORD *v5; // x2
  int v6; // w1
  __int64 v8; // [xsp+0h] [xbp-10010h] BYREF
  _DWORD v9[252]; // [xsp+10h] [xbp-10000h] BYREF
  __int64 v10; // [xsp+400h] [xbp-FC10h]
  _BYTE v11[16]; // [xsp+10000h] [xbp-10h] BYREF

  if ( n <= 0 )
    return -1;
  v1 = 4LL * n + 15;
  v2 = v1 & 0xFFFFFFFFFFFF0000LL;
  v3 = v1 & 0xFFF0;
  v4 = (__int64 *)&v11[-v2];
  if ( v11 != (_BYTE *)v4 )
  {
    do
      v10 = 0;
    while ( &v8 != v4 );
  }
  v8 = 0;
  if ( v3 >= 0x400uLL )
    v10 = 0;
  v5 = v9;
  v6 = 0;
  do
  {
    *v5++ = v6;
    v6 += 3;
  }
  while ( v6 != 3 * n );
  return v9[n >> 1];
}


/* Function: stack_alias @ 0xF20 */
int __fastcall stack_alias(int *p1, int *p2)
{
  return 20;
}


/* Function: test_stack_memory @ 0xF30 */
void __cdecl test_stack_memory()
{
  int v0; // w0
  int v1; // w0

  puts(asc_1FA8);
  __printf_chk(1, "MEM-L1-01 (local_vars): %d\n", 20);
  __printf_chk(1, "MEM-L1-02 (local_array): %d\n", 10);
  __printf_chk(1, "MEM-L1-03 (local_struct): %d\n", 15);
  __printf_chk(1, "MEM-L1-04 (address_of_local): %d\n", 42);
  __printf_chk(1, "MEM-L1-05 (address_of_array): %d\n", 2);
  v0 = large_stack_frame();
  __printf_chk(1, "MEM-L2-01 (large_stack_frame): %d\n", v0);
  __printf_chk(1, "MEM-L2-02 (vla_stack): %d\n", 10);
  v1 = alloca_usage(10);
  __printf_chk(1, "MEM-L2-03 (alloca_usage): %d\n", v1);
  __printf_chk(1, "MEM-L2-04 (stack_alias): %d\n", 20);
}


/* Function: heap_basic @ 0x1010 */
int __fastcall heap_basic(int n)
{
  _DWORD *v2; // x0
  __int64 v3; // x1
  int v4; // w19

  v2 = malloc(4LL * n);
  if ( !v2 )
    return -1;
  if ( n > 0 )
  {
    v3 = 0;
    do
    {
      v2[v3] = 2 * v3;
      ++v3;
    }
    while ( n > (int)v3 );
  }
  v4 = v2[n / 2];
  free(v2);
  return v4;
}


/* Function: heap_calloc @ 0x1074 */
int __fastcall heap_calloc(int n)
{
  _DWORD *v2; // x0
  __int64 v3; // x1
  int v4; // w19
  int v5; // w2

  v2 = calloc(n, 4u);
  if ( !v2 )
    return -1;
  if ( n <= 0 )
  {
    v4 = 0;
  }
  else
  {
    v3 = 0;
    v4 = 0;
    do
    {
      v5 = v2[v3++];
      v4 += v5;
    }
    while ( n > (int)v3 );
  }
  free(v2);
  return v4;
}


/* Function: heap_realloc @ 0x10E0 */
int __cdecl heap_realloc()
{
  _QWORD *v0; // x0
  void *v1; // x19
  _DWORD *v2; // x0
  int v3; // w19
  void *v5; // x0

  v0 = malloc(0x14u);
  if ( !v0 )
    return -1;
  *v0 = 0x200000001LL;
  v0[1] = 0x400000003LL;
  v1 = v0;
  *((_DWORD *)v0 + 4) = 5;
  v2 = realloc(v0, 0x28u);
  if ( v2 )
  {
    if ( v2[2] == 3 )
      v3 = 50;
    else
      v3 = -3;
    free(v2);
  }
  else
  {
    v5 = v1;
    v3 = -2;
    free(v5);
  }
  return v3;
}


/* Function: heap_array @ 0x1164 */
int __fastcall heap_array(int n)
{
  _DWORD *v2; // x0
  _DWORD *v3; // x2
  int v4; // w1
  int v5; // w19

  v2 = malloc(4LL * n);
  if ( !v2 )
    return -1;
  if ( n > 0 )
  {
    v3 = v2;
    v4 = 0;
    do
    {
      *v3++ = v4;
      v4 += 3;
    }
    while ( v4 != 3 * n );
  }
  v5 = v2[n / 2];
  free(v2);
  return v5;
}


/* Function: heap_struct @ 0x11D0 */
int __fastcall heap_struct(int x)
{
  void *v2; // x0
  int v3; // w19

  v2 = malloc(8u);
  if ( !v2 )
    return -1;
  v3 = 3 * x;
  free(v2);
  return v3;
}


/* Function: heap_nested @ 0x1210 */
int __fastcall heap_nested(Node **head)
{
  Node *v2; // x0
  Node *v3; // x19
  Node *v4; // x0
  Node *v5; // x1
  int result; // w0

  v2 = (Node *)malloc(0x10u);
  *head = v2;
  if ( !v2 )
    return -1;
  v3 = v2;
  v2->data = 10;
  v4 = (Node *)malloc(0x10u);
  v3->next = v4;
  v5 = v4;
  if ( v4 )
  {
    result = 0;
    v5->data = 20;
    v5->next = 0;
  }
  else
  {
    free(v3);
    return -2;
  }
  return result;
}


/* Function: linked_list_heap @ 0x1284 */
int __cdecl linked_list_heap()
{
  _QWORD *v0; // x0
  int v1; // w20
  _QWORD *v2; // x19
  _QWORD *v3; // x21
  _QWORD *v4; // x0
  int v5; // w20
  int v6; // w1
  void *v7; // x0
  void *v9; // x0

  v0 = 0;
  v1 = 0;
  v2 = 0;
  while ( 1 )
  {
    v3 = v0;
    v0 = malloc(0x10u);
    if ( !v0 )
      break;
    *(_DWORD *)v0 = v1;
    v0[1] = 0;
    if ( v2 )
      v3[1] = v0;
    else
      v2 = v0;
    v1 += 10;
    if ( v1 == 50 )
    {
      v4 = v2;
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
        v7 = v2;
        v2 = (_QWORD *)v2[1];
        free(v7);
      }
      while ( v2 );
      return v5;
    }
  }
  while ( v2 )
  {
    v9 = v2;
    v2 = (_QWORD *)v2[1];
    free(v9);
  }
  return -1;
}


/* Function: create_tree_node @ 0x1330 */
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


/* Function: tree_heap_traversal @ 0x1360 */
int __cdecl tree_heap_traversal()
{
  void *v0; // x0
  void *v1; // x19
  void *v2; // x20
  void *v3; // x21
  void *v5; // x0

  v0 = malloc(0x18u);
  if ( !v0 )
    return -1;
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
    return -2;
  }
  free(v2);
  free(v3);
  free(v1);
  return 60;
}


/* Function: memory_leak @ 0x1410 */
int __fastcall memory_leak(int n)
{
  _DWORD *v2; // x0
  __int64 v3; // x1

  v2 = malloc(4LL * n);
  if ( !v2 )
    return -1;
  if ( n > 0 )
  {
    v3 = 0;
    do
    {
      v2[v3] = v3;
      ++v3;
    }
    while ( n > (int)v3 );
  }
  return v2[n / 2];
}


/* Function: dangling_pointer @ 0x1470 */
int __cdecl dangling_pointer()
{
  _DWORD *v0; // x0
  _DWORD *v1; // x19

  v0 = malloc(4u);
  if ( !v0 )
    return -1;
  v1 = v0;
  __printf_chk(1, "value before free: %d\n", 42);
  free(v1);
  return *v1;
}


/* Function: double_free @ 0x14C0 */
int __fastcall double_free(int *p)
{
  void *v2; // x0
  void *v3; // x19

  if ( p )
    return *p;
  v2 = malloc(4u);
  v3 = v2;
  if ( !v2 )
    return -1;
  free(v2);
  free(v3);
  return -2;
}


/* Function: heap_overflow @ 0x1510 */
int __cdecl heap_overflow()
{
  int *v0; // x0
  int *v1; // x2
  int i; // w1
  int v3; // w19

  v0 = (int *)malloc(0x28u);
  if ( !v0 )
    return -1;
  v1 = v0;
  for ( i = 0; i != 1100; i += 100 )
    *v1++ = i;
  v3 = *v0;
  free(v0);
  return v3;
}


/* Function: test_heap_memory @ 0x1560 */
void __cdecl test_heap_memory()
{
  _DWORD *v0; // x0
  __int64 i; // x1
  int v2; // w19
  int *v3; // x0
  int *v4; // x1
  int v5; // w19
  int v6; // t1
  int v7; // w0
  _DWORD *v8; // x0
  _DWORD *v9; // x2
  int j; // w1
  int v11; // w19
  void *v12; // x0
  int v13; // w2
  void **v14; // x19
  _DWORD *v15; // x0
  int v16; // w2
  int v17; // w0
  int v18; // w0
  _QWORD *v19; // x0
  int v20; // w2
  int v21; // w0
  unsigned int *v22; // x19
  __int64 v23; // x2
  int status; // [xsp+24h] [xbp+24h] BYREF

  puts(asc_2118);
  v0 = malloc(0x28u);
  if ( v0 )
  {
    for ( i = 0; i != 10; ++i )
      v0[i] = 2 * i;
    v2 = v0[5];
    free(v0);
  }
  else
  {
    v2 = -1;
  }
  __printf_chk(1, "HEAP-L2-01 (heap_basic): %d\n", v2);
  v3 = (int *)calloc(5u, 4u);
  if ( v3 )
  {
    v4 = v3;
    v5 = 0;
    do
    {
      v6 = *v4++;
      v5 += v6;
    }
    while ( v3 + 5 != v4 );
    free(v3);
  }
  else
  {
    v5 = -1;
  }
  __printf_chk(1, "HEAP-L2-02 (heap_calloc): %d\n", v5);
  v7 = heap_realloc();
  __printf_chk(1, "HEAP-L2-03 (heap_realloc): %d\n", v7);
  v8 = malloc(0x28u);
  if ( v8 )
  {
    v9 = v8;
    for ( j = 0; j != 30; j += 3 )
      *v9++ = j;
    v11 = v8[5];
    free(v8);
  }
  else
  {
    v11 = -1;
  }
  __printf_chk(1, "HEAP-L2-04 (heap_array): %d\n", v11);
  v12 = malloc(8u);
  if ( v12 )
  {
    free(v12);
    v13 = 15;
  }
  else
  {
    v13 = -1;
  }
  __printf_chk(1, "HEAP-L2-05 (heap_struct): %d\n", v13);
  v14 = (void **)malloc(0x10u);
  if ( v14 )
  {
    v15 = malloc(0x10u);
    v14[1] = v15;
    if ( v15 )
    {
      v16 = 0;
      *v15 = 20;
      *((_QWORD *)v15 + 1) = 0;
    }
    else
    {
      free(v14);
      v16 = -2;
    }
    __printf_chk(1, "HEAP-L2-06 (heap_nested): %d\n", v16);
    free(v14[1]);
    free(v14);
  }
  else
  {
    __printf_chk(1, "HEAP-L2-06 (heap_nested): %d\n", -1);
  }
  v17 = linked_list_heap();
  __printf_chk(1, "HEAP-L3-01 (linked_list_heap): %d\n", v17);
  v18 = tree_heap_traversal();
  __printf_chk(1, "HEAP-L3-02 (tree_heap_traversal): %d\n", v18);
  v19 = malloc(0x14u);
  if ( v19 )
  {
    v20 = 2;
    *v19 = 0x100000000LL;
    v19[1] = 0x300000002LL;
    *((_DWORD *)v19 + 4) = 4;
  }
  else
  {
    v20 = -1;
  }
  __printf_chk(1, "HEAP-L3-03 (memory_leak): %d\n", v20);
  __printf_chk(1, "HEAP-L3-04 (dangling_pointer): ");
  v21 = fork();
  if ( !v21 )
  {
    v22 = (unsigned int *)malloc(4u);
    if ( v22 )
    {
      __printf_chk(1, "value before free: %d\n", 42);
      free(v22);
      v23 = *v22;
    }
    else
    {
      v23 = 0xFFFFFFFFLL;
    }
    __printf_chk(1, aD, v23);
    exit(0);
  }
  if ( v21 <= 0 )
  {
    perror(aFork_0);
  }
  else
  {
    waitpid(v21, &status, 0);
    if ( (status & 0x7F) != 0 )
    {
      if ( ((status & 0x7F) + 1) << 24 >> 25 > 0 )
        __printf_chk(1, byte_22A0);
    }
    else
    {
      __printf_chk(1, byte_2278, BYTE1(status));
    }
  }
}


/* Function: global_var_access @ 0x18C0 */
int __cdecl global_var_access()
{
  return ++global_counter;
}


/* Function: global_var_read @ 0x18D4 */
int __cdecl global_var_read()
{
  return 2 * global_counter;
}


/* Function: global_array_access @ 0x18E4 */
int __fastcall global_array_access(int idx)
{
  if ( (unsigned int)idx > 9 )
    return -1;
  else
    return global_array[idx];
}


/* Function: static_local @ 0x1904 */
int __fastcall static_local(int reset)
{
  int result; // w0

  if ( reset )
  {
    result = 0;
    counter_1 = 0;
  }
  else
  {
    return ++counter_1;
  }
  return result;
}


/* Function: call_static_func @ 0x1940 */
int __fastcall call_static_func(int x)
{
  return 2 * x + 1;
}


/* Function: access_extern_global @ 0x1950 */
int __cdecl access_extern_global()
{
  return extern_global_var + 100;
}


/* Function: call_extern_func @ 0x1964 */
int __cdecl call_extern_func()
{
  return extern_function(5);
}


/* Function: read_const_data @ 0x1970 */
int __cdecl read_const_data()
{
  return *((unsigned __int8 *)const_string + 4) + 42;
}


/* Function: access_bss_var @ 0x1984 */
int __cdecl access_bss_var()
{
  return 0;
}


/* Function: access_bss_buffer @ 0x1990 */
int __cdecl access_bss_buffer()
{
  return 0;
}


/* Function: global_struct_access @ 0x19A0 */
int __cdecl global_struct_access()
{
  return 30;
}


/* Function: set_file_static @ 0x19B0 */
void __fastcall set_file_static(int val)
{
  file_scope_static = val;
}


/* Function: get_file_static @ 0x19C0 */
int __cdecl get_file_static()
{
  return file_scope_static;
}


/* Function: set_global_callback @ 0x19D0 */
void __fastcall set_global_callback(int (*f)(int))
{
  global_func_ptr = f;
}


/* Function: call_global_callback @ 0x19E0 */
int __fastcall call_global_callback(int x)
{
  if ( global_func_ptr )
    return global_func_ptr(x);
  else
    return -1;
}


/* Function: global_heap_store @ 0x1A00 */
int __fastcall global_heap_store(int *p)
{
  if ( p )
    return *p;
  else
    return -1;
}


/* Function: static_complex_init @ 0x1A14 */
int __cdecl static_complex_init()
{
  return 15;
}


/* Function: tls_access @ 0x1A20 */
int __fastcall tls_access(int val)
{
  return 2 * val;
}


/* Function: init_order_test @ 0x1A30 */
int __cdecl init_order_test()
{
  return 20;
}


/* Function: test_static_global @ 0x1A40 */
void __cdecl test_static_global()
{
  int v0; // w0

  puts(asc_2318);
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
  __printf_chk(1, "STM-L2-03 (read_const_data): %d\n", *((unsigned __int8 *)const_string + 4) + 42);
  __printf_chk(1, "STM-L2-04 (access_bss_var): %d\n", 0);
  __printf_chk(1, "STM-L2-04 (access_bss_buffer): %d\n", 0);
  __printf_chk(1, "STM-L2-05 (global_struct_access): %d\n", 30);
  file_scope_static = 50;
  __printf_chk(1, "STM-L2-06 (file_static): %d\n", 50);
  global_func_ptr = double_value;
  __printf_chk(1, "STM-L2-07 (global_func_ptr): %d\n", 10);
  __printf_chk(1, "STM-L2-08 (global_heap_store): %d\n", 100);
  __printf_chk(1, "STM-L2-09 (static_complex_init): %d\n", 15);
  __printf_chk(1, "STM-L3-01 (tls_access): %d\n", 20);
  __printf_chk(1, "STM-L3-02 (init_order_test): %d\n", 20);
}


/* Function: memop_memset @ 0x1C30 */
int __fastcall memop_memset(void *buf, size_t size, int fill_value)
{
  bool v3; // zf

  if ( buf )
    v3 = size == 0;
  else
    v3 = 1;
  if ( v3 )
    return -1;
  memset(buf, fill_value, size);
  return *(unsigned __int8 *)buf;
}


/* Function: memop_memcpy @ 0x1C74 */
int __fastcall memop_memcpy(void *dst, const void *src, size_t n)
{
  bool v3; // zf
  size_t v6; // x20

  if ( src )
    v3 = n == 0;
  else
    v3 = 1;
  if ( v3 || dst == 0 )
    return -1;
  v6 = n & 0xFFFFFFFFFFFFFFFCLL;
  memcpy(dst, src, n);
  return *(_DWORD *)((char *)dst + v6 - 4);
}


/* Function: memop_memmove @ 0x1CC0 */
int __fastcall memop_memmove(void *buf, size_t n)
{
  bool v2; // cc

  if ( buf )
    v2 = n > 1;
  else
    v2 = 0;
  if ( !v2 )
    return -1;
  memmove((char *)buf + 1, buf, n - 1);
  return *((unsigned __int8 *)buf + 1);
}


/* Function: memop_memcmp @ 0x1D04 */
int __fastcall memop_memcmp(const void *p1, const void *p2, size_t n)
{
  bool v3; // zf
  int result; // w0
  int v6; // w0
  bool v7; // cc

  if ( p2 )
    v3 = n == 0;
  else
    v3 = 1;
  if ( v3 || p1 == 0 )
    return 0;
  v6 = memcmp(p1, p2, n);
  v7 = v6 <= 0;
  if ( v6 )
    result = -1;
  else
    result = 0;
  if ( !v7 )
    return 1;
  return result;
}


/* Function: memop_bzero @ 0x1D40 */
int __fastcall memop_bzero(void *buf, size_t n)
{
  if ( !buf )
    return -1;
  memset(buf, 0, n);
  return *(unsigned __int8 *)buf;
}


/* Function: memop_bcopy @ 0x1D80 */
int __fastcall memop_bcopy(const void *src, void *dst, size_t n)
{
  bool v3; // zf

  if ( dst )
    v3 = n == 0;
  else
    v3 = 1;
  if ( v3 || src == 0 )
    return -1;
  else
    return *(unsigned __int8 *)memmove(dst, src, n);
}


/* Function: memop_unaligned_access @ 0x1DC0 */
int __fastcall memop_unaligned_access(const char *buf)
{
  if ( buf )
    return *(_DWORD *)(buf + 1);
  else
    return -1;
}


/* Function: memop_memory_barrier @ 0x1DD4 */
int __fastcall memop_memory_barrier(volatile int *flag)
{
  volatile int v1; // w1

  if ( !flag )
    return -1;
  v1 = *flag;
  __dmb(0xBu);
  return *flag + v1;
}


/* Function: test_memory_op_functions @ 0x1DF4 */
void __cdecl test_memory_op_functions()
{
  int v0; // w0
  int v1; // w2
  volatile int flag; // [xsp+24h] [xbp+24h]
  int cmp_a[3]; // [xsp+28h] [xbp+28h] BYREF
  int cmp_b[3]; // [xsp+38h] [xbp+38h] BYREF
  char zero_buf[10]; // [xsp+48h] [xbp+48h] BYREF
  char move_buf[16]; // [xsp+58h] [xbp+58h] BYREF
  char buffer[256]; // [xsp+68h] [xbp+68h] BYREF

  puts(asc_25C8);
  memset(buffer, 65, 10);
  __printf_chk(1, "MEMOP-L2-01: %d\n", 65);
  __printf_chk(1, "MEMOP-L2-02: %d\n", 50);
  strcpy(move_buf, "HelloWorld");
  memmove(&move_buf[1], move_buf, 9u);
  __printf_chk(1, "MEMOP-L2-03: %c\n", 72);
  *(_QWORD *)cmp_a = 0x200000001LL;
  cmp_a[2] = 3;
  *(_QWORD *)cmp_b = 0x200000001LL;
  cmp_b[2] = 4;
  v0 = memcmp(cmp_a, cmp_b, 0xCu);
  if ( v0 )
    v1 = -1;
  else
    v1 = 0;
  if ( v0 > 0 )
    v1 = 1;
  __printf_chk(1, "MEMOP-L2-04: %d\n", v1);
  memset(zero_buf, 0, sizeof(zero_buf));
  __printf_chk(1, "MEMOP-L2-05: %d\n", 0);
  __printf_chk(1, "MEMOP-L2-06: %d\n", 1);
  __printf_chk(1, "MEMOP-L3-01: 0x%x\n", 67305985);
  flag = 5;
  __dmb(0xBu);
  __printf_chk(1, "MEMOP-L3-02: %d\n", flag + 5);
}


/* Function: extern_function @ 0x1F80 */
int __fastcall extern_function(int x)
{
  return 3 * x;
}


/* Function: .term_proc @ 0x1F88 */
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

/* Total functions decompiled: 65, failed: 19 */
