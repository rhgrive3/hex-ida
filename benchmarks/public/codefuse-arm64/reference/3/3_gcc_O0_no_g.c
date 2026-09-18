/*
 * Decompiled by IDA Pro 9.1 with Hex-Rays
 * Binary: /Users/eren/Desktop/Antigravity/compiler/build/arm64/3/3_gcc_O0_no_g
 * Processor: arm
 */

/* Function: .init_proc @ 0x9C0 */
__int64 init_proc()
{
  return call_weak_fn();
}


/* Function: sub_9E0 @ 0x9E0 */
void sub_9E0()
{
  JUMPOUT(0);
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


/* Function: local_vars @ 0xC6C */
__int64 __fastcall local_vars(int a1)
{
  return (unsigned int)(2 * a1 + 10);
}


/* Function: local_array @ 0xCA0 */
__int64 __fastcall local_array(int a1)
{
  int i; // [xsp+2Ch] [xbp+2Ch]
  _DWORD v3[10]; // [xsp+30h] [xbp+30h]

  for ( i = 0; i <= 9; ++i )
    v3[i] = i * a1;
  return v3[5];
}


/* Function: local_struct @ 0xD30 */
__int64 __fastcall local_struct(int a1)
{
  return (unsigned int)(3 * a1);
}


/* Function: address_of_local @ 0xD60 */
__int64 __fastcall address_of_local(_DWORD *a1)
{
  *a1 = 42;
  return 42;
}


/* Function: address_of_array @ 0xD88 */
__int64 __fastcall address_of_array(_DWORD *a1)
{
  return (unsigned int)(2 * *a1);
}


/* Function: large_stack_frame @ 0xDBC */
__int64 large_stack_frame()
{
  int i; // [xsp+14h] [xbp+14h]
  _BYTE v2[2048]; // [xsp+18h] [xbp+18h]

  for ( i = 0; i <= 2047; ++i )
    v2[i] = i;
  return v2[1024];
}


/* Function: vla_stack @ 0xE48 */
__int64 __fastcall vla_stack(int a1)
{
  __int64 result; // x0
  _QWORD v2[2]; // [xsp+FC00h] [xbp-10h] BYREF
  __int64 v3; // [xsp+FC10h] [xbp+0h] BYREF
  int v4; // [xsp+FC2Ch] [xbp+1Ch]
  int i; // [xsp+FC34h] [xbp+24h]
  __int64 v6; // [xsp+FC38h] [xbp+28h]
  __int64 *v7; // [xsp+FC40h] [xbp+30h]

  v4 = a1;
  if ( a1 > 0 && v4 <= 1000 )
  {
    v6 = v4 - 1LL;
    while ( v2 != (_QWORD *)((char *)v2 - ((16 * ((unsigned __int64)(4LL * v4 + 15) >> 4)) & 0xFFFFFFFFFFFF0000LL)) )
      ;
    v2[0] = 0;
    if ( (unsigned __int16)(16 * ((unsigned __int64)(4LL * v4 + 15) >> 4)) >= 0x400uLL )
      STACK[0x10000] = 0;
    v7 = &v3;
    for ( i = 0; i < v4; ++i )
      *((_DWORD *)v7 + i) = 2 * i;
    LODWORD(result) = *((_DWORD *)v7 + v4 / 2);
  }
  else
  {
    LODWORD(result) = -1;
  }
  return (unsigned int)result;
}


/* Function: alloca_usage @ 0xFCC */
__int64 __fastcall alloca_usage(int a1)
{
  __int64 result; // x0
  _QWORD v2[2]; // [xsp+FC00h] [xbp-10h] BYREF
  __int64 v3; // [xsp+FC10h] [xbp+0h] BYREF
  int v4; // [xsp+FC2Ch] [xbp+1Ch]
  int i; // [xsp+FC3Ch] [xbp+2Ch]
  __int64 *v6; // [xsp+FC40h] [xbp+30h]

  v4 = a1;
  if ( a1 > 0 )
  {
    while ( v2 != (_QWORD *)((char *)v2 - ((16 * ((unsigned __int64)(4LL * v4 + 15) >> 4)) & 0xFFFFFFFFFFFF0000LL)) )
      ;
    v2[0] = 0;
    if ( (unsigned __int16)(16 * ((unsigned __int64)(4LL * v4 + 15) >> 4)) >= 0x400uLL )
      STACK[0x10000] = 0;
    v6 = &v3;
    for ( i = 0; i < v4; ++i )
      *((_DWORD *)v6 + i) = 3 * i;
    LODWORD(result) = *((_DWORD *)v6 + v4 / 2);
  }
  else
  {
    LODWORD(result) = -1;
  }
  return (unsigned int)result;
}


/* Function: stack_alias @ 0x1104 */
__int64 stack_alias()
{
  __int64 result; // x0
  int v1; // [xsp+24h] [xbp+24h] BYREF

  v1 = 10;
  if ( &v1 )
  {
    v1 = 20;
    LODWORD(result) = 20;
  }
  else
  {
    LODWORD(result) = -1;
  }
  return (unsigned int)result;
}


/* Function: test_stack_memory @ 0x11A8 */
void *test_stack_memory()
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
  _DWORD v10[2]; // [xsp+18h] [xbp+18h] BYREF
  _QWORD v11[5]; // [xsp+20h] [xbp+20h] BYREF

  puts(asc_28F8);
  v0 = local_vars(5);
  printf("MEM-L1-01 (local_vars): %d\n", v0);
  v1 = local_array(2);
  printf("MEM-L1-02 (local_array): %d\n", v1);
  v2 = local_struct(5);
  printf("MEM-L1-03 (local_struct): %d\n", v2);
  v3 = address_of_local(v10);
  printf("MEM-L1-04 (address_of_local): %d\n", v3);
  memset(&v11[2], 0, 24);
  v11[0] = 0x200000001LL;
  v11[1] = 3;
  v4 = address_of_array(v11);
  printf("MEM-L1-05 (address_of_array): %d\n", v4);
  v5 = large_stack_frame();
  printf("MEM-L2-01 (large_stack_frame): %d\n", v5);
  v6 = vla_stack(10);
  printf("MEM-L2-02 (vla_stack): %d\n", v6);
  v7 = alloca_usage(10);
  printf("MEM-L2-03 (alloca_usage): %d\n", v7);
  v10[1] = 0;
  v8 = stack_alias();
  printf("MEM-L2-04 (stack_alias): %d\n", v8);
  return &_stack_chk_guard;
}


/* Function: heap_basic @ 0x12FC */
__int64 __fastcall heap_basic(int a1)
{
  int i; // [xsp+20h] [xbp+20h]
  unsigned int v4; // [xsp+24h] [xbp+24h]
  _DWORD *ptr; // [xsp+28h] [xbp+28h]

  ptr = malloc(4LL * a1);
  if ( !ptr )
    return 0xFFFFFFFFLL;
  for ( i = 0; i < a1; ++i )
    ptr[i] = 2 * i;
  v4 = ptr[a1 / 2];
  free(ptr);
  return v4;
}


/* Function: heap_calloc @ 0x13A8 */
__int64 __fastcall heap_calloc(int a1)
{
  unsigned int nmemb_4; // [xsp+20h] [xbp+20h]
  int i; // [xsp+24h] [xbp+24h]
  _DWORD *ptr; // [xsp+28h] [xbp+28h]

  ptr = calloc(a1, 4u);
  if ( !ptr )
    return 0xFFFFFFFFLL;
  nmemb_4 = 0;
  for ( i = 0; i < a1; ++i )
    nmemb_4 += ptr[i];
  free(ptr);
  return nmemb_4;
}


/* Function: heap_realloc @ 0x1434 */
__int64 heap_realloc()
{
  int v1; // w0
  int i; // [xsp+10h] [xbp+10h]
  int j; // [xsp+14h] [xbp+14h]
  int v4; // [xsp+18h] [xbp+18h]
  unsigned int v5; // [xsp+1Ch] [xbp+1Ch]
  _DWORD *ptr; // [xsp+20h] [xbp+20h]
  _DWORD *v7; // [xsp+28h] [xbp+28h]

  ptr = malloc(0x14u);
  if ( !ptr )
    return 0xFFFFFFFFLL;
  for ( i = 0; i <= 4; ++i )
    ptr[i] = i + 1;
  v4 = ptr[2];
  v7 = realloc(ptr, 0x28u);
  if ( v7 )
  {
    for ( j = 5; j <= 9; ++j )
      v7[j] = 10 * j;
    if ( v4 == v7[2] )
      v1 = v7[5];
    else
      v1 = -3;
    v5 = v1;
    free(v7);
    return v5;
  }
  else
  {
    free(ptr);
    return 4294967294LL;
  }
}


/* Function: heap_array @ 0x1564 */
__int64 __fastcall heap_array(int a1)
{
  int i; // [xsp+20h] [xbp+20h]
  unsigned int v4; // [xsp+24h] [xbp+24h]
  _DWORD *ptr; // [xsp+28h] [xbp+28h]

  ptr = malloc(4LL * a1);
  if ( !ptr )
    return 0xFFFFFFFFLL;
  for ( i = 0; i < a1; ++i )
    ptr[i] = 3 * i;
  v4 = ptr[a1 / 2];
  free(ptr);
  return v4;
}


/* Function: heap_struct @ 0x1618 */
__int64 __fastcall heap_struct(int a1)
{
  unsigned int v3; // [xsp+24h] [xbp+24h]
  _DWORD *ptr; // [xsp+28h] [xbp+28h]

  ptr = malloc(8u);
  if ( !ptr )
    return 0xFFFFFFFFLL;
  *ptr = a1;
  ptr[1] = 2 * a1;
  v3 = *ptr + ptr[1];
  free(ptr);
  return v3;
}


/* Function: heap_nested @ 0x168C */
__int64 __fastcall heap_nested(void **a1)
{
  _QWORD *v2; // x19

  *a1 = malloc(0x10u);
  if ( !*a1 )
    return 0xFFFFFFFFLL;
  *(_DWORD *)*a1 = 10;
  v2 = *a1;
  v2[1] = malloc(0x10u);
  if ( *((_QWORD *)*a1 + 1) )
  {
    **((_DWORD **)*a1 + 1) = 20;
    *(_QWORD *)(*((_QWORD *)*a1 + 1) + 8LL) = 0;
    return 0;
  }
  else
  {
    free(*a1);
    return 4294967294LL;
  }
}


/* Function: linked_list_heap @ 0x1748 */
__int64 linked_list_heap()
{
  int i; // [xsp+18h] [xbp+18h]
  unsigned int v2; // [xsp+1Ch] [xbp+1Ch]
  _QWORD *v3; // [xsp+20h] [xbp+20h]
  _QWORD *v4; // [xsp+28h] [xbp+28h]
  _QWORD *j; // [xsp+30h] [xbp+30h]
  void *v6; // [xsp+38h] [xbp+38h]
  _QWORD *v7; // [xsp+40h] [xbp+40h]
  void *ptr; // [xsp+48h] [xbp+48h]

  v3 = 0;
  v4 = 0;
  for ( i = 0; ; ++i )
  {
    if ( i > 4 )
    {
      v2 = 0;
      for ( j = v3; j; j = (_QWORD *)j[1] )
        v2 += *(_DWORD *)j;
      while ( v3 )
      {
        v6 = v3;
        v3 = (_QWORD *)v3[1];
        free(v6);
      }
      return v2;
    }
    v7 = malloc(0x10u);
    if ( !v7 )
      break;
    *(_DWORD *)v7 = 10 * i;
    v7[1] = 0;
    if ( v3 )
      v4[1] = v7;
    else
      v3 = v7;
    v4 = v7;
  }
  while ( v3 )
  {
    ptr = v3;
    v3 = (_QWORD *)v3[1];
    free(ptr);
  }
  return 0xFFFFFFFFLL;
}


/* Function: create_tree_node @ 0x1894 */
_QWORD *__fastcall create_tree_node(int a1)
{
  _QWORD *v3; // [xsp+28h] [xbp+28h]

  v3 = malloc(0x18u);
  if ( v3 )
  {
    *(_DWORD *)v3 = a1;
    v3[1] = 0;
    v3[2] = 0;
  }
  return v3;
}


/* Function: tree_heap_traversal @ 0x18E0 */
__int64 tree_heap_traversal()
{
  unsigned int v1; // [xsp+14h] [xbp+14h]
  void **ptr; // [xsp+18h] [xbp+18h]

  ptr = (void **)create_tree_node(10);
  if ( !ptr )
    return 0xFFFFFFFFLL;
  ptr[1] = create_tree_node(20);
  ptr[2] = create_tree_node(30);
  if ( ptr[1] && ptr[2] )
  {
    v1 = *(_DWORD *)ptr + *(_DWORD *)ptr[1] + *(_DWORD *)ptr[2];
    free(ptr[1]);
    free(ptr[2]);
    free(ptr);
    return v1;
  }
  else
  {
    if ( ptr[1] )
      free(ptr[1]);
    if ( ptr[2] )
      free(ptr[2]);
    free(ptr);
    return 4294967294LL;
  }
}


/* Function: memory_leak @ 0x19F0 */
__int64 __fastcall memory_leak(int a1)
{
  int i; // [xsp+24h] [xbp+24h]
  _DWORD *v4; // [xsp+28h] [xbp+28h]

  v4 = malloc(4LL * a1);
  if ( !v4 )
    return 0xFFFFFFFFLL;
  for ( i = 0; i < a1; ++i )
    v4[i] = i;
  return (unsigned int)v4[a1 / 2];
}


/* Function: dangling_pointer @ 0x1A88 */
__int64 dangling_pointer()
{
  unsigned int *ptr; // [xsp+18h] [xbp+18h]

  ptr = (unsigned int *)malloc(4u);
  if ( !ptr )
    return 0xFFFFFFFFLL;
  *ptr = 42;
  printf("value before free: %d\n", *ptr);
  free(ptr);
  return *ptr;
}


/* Function: double_free @ 0x1AF8 */
__int64 __fastcall double_free(unsigned int *a1)
{
  _DWORD *ptr; // [xsp+28h] [xbp+28h]

  if ( a1 )
    return *a1;
  ptr = malloc(4u);
  if ( !ptr )
    return 0xFFFFFFFFLL;
  *ptr = 10;
  free(ptr);
  free(ptr);
  return 4294967294LL;
}


/* Function: heap_overflow @ 0x1B64 */
__int64 heap_overflow()
{
  int i; // [xsp+10h] [xbp+10h]
  unsigned int v2; // [xsp+14h] [xbp+14h]
  unsigned int *ptr; // [xsp+18h] [xbp+18h]

  ptr = (unsigned int *)malloc(0x28u);
  if ( !ptr )
    return 0xFFFFFFFFLL;
  for ( i = 0; i <= 10; ++i )
    ptr[i] = 100 * i;
  v2 = *ptr;
  free(ptr);
  return v2;
}


/* Function: test_heap_memory @ 0x1BEC */
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
  int stat_loc; // [xsp+14h] [xbp+14h] BYREF
  __pid_t pid; // [xsp+18h] [xbp+18h]
  unsigned int v12; // [xsp+1Ch] [xbp+1Ch]
  void *ptr; // [xsp+20h] [xbp+20h] BYREF

  puts(asc_2A68);
  v0 = heap_basic(10);
  printf("HEAP-L2-01 (heap_basic): %d\n", v0);
  v1 = heap_calloc(5);
  printf("HEAP-L2-02 (heap_calloc): %d\n", v1);
  v2 = heap_realloc();
  printf("HEAP-L2-03 (heap_realloc): %d\n", v2);
  v3 = heap_array(10);
  printf("HEAP-L2-04 (heap_array): %d\n", v3);
  v4 = heap_struct(5);
  printf("HEAP-L2-05 (heap_struct): %d\n", v4);
  ptr = 0;
  v5 = heap_nested(&ptr);
  printf("HEAP-L2-06 (heap_nested): %d\n", v5);
  if ( ptr )
  {
    free(*((void **)ptr + 1));
    free(ptr);
  }
  v6 = linked_list_heap();
  printf("HEAP-L3-01 (linked_list_heap): %d\n", v6);
  v7 = tree_heap_traversal();
  printf("HEAP-L3-02 (tree_heap_traversal): %d\n", v7);
  v8 = memory_leak(5);
  printf("HEAP-L3-03 (memory_leak): %d\n", v8);
  printf("HEAP-L3-04 (dangling_pointer): ");
  pid = fork();
  if ( !pid )
  {
    v12 = dangling_pointer();
    printf(aD, v12);
    exit(0);
  }
  if ( pid <= 0 )
  {
    perror(aFork_0);
  }
  else
  {
    waitpid(pid, &stat_loc, 0);
    if ( (stat_loc & 0x7F) != 0 )
    {
      if ( (char)((stat_loc & 0x7F) + 1) >> 1 > 0 )
        printf(byte_2C10, stat_loc & 0x7F);
    }
    else
    {
      printf(byte_2BE8, BYTE1(stat_loc));
    }
  }
  return &_stack_chk_guard;
}


/* Function: global_var_access @ 0x1E14 */
__int64 global_var_access()
{
  return (unsigned int)++global_counter;
}


/* Function: global_var_read @ 0x1E40 */
__int64 global_var_read()
{
  return (unsigned int)(2 * global_counter);
}


/* Function: global_array_access @ 0x1E54 */
__int64 __fastcall global_array_access(unsigned int a1)
{
  if ( a1 < 0xA )
    return global_array[a1];
  else
    return 0xFFFFFFFFLL;
}


/* Function: static_local @ 0x1E94 */
__int64 __fastcall static_local(int a1)
{
  if ( a1 )
  {
    counter_1 = 0;
    return 0;
  }
  else
  {
    return (unsigned int)++counter_1;
  }
}


/* Function: static_helper @ 0x1EEC */
__int64 __fastcall static_helper(int a1)
{
  return (unsigned int)(2 * a1);
}


/* Function: call_static_func @ 0x1F04 */
__int64 __fastcall call_static_func(int a1)
{
  return (unsigned int)static_helper(a1) + 1;
}


/* Function: access_extern_global @ 0x1F24 */
__int64 access_extern_global()
{
  return (unsigned int)(extern_global_var + 100);
}


/* Function: call_extern_func @ 0x1F38 */
__int64 call_extern_func()
{
  return extern_function(5);
}


/* Function: read_const_data @ 0x1F50 */
__int64 read_const_data()
{
  return (unsigned int)(unsigned __int8)const_string[4] + 42;
}


/* Function: access_bss_var @ 0x1F74 */
__int64 access_bss_var()
{
  return (unsigned int)bss_var;
}


/* Function: access_bss_buffer @ 0x1F84 */
__int64 access_bss_buffer()
{
  return (unsigned __int8)bss_buffer;
}


/* Function: global_struct_access @ 0x1F94 */
__int64 global_struct_access()
{
  return (unsigned int)(global_point + dword_1403C);
}


/* Function: set_file_static @ 0x1FB4 */
int *__fastcall set_file_static(int a1)
{
  int *result; // x0

  result = &file_scope_static;
  file_scope_static = a1;
  return result;
}


/* Function: get_file_static @ 0x1FD8 */
__int64 get_file_static()
{
  return (unsigned int)file_scope_static;
}


/* Function: set_global_callback @ 0x1FE8 */
_UNKNOWN **__fastcall set_global_callback(void *a1)
{
  _UNKNOWN **result; // x0

  result = &global_func_ptr;
  global_func_ptr = a1;
  return result;
}


/* Function: call_global_callback @ 0x200C */
__int64 __fastcall call_global_callback(unsigned int a1)
{
  if ( global_func_ptr )
    return global_func_ptr(a1);
  else
    return 0xFFFFFFFFLL;
}


/* Function: global_heap_store @ 0x2050 */
__int64 __fastcall global_heap_store(__int64 a1)
{
  global_heap_ptr = a1;
  if ( a1 )
    return *(unsigned int *)global_heap_ptr;
  else
    return 0xFFFFFFFFLL;
}


/* Function: static_complex_init @ 0x209C */
__int64 static_complex_init()
{
  return (unsigned int)(complex_init + dword_14050 + dword_14058);
}


/* Function: tls_access @ 0x20CC */
__int64 __fastcall tls_access(int a1)
{
  *(_DWORD *)(_ReadStatusReg(TPIDR_EL0) + 16) = a1;
  return (unsigned int)(2 * *(_DWORD *)(_ReadStatusReg(TPIDR_EL0) + 16));
}


/* Function: init_depends_on @ 0x2104 */
__int64 __fastcall init_depends_on(int *a1)
{
  if ( a1 )
    static_depends_0 = *a1;
  return (unsigned int)static_depends_0;
}


/* Function: init_order_test @ 0x2140 */
__int64 init_order_test()
{
  int v1; // [xsp+14h] [xbp+14h] BYREF

  v1 = 20;
  return (unsigned int)init_depends_on(&v1);
}


/* Function: test_static_global @ 0x219C */
void *test_static_global()
{
  int v0; // w0
  int v1; // w0
  int v2; // w0
  int v3; // w0
  int v4; // w0
  int v5; // w0
  int v6; // w0
  int v7; // w0
  int const_data; // w0
  int v9; // w0
  int v10; // w0
  int v11; // w0
  int file_static; // w0
  int v13; // w0
  int v14; // w0
  int v15; // w0
  int v16; // w0
  int inited; // w0
  int v19; // [xsp+14h] [xbp+14h] BYREF

  puts(asc_2C78);
  v0 = global_var_access();
  printf("STM-L1-01 (global_var_access): %d\n", v0);
  v1 = global_var_read();
  printf("STM-L1-01 (global_var_read): %d\n", v1);
  v2 = global_array_access(5u);
  printf("STM-L1-02 (global_array_access): %d\n", v2);
  static_local(1);
  v3 = static_local(0);
  printf("STM-L1-03 (static_local): %d\n", v3);
  v4 = static_local(0);
  printf("STM-L1-03 (static_local): %d\n", v4);
  v5 = call_static_func(5);
  printf("STM-L1-04 (call_static_func): %d\n", v5);
  v6 = access_extern_global();
  printf("STM-L2-01 (access_extern_global): %d\n", v6);
  v7 = call_extern_func();
  printf("STM-L2-02 (call_extern_func): %d\n", v7);
  const_data = read_const_data();
  printf("STM-L2-03 (read_const_data): %d\n", const_data);
  v9 = access_bss_var();
  printf("STM-L2-04 (access_bss_var): %d\n", v9);
  v10 = access_bss_buffer();
  printf("STM-L2-04 (access_bss_buffer): %d\n", v10);
  v11 = global_struct_access();
  printf("STM-L2-05 (global_struct_access): %d\n", v11);
  set_file_static(50);
  file_static = get_file_static();
  printf("STM-L2-06 (file_static): %d\n", file_static);
  set_global_callback(double_value);
  v13 = call_global_callback(5u);
  printf("STM-L2-07 (global_func_ptr): %d\n", v13);
  v19 = 100;
  v14 = global_heap_store((__int64)&v19);
  printf("STM-L2-08 (global_heap_store): %d\n", v14);
  v15 = static_complex_init();
  printf("STM-L2-09 (static_complex_init): %d\n", v15);
  v16 = tls_access(10);
  printf("STM-L3-01 (tls_access): %d\n", v16);
  inited = init_order_test();
  printf("STM-L3-02 (init_order_test): %d\n", inited);
  return &_stack_chk_guard;
}


/* Function: memop_memset @ 0x2398 */
__int64 __fastcall memop_memset(unsigned __int8 *a1, size_t a2, int a3)
{
  if ( !a1 || !a2 )
    return 0xFFFFFFFFLL;
  memset(a1, a3, a2);
  return *a1;
}


/* Function: memop_memcpy @ 0x23EC */
__int64 __fastcall memop_memcpy(char *a1, const void *a2, size_t a3)
{
  if ( !a1 || !a2 || !a3 )
    return 0xFFFFFFFFLL;
  memcpy(a1, a2, a3);
  return *(unsigned int *)&a1[(a3 & 0xFFFFFFFFFFFFFFFCLL) - 4];
}


/* Function: memop_memmove @ 0x245C */
__int64 __fastcall memop_memmove(__int64 a1, unsigned __int64 a2)
{
  if ( !a1 || a2 <= 1 )
    return 0xFFFFFFFFLL;
  memmove((void *)(a1 + 1), (const void *)a1, a2 - 1);
  return *(unsigned __int8 *)(a1 + 1);
}


/* Function: memop_memcmp @ 0x24C0 */
__int64 __fastcall memop_memcmp(const void *a1, const void *a2, size_t a3)
{
  int v4; // [xsp+3Ch] [xbp+3Ch]

  if ( !a1 || !a2 || !a3 )
    return 0;
  v4 = memcmp(a1, a2, a3);
  if ( v4 > 0 )
    return 1;
  if ( v4 >= 0 )
    return 0;
  return 0xFFFFFFFFLL;
}


/* Function: memop_bzero @ 0x2548 */
__int64 __fastcall memop_bzero(unsigned __int8 *a1, size_t a2)
{
  if ( !a1 )
    return 0xFFFFFFFFLL;
  memset(a1, 0, a2);
  return *a1;
}


/* Function: memop_bcopy @ 0x2598 */
__int64 __fastcall memop_bcopy(const void *a1, unsigned __int8 *a2, size_t a3)
{
  if ( !a1 || !a2 || !a3 )
    return 0xFFFFFFFFLL;
  memmove(a2, a1, a3);
  return *a2;
}


/* Function: memop_unaligned_access @ 0x25F8 */
__int64 __fastcall memop_unaligned_access(__int64 result)
{
  if ( result )
    LODWORD(result) = *(_DWORD *)(result + 1);
  else
    LODWORD(result) = -1;
  return (unsigned int)result;
}


/* Function: memop_memory_barrier @ 0x2670 */
__int64 __fastcall memop_memory_barrier(int *a1)
{
  int v2; // [xsp+1Ch] [xbp-4h]

  if ( !a1 )
    return 0xFFFFFFFFLL;
  v2 = *a1;
  __dmb(0xBu);
  return (unsigned int)(*a1 + v2);
}


/* Function: test_memory_op_functions @ 0x26B4 */
void *test_memory_op_functions()
{
  int v0; // w0
  int v1; // w0
  unsigned int v2; // w0
  int v3; // w0
  int v4; // w0
  int v5; // w0
  int v6; // w0
  int v7; // w0
  int v9; // [xsp+1Ch] [xbp+1Ch] BYREF
  __int64 v10; // [xsp+20h] [xbp+20h] BYREF
  int v11; // [xsp+28h] [xbp+28h]
  __int64 v12; // [xsp+30h] [xbp+30h] BYREF
  int v13; // [xsp+38h] [xbp+38h]
  _QWORD v14[2]; // [xsp+40h] [xbp+40h] BYREF
  int v15; // [xsp+50h] [xbp+50h]
  _QWORD v16[2]; // [xsp+58h] [xbp+58h] BYREF
  int v17; // [xsp+68h] [xbp+68h]
  int v18; // [xsp+70h] [xbp+70h] BYREF
  unsigned __int8 v19[8]; // [xsp+78h] [xbp+78h] BYREF
  __int64 v20; // [xsp+80h] [xbp+80h] BYREF
  unsigned __int8 v21[16]; // [xsp+88h] [xbp+88h] BYREF
  char v22[16]; // [xsp+98h] [xbp+98h] BYREF
  unsigned __int8 v23[256]; // [xsp+A8h] [xbp+A8h] BYREF

  puts(asc_2F28);
  v14[0] = *(_QWORD *)"\n";
  v14[1] = 0x280000001ELL;
  v15 = 50;
  v16[0] = 0;
  v16[1] = 0;
  v17 = 0;
  v0 = memop_memset(v23, 0xAu, 65);
  printf("MEMOP-L2-01: %d\n", v0);
  v1 = memop_memcpy((char *)v16, v14, 0x14u);
  printf("MEMOP-L2-02: %d\n", v1);
  strcpy(v22, "HelloWorld");
  v2 = memop_memmove((__int64)v22, 0xAu);
  printf("MEMOP-L2-03: %c\n", v2);
  v10 = 0x200000001LL;
  v11 = 3;
  v12 = 0x200000001LL;
  v13 = 4;
  v3 = memop_memcmp(&v10, &v12, 0xCu);
  printf("MEMOP-L2-04: %d\n", v3);
  v4 = memop_bzero(v21, 0xAu);
  printf("MEMOP-L2-05: %d\n", v4);
  v18 = 67305985;
  *(_DWORD *)v19 = 0;
  v5 = memop_bcopy(&v18, v19, 4u);
  printf("MEMOP-L2-06: %d\n", v5);
  v20 = 0x706050403020100LL;
  v6 = memop_unaligned_access((__int64)&v20);
  printf("MEMOP-L3-01: 0x%x\n", v6);
  v9 = 5;
  v7 = memop_memory_barrier(&v9);
  printf("MEMOP-L3-02: %d\n", v7);
  return &_stack_chk_guard;
}


/* Function: main @ 0x2898 */
int __fastcall main(int argc, const char **argv, const char **envp)
{
  test_stack_memory();
  test_heap_memory();
  test_static_global();
  test_memory_op_functions();
  return 0;
}


/* Function: extern_function @ 0x28BC */
__int64 __fastcall extern_function(int a1)
{
  return (unsigned int)(3 * a1);
}


/* Function: .term_proc @ 0x28DC */
void term_proc()
{
  ;
}


/* FAILED to decompile: memcpy @ 0x14170 */

/* FAILED to decompile: memmove @ 0x14178 */

/* FAILED to decompile: exit @ 0x14180 */

/* FAILED to decompile: __libc_start_main @ 0x14188 */

/* FAILED to decompile: perror @ 0x14190 */

/* FAILED to decompile: __cxa_finalize @ 0x14198 */

/* FAILED to decompile: fork @ 0x141A0 */

/* FAILED to decompile: malloc @ 0x141A8 */

/* FAILED to decompile: memset @ 0x141B0 */

/* FAILED to decompile: calloc @ 0x141B8 */

/* FAILED to decompile: realloc @ 0x141C0 */

/* FAILED to decompile: __stack_chk_fail @ 0x141C8 */

/* FAILED to decompile: abort @ 0x141D8 */

/* FAILED to decompile: puts @ 0x141E0 */

/* FAILED to decompile: memcmp @ 0x141E8 */

/* FAILED to decompile: free @ 0x141F0 */

/* FAILED to decompile: printf @ 0x141F8 */

/* FAILED to decompile: waitpid @ 0x14200 */

/* FAILED to decompile: __gmon_start__ @ 0x14210 */

/* Total functions decompiled: 67, failed: 19 */
