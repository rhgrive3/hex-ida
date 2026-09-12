/* Owned synthetic microcases. No engine output serves as ground truth. */
typedef unsigned long long u64;
struct Pair { u64 left, right; };
extern void *malloc(unsigned long);
extern void free(void *);
__attribute__((noinline)) u64 bv_wrap(u64 x) { return x + 7ULL; }
__attribute__((noinline)) u64 alias_subobject(struct Pair *p) { p->left = 1; p->right = 2; return p->left; }
__attribute__((noinline)) u64 reaching_store(u64 *p, u64 x) { *p = x; return *p; }
__attribute__((noinline)) void source_sink(u64 *sink, u64 input) { *sink = input; }
__attribute__((noinline)) int length_buffer(unsigned char *p, unsigned long n) { if (n < 8) return 0; p[7] = 1; return 1; }
__attribute__((noinline)) int allocation_guard(unsigned long n) { void *p = malloc(n); if (!p) return 0; free(p); return 1; }
__attribute__((noinline)) u64 register_dispatch(u64 (*f)(u64), u64 x) { return f(x); }
