/*
 * Decompiled by IDA Pro 9.1 with Hex-Rays
 * Binary: /Users/eren/Desktop/Antigravity/compiler/build/arm64/3/3_gcc_O1_no_g
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


/* Function: _start @ 0xB00 */
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


/* Function: call_weak_fn @ 0xB34 */
void *call_weak_fn()
{
  void *result; // x0

  result = &_gmon_start__;
  if ( &_gmon_start__ )
    return (void *)__gmon_start__();
  return result;
}


/* Function: deregister_tm_clones @ 0xB50 */
char *deregister_tm_clones()
{
  return &completed_0;
}


/* Function: register_tm_clones @ 0xB80 */
char *register_tm_clones()
{
  return &completed_0;
}


/* Function: __do_global_dtors_aux @ 0xBC0 */
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


/* Function: frame_dummy @ 0xC10 */
// attributes: thunk
char *frame_dummy()
{
  return register_tm_clones();
}


/* Function: double_value @ 0xC14 */
__int64 __fastcall double_value(int a1)
{
  return (unsigned int)(2 * a1);
}


/* Function: local_vars @ 0xC1C */
__int64 __fastcall local_vars(int a1)
{
  return (unsigned int)(2 * a1 + 10);
}


/* Function: local_array @ 0xC28 */
__int64 __fastcall local_array(int a1)
{
  __int64 *v1; // x2
  int v2; // w1
  char v4; // [xsp+10h] [xbp+10h] BYREF
  unsigned int v5; // [xsp+24h] [xbp+24h]
  __int64 v6; // [xsp+38h] [xbp+38h] BYREF

  v1 = (__int64 *)&v4;
  v2 = 0;
  do
  {
    *(_DWORD *)v1 = v2;
    v1 = (__int64 *)((char *)v1 + 4);
    v2 += a1;
  }
  while ( v1 != &v6 );
  return v5;
}


/* Function: local_struct @ 0xC8C */
__int64 __fastcall local_struct(int a1)
{
  return (unsigned int)(3 * a1);
}


/* Function: address_of_local @ 0xC94 */
__int64 __fastcall address_of_local(_DWORD *a1)
{
  __int64 result; // x0

  result = 42;
  *a1 = 42;
  return result;
}


/* Function: address_of_array @ 0xCA4 */
__int64 __fastcall address_of_array(_DWORD *a1)
{
  return (unsigned int)(2 * *a1);
}


/* Function: large_stack_frame @ 0xCB0 */
__int64 large_stack_frame()
{
  _BYTE *v0; // x1
  int i; // w0
  _BYTE v3[2048]; // [xsp+18h] [xbp+18h] BYREF

  v0 = v3;
  for ( i = 0; i != 2048; ++i )
    *v0++ = i;
  return v3[1024];
}


/* Function: vla_stack @ 0xD18 */
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
  return *((unsigned int *)&v6[2] + a1 / 2);
}


/* Function: alloca_usage @ 0xDE0 */
__int64 __fastcall alloca_usage(int a1)
{
  __int64 v1; // x1
  unsigned __int16 v2; // w2
  _QWORD *v3; // x1
  __int64 *v4; // x2
  int v5; // w1
  _QWORD v7[2]; // [xsp+FC00h] [xbp-10h] BYREF
  __int64 v8; // [xsp+FC10h] [xbp+0h] BYREF

  if ( a1 <= 0 )
    return 0xFFFFFFFFLL;
  v1 = 4LL * a1 + 15;
  v2 = v1 & 0xFFF0;
  v3 = (_QWORD *)((char *)v7 - (v1 & 0xFFFFFFFFFFFF0000LL));
  while ( v7 != v3 )
    ;
  v7[0] = 0;
  if ( v2 >= 0x400uLL )
    STACK[0x10000] = 0;
  v4 = &v8;
  v5 = 0;
  do
  {
    *(_DWORD *)v4 = v5;
    v4 = (__int64 *)((char *)v4 + 4);
    v5 += 3;
  }
  while ( v5 != 3 * a1 );
  return *((unsigned int *)&v8 + a1 / 2);
}


/* Function: stack_alias @ 0xEA8 */
__int64 stack_alias()
{
  return 20;
}


/* Function: test_stack_memory @ 0xEB0 */
__int64 test_stack_memory()
{
  int v0; // w0
  int v1; // w0
  int v2; // w0
  int v3; // w0

  puts(asc_1E38);
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


/* Function: heap_basic @ 0xF9C */
__int64 __fastcall heap_basic(int a1)
{
  _DWORD *v2; // x0
  __int64 v3; // x1
  unsigned int v4; // w19

  v2 = malloc(4LL * a1);
  if ( v2 )
  {
    if ( a1 > 0 )
    {
      v3 = 0;
      do
      {
        v2[v3] = 2 * v3;
        ++v3;
      }
      while ( a1 > (int)v3 );
    }
    v4 = v2[a1 / 2];
    free(v2);
  }
  else
  {
    return (unsigned int)-1;
  }
  return v4;
}


/* Function: heap_calloc @ 0x1000 */
__int64 __fastcall heap_calloc(int a1)
{
  _DWORD *v2; // x0
  __int64 v3; // x1
  unsigned int v4; // w19

  v2 = calloc(a1, 4u);
  if ( v2 )
  {
    if ( a1 <= 0 )
    {
      v4 = 0;
    }
    else
    {
      v3 = 0;
      v4 = 0;
      do
        v4 += v2[v3++];
      while ( a1 > (int)v3 );
    }
    free(v2);
  }
  else
  {
    return (unsigned int)-1;
  }
  return v4;
}


/* Function: heap_realloc @ 0x1068 */
__int64 heap_realloc()
{
  _DWORD *v0; // x0
  void *v1; // x19
  _DWORD *v2; // x0
  unsigned int v3; // w19

  v0 = malloc(0x14u);
  if ( v0 )
  {
    v1 = v0;
    *v0 = 1;
    v0[1] = 2;
    v0[2] = 3;
    v0[3] = 4;
    v0[4] = 5;
    v2 = realloc(v0, 0x28u);
    if ( v2 )
    {
      v2[5] = 50;
      v2[6] = 60;
      v2[7] = 70;
      v2[8] = 80;
      v2[9] = 90;
      v3 = -3;
      if ( v2[2] == 3 )
        v3 = v2[5];
      free(v2);
    }
    else
    {
      free(v1);
      return (unsigned int)-2;
    }
  }
  else
  {
    return (unsigned int)-1;
  }
  return v3;
}


/* Function: heap_array @ 0x1128 */
__int64 __fastcall heap_array(int a1)
{
  _DWORD *v2; // x0
  _DWORD *v3; // x2
  int v4; // w1
  unsigned int v5; // w19

  v2 = malloc(4LL * a1);
  if ( v2 )
  {
    if ( a1 > 0 )
    {
      v3 = v2;
      v4 = 0;
      do
      {
        *v3++ = v4;
        v4 += 3;
      }
      while ( v4 != 3 * a1 );
    }
    v5 = v2[a1 / 2];
    free(v2);
  }
  else
  {
    return (unsigned int)-1;
  }
  return v5;
}


/* Function: heap_struct @ 0x1190 */
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


/* Function: heap_nested @ 0x11CC */
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


/* Function: linked_list_heap @ 0x123C */
__int64 linked_list_heap()
{
  int v0; // w20
  _QWORD *v1; // x0
  _QWORD *v2; // x19
  void *v3; // x0
  unsigned int v4; // w20
  _QWORD *v5; // x21
  _QWORD *v6; // x0
  void *v7; // x0

  v0 = 0;
  v1 = 0;
  v2 = 0;
  while ( 1 )
  {
    v5 = v1;
    v1 = malloc(0x10u);
    if ( !v1 )
      break;
    *(_DWORD *)v1 = v0;
    v1[1] = 0;
    if ( v2 )
      v5[1] = v1;
    else
      v2 = v1;
    v0 += 10;
    if ( v0 == 50 )
    {
      v6 = v2;
      v4 = 0;
      do
      {
        v4 += *(_DWORD *)v6;
        v6 = (_QWORD *)v6[1];
      }
      while ( v6 );
      do
      {
        v7 = v2;
        v2 = (_QWORD *)v2[1];
        free(v7);
      }
      while ( v2 );
      return v4;
    }
  }
  if ( v2 )
  {
    do
    {
      v3 = v2;
      v2 = (_QWORD *)v2[1];
      free(v3);
    }
    while ( v2 );
    return (unsigned int)-1;
  }
  else
  {
    return (unsigned int)-1;
  }
}


/* Function: create_tree_node @ 0x1300 */
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


/* Function: tree_heap_traversal @ 0x1334 */
__int64 tree_heap_traversal()
{
  _QWORD *tree_node; // x0
  _DWORD *v1; // x19
  _QWORD *v2; // x1
  _DWORD *v3; // x0
  bool v4; // zf
  unsigned int v5; // w20
  void *v7; // x0

  tree_node = create_tree_node(10);
  if ( tree_node )
  {
    v1 = tree_node;
    tree_node[1] = create_tree_node(20);
    v2 = create_tree_node(30);
    *((_QWORD *)v1 + 2) = v2;
    v3 = (_DWORD *)*((_QWORD *)v1 + 1);
    if ( v2 )
      v4 = v3 == 0;
    else
      v4 = 1;
    if ( v4 )
    {
      if ( v3 )
        free(v3);
      v7 = (void *)*((_QWORD *)v1 + 2);
      if ( v7 )
        free(v7);
      free(v1);
      return (unsigned int)-2;
    }
    else
    {
      v5 = *v1 + *v3 + *(_DWORD *)v2;
      free(v3);
      free(*((void **)v1 + 2));
      free(v1);
    }
  }
  else
  {
    return (unsigned int)-1;
  }
  return v5;
}


/* Function: memory_leak @ 0x13E0 */
__int64 __fastcall memory_leak(int a1)
{
  _DWORD *v2; // x0
  __int64 v3; // x1

  v2 = malloc(4LL * a1);
  if ( !v2 )
    return 0xFFFFFFFFLL;
  if ( a1 > 0 )
  {
    v3 = 0;
    do
    {
      v2[v3] = v3;
      ++v3;
    }
    while ( a1 > (int)v3 );
  }
  return (unsigned int)v2[a1 / 2];
}


/* Function: dangling_pointer @ 0x1438 */
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


/* Function: double_free @ 0x1488 */
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


/* Function: heap_overflow @ 0x14D4 */
__int64 heap_overflow()
{
  _DWORD *v0; // x0
  _DWORD *v1; // x2
  int i; // w1
  unsigned int v3; // w19

  v0 = malloc(0x28u);
  if ( v0 )
  {
    v1 = v0;
    for ( i = 0; i != 1100; i += 100 )
      *v1++ = i;
    v3 = *v0;
    free(v0);
  }
  else
  {
    return (unsigned int)-1;
  }
  return v3;
}


/* Function: test_heap_memory @ 0x1524 */
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
  int stat_loc; // [xsp+1Ch] [xbp+1Ch] BYREF
  void *ptr; // [xsp+20h] [xbp+20h] BYREF

  puts(asc_1FA8);
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
    free(*((void **)ptr + 1));
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
    if ( (stat_loc & 0x7F) != 0 )
    {
      if ( ((stat_loc & 0x7F) + 1) << 24 >> 25 > 0 )
        __printf_chk(1, byte_2150, stat_loc & 0x7F);
    }
    else
    {
      __printf_chk(1, byte_2128, BYTE1(stat_loc));
    }
  }
  return &_stack_chk_guard;
}


/* Function: global_var_access @ 0x1724 */
__int64 global_var_access()
{
  return (unsigned int)++global_counter;
}


/* Function: global_var_read @ 0x1738 */
__int64 global_var_read()
{
  return (unsigned int)(2 * global_counter);
}


/* Function: global_array_access @ 0x1748 */
__int64 __fastcall global_array_access(unsigned int a1)
{
  if ( a1 > 9 )
    return 0xFFFFFFFFLL;
  else
    return global_array[a1];
}


/* Function: static_local @ 0x1768 */
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


/* Function: call_static_func @ 0x178C */
__int64 __fastcall call_static_func(int a1)
{
  return (unsigned int)(2 * a1 + 1);
}


/* Function: access_extern_global @ 0x1798 */
__int64 access_extern_global()
{
  return (unsigned int)(extern_global_var + 100);
}


/* Function: call_extern_func @ 0x17AC */
__int64 call_extern_func()
{
  return extern_function(5);
}


/* Function: read_const_data @ 0x17C4 */
__int64 read_const_data()
{
  return (unsigned int)(unsigned __int8)const_string[4] + 42;
}


/* Function: access_bss_var @ 0x17D8 */
__int64 access_bss_var()
{
  return 0;
}


/* Function: access_bss_buffer @ 0x17E0 */
__int64 access_bss_buffer()
{
  return 0;
}


/* Function: global_struct_access @ 0x17E8 */
__int64 global_struct_access()
{
  return 30;
}


/* Function: set_file_static @ 0x17F0 */
__int64 __fastcall set_file_static(__int64 result)
{
  file_scope_static = result;
  return result;
}


/* Function: get_file_static @ 0x17FC */
__int64 get_file_static()
{
  return (unsigned int)file_scope_static;
}


/* Function: set_global_callback @ 0x1808 */
void *__fastcall set_global_callback(void *result)
{
  global_func_ptr = result;
  return result;
}


/* Function: call_global_callback @ 0x1814 */
__int64 call_global_callback()
{
  if ( global_func_ptr )
    return global_func_ptr();
  else
    return 0xFFFFFFFFLL;
}


/* Function: global_heap_store @ 0x183C */
__int64 __fastcall global_heap_store(unsigned int *a1)
{
  if ( a1 )
    return *a1;
  else
    return 0xFFFFFFFFLL;
}


/* Function: static_complex_init @ 0x1850 */
__int64 static_complex_init()
{
  return 15;
}


/* Function: tls_access @ 0x1858 */
__int64 __fastcall tls_access(int a1)
{
  return (unsigned int)(2 * a1);
}


/* Function: init_order_test @ 0x1860 */
__int64 init_order_test()
{
  __int64 result; // x0

  result = 20;
  static_depends_0 = 20;
  return result;
}


/* Function: test_static_global @ 0x1870 */
__int64 test_static_global()
{
  int v0; // w0
  int v1; // w0
  int const_data; // w0
  int v3; // w0
  int v4; // w0
  int v5; // w0
  int inited; // w0

  puts(asc_21A8);
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
  inited = init_order_test();
  return __printf_chk(1, "STM-L3-02 (init_order_test): %d\n", inited);
}


/* Function: memop_memset @ 0x1A60 */
__int64 __fastcall memop_memset(unsigned __int8 *s, size_t n, int c)
{
  bool v4; // zf

  if ( s )
    v4 = n == 0;
  else
    v4 = 1;
  if ( v4 )
    return 0xFFFFFFFFLL;
  memset(s, c, n);
  return *s;
}


/* Function: memop_memcpy @ 0x1AA8 */
__int64 __fastcall memop_memcpy(char *a1, const void *a2, size_t a3)
{
  bool v3; // zf

  if ( a2 )
    v3 = a3 == 0;
  else
    v3 = 1;
  if ( v3 || a1 == 0 )
    return 0xFFFFFFFFLL;
  memcpy(a1, a2, a3);
  return *(unsigned int *)&a1[(a3 & 0xFFFFFFFFFFFFFFFCLL) - 4];
}


/* Function: memop_memmove @ 0x1AF0 */
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


/* Function: memop_memcmp @ 0x1B34 */
__int64 __fastcall memop_memcmp(const void *a1, const void *a2, size_t a3)
{
  bool v3; // zf
  int v6; // w0

  if ( a2 )
    v3 = a3 == 0;
  else
    v3 = 1;
  if ( v3 || a1 == 0 )
    return 0;
  v6 = memcmp(a1, a2, a3);
  if ( v6 > 0 )
    return 1;
  else
    return (unsigned int)(v6 >> 31);
}


/* Function: memop_bzero @ 0x1B6C */
__int64 __fastcall memop_bzero(unsigned __int8 *a1, size_t n)
{
  if ( !a1 )
    return 0xFFFFFFFFLL;
  memset(a1, 0, n);
  return *a1;
}


/* Function: memop_bcopy @ 0x1BA4 */
__int64 __fastcall memop_bcopy(void *src, unsigned __int8 *dest, size_t a3)
{
  bool v3; // zf

  if ( dest )
    v3 = a3 == 0;
  else
    v3 = 1;
  if ( v3 || src == 0 )
    return 0xFFFFFFFFLL;
  memmove(dest, src, a3);
  return *dest;
}


/* Function: memop_unaligned_access @ 0x1BE8 */
__int64 __fastcall memop_unaligned_access(__int64 a1)
{
  if ( a1 )
    return *(unsigned int *)(a1 + 1);
  else
    return 0xFFFFFFFFLL;
}


/* Function: memop_memory_barrier @ 0x1BFC */
__int64 __fastcall memop_memory_barrier(int *a1)
{
  int v1; // w1

  if ( !a1 )
    return 0xFFFFFFFFLL;
  v1 = *a1;
  __dmb(0xBu);
  return (unsigned int)(*a1 + v1);
}


/* Function: test_memory_op_functions @ 0x1C1C */
void *test_memory_op_functions()
{
  int v0; // w0
  int v1; // w0
  unsigned int v2; // w0
  int v3; // w0
  int v4; // w0
  int v5; // w0
  int v6; // w0
  int v8; // [xsp+24h] [xbp+24h] BYREF
  _DWORD v9[4]; // [xsp+28h] [xbp+28h] BYREF
  _DWORD v10[4]; // [xsp+38h] [xbp+38h] BYREF
  _QWORD v11[2]; // [xsp+48h] [xbp+48h] BYREF
  int v12; // [xsp+58h] [xbp+58h]
  _QWORD v13[2]; // [xsp+60h] [xbp+60h] BYREF
  int v14; // [xsp+70h] [xbp+70h]
  int v15; // [xsp+78h] [xbp+78h] BYREF
  unsigned __int8 dest[8]; // [xsp+80h] [xbp+80h] BYREF
  unsigned __int8 v17[16]; // [xsp+88h] [xbp+88h] BYREF
  char src[16]; // [xsp+98h] [xbp+98h] BYREF
  unsigned __int8 s[256]; // [xsp+A8h] [xbp+A8h] BYREF

  puts(asc_2458);
  v11[0] = 0x140000000ALL;
  v11[1] = 0x280000001ELL;
  v12 = 50;
  v13[0] = 0;
  v13[1] = 0;
  v14 = 0;
  v0 = memop_memset(s, 0xAu, 65);
  __printf_chk(1, "MEMOP-L2-01: %d\n", v0);
  v1 = memop_memcpy((char *)v13, v11, 0x14u);
  __printf_chk(1, "MEMOP-L2-02: %d\n", v1);
  strcpy(src, "HelloWorld");
  v2 = memop_memmove(src, 0xAu);
  __printf_chk(1, "MEMOP-L2-03: %c\n", v2);
  v9[0] = 1;
  v9[1] = 2;
  v9[2] = 3;
  v10[0] = 1;
  v10[1] = 2;
  v10[2] = 4;
  v3 = memop_memcmp(v9, v10, 0xCu);
  __printf_chk(1, "MEMOP-L2-04: %d\n", v3);
  v4 = memop_bzero(v17, 0xAu);
  __printf_chk(1, "MEMOP-L2-05: %d\n", v4);
  v15 = 67305985;
  *(_DWORD *)dest = 0;
  v5 = memop_bcopy(&v15, dest, 4u);
  __printf_chk(1, "MEMOP-L2-06: %d\n", v5);
  __printf_chk(1, "MEMOP-L3-01: 0x%x\n", 67305985);
  v8 = 5;
  v6 = memop_memory_barrier(&v8);
  __printf_chk(1, "MEMOP-L3-02: %d\n", v6);
  return &_stack_chk_guard;
}


/* Function: main @ 0x1DF0 */
int __fastcall main(int argc, const char **argv, const char **envp)
{
  test_stack_memory();
  test_heap_memory();
  test_static_global();
  test_memory_op_functions();
  return 0;
}


/* Function: extern_function @ 0x1E14 */
__int64 __fastcall extern_function(int a1)
{
  return (unsigned int)(3 * a1);
}


/* Function: .term_proc @ 0x1E1C */
void term_proc()
{
  ;
}


/* FAILED to decompile: memcpy @ 0x140A0 */

/* FAILED to decompile: memmove @ 0x140A8 */

/* FAILED to decompile: exit @ 0x140B0 */

/* FAILED to decompile: __libc_start_main @ 0x140B8 */

/* FAILED to decompile: perror @ 0x140C0 */

/* FAILED to decompile: __cxa_finalize @ 0x140C8 */

/* FAILED to decompile: fork @ 0x140D0 */

/* FAILED to decompile: malloc @ 0x140D8 */

/* FAILED to decompile: __printf_chk @ 0x140E0 */

/* FAILED to decompile: memset @ 0x140E8 */

/* FAILED to decompile: calloc @ 0x140F0 */

/* FAILED to decompile: realloc @ 0x140F8 */

/* FAILED to decompile: __stack_chk_fail @ 0x14100 */

/* FAILED to decompile: abort @ 0x14110 */

/* FAILED to decompile: puts @ 0x14118 */

/* FAILED to decompile: memcmp @ 0x14120 */

/* FAILED to decompile: free @ 0x14128 */

/* FAILED to decompile: waitpid @ 0x14130 */

/* FAILED to decompile: __gmon_start__ @ 0x14140 */

/* Total functions decompiled: 65, failed: 19 */
