/*
 * Decompiled by IDA Pro 9.1 with Hex-Rays
 * Binary: /Users/eren/Desktop/Antigravity/compiler/build/arm64/3/3_gcc_Os_no_g
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


/* Function: double_value @ 0xC54 */
__int64 __fastcall double_value(int a1)
{
  return (unsigned int)(2 * a1);
}


/* Function: local_vars @ 0xC5C */
__int64 __fastcall local_vars(int a1)
{
  return (unsigned int)(2 * a1 + 10);
}


/* Function: local_array @ 0xC68 */
__int64 __fastcall local_array(int a1)
{
  int v1; // w2
  __int64 i; // x1
  _DWORD v4[10]; // [xsp+10h] [xbp+10h]

  v1 = 0;
  for ( i = 0; i != 10; ++i )
  {
    v4[i] = v1;
    v1 += a1;
  }
  return v4[5];
}


/* Function: local_struct @ 0xCCC */
__int64 __fastcall local_struct(int a1)
{
  return (unsigned int)(3 * a1);
}


/* Function: address_of_local @ 0xCD4 */
__int64 __fastcall address_of_local(_DWORD *a1)
{
  __int64 result; // x0

  result = 42;
  *a1 = 42;
  return result;
}


/* Function: address_of_array @ 0xCE4 */
__int64 __fastcall address_of_array(_DWORD *a1)
{
  return (unsigned int)(2 * *a1);
}


/* Function: large_stack_frame @ 0xCF0 */
__int64 large_stack_frame()
{
  __int64 i; // x0
  _BYTE v2[2048]; // [xsp+18h] [xbp+18h] BYREF

  for ( i = 0; i != 2048; ++i )
    v2[i] = i;
  return v2[1024];
}


/* Function: vla_stack @ 0xD58 */
__int64 __fastcall vla_stack(int a1)
{
  __int64 v1; // x1
  unsigned __int16 v2; // w2
  _QWORD *v3; // x1
  __int64 v4; // x1
  _QWORD v6[3]; // [xsp+FC00h] [xbp-10h] BYREF

  if ( (unsigned int)(a1 - 1) > 0x3E7 )
    return 0xFFFFFFFFLL;
  v1 = 4LL * a1 + 15;
  v2 = v1 & 0xFFF0;
  v3 = (_QWORD *)((char *)v6 - (v1 & 0xFFFFFFFFFFFF0000LL));
  while ( v6 != v3 )
    ;
  v6[0] = 0;
  if ( v2 >= 0x400uLL )
    STACK[0x10000] = 0;
  v4 = 0;
  do
  {
    *((_DWORD *)&v6[2] + v4) = 2 * v4;
    ++v4;
  }
  while ( a1 > (int)v4 );
  return *((unsigned int *)&v6[2] + (a1 >> 1));
}


/* Function: alloca_usage @ 0xE1C */
__int64 __fastcall alloca_usage(int a1)
{
  __int64 v1; // x1
  unsigned __int16 v2; // w2
  _QWORD *v3; // x1
  __int64 v4; // x1
  _QWORD v6[3]; // [xsp+FC00h] [xbp-10h] BYREF

  if ( a1 <= 0 )
    return 0xFFFFFFFFLL;
  v1 = 4LL * a1 + 15;
  v2 = v1 & 0xFFF0;
  v3 = (_QWORD *)((char *)v6 - (v1 & 0xFFFFFFFFFFFF0000LL));
  while ( v6 != v3 )
    ;
  v6[0] = 0;
  if ( v2 >= 0x400uLL )
    STACK[0x10000] = 0;
  v4 = 0;
  do
  {
    *((_DWORD *)&v6[2] + v4) = 3 * v4;
    ++v4;
  }
  while ( a1 > (int)v4 );
  return *((unsigned int *)&v6[2] + (a1 >> 1));
}


/* Function: stack_alias @ 0xEDC */
__int64 stack_alias()
{
  return 20;
}


/* Function: test_stack_memory @ 0xEE4 */
__int64 test_stack_memory()
{
  int v0; // w0
  int v1; // w0
  int v2; // w0
  int v3; // w0

  puts(asc_1D98);
  __printf_chk(1, "MEM-L1-01 (local_vars): %d\n", 20);
  v0 = local_array(2);
  __printf_chk(1, "MEM-L1-02 (local_array): %d\n", v0);
  __printf_chk(1, "MEM-L1-03 (local_struct): %d\n", 15);
  __printf_chk(1, "MEM-L1-04 (address_of_local): %d\n", 42);
  __printf_chk(1, "MEM-L1-05 (address_of_array): %d\n", 2);
  v1 = large_stack_frame();
  __printf_chk(1, "MEM-L2-01 (large_stack_frame): %d\n", v1);
  v2 = vla_stack(10);
  __printf_chk(1, "MEM-L2-02 (vla_stack): %d\n", v2);
  v3 = alloca_usage(10);
  __printf_chk(1, "MEM-L2-03 (alloca_usage): %d\n", v3);
  return __printf_chk(1, "MEM-L2-04 (stack_alias): %d\n", 20);
}


/* Function: heap_basic @ 0xFCC */
__int64 __fastcall heap_basic(int a1)
{
  _DWORD *v2; // x0
  __int64 i; // x1
  unsigned int v4; // w19

  v2 = malloc(4LL * a1);
  if ( v2 )
  {
    for ( i = 0; a1 > (int)i; ++i )
      v2[i] = 2 * i;
    v4 = v2[a1 / 2];
    free(v2);
  }
  else
  {
    return (unsigned int)-1;
  }
  return v4;
}


/* Function: heap_calloc @ 0x102C */
__int64 __fastcall heap_calloc(int a1)
{
  _DWORD *v2; // x0
  __int64 v3; // x1
  unsigned int v4; // w19
  int v6; // w2

  v2 = calloc(a1, 4u);
  if ( v2 )
  {
    v3 = 0;
    v4 = 0;
    while ( a1 > (int)v3 )
    {
      v6 = v2[v3++];
      v4 += v6;
    }
    free(v2);
  }
  else
  {
    return (unsigned int)-1;
  }
  return v4;
}


/* Function: heap_realloc @ 0x1088 */
__int64 heap_realloc()
{
  _QWORD *v0; // x0
  void *v1; // x19
  _DWORD *v2; // x0
  unsigned int v3; // w19
  void *v5; // x0

  v0 = malloc(0x14u);
  if ( v0 )
  {
    v1 = v0;
    *v0 = 0x200000001LL;
    v0[1] = 0x400000003LL;
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
  }
  else
  {
    return (unsigned int)-1;
  }
  return v3;
}


/* Function: heap_array @ 0x1110 */
__int64 __fastcall heap_array(int a1)
{
  _DWORD *v2; // x0
  __int64 i; // x1
  unsigned int v4; // w19

  v2 = malloc(4LL * a1);
  if ( v2 )
  {
    for ( i = 0; a1 > (int)i; ++i )
      v2[i] = 3 * i;
    v4 = v2[a1 / 2];
    free(v2);
  }
  else
  {
    return (unsigned int)-1;
  }
  return v4;
}


/* Function: heap_struct @ 0x1170 */
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


/* Function: heap_nested @ 0x11AC */
__int64 __fastcall heap_nested(_QWORD *a1)
{
  _DWORD *v2; // x0
  _QWORD *v3; // x19
  _QWORD *v4; // x0

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
    *(_DWORD *)v4 = 20;
    v4[1] = 0;
    return 0;
  }
  else
  {
    free(v3);
    return 4294967294LL;
  }
}


/* Function: linked_list_heap @ 0x121C */
__int64 linked_list_heap()
{
  _QWORD *v0; // x0
  int v1; // w20
  _QWORD *v2; // x19
  _QWORD *v3; // x21
  unsigned int v4; // w20
  _QWORD *v6; // x20
  _QWORD *v7; // x0
  int v8; // w1
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
      v7 = v2;
      v4 = 0;
      do
      {
        v8 = *(_DWORD *)v7;
        v7 = (_QWORD *)v7[1];
        v4 += v8;
      }
      while ( v7 );
      do
      {
        v9 = v2;
        v2 = (_QWORD *)v2[1];
        free(v9);
      }
      while ( v2 );
      return v4;
    }
  }
  while ( v2 )
  {
    v6 = (_QWORD *)v2[1];
    free(v2);
    v2 = v6;
  }
  return (unsigned int)-1;
}


/* Function: create_tree_node @ 0x12C8 */
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


/* Function: tree_heap_traversal @ 0x12F8 */
__int64 tree_heap_traversal()
{
  _QWORD *tree_node; // x0
  _QWORD *v1; // x19
  _QWORD *v2; // x1
  _DWORD *v3; // x0
  void *v4; // x0
  unsigned int v5; // w20

  tree_node = create_tree_node(10);
  if ( !tree_node )
    return (unsigned int)-1;
  v1 = tree_node;
  tree_node[1] = create_tree_node(20);
  v2 = create_tree_node(30);
  v3 = (_DWORD *)v1[1];
  v1[2] = v2;
  if ( v3 )
  {
    if ( v2 )
    {
      v5 = *(_DWORD *)v1 + *v3 + *(_DWORD *)v2;
      free(v3);
      free((void *)v1[2]);
      free(v1);
      return v5;
    }
    free(v3);
  }
  v4 = (void *)v1[2];
  if ( v4 )
    free(v4);
  v5 = -2;
  free(v1);
  return v5;
}


/* Function: memory_leak @ 0x139C */
__int64 __fastcall memory_leak(int a1)
{
  _DWORD *v2; // x0
  __int64 i; // x1

  v2 = malloc(4LL * a1);
  if ( !v2 )
    return 0xFFFFFFFFLL;
  for ( i = 0; a1 > (int)i; ++i )
    v2[i] = i;
  return (unsigned int)v2[a1 / 2];
}


/* Function: dangling_pointer @ 0x13F0 */
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


/* Function: double_free @ 0x1440 */
__int64 __fastcall double_free(unsigned int *a1)
{
  void *v1; // x0
  void *v2; // x19

  if ( a1 )
    return *a1;
  v1 = malloc(4u);
  v2 = v1;
  if ( !v1 )
    return 0xFFFFFFFFLL;
  free(v1);
  free(v2);
  return 4294967294LL;
}


/* Function: heap_overflow @ 0x148C */
__int64 heap_overflow()
{
  unsigned int *v0; // x0
  __int64 i; // x1
  unsigned int v2; // w19

  v0 = (unsigned int *)malloc(0x28u);
  if ( v0 )
  {
    for ( i = 0; i != 11; ++i )
      v0[i] = 100 * i;
    v2 = *v0;
    free(v0);
  }
  else
  {
    return (unsigned int)-1;
  }
  return v2;
}


/* Function: test_heap_memory @ 0x14E0 */
void *test_heap_memory()
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
  unsigned int v10; // w0
  __int64 v11; // x2
  int stat_loc; // [xsp+1Ch] [xbp+1Ch] BYREF
  void *ptr; // [xsp+20h] [xbp+20h] BYREF

  puts(asc_1EE1);
  v0 = heap_basic(10);
  __printf_chk(1, "HEAP-L2-01 (heap_basic): %d\n", v0);
  v1 = heap_calloc(5);
  __printf_chk(1, "HEAP-L2-02 (heap_calloc): %d\n", v1);
  v2 = heap_realloc();
  __printf_chk(1, "HEAP-L2-03 (heap_realloc): %d\n", v2);
  v3 = heap_array(10);
  __printf_chk(1, "HEAP-L2-04 (heap_array): %d\n", v3);
  v4 = heap_struct(5);
  __printf_chk(1, "HEAP-L2-05 (heap_struct): %d\n", v4);
  ptr = 0;
  v5 = heap_nested(&ptr);
  __printf_chk(1, "HEAP-L2-06 (heap_nested): %d\n", v5);
  if ( ptr )
  {
    free(*(void **)&byte_8[(_QWORD)ptr]);
    free(ptr);
  }
  v6 = linked_list_heap();
  __printf_chk(1, "HEAP-L3-01 (linked_list_heap): %d\n", v6);
  v7 = tree_heap_traversal();
  __printf_chk(1, "HEAP-L3-02 (tree_heap_traversal): %d\n", v7);
  v8 = memory_leak(5);
  __printf_chk(1, "HEAP-L3-03 (memory_leak): %d\n", v8);
  __printf_chk(1, "HEAP-L3-04 (dangling_pointer): ");
  v9 = fork();
  if ( !v9 )
  {
    v10 = dangling_pointer();
    __printf_chk(1, aD, v10);
    exit(0);
  }
  if ( v9 <= 0 )
  {
    perror(aFork_0);
  }
  else
  {
    waitpid(v9, &stat_loc, 0);
    v11 = stat_loc & 0x7F;
    if ( (stat_loc & 0x7F) != 0 )
    {
      if ( ((int)v11 + 1) << 24 >> 25 > 0 )
        __printf_chk(1, byte_206E, v11);
    }
    else
    {
      __printf_chk(1, byte_2049, BYTE1(stat_loc));
    }
  }
  return &_stack_chk_guard;
}


/* Function: global_var_access @ 0x16D4 */
__int64 global_var_access()
{
  return (unsigned int)++global_counter;
}


/* Function: global_var_read @ 0x16E8 */
__int64 global_var_read()
{
  return (unsigned int)(2 * global_counter);
}


/* Function: global_array_access @ 0x16F8 */
__int64 __fastcall global_array_access(unsigned int a1)
{
  if ( a1 > 9 )
    return 0xFFFFFFFFLL;
  else
    return global_array[a1];
}


/* Function: static_local @ 0x1718 */
__int64 __fastcall static_local(int a1)
{
  __int64 result; // x0

  if ( a1 )
    result = 0;
  else
    result = (unsigned int)(counter_1 + 1);
  counter_1 = result;
  return result;
}


/* Function: call_static_func @ 0x1740 */
__int64 __fastcall call_static_func(int a1)
{
  return (unsigned int)(2 * a1 + 1);
}


/* Function: access_extern_global @ 0x174C */
__int64 access_extern_global()
{
  return (unsigned int)(extern_global_var + 100);
}


/* Function: call_extern_func @ 0x1760 */
__int64 call_extern_func()
{
  return extern_function(5);
}


/* Function: read_const_data @ 0x1768 */
__int64 read_const_data()
{
  return (unsigned int)(unsigned __int8)const_string[4] + 42;
}


/* Function: access_bss_var @ 0x177C */
__int64 access_bss_var()
{
  return 0;
}


/* Function: access_bss_buffer @ 0x1784 */
__int64 access_bss_buffer()
{
  return 0;
}


/* Function: global_struct_access @ 0x178C */
__int64 global_struct_access()
{
  return 30;
}


/* Function: set_file_static @ 0x1794 */
__int64 __fastcall set_file_static(__int64 result)
{
  file_scope_static = result;
  return result;
}


/* Function: get_file_static @ 0x17A0 */
__int64 get_file_static()
{
  return (unsigned int)file_scope_static;
}


/* Function: set_global_callback @ 0x17AC */
void *__fastcall set_global_callback(void *result)
{
  global_func_ptr = result;
  return result;
}


/* Function: call_global_callback @ 0x17B8 */
__int64 call_global_callback()
{
  if ( global_func_ptr )
    return global_func_ptr();
  else
    return 0xFFFFFFFFLL;
}


/* Function: global_heap_store @ 0x17D4 */
__int64 __fastcall global_heap_store(unsigned int *a1)
{
  if ( a1 )
    return *a1;
  else
    return 0xFFFFFFFFLL;
}


/* Function: static_complex_init @ 0x17E8 */
__int64 static_complex_init()
{
  return 15;
}


/* Function: tls_access @ 0x17F0 */
__int64 __fastcall tls_access(int a1)
{
  return (unsigned int)(2 * a1);
}


/* Function: init_order_test @ 0x17F8 */
__int64 init_order_test()
{
  return 20;
}


/* Function: test_static_global @ 0x1800 */
__int64 test_static_global()
{
  int v0; // w0
  int v1; // w0
  int const_data; // w0
  int v3; // w0
  int v4; // w0
  int v5; // w0

  puts(asc_20BA);
  v0 = global_var_access();
  __printf_chk(1, "STM-L1-01 (global_var_access): %d\n", v0);
  __printf_chk(1, "STM-L1-01 (global_var_read): %d\n", 2 * global_counter);
  __printf_chk(1, "STM-L1-02 (global_array_access): %d\n", 5);
  counter_1 = 1;
  __printf_chk(1, "STM-L1-03 (static_local): %d\n", 1);
  __printf_chk(1, "STM-L1-03 (static_local): %d\n", ++counter_1);
  __printf_chk(1, "STM-L1-04 (call_static_func): %d\n", 11);
  __printf_chk(1, "STM-L2-01 (access_extern_global): %d\n", extern_global_var + 100);
  v1 = call_extern_func();
  __printf_chk(1, "STM-L2-02 (call_extern_func): %d\n", v1);
  const_data = read_const_data();
  __printf_chk(1, "STM-L2-03 (read_const_data): %d\n", const_data);
  __printf_chk(1, "STM-L2-04 (access_bss_var): %d\n", 0);
  __printf_chk(1, "STM-L2-04 (access_bss_buffer): %d\n", 0);
  v3 = global_struct_access();
  __printf_chk(1, "STM-L2-05 (global_struct_access): %d\n", v3);
  file_scope_static = 50;
  __printf_chk(1, "STM-L2-06 (file_static): %d\n", 50);
  global_func_ptr = (__int64 (*)(void))double_value;
  v4 = call_global_callback();
  __printf_chk(1, "STM-L2-07 (global_func_ptr): %d\n", v4);
  __printf_chk(1, "STM-L2-08 (global_heap_store): %d\n", 100);
  v5 = static_complex_init();
  __printf_chk(1, "STM-L2-09 (static_complex_init): %d\n", v5);
  __printf_chk(1, "STM-L3-01 (tls_access): %d\n", 20);
  return __printf_chk(1, "STM-L3-02 (init_order_test): %d\n", 20);
}


/* Function: memop_memset @ 0x19E8 */
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


/* Function: memop_memcpy @ 0x1A2C */
__int64 __fastcall memop_memcpy(char *a1, const void *a2, size_t a3)
{
  bool v3; // zf
  char *v4; // x19

  if ( a1 )
    v3 = a2 == 0;
  else
    v3 = 1;
  if ( v3 )
    return 0xFFFFFFFFLL;
  if ( !a3 )
    return 0xFFFFFFFFLL;
  v4 = &a1[a3 & 0xFFFFFFFFFFFFFFFCLL];
  memcpy(a1, a2, a3);
  return *((unsigned int *)v4 - 1);
}


/* Function: memop_memmove @ 0x1A7C */
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


/* Function: memop_memcmp @ 0x1AC0 */
__int64 __fastcall memop_memcmp(const void *a1, const void *a2, size_t a3)
{
  bool v3; // zf
  int v4; // w0
  bool v5; // cc
  __int64 result; // x0

  if ( a1 )
    v3 = a2 == 0;
  else
    v3 = 1;
  if ( v3 || !a3 )
    return 0;
  v4 = memcmp(a1, a2, a3);
  v5 = v4 <= 0;
  if ( v4 )
    LODWORD(result) = -1;
  else
    LODWORD(result) = 0;
  if ( v5 )
    return (unsigned int)result;
  else
    return 1;
}


/* Function: memop_bzero @ 0x1AF8 */
__int64 __fastcall memop_bzero(unsigned __int8 *a1, size_t n)
{
  if ( !a1 )
    return 0xFFFFFFFFLL;
  memset(a1, 0, n);
  return *a1;
}


/* Function: memop_bcopy @ 0x1B30 */
__int64 __fastcall memop_bcopy(void *src, void *dest, size_t a3)
{
  bool v3; // zf

  if ( src )
    v3 = dest == 0;
  else
    v3 = 1;
  if ( v3 || !a3 )
    return 0xFFFFFFFFLL;
  else
    return *(unsigned __int8 *)memmove(dest, src, a3);
}


/* Function: memop_unaligned_access @ 0x1B6C */
__int64 __fastcall memop_unaligned_access(__int64 a1)
{
  if ( a1 )
    return *(unsigned int *)(a1 + 1);
  else
    return 0xFFFFFFFFLL;
}


/* Function: memop_memory_barrier @ 0x1B80 */
__int64 __fastcall memop_memory_barrier(int *a1)
{
  int v1; // w1

  if ( !a1 )
    return 0xFFFFFFFFLL;
  v1 = *a1;
  __dmb(0xBu);
  return (unsigned int)(*a1 + v1);
}


/* Function: test_memory_op_functions @ 0x1BA0 */
void *test_memory_op_functions()
{
  int v0; // w0
  int v1; // w0
  unsigned int v2; // w0
  int v3; // w0
  __int64 v4; // x2
  int v5; // w0
  int v6; // w0
  int v7; // w0
  int v9; // [xsp+24h] [xbp+24h] BYREF
  __int64 s1; // [xsp+28h] [xbp+28h] BYREF
  int v11; // [xsp+30h] [xbp+30h]
  __int64 s2; // [xsp+38h] [xbp+38h] BYREF
  int v13; // [xsp+40h] [xbp+40h]
  _QWORD v14[2]; // [xsp+48h] [xbp+48h] BYREF
  int v15; // [xsp+58h] [xbp+58h]
  _QWORD v16[2]; // [xsp+60h] [xbp+60h] BYREF
  int v17; // [xsp+70h] [xbp+70h]
  int v18; // [xsp+78h] [xbp+78h] BYREF
  int dest; // [xsp+80h] [xbp+80h] BYREF
  unsigned __int8 v20[16]; // [xsp+88h] [xbp+88h] BYREF
  char src[16]; // [xsp+98h] [xbp+98h] BYREF
  unsigned __int8 v22[256]; // [xsp+A8h] [xbp+A8h] BYREF

  puts(asc_231C);
  v16[0] = 0;
  v16[1] = 0;
  v17 = 0;
  v14[0] = 0x140000000ALL;
  v14[1] = 0x280000001ELL;
  v15 = 50;
  v0 = memop_memset(v22, 0xAu, 65);
  __printf_chk(1, "MEMOP-L2-01: %d\n", v0);
  v1 = memop_memcpy((char *)v16, v14, 0x14u);
  __printf_chk(1, "MEMOP-L2-02: %d\n", v1);
  strcpy(src, "HelloWorld");
  v2 = memop_memmove(src, 0xAu);
  __printf_chk(1, "MEMOP-L2-03: %c\n", v2);
  s1 = 0x200000001LL;
  s2 = 0x200000001LL;
  v11 = 3;
  v13 = 4;
  v3 = memcmp(&s1, &s2, 0xCu);
  if ( v3 )
    LODWORD(v4) = -1;
  else
    LODWORD(v4) = 0;
  if ( v3 > 0 )
    v4 = 1;
  else
    v4 = (unsigned int)v4;
  __printf_chk(1, "MEMOP-L2-04: %d\n", v4);
  v5 = memop_bzero(v20, 0xAu);
  __printf_chk(1, "MEMOP-L2-05: %d\n", v5);
  v18 = 67305985;
  dest = 0;
  v6 = memop_bcopy(&v18, &dest, 4u);
  __printf_chk(1, "MEMOP-L2-06: %d\n", v6);
  __printf_chk(1, "MEMOP-L3-01: 0x%x\n", 67305985);
  v9 = 5;
  v7 = memop_memory_barrier(&v9);
  __printf_chk(1, "MEMOP-L3-02: %d\n", v7);
  return &_stack_chk_guard;
}


/* Function: extern_function @ 0x1D78 */
__int64 __fastcall extern_function(int a1)
{
  return (unsigned int)(3 * a1);
}


/* Function: .term_proc @ 0x1D80 */
void term_proc()
{
  ;
}


/* FAILED to decompile: memcpy @ 0x13098 */

/* FAILED to decompile: memmove @ 0x130A0 */

/* FAILED to decompile: exit @ 0x130A8 */

/* FAILED to decompile: __libc_start_main @ 0x130B0 */

/* FAILED to decompile: perror @ 0x130B8 */

/* FAILED to decompile: __cxa_finalize @ 0x130C0 */

/* FAILED to decompile: fork @ 0x130C8 */

/* FAILED to decompile: malloc @ 0x130D0 */

/* FAILED to decompile: __printf_chk @ 0x130D8 */

/* FAILED to decompile: memset @ 0x130E0 */

/* FAILED to decompile: calloc @ 0x130E8 */

/* FAILED to decompile: realloc @ 0x130F0 */

/* FAILED to decompile: __stack_chk_fail @ 0x130F8 */

/* FAILED to decompile: abort @ 0x13108 */

/* FAILED to decompile: puts @ 0x13110 */

/* FAILED to decompile: memcmp @ 0x13118 */

/* FAILED to decompile: free @ 0x13120 */

/* FAILED to decompile: waitpid @ 0x13128 */

/* FAILED to decompile: __gmon_start__ @ 0x13138 */

/* Total functions decompiled: 65, failed: 19 */
