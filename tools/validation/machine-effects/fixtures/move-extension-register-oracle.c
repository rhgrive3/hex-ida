#include <inttypes.h>
#include <stdint.h>
#include <stdio.h>

/* Read-only register semantics probe, not a full ISA/flags oracle. */
#define CHECK(NAME, BYTES, EXPECTED) do { \
  uint64_t actual = initial; \
  __asm__ volatile(BYTES : "+a"(actual) : "b"(source) : "cc"); \
  const uint64_t expected = (EXPECTED); \
  if (actual != expected) { \
    fprintf(stderr, "%s: initial=%016" PRIx64 " source=%016" PRIx64 \
      " actual=%016" PRIx64 " expected=%016" PRIx64 "\n", \
      NAME, initial, source, actual, expected); \
    return 1; \
  } \
  ++cases; \
} while (0)

int main(void) {
  const uint64_t sources[] = {0, 0x7fff, 0x8000, 0xffff,
    UINT64_C(0x7fffffff), UINT64_C(0x80000000), UINT64_C(0xffffffffffffffff)};
  const uint64_t initials[] = {0, UINT64_C(0x123456789abcdef0), UINT64_C(0xffffffffffffffff)};
  unsigned cases = 0;
  for (unsigned i = 0; i < sizeof(initials) / sizeof(initials[0]); ++i) {
    for (unsigned j = 0; j < sizeof(sources) / sizeof(sources[0]); ++j) {
      const uint64_t initial = initials[i], source = sources[j];
      const uint64_t word = (initial & ~UINT64_C(0xffff)) | (source & UINT64_C(0xffff));
      CHECK("movzx16", ".byte 0x66,0x0f,0xb7,0xc3", word);
      CHECK("movsx16", ".byte 0x66,0x0f,0xbf,0xc3", word);
      CHECK("movsxd16", ".byte 0x66,0x63,0xc3", word);
      CHECK("movsxd32", ".byte 0x63,0xc3", (uint64_t)(uint32_t)source);
      CHECK("movsxd64", ".byte 0x48,0x63,0xc3", (uint64_t)(int64_t)(int32_t)source);
    }
  }
  printf("native x86 move-extension RAX projection: PASS (%u cases, 5 byte sequences)\n", cases);
  return 0;
}
