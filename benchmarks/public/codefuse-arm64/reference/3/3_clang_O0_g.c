/*
 * Decompiled by IDA Pro 9.1 with Hex-Rays
 * Binary: /Users/eren/Desktop/Antigravity/compiler/build/arm64/3/3_clang_O0_g
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
int __cdecl local_vars(int x)
{
  return 2 * x + 10;
}


/* Function: local_array @ 0xBC8 */
int __cdecl local_array(int n)
{
  int i; // [xsp+0h] [xbp-30h]
  _DWORD v3[10]; // [xsp+4h] [xbp-2Ch]
  int v4; // [xsp+2Ch] [xbp-4h]

  v4 = n;
  for ( i = 0; i < 10; ++i )
    v3[i] = i * v4;
  return v3[5];
}


/* Function: local_struct @ 0xC20 */
int __cdecl local_struct(int x)
{
  return 3 * x;
}


/* Function: address_of_local @ 0xC50 */
int __cdecl address_of_local(int *out)
{
  *out = 42;
  return 42;
}


/* Function: address_of_array @ 0xC78 */
int __cdecl address_of_array(int *arr)
{
  return 2 * *arr;
}


/* Function: large_stack_frame @ 0xCAC */
int __cdecl large_stack_frame()
{
  int i; // [xsp+Ch] [xbp-814h]
  _BYTE v2[2048]; // [xsp+10h] [xbp-810h]

  for ( i = 0; i < 2048; ++i )
    v2[i] = i;
  return v2[1024];
}


/* Function: vla_stack @ 0xD00 */
int __cdecl vla_stack(int n)
{
  __int64 v2; // [xsp+0h] [xbp-30h] BYREF
  int (*p_vla)[]; // [xsp+8h] [xbp-28h]
  int i; // [xsp+14h] [xbp-1Ch]
  unsigned __int64 __vla_expr0; // [xsp+18h] [xbp-18h]
  __int64 *v6; // [xsp+20h] [xbp-10h]
  int na; // [xsp+28h] [xbp-8h]

  na = n;
  if ( n <= 0 || na > 1000 )
    return -1;
  v6 = &v2;
  p_vla = (int (*)[])((char *)&v2 - ((4LL * (unsigned int)na + 15) & 0xFFFFFFFFFFFFFFF0LL));
  __vla_expr0 = (unsigned int)na;
  for ( i = 0; i < na; ++i )
    *((_DWORD *)p_vla + i) = 2 * i;
  return *((_DWORD *)p_vla + na / 2);
}


/* Function: alloca_usage @ 0xDE0 */
int __cdecl alloca_usage(int n)
{
  __int64 v2; // [xsp+0h] [xbp-20h] BYREF
  int i; // [xsp+Ch] [xbp-14h]
  int *arr; // [xsp+10h] [xbp-10h]
  int na; // [xsp+18h] [xbp-8h]

  na = n;
  if ( n <= 0 )
    return -1;
  arr = (int *)((char *)&v2 - ((4LL * na + 15) & 0xFFFFFFFFFFFFFFF0LL));
  for ( i = 0; i < na; ++i )
    arr[i] = 3 * i;
  return arr[na / 2];
}


/* Function: stack_alias @ 0xEA4 */
int __cdecl stack_alias(int *p1, int *p2)
{
  int v3; // [xsp+4h] [xbp-1Ch] BYREF
  int *v4; // [xsp+8h] [xbp-18h]
  int *v5; // [xsp+10h] [xbp-10h]

  v3 = 10;
  v5 = &v3;
  v4 = &v3;
  if ( !&v3 )
    return -1;
  *v5 = 20;
  return *v4;
}


/* Function: test_stack_memory @ 0xF1C */
void __cdecl test_stack_memory()
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
  int p1; // [xsp+20h] [xbp-30h] BYREF
  int s[10]; // [xsp+24h] [xbp-2Ch] BYREF
  int out; // [xsp+4Ch] [xbp-4h] BYREF

  printf(asc_2714);
  v0 = local_vars(5);
  printf("MEM-L1-01 (local_vars): %d\n", v0);
  v1 = local_array(2);
  printf("MEM-L1-02 (local_array): %d\n", v1);
  v2 = local_struct(5);
  printf("MEM-L1-03 (local_struct): %d\n", v2);
  v3 = address_of_local(&out);
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
  p1 = 0;
  v8 = stack_alias(&p1, &p1);
  printf("MEM-L2-04 (stack_alias): %d\n", v8);
}


/* Function: heap_basic @ 0x1054 */
int __cdecl heap_basic(int n)
{
  int v2; // [xsp+8h] [xbp-18h]
  int i; // [xsp+Ch] [xbp-14h]
  _DWORD *ptr; // [xsp+10h] [xbp-10h]

  ptr = malloc(4LL * n);
  if ( !ptr )
    return -1;
  for ( i = 0; i < n; ++i )
    ptr[i] = 2 * i;
  v2 = ptr[n / 2];
  free(ptr);
  return v2;
}


/* Function: heap_calloc @ 0x110C */
int __cdecl heap_calloc(int n)
{
  int i; // [xsp+8h] [xbp-18h]
  int v3; // [xsp+Ch] [xbp-14h]
  _DWORD *ptr; // [xsp+10h] [xbp-10h]

  ptr = calloc(n, 4u);
  if ( !ptr )
    return -1;
  v3 = 0;
  for ( i = 0; i < n; ++i )
    v3 += ptr[i];
  free(ptr);
  return v3;
}


/* Function: heap_realloc @ 0x11B4 */
int __cdecl heap_realloc()
{
  _DWORD *v0; // x0
  int v2; // [xsp+4h] [xbp-2Ch]
  int j; // [xsp+Ch] [xbp-24h]
  int v4; // [xsp+18h] [xbp-18h]
  int i; // [xsp+1Ch] [xbp-14h]
  int *p; // [xsp+20h] [xbp-10h]

  p = (int *)malloc(0x14u);
  if ( !p )
    return -1;
  for ( i = 0; i < 5; ++i )
    p[i] = i + 1;
  v4 = p[2];
  v0 = realloc(p, 0x28u);
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
    free(p);
    return -2;
  }
}


/* Function: heap_array @ 0x1310 */
int __cdecl heap_array(int n)
{
  int v2; // [xsp+8h] [xbp-18h]
  int i; // [xsp+Ch] [xbp-14h]
  _DWORD *ptr; // [xsp+10h] [xbp-10h]

  ptr = malloc(4LL * n);
  if ( !ptr )
    return -1;
  for ( i = 0; i < n; ++i )
    ptr[i] = 3 * i;
  v2 = ptr[n / 2];
  free(ptr);
  return v2;
}


/* Function: heap_struct @ 0x13CC */
int __cdecl heap_struct(int x)
{
  int v2; // [xsp+Ch] [xbp-14h]
  _DWORD *ptr; // [xsp+10h] [xbp-10h]

  ptr = malloc(8u);
  if ( !ptr )
    return -1;
  *ptr = x;
  ptr[1] = 2 * x;
  v2 = *ptr + ptr[1];
  free(ptr);
  return v2;
}


/* Function: heap_nested @ 0x1458 */
__int64 __fastcall heap_nested(Node **head)
{
  *head = (Node *)malloc(0x10u);
  if ( *head )
  {
    (*head)->data = 10;
    (*head)->next = (Node *)malloc(0x10u);
    if ( (*head)->next )
    {
      (*head)->next->data = 20;
      (*head)->next->next = 0;
      return 0;
    }
    else
    {
      free(*head);
      return (unsigned int)-2;
    }
  }
  else
  {
    return (unsigned int)-1;
  }
}


/* Function: linked_list_heap @ 0x1520 */
int __cdecl linked_list_heap()
{
  Node *v1; // [xsp+8h] [xbp-48h]
  Node *j; // [xsp+10h] [xbp-40h]
  int v3; // [xsp+1Ch] [xbp-34h]
  Node *ptr; // [xsp+20h] [xbp-30h]
  Node *v5; // [xsp+28h] [xbp-28h]
  int i; // [xsp+34h] [xbp-1Ch]
  Node *current; // [xsp+38h] [xbp-18h]
  Node *head; // [xsp+40h] [xbp-10h]

  head = 0;
  current = 0;
  for ( i = 0; ; ++i )
  {
    if ( i >= 5 )
    {
      v3 = 0;
      for ( j = head; j; j = j->next )
        v3 += j->data;
      while ( head )
      {
        v1 = head;
        head = head->next;
        free(v1);
      }
      return v3;
    }
    v5 = (Node *)malloc(0x10u);
    if ( !v5 )
      break;
    v5->data = 10 * i;
    v5->next = 0;
    if ( head )
      current->next = v5;
    else
      head = v5;
    current = v5;
  }
  while ( head )
  {
    ptr = head;
    head = head->next;
    free(ptr);
  }
  return -1;
}


/* Function: create_tree_node @ 0x1694 */
TreeNode *__cdecl create_tree_node(int data)
{
  TreeNode *v2; // [xsp+0h] [xbp-10h]

  v2 = (TreeNode *)malloc(0x18u);
  if ( v2 )
  {
    v2->data = data;
    v2->left = 0;
    v2->right = 0;
  }
  return v2;
}


/* Function: tree_heap_traversal @ 0x16EC */
int __cdecl tree_heap_traversal()
{
  int v1; // [xsp+Ch] [xbp-14h]
  TreeNode *ptr; // [xsp+10h] [xbp-10h]

  ptr = create_tree_node(10);
  if ( !ptr )
    return -1;
  ptr->left = create_tree_node(20);
  ptr->right = create_tree_node(30);
  if ( ptr->left && ptr->right )
  {
    v1 = ptr->data + ptr->left->data + ptr->right->data;
    free(ptr->left);
    free(ptr->right);
    free(ptr);
    return v1;
  }
  else
  {
    if ( ptr->left )
      free(ptr->left);
    if ( ptr->right )
      free(ptr->right);
    free(ptr);
    return -2;
  }
}


/* Function: memory_leak @ 0x1818 */
int __cdecl memory_leak(int n)
{
  int i; // [xsp+Ch] [xbp-14h]
  _DWORD *v3; // [xsp+10h] [xbp-10h]

  v3 = malloc(4LL * n);
  if ( !v3 )
    return -1;
  for ( i = 0; i < n; ++i )
    v3[i] = i;
  return v3[n / 2];
}


/* Function: dangling_pointer @ 0x18BC */
int __cdecl dangling_pointer()
{
  _DWORD *ptr; // [xsp+10h] [xbp-10h]

  ptr = malloc(4u);
  if ( !ptr )
    return -1;
  *ptr = 42;
  printf("value before free: %d\n", *ptr);
  free(ptr);
  return *ptr;
}


/* Function: double_free @ 0x1944 */
__int64 __fastcall double_free(unsigned int *p)
{
  _DWORD *ptr; // [xsp+8h] [xbp-18h]

  if ( p )
  {
    return *p;
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
int __cdecl heap_overflow()
{
  int v1; // [xsp+8h] [xbp-18h]
  int i; // [xsp+Ch] [xbp-14h]
  int *ptr; // [xsp+10h] [xbp-10h]

  ptr = (int *)malloc(0x28u);
  if ( !ptr )
    return -1;
  for ( i = 0; i <= 10; ++i )
    ptr[i] = 100 * i;
  v1 = *ptr;
  free(ptr);
  return v1;
}


/* Function: test_heap_memory @ 0x1A70 */
void __cdecl test_heap_memory()
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
  pid_t pid; // [xsp+14h] [xbp-Ch]
  Node *head; // [xsp+18h] [xbp-8h] BYREF

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
  head = 0;
  v5 = heap_nested(&head);
  printf("HEAP-L2-06 (heap_nested): %d\n", v5);
  if ( head )
  {
    free(*(void **)&byte_8[(_QWORD)head]);
    free(head);
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
    v10 = dangling_pointer();
    printf(aD, v10);
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
        printf(byte_29EC, stat_loc & 0x7F);
    }
    else
    {
      printf(byte_29C7, (stat_loc & 0xFF00) >> 8);
    }
  }
}


/* Function: global_var_access @ 0x1C70 */
int __cdecl global_var_access()
{
  return ++global_counter;
}


/* Function: global_var_read @ 0x1C88 */
int __cdecl global_var_read()
{
  return 2 * global_counter;
}


/* Function: global_array_access @ 0x1C98 */
int __cdecl global_array_access(int idx)
{
  if ( idx < 0 || idx >= 10 )
    return -1;
  else
    return global_array[idx];
}


/* Function: static_local @ 0x1CEC */
int __cdecl static_local(int reset)
{
  if ( !reset )
    return ++static_local_counter;
  static_local_counter = 0;
  return 0;
}


/* Function: call_static_func @ 0x1D38 */
int __cdecl call_static_func(int x)
{
  return static_helper(x) + 1;
}


/* Function: static_helper @ 0x1D60 */
int __cdecl static_helper(int x)
{
  return 2 * x;
}


/* Function: access_extern_global @ 0x1D78 */
int __cdecl access_extern_global()
{
  return extern_global_var + 100;
}


/* Function: call_extern_func @ 0x1D8C */
int __cdecl call_extern_func()
{
  return extern_function(5);
}


/* Function: read_const_data @ 0x1DA4 */
int __cdecl read_const_data()
{
  return (unsigned __int8)const_string[4] + 42;
}


/* Function: access_bss_var @ 0x1DB8 */
int __cdecl access_bss_var()
{
  return bss_var;
}


/* Function: access_bss_buffer @ 0x1DC4 */
int __cdecl access_bss_buffer()
{
  return (unsigned __int8)bss_buffer;
}


/* Function: global_struct_access @ 0x1DD0 */
int __cdecl global_struct_access()
{
  return global_point + dword_140D4;
}


/* Function: set_file_static @ 0x1DEC */
void __cdecl set_file_static(int val)
{
  file_scope_static = val;
}


/* Function: get_file_static @ 0x1E08 */
int __cdecl get_file_static()
{
  return file_scope_static;
}


/* Function: set_global_callback @ 0x1E14 */
void __cdecl set_global_callback(int (*f)(int))
{
  global_func_ptr = f;
}


/* Function: call_global_callback @ 0x1E30 */
__int64 __fastcall call_global_callback(unsigned int x)
{
  if ( global_func_ptr )
    return (unsigned int)global_func_ptr(x);
  else
    return (unsigned int)-1;
}


/* Function: global_heap_store @ 0x1E84 */
int __cdecl global_heap_store(int *p)
{
  global_heap_ptr = (__int64)p;
  if ( p )
    return *(_DWORD *)global_heap_ptr;
  else
    return -1;
}


/* Function: static_complex_init @ 0x1ED0 */
int __cdecl static_complex_init()
{
  return complex_init + dword_140E4 + dword_140EC;
}


/* Function: tls_access @ 0x1EF4 */
int __cdecl tls_access(int val)
{
  int *v1; // x8

  v1 = (int *)(_ReadStatusReg(TPIDR_EL0) + 16);
  *v1 = val;
  return 2 * *v1;
}


/* Function: init_order_test @ 0x1F20 */
int __cdecl init_order_test()
{
  int external_val; // [xsp+Ch] [xbp-4h] BYREF

  external_val = 20;
  return init_depends_on(&external_val);
}


/* Function: init_depends_on @ 0x1F48 */
int __cdecl init_depends_on(int *p)
{
  if ( p )
    init_depends_on_static_depends = *p;
  return init_depends_on_static_depends;
}


/* Function: test_static_global @ 0x1F80 */
void __cdecl test_static_global()
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
  int heap_val; // [xsp+1Ch] [xbp-4h] BYREF

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
  set_global_callback((int (*)(int))double_value);
  v13 = call_global_callback(5u);
  printf("STM-L2-07 (global_func_ptr): %d\n", v13);
  heap_val = 100;
  v14 = global_heap_store(&heap_val);
  printf("STM-L2-08 (global_heap_store): %d\n", v14);
  v15 = static_complex_init();
  printf("STM-L2-09 (static_complex_init): %d\n", v15);
  v16 = tls_access(10);
  printf("STM-L3-01 (tls_access): %d\n", v16);
  inited = init_order_test();
  printf("STM-L3-02 (init_order_test): %d\n", inited);
}


/* Function: double_value @ 0x2154 */
int __cdecl double_value(int x)
{
  return 2 * x;
}


/* Function: memop_memset @ 0x216C */
__int64 __fastcall memop_memset(unsigned __int8 *buf, size_t size, int fill_value)
{
  if ( buf && size )
  {
    memset(buf, fill_value, size);
    return *buf;
  }
  else
  {
    return (unsigned int)-1;
  }
}


/* Function: memop_memcpy @ 0x21D8 */
__int64 __fastcall memop_memcpy(void *dst, const void *src, size_t n)
{
  if ( dst && src && n )
  {
    memcpy(dst, src, n);
    return (unsigned int)*((_DWORD *)dst + n / 4 - 1);
  }
  else
  {
    return (unsigned int)-1;
  }
}


/* Function: memop_memmove @ 0x2260 */
__int64 __fastcall memop_memmove(char *buf, size_t n)
{
  if ( buf && n >= 2 )
  {
    memmove(buf + 1, buf, n - 1);
    return (unsigned __int8)buf[1];
  }
  else
  {
    return (unsigned int)-1;
  }
}


/* Function: memop_memcmp @ 0x22D4 */
__int64 __fastcall memop_memcmp(const void *p1, const void *p2, size_t n)
{
  int v6; // [xsp+Ch] [xbp-24h]

  if ( p1 && p2 && n )
  {
    v6 = memcmp(p1, p2, n);
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
__int64 __fastcall memop_bzero(unsigned __int8 *buf, size_t n)
{
  if ( buf )
  {
    memset(buf, 0, n);
    return *buf;
  }
  else
  {
    return (unsigned int)-1;
  }
}


/* Function: memop_bcopy @ 0x23D8 */
__int64 __fastcall memop_bcopy(const void *src, unsigned __int8 *dst, size_t n)
{
  if ( src && dst && n )
  {
    bcopy(src, dst, n);
    return *dst;
  }
  else
  {
    return (unsigned int)-1;
  }
}


/* Function: memop_unaligned_access @ 0x2450 */
int __cdecl memop_unaligned_access(const char *buf)
{
  if ( buf )
    return *(_DWORD *)(buf + 1);
  else
    return -1;
}


/* Function: memop_memory_barrier @ 0x2494 */
int __cdecl memop_memory_barrier(volatile int *flag)
{
  volatile int v2; // [xsp+Ch] [xbp-14h]

  if ( !flag )
    return -1;
  v2 = *flag;
  __dmb(0xBu);
  return v2 + *flag;
}


/* Function: test_memory_op_functions @ 0x24E8 */
void __cdecl test_memory_op_functions()
{
  int v0; // w0
  int v1; // w0
  unsigned int v2; // w0
  int v3; // w0
  int v4; // w0
  int v5; // w0
  int v6; // w0
  int v7; // w0
  int flag; // [xsp+24h] [xbp-18Ch] BYREF
  char v9[12]; // [xsp+28h] [xbp-188h] BYREF
  int v10; // [xsp+34h] [xbp-17Ch] BYREF
  int v11; // [xsp+38h] [xbp-178h] BYREF
  unsigned __int8 v12[10]; // [xsp+3Eh] [xbp-172h] BYREF
  __int64 p2; // [xsp+48h] [xbp-168h] BYREF
  int v14; // [xsp+50h] [xbp-160h]
  __int64 p1; // [xsp+58h] [xbp-158h] BYREF
  int v16; // [xsp+60h] [xbp-150h]
  char v17[16]; // [xsp+68h] [xbp-148h] BYREF
  _QWORD v18[2]; // [xsp+78h] [xbp-138h] BYREF
  int v19; // [xsp+88h] [xbp-128h]
  __int128 v20; // [xsp+90h] [xbp-120h] BYREF
  int v21; // [xsp+A0h] [xbp-110h]
  unsigned __int8 buf[256]; // [xsp+B0h] [xbp-100h] BYREF

  printf(asc_2CA6);
  v20 = xmmword_2D58;
  v21 = 50;
  v18[0] = 0;
  v18[1] = 0;
  v19 = 0;
  v0 = memop_memset(buf, 0xAu, 65);
  printf("MEMOP-L2-01: %d\n", v0);
  v1 = memop_memcpy(v18, &v20, 0x14u);
  printf("MEMOP-L2-02: %d\n", v1);
  strcpy(v17, "HelloWorld");
  v2 = memop_memmove(v17, 0xAu);
  printf("MEMOP-L2-03: %c\n", v2);
  p1 = 0x200000001LL;
  v16 = 3;
  p2 = 0x200000001LL;
  v14 = 4;
  v3 = memop_memcmp(&p1, &p2, 0xCu);
  printf("MEMOP-L2-04: %d\n", v3);
  v4 = memop_bzero(v12, 0xAu);
  printf("MEMOP-L2-05: %d\n", v4);
  v11 = 67305985;
  v10 = 0;
  v5 = memop_bcopy(&v11, (unsigned __int8 *)&v10, 4u);
  printf("MEMOP-L2-06: %d\n", v5);
  *(_QWORD *)v9 = 0x706050403020100LL;
  v6 = memop_unaligned_access(v9);
  printf("MEMOP-L3-01: 0x%x\n", v6);
  flag = 5;
  v7 = memop_memory_barrier(&flag);
  printf("MEMOP-L3-02: %d\n", v7);
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
int __cdecl extern_function(int x)
{
  return 3 * x;
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
