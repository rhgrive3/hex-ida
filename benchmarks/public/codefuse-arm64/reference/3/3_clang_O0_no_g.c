/*
 * Decompiled by IDA Pro 9.1 with Hex-Rays
 * Binary: /Users/eren/Desktop/Antigravity/compiler/build/arm64/3/3_clang_O0_no_g
 * Processor: arm
 */

/* Function: .init_proc @ 0x908 */
__int64 init_proc()
{
  return call_weak_fn();
}


/* Function: sub_920 @ 0x920 */
void sub_920()
{
  JUMPOUT(0);
}


/* Function: _start @ 0xA80 */
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


/* Function: call_weak_fn @ 0xAB4 */
void *call_weak_fn()
{
  void *result; // x0

  result = &_gmon_start__;
  if ( &_gmon_start__ )
    return (void *)__gmon_start__();
  return result;
}


/* Function: deregister_tm_clones @ 0xAD0 */
char *deregister_tm_clones()
{
  return &completed_0;
}


/* Function: register_tm_clones @ 0xB00 */
char *register_tm_clones()
{
  return &completed_0;
}


/* Function: __do_global_dtors_aux @ 0xB40 */
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


/* Function: frame_dummy @ 0xB90 */
// attributes: thunk
char *frame_dummy()
{
  return register_tm_clones();
}


/* Function: local_vars @ 0xB94 */
__int64 __fastcall local_vars(int a1)
{
  return (unsigned int)(2 * a1 + 10);
}


/* Function: local_array @ 0xBC8 */
__int64 __fastcall local_array(int a1)
{
  int i; // [xsp+0h] [xbp-30h]
  _DWORD v3[10]; // [xsp+4h] [xbp-2Ch]
  int v4; // [xsp+2Ch] [xbp-4h]

  v4 = a1;
  for ( i = 0; i < 10; ++i )
    v3[i] = i * v4;
  return v3[5];
}


/* Function: local_struct @ 0xC20 */
__int64 __fastcall local_struct(int a1)
{
  return (unsigned int)(3 * a1);
}


/* Function: address_of_local @ 0xC50 */
__int64 __fastcall address_of_local(_DWORD *a1)
{
  *a1 = 42;
  return 42;
}


/* Function: address_of_array @ 0xC78 */
__int64 __fastcall address_of_array(_DWORD *a1)
{
  return (unsigned int)(2 * *a1);
}


/* Function: large_stack_frame @ 0xCAC */
__int64 large_stack_frame()
{
  int i; // [xsp+Ch] [xbp-814h]
  _BYTE v2[2048]; // [xsp+10h] [xbp-810h]

  for ( i = 0; i < 2048; ++i )
    v2[i] = i;
  return v2[1024];
}


/* Function: vla_stack @ 0xD00 */
__int64 __fastcall vla_stack(int a1)
{
  __int64 v2; // [xsp+0h] [xbp-30h] BYREF
  char *v3; // [xsp+8h] [xbp-28h]
  int i; // [xsp+14h] [xbp-1Ch]
  __int64 v5; // [xsp+18h] [xbp-18h]
  __int64 *v6; // [xsp+20h] [xbp-10h]
  int v7; // [xsp+28h] [xbp-8h]

  v7 = a1;
  if ( a1 > 0 && v7 <= 1000 )
  {
    v6 = &v2;
    v3 = (char *)&v2 - ((4LL * (unsigned int)v7 + 15) & 0xFFFFFFFFFFFFFFF0LL);
    v5 = (unsigned int)v7;
    for ( i = 0; i < v7; ++i )
      *(_DWORD *)&v3[4 * i] = 2 * i;
    return *(unsigned int *)&v3[4 * (v7 / 2)];
  }
  else
  {
    return (unsigned int)-1;
  }
}


/* Function: alloca_usage @ 0xDE0 */
__int64 __fastcall alloca_usage(int a1)
{
  __int64 v2; // [xsp+0h] [xbp-20h] BYREF
  int i; // [xsp+Ch] [xbp-14h]
  char *v4; // [xsp+10h] [xbp-10h]
  int v5; // [xsp+18h] [xbp-8h]

  v5 = a1;
  if ( a1 > 0 )
  {
    v4 = (char *)&v2 - ((4LL * v5 + 15) & 0xFFFFFFFFFFFFFFF0LL);
    for ( i = 0; i < v5; ++i )
      *(_DWORD *)&v4[4 * i] = 3 * i;
    return *(unsigned int *)&v4[4 * (v5 / 2)];
  }
  else
  {
    return (unsigned int)-1;
  }
}


/* Function: stack_alias @ 0xEA4 */
__int64 stack_alias()
{
  int v1; // [xsp+4h] [xbp-1Ch] BYREF
  int *v2; // [xsp+8h] [xbp-18h]
  int *v3; // [xsp+10h] [xbp-10h]

  v1 = 10;
  v3 = &v1;
  v2 = &v1;
  if ( &v1 )
  {
    *v3 = 20;
    return (unsigned int)*v2;
  }
  else
  {
    return (unsigned int)-1;
  }
}


/* Function: test_stack_memory @ 0xF1C */
__int64 test_stack_memory()
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
  _DWORD s[10]; // [xsp+24h] [xbp-2Ch] BYREF
  int v11; // [xsp+4Ch] [xbp-4h] BYREF

  printf(asc_2714);
  v0 = local_vars(5);
  printf("MEM-L1-01 (local_vars): %d\n", v0);
  v1 = local_array(2);
  printf("MEM-L1-02 (local_array): %d\n", v1);
  v2 = local_struct(5);
  printf("MEM-L1-03 (local_struct): %d\n", v2);
  v3 = address_of_local(&v11);
  printf("MEM-L1-04 (address_of_local): %d\n", v3);
  memset(s, 0, sizeof(s));
  s[0] = 1;
  s[1] = 2;
  s[2] = 3;
  v4 = address_of_array(s);
  printf("MEM-L1-05 (address_of_array): %d\n", v4);
  v5 = large_stack_frame();
  printf("MEM-L2-01 (large_stack_frame): %d\n", v5);
  v6 = vla_stack(10);
  printf("MEM-L2-02 (vla_stack): %d\n", v6);
  v7 = alloca_usage(10);
  printf("MEM-L2-03 (alloca_usage): %d\n", v7);
  v8 = stack_alias();
  return printf("MEM-L2-04 (stack_alias): %d\n", v8);
}


/* Function: heap_basic @ 0x1054 */
__int64 __fastcall heap_basic(int a1)
{
  unsigned int v2; // [xsp+8h] [xbp-18h]
  int i; // [xsp+Ch] [xbp-14h]
  _DWORD *ptr; // [xsp+10h] [xbp-10h]

  ptr = malloc(4LL * a1);
  if ( ptr )
  {
    for ( i = 0; i < a1; ++i )
      ptr[i] = 2 * i;
    v2 = ptr[a1 / 2];
    free(ptr);
    return v2;
  }
  else
  {
    return (unsigned int)-1;
  }
}


/* Function: heap_calloc @ 0x110C */
__int64 __fastcall heap_calloc(int a1)
{
  int i; // [xsp+8h] [xbp-18h]
  unsigned int v3; // [xsp+Ch] [xbp-14h]
  _DWORD *ptr; // [xsp+10h] [xbp-10h]

  ptr = calloc(a1, 4u);
  if ( ptr )
  {
    v3 = 0;
    for ( i = 0; i < a1; ++i )
      v3 += ptr[i];
    free(ptr);
    return v3;
  }
  else
  {
    return (unsigned int)-1;
  }
}


/* Function: heap_realloc @ 0x11B4 */
__int64 heap_realloc()
{
  _DWORD *v0; // x0
  unsigned int v2; // [xsp+4h] [xbp-2Ch]
  int j; // [xsp+Ch] [xbp-24h]
  int v4; // [xsp+18h] [xbp-18h]
  int i; // [xsp+1Ch] [xbp-14h]
  _DWORD *v6; // [xsp+20h] [xbp-10h]

  v6 = malloc(0x14u);
  if ( v6 )
  {
    for ( i = 0; i < 5; ++i )
      v6[i] = i + 1;
    v4 = v6[2];
    v0 = realloc(v6, 0x28u);
    if ( v0 )
    {
      for ( j = 5; j < 10; ++j )
        v0[j] = 10 * j;
      if ( v0[2] == v4 )
        v2 = v0[5];
      else
        v2 = -3;
      free(v0);
      return v2;
    }
    else
    {
      free(v6);
      return (unsigned int)-2;
    }
  }
  else
  {
    return (unsigned int)-1;
  }
}


/* Function: heap_array @ 0x1310 */
__int64 __fastcall heap_array(int a1)
{
  unsigned int v2; // [xsp+8h] [xbp-18h]
  int i; // [xsp+Ch] [xbp-14h]
  _DWORD *ptr; // [xsp+10h] [xbp-10h]

  ptr = malloc(4LL * a1);
  if ( ptr )
  {
    for ( i = 0; i < a1; ++i )
      ptr[i] = 3 * i;
    v2 = ptr[a1 / 2];
    free(ptr);
    return v2;
  }
  else
  {
    return (unsigned int)-1;
  }
}


/* Function: heap_struct @ 0x13CC */
__int64 __fastcall heap_struct(int a1)
{
  unsigned int v2; // [xsp+Ch] [xbp-14h]
  _DWORD *ptr; // [xsp+10h] [xbp-10h]

  ptr = malloc(8u);
  if ( ptr )
  {
    *ptr = a1;
    ptr[1] = 2 * a1;
    v2 = *ptr + ptr[1];
    free(ptr);
    return v2;
  }
  else
  {
    return (unsigned int)-1;
  }
}


/* Function: heap_nested @ 0x1458 */
__int64 __fastcall heap_nested(void **a1)
{
  *a1 = malloc(0x10u);
  if ( *a1 )
  {
    *(_DWORD *)*a1 = 10;
    *((_QWORD *)*a1 + 1) = malloc(0x10u);
    if ( *((_QWORD *)*a1 + 1) )
    {
      **((_DWORD **)*a1 + 1) = 20;
      *(_QWORD *)(*((_QWORD *)*a1 + 1) + 8LL) = 0;
      return 0;
    }
    else
    {
      free(*a1);
      return (unsigned int)-2;
    }
  }
  else
  {
    return (unsigned int)-1;
  }
}


/* Function: linked_list_heap @ 0x1520 */
__int64 linked_list_heap()
{
  void *v1; // [xsp+8h] [xbp-48h]
  _QWORD *j; // [xsp+10h] [xbp-40h]
  unsigned int v3; // [xsp+1Ch] [xbp-34h]
  void *ptr; // [xsp+20h] [xbp-30h]
  _QWORD *v5; // [xsp+28h] [xbp-28h]
  int i; // [xsp+34h] [xbp-1Ch]
  _QWORD *v7; // [xsp+38h] [xbp-18h]
  _QWORD *v8; // [xsp+40h] [xbp-10h]

  v8 = 0;
  v7 = 0;
  for ( i = 0; ; ++i )
  {
    if ( i >= 5 )
    {
      v3 = 0;
      for ( j = v8; j; j = (_QWORD *)j[1] )
        v3 += *(_DWORD *)j;
      while ( v8 )
      {
        v1 = v8;
        v8 = (_QWORD *)v8[1];
        free(v1);
      }
      return v3;
    }
    v5 = malloc(0x10u);
    if ( !v5 )
      break;
    *(_DWORD *)v5 = 10 * i;
    v5[1] = 0;
    if ( v8 )
      v7[1] = v5;
    else
      v8 = v5;
    v7 = v5;
  }
  while ( v8 )
  {
    ptr = v8;
    v8 = (_QWORD *)v8[1];
    free(ptr);
  }
  return (unsigned int)-1;
}


/* Function: create_tree_node @ 0x1694 */
_QWORD *__fastcall create_tree_node(int a1)
{
  _QWORD *v2; // [xsp+0h] [xbp-10h]

  v2 = malloc(0x18u);
  if ( v2 )
  {
    *(_DWORD *)v2 = a1;
    v2[1] = 0;
    v2[2] = 0;
  }
  return v2;
}


/* Function: tree_heap_traversal @ 0x16EC */
__int64 tree_heap_traversal()
{
  unsigned int v1; // [xsp+Ch] [xbp-14h]
  void **ptr; // [xsp+10h] [xbp-10h]

  ptr = (void **)create_tree_node(10);
  if ( ptr )
  {
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
      return (unsigned int)-2;
    }
  }
  else
  {
    return (unsigned int)-1;
  }
}


/* Function: memory_leak @ 0x1818 */
__int64 __fastcall memory_leak(int a1)
{
  int i; // [xsp+Ch] [xbp-14h]
  _DWORD *v3; // [xsp+10h] [xbp-10h]

  v3 = malloc(4LL * a1);
  if ( v3 )
  {
    for ( i = 0; i < a1; ++i )
      v3[i] = i;
    return (unsigned int)v3[a1 / 2];
  }
  else
  {
    return (unsigned int)-1;
  }
}


/* Function: dangling_pointer @ 0x18BC */
__int64 dangling_pointer()
{
  unsigned int *ptr; // [xsp+10h] [xbp-10h]

  ptr = (unsigned int *)malloc(4u);
  if ( ptr )
  {
    *ptr = 42;
    printf("value before free: %d\n", *ptr);
    free(ptr);
    return *ptr;
  }
  else
  {
    return (unsigned int)-1;
  }
}


/* Function: double_free @ 0x1944 */
__int64 __fastcall double_free(unsigned int *a1)
{
  _DWORD *ptr; // [xsp+8h] [xbp-18h]

  if ( a1 )
  {
    return *a1;
  }
  else
  {
    ptr = malloc(4u);
    if ( ptr )
    {
      *ptr = 10;
      free(ptr);
      free(ptr);
      return (unsigned int)-2;
    }
    else
    {
      return (unsigned int)-1;
    }
  }
}


/* Function: heap_overflow @ 0x19CC */
__int64 heap_overflow()
{
  unsigned int v1; // [xsp+8h] [xbp-18h]
  int i; // [xsp+Ch] [xbp-14h]
  unsigned int *ptr; // [xsp+10h] [xbp-10h]

  ptr = (unsigned int *)malloc(0x28u);
  if ( ptr )
  {
    for ( i = 0; i <= 10; ++i )
      ptr[i] = 100 * i;
    v1 = *ptr;
    free(ptr);
    return v1;
  }
  else
  {
    return (unsigned int)-1;
  }
}


/* Function: test_heap_memory @ 0x1A70 */
void test_heap_memory()
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
  int stat_loc; // [xsp+Ch] [xbp-14h] BYREF
  unsigned int v10; // [xsp+10h] [xbp-10h]
  __pid_t v11; // [xsp+14h] [xbp-Ch]
  void *v12; // [xsp+18h] [xbp-8h] BYREF

  printf(asc_285E);
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
  v12 = 0;
  v5 = heap_nested(&v12);
  printf("HEAP-L2-06 (heap_nested): %d\n", v5);
  if ( v12 )
  {
    free(*(void **)&byte_8[(_QWORD)v12]);
    free(v12);
  }
  v6 = linked_list_heap();
  printf("HEAP-L3-01 (linked_list_heap): %d\n", v6);
  v7 = tree_heap_traversal();
  printf("HEAP-L3-02 (tree_heap_traversal): %d\n", v7);
  v8 = memory_leak(5);
  printf("HEAP-L3-03 (memory_leak): %d\n", v8);
  printf("HEAP-L3-04 (dangling_pointer): ");
  v11 = fork();
  if ( !v11 )
  {
    v10 = dangling_pointer();
    printf(aD, v10);
    exit(0);
  }
  if ( v11 <= 0 )
  {
    perror(aFork_0);
  }
  else
  {
    waitpid(v11, &stat_loc, 0);
    if ( (stat_loc & 0x7F) != 0 )
    {
      if ( (char)((stat_loc & 0x7F) + 1) >> 1 > 0 )
        printf(byte_29EC, stat_loc & 0x7F);
    }
    else
    {
      printf(byte_29C7, (stat_loc & 0xFF00) >> 8);
    }
  }
}


/* Function: global_var_access @ 0x1C70 */
__int64 global_var_access()
{
  return (unsigned int)++global_counter;
}


/* Function: global_var_read @ 0x1C88 */
__int64 global_var_read()
{
  return (unsigned int)(2 * global_counter);
}


/* Function: global_array_access @ 0x1C98 */
__int64 __fastcall global_array_access(int a1)
{
  if ( a1 < 0 || a1 >= 10 )
    return (unsigned int)-1;
  else
    return (unsigned int)global_array[a1];
}


/* Function: static_local @ 0x1CEC */
__int64 __fastcall static_local(int a1)
{
  if ( a1 )
  {
    static_local_counter = 0;
    return 0;
  }
  else
  {
    return (unsigned int)++static_local_counter;
  }
}


/* Function: call_static_func @ 0x1D38 */
__int64 __fastcall call_static_func(unsigned int a1)
{
  return (unsigned int)static_helper(a1) + 1;
}


/* Function: static_helper @ 0x1D60 */
__int64 __fastcall static_helper(int a1)
{
  return (unsigned int)(2 * a1);
}


/* Function: access_extern_global @ 0x1D78 */
__int64 access_extern_global()
{
  return (unsigned int)(extern_global_var + 100);
}


/* Function: call_extern_func @ 0x1D8C */
__int64 call_extern_func()
{
  return extern_function(5);
}


/* Function: read_const_data @ 0x1DA4 */
__int64 read_const_data()
{
  return (unsigned int)(unsigned __int8)const_string[4] + 42;
}


/* Function: access_bss_var @ 0x1DB8 */
__int64 access_bss_var()
{
  return (unsigned int)bss_var;
}


/* Function: access_bss_buffer @ 0x1DC4 */
__int64 access_bss_buffer()
{
  return (unsigned __int8)bss_buffer;
}


/* Function: global_struct_access @ 0x1DD0 */
__int64 global_struct_access()
{
  return (unsigned int)(global_point + dword_140D4);
}


/* Function: set_file_static @ 0x1DEC */
__int64 __fastcall set_file_static(__int64 result)
{
  file_scope_static = result;
  return result;
}


/* Function: get_file_static @ 0x1E08 */
__int64 get_file_static()
{
  return (unsigned int)file_scope_static;
}


/* Function: set_global_callback @ 0x1E14 */
void *__fastcall set_global_callback(void *result)
{
  global_func_ptr = result;
  return result;
}


/* Function: call_global_callback @ 0x1E30 */
__int64 __fastcall call_global_callback(unsigned int a1)
{
  if ( global_func_ptr )
    return (unsigned int)global_func_ptr(a1);
  else
    return (unsigned int)-1;
}


/* Function: global_heap_store @ 0x1E84 */
__int64 __fastcall global_heap_store(__int64 a1)
{
  global_heap_ptr = a1;
  if ( a1 )
    return *(unsigned int *)global_heap_ptr;
  else
    return (unsigned int)-1;
}


/* Function: static_complex_init @ 0x1ED0 */
__int64 static_complex_init()
{
  return (unsigned int)(complex_init + dword_140E4 + dword_140EC);
}


/* Function: tls_access @ 0x1EF4 */
__int64 __fastcall tls_access(int a1)
{
  _DWORD *v1; // x8

  v1 = (_DWORD *)(_ReadStatusReg(TPIDR_EL0) + 16);
  *v1 = a1;
  return (unsigned int)(2 * *v1);
}


/* Function: init_order_test @ 0x1F20 */
__int64 init_order_test()
{
  int v1; // [xsp+Ch] [xbp-4h] BYREF

  v1 = 20;
  return init_depends_on(&v1);
}


/* Function: init_depends_on @ 0x1F48 */
__int64 __fastcall init_depends_on(int *a1)
{
  if ( a1 )
    init_depends_on_static_depends = *a1;
  return (unsigned int)init_depends_on_static_depends;
}


/* Function: test_static_global @ 0x1F80 */
__int64 test_static_global()
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
  int v19; // [xsp+1Ch] [xbp-4h] BYREF

  printf(asc_2A43);
  v0 = global_var_access();
  printf("STM-L1-01 (global_var_access): %d\n", v0);
  v1 = global_var_read();
  printf("STM-L1-01 (global_var_read): %d\n", v1);
  v2 = global_array_access(5);
  printf("STM-L1-02 (global_array_access): %d\n", v2);
  static_local(1);
  v3 = static_local(0);
  printf("STM-L1-03 (static_local): %d\n", v3);
  v4 = static_local(0);
  printf("STM-L1-03 (static_local): %d\n", v4);
  v5 = call_static_func(5u);
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
  return printf("STM-L3-02 (init_order_test): %d\n", inited);
}


/* Function: double_value @ 0x2154 */
__int64 __fastcall double_value(int a1)
{
  return (unsigned int)(2 * a1);
}


/* Function: memop_memset @ 0x216C */
__int64 __fastcall memop_memset(unsigned __int8 *a1, size_t a2, int a3)
{
  if ( a1 && a2 )
  {
    memset(a1, a3, a2);
    return *a1;
  }
  else
  {
    return (unsigned int)-1;
  }
}


/* Function: memop_memcpy @ 0x21D8 */
__int64 __fastcall memop_memcpy(void *a1, const void *a2, size_t a3)
{
  if ( a1 && a2 && a3 )
  {
    memcpy(a1, a2, a3);
    return (unsigned int)*((_DWORD *)a1 + a3 / 4 - 1);
  }
  else
  {
    return (unsigned int)-1;
  }
}


/* Function: memop_memmove @ 0x2260 */
__int64 __fastcall memop_memmove(__int64 a1, unsigned __int64 a2)
{
  if ( a1 && a2 >= 2 )
  {
    memmove((void *)(a1 + 1), (const void *)a1, a2 - 1);
    return *(unsigned __int8 *)(a1 + 1);
  }
  else
  {
    return (unsigned int)-1;
  }
}


/* Function: memop_memcmp @ 0x22D4 */
__int64 __fastcall memop_memcmp(const void *a1, const void *a2, size_t a3)
{
  int v6; // [xsp+Ch] [xbp-24h]

  if ( a1 && a2 && a3 )
  {
    v6 = memcmp(a1, a2, a3);
    if ( v6 <= 0 )
    {
      if ( v6 < 0 )
        return (unsigned int)-1;
      else
        return 0;
    }
    else
    {
      return 1;
    }
  }
  else
  {
    return 0;
  }
}


/* Function: memop_bzero @ 0x237C */
__int64 __fastcall memop_bzero(unsigned __int8 *a1, size_t a2)
{
  if ( a1 )
  {
    memset(a1, 0, a2);
    return *a1;
  }
  else
  {
    return (unsigned int)-1;
  }
}


/* Function: memop_bcopy @ 0x23D8 */
__int64 __fastcall memop_bcopy(const void *a1, unsigned __int8 *a2, size_t a3)
{
  if ( a1 && a2 && a3 )
  {
    bcopy(a1, a2, a3);
    return *a2;
  }
  else
  {
    return (unsigned int)-1;
  }
}


/* Function: memop_unaligned_access @ 0x2450 */
__int64 __fastcall memop_unaligned_access(__int64 a1)
{
  if ( a1 )
    return *(unsigned int *)(a1 + 1);
  else
    return (unsigned int)-1;
}


/* Function: memop_memory_barrier @ 0x2494 */
__int64 __fastcall memop_memory_barrier(int *a1)
{
  int v2; // [xsp+Ch] [xbp-14h]

  if ( a1 )
  {
    v2 = *a1;
    __dmb(0xBu);
    return (unsigned int)(v2 + *a1);
  }
  else
  {
    return (unsigned int)-1;
  }
}


/* Function: test_memory_op_functions @ 0x24E8 */
__int64 test_memory_op_functions()
{
  int v0; // w0
  int v1; // w0
  unsigned int v2; // w0
  int v3; // w0
  int v4; // w0
  int v5; // w0
  int v6; // w0
  int v7; // w0
  int v9; // [xsp+24h] [xbp-18Ch] BYREF
  __int64 v10; // [xsp+28h] [xbp-188h] BYREF
  int v11; // [xsp+34h] [xbp-17Ch] BYREF
  int v12; // [xsp+38h] [xbp-178h] BYREF
  unsigned __int8 v13[10]; // [xsp+3Eh] [xbp-172h] BYREF
  __int64 v14; // [xsp+48h] [xbp-168h] BYREF
  int v15; // [xsp+50h] [xbp-160h]
  __int64 v16; // [xsp+58h] [xbp-158h] BYREF
  int v17; // [xsp+60h] [xbp-150h]
  char v18[16]; // [xsp+68h] [xbp-148h] BYREF
  _QWORD v19[2]; // [xsp+78h] [xbp-138h] BYREF
  int v20; // [xsp+88h] [xbp-128h]
  __int128 v21; // [xsp+90h] [xbp-120h] BYREF
  int v22; // [xsp+A0h] [xbp-110h]
  unsigned __int8 v23[256]; // [xsp+B0h] [xbp-100h] BYREF

  printf(asc_2CA6);
  v21 = xmmword_2D58;
  v22 = 50;
  v19[0] = 0;
  v19[1] = 0;
  v20 = 0;
  v0 = memop_memset(v23, 0xAu, 65);
  printf("MEMOP-L2-01: %d\n", v0);
  v1 = memop_memcpy(v19, &v21, 0x14u);
  printf("MEMOP-L2-02: %d\n", v1);
  strcpy(v18, "HelloWorld");
  v2 = memop_memmove((__int64)v18, 0xAu);
  printf("MEMOP-L2-03: %c\n", v2);
  v16 = 0x200000001LL;
  v17 = 3;
  v14 = 0x200000001LL;
  v15 = 4;
  v3 = memop_memcmp(&v16, &v14, 0xCu);
  printf("MEMOP-L2-04: %d\n", v3);
  v4 = memop_bzero(v13, 0xAu);
  printf("MEMOP-L2-05: %d\n", v4);
  v12 = 67305985;
  v11 = 0;
  v5 = memop_bcopy(&v12, (unsigned __int8 *)&v11, 4u);
  printf("MEMOP-L2-06: %d\n", v5);
  v10 = 0x706050403020100LL;
  v6 = memop_unaligned_access((__int64)&v10);
  printf("MEMOP-L3-01: 0x%x\n", v6);
  v9 = 5;
  v7 = memop_memory_barrier(&v9);
  return printf("MEMOP-L3-02: %d\n", v7);
}


/* Function: main @ 0x26A8 */
int __fastcall main(int argc, const char **argv, const char **envp)
{
  test_stack_memory();
  test_heap_memory();
  test_static_global();
  test_memory_op_functions();
  return 0;
}


/* Function: extern_function @ 0x26E0 */
__int64 __fastcall extern_function(int a1)
{
  return (unsigned int)(3 * a1);
}


/* Function: .term_proc @ 0x26FC */
void term_proc()
{
  ;
}


/* FAILED to decompile: memcpy @ 0x141F8 */

/* FAILED to decompile: memmove @ 0x14200 */

/* FAILED to decompile: exit @ 0x14208 */

/* FAILED to decompile: __libc_start_main @ 0x14210 */

/* FAILED to decompile: perror @ 0x14218 */

/* FAILED to decompile: __cxa_finalize @ 0x14220 */

/* FAILED to decompile: fork @ 0x14228 */

/* FAILED to decompile: malloc @ 0x14230 */

/* FAILED to decompile: memset @ 0x14238 */

/* FAILED to decompile: calloc @ 0x14240 */

/* FAILED to decompile: realloc @ 0x14248 */

/* FAILED to decompile: abort @ 0x14250 */

/* FAILED to decompile: memcmp @ 0x14258 */

/* FAILED to decompile: free @ 0x14260 */

/* FAILED to decompile: printf @ 0x14268 */

/* FAILED to decompile: bcopy @ 0x14270 */

/* FAILED to decompile: waitpid @ 0x14278 */

/* FAILED to decompile: __gmon_start__ @ 0x14288 */

/* Total functions decompiled: 67, failed: 18 */
