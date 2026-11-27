// Freestanding WASM32 integration of upstream LLVM ItaniumDemangle.h & RustDemangle.cpp
// (third_party/llvm-demangle/, Apache-2.0 WITH LLVM-exception).
// Compiles under: clang++ --target=wasm32 -std=c++20 -Os -nostdlib -fno-exceptions -fno-rtti -mbulk-memory
// Produces 0 external WASM imports, zero libc dependency, zero shared-scratch mutation.

#include "hex_demangle.hpp"
#include "hex_core/types.hpp"

#include <limits.h>
#include <stddef.h>
#include <stdint.h>

// ============================================================================
// 1. Bounded Static Arenas & Dedicated Fixed I/O Buffers (Zero WASM Imports)
// ============================================================================
namespace hex_demangle_detail {

constexpr size_t   kOutputBufCap        = 16384u;
constexpr size_t   kAstArenaCap         = 256u * 1024u;
constexpr size_t   kHeapArenaCap        = 256u * 1024u;
constexpr uint32_t kMaxInputLen         = 2048u;
constexpr uint32_t kIoOutBufCap         = 8192u;
constexpr uint32_t kMaxItaniumDepth     = 32u;
constexpr uint32_t kMaxItaniumSubstRefs = 64u;
constexpr uint32_t kMaxRustV0Depth      = 40u;

alignas(8) static char     g_out_buf[kOutputBufCap];
alignas(8) static uint8_t  g_ast_arena[kAstArenaCap];
alignas(8) static uint8_t  g_heap_arena[kHeapArenaCap];
alignas(8) static uint8_t  g_io_in_buf[kMaxInputLen];
alignas(8) static uint8_t  g_io_out_buf[kIoOutBufCap];
alignas(4) static uint32_t g_io_out_len = 0u;

static size_t g_ast_cursor = 0u;
static size_t g_heap_cursor = 0u;
static bool   g_arena_oom = false;
static bool   g_out_overflowed = false;

inline void reset_arenas() {
  g_ast_cursor = 0u;
  g_heap_cursor = 0u;
  g_arena_oom = false;
  g_out_overflowed = false;
}

inline void* heap_alloc(size_t sz) {
  if (sz == 0u) sz = 1u;
  const size_t aligned = (g_heap_cursor + 7u) & ~size_t(7u);
  if (aligned > kHeapArenaCap || sz > kHeapArenaCap - aligned || 8u > kHeapArenaCap - aligned - sz) {
    g_arena_oom = true;
    return nullptr;
  }
  uint8_t* hdr = g_heap_arena + aligned;
  const uint64_t stored_sz = static_cast<uint64_t>(sz);
  hex::mem_copy(hdr, &stored_sz, 8u);
  g_heap_cursor = aligned + 8u + sz;
  return hdr + 8u;
}

inline void* heap_realloc(void* ptr, size_t new_sz) {
  if (ptr == nullptr) return heap_alloc(new_sz);
  const uint8_t* old_p = static_cast<const uint8_t*>(ptr);
  uint64_t old_sz = 0u;
  if (old_p >= g_heap_arena + 8u && old_p < g_heap_arena + kHeapArenaCap) {
    hex::mem_copy(&old_sz, old_p - 8u, 8u);
  }
  void* np = heap_alloc(new_sz);
  if (np == nullptr) return nullptr;
  const size_t copy_n = (static_cast<size_t>(old_sz) < new_sz) ? static_cast<size_t>(old_sz) : new_sz;
  if (copy_n > 0u) hex::mem_copy(np, ptr, copy_n);
  return np;
}

inline void heap_free(void*) {
  // Bump arena: reclaimed in O(1) by reset_arenas() on next hex_demangle_symbol call.
}

}  // namespace hex_demangle_detail

// ============================================================================
// 2. Freestanding std:: Shim for wasm32 -nostdlib
// ============================================================================
#if defined(__wasm__) || defined(HEX_DEMANGLE_FREESTANDING_STD)

inline void* operator new(size_t, void* p) noexcept { return p; }
inline void* operator new[](size_t, void* p) noexcept { return p; }
void operator delete(void*) noexcept {}
void operator delete(void*, size_t) noexcept {}
void operator delete[](void*) noexcept {}
void operator delete[](void*, size_t) noexcept {}

#ifndef assert
#define assert(x) ((void)0)
#endif

inline int isdigit(int c) { return (c >= '0' && c <= '9') ? 1 : 0; }

inline int snprintf(char* buf, size_t cap, const char*, double val) {
  if (cap == 0u) return 0;
  uint64_t bits = 0;
  hex::mem_copy(&bits, &val, 8u);
  static constexpr char kHex[] = "0123456789abcdef";
  size_t pos = 0;
  auto put = [&](char c) { if (pos + 1u < cap) buf[pos++] = c; };
  put('0'); put('x');
  for (int sh = 60; sh >= 0; sh -= 4) put(kHex[(bits >> sh) & 0xFu]);
  buf[pos] = '\0';
  return static_cast<int>(pos);
}

inline int snprintf(char* buf, size_t cap, const char*, long double val) {
  if (cap == 0u) return 0;
  uint8_t raw[sizeof(long double)];
  hex::mem_copy(raw, &val, sizeof(long double));
  static constexpr char kHex[] = "0123456789abcdef";
  size_t pos = 0;
  auto put = [&](char c) { if (pos + 1u < cap) buf[pos++] = c; };
  put('0'); put('x');
  for (size_t i = sizeof(long double); i > 0u; --i) {
    const uint8_t b = raw[i - 1u];
    put(kHex[(b >> 4u) & 0xFu]);
    put(kHex[b & 0xFu]);
  }
  buf[pos] = '\0';
  return static_cast<int>(pos);
}

namespace std {

using ::size_t;
using ::ptrdiff_t;
using ::uint8_t;
using ::uint16_t;
using ::uint32_t;
using ::uint64_t;
using ::int8_t;
using ::int16_t;
using ::int32_t;
using ::int64_t;
using nullptr_t = decltype(nullptr);

inline void* memcpy(void* d, const void* s, size_t n) { hex::mem_copy(d, s, n); return d; }
inline void* memmove(void* d, const void* s, size_t n) { hex::mem_move(d, s, n); return d; }
inline void* memset(void* d, int c, size_t n) { hex::mem_set(d, c, n); return d; }
inline int   memcmp(const void* a, const void* b, size_t n) { return hex::mem_cmp(a, b, n); }
inline size_t strlen(const char* s) {
  size_t n = 0;
  while (s[n] != '\0') ++n;
  return n;
}
inline int strncmp(const char* a, const char* b, size_t n) {
  for (size_t i = 0; i < n; ++i) {
    if (a[i] != b[i] || a[i] == '\0') {
      return static_cast<unsigned char>(a[i]) - static_cast<unsigned char>(b[i]);
    }
  }
  return 0;
}

inline void* malloc(size_t sz) { return hex_demangle_detail::heap_alloc(sz); }
inline void* realloc(void* p, size_t sz) { return hex_demangle_detail::heap_realloc(p, sz); }
inline void  free(void* p) { hex_demangle_detail::heap_free(p); }
[[noreturn]] inline void abort() { __builtin_trap(); }

using ::isdigit;
inline long long abs(long long x) { return x < 0 ? -x : x; }

template <class T> struct remove_reference { using type = T; };
template <class T> struct remove_reference<T&> { using type = T; };
template <class T> struct remove_reference<T&&> { using type = T; };
template <class T> using remove_reference_t = typename remove_reference<T>::type;

template <class T> struct remove_cv { using type = T; };
template <class T> struct remove_cv<const T> { using type = T; };
template <class T> struct remove_cv<volatile T> { using type = T; };
template <class T> struct remove_cv<const volatile T> { using type = T; };
template <class T> using decay_t = typename remove_cv<remove_reference_t<T>>::type;

template <class T>
constexpr remove_reference_t<T>&& move(T&& t) noexcept {
  return static_cast<remove_reference_t<T>&&>(t);
}

template <class T>
constexpr T&& forward(remove_reference_t<T>& t) noexcept {
  return static_cast<T&&>(t);
}
template <class T>
constexpr T&& forward(remove_reference_t<T>&& t) noexcept {
  return static_cast<T&&>(t);
}

template <class T>
constexpr void swap(T& a, T& b) noexcept {
  T tmp = std::move(a);
  a = std::move(b);
  b = std::move(tmp);
}

template <class T>
constexpr const T& min(const T& a, const T& b) {
  return (b < a) ? b : a;
}

template <class T>
constexpr const T& max(const T& a, const T& b) {
  return (a < b) ? b : a;
}

template <class InputIt, class OutputIt>
OutputIt copy(InputIt first, InputIt last, OutputIt d_first) {
  while (first != last) *d_first++ = *first++;
  return d_first;
}

template <class BidirIt>
void reverse(BidirIt first, BidirIt last) {
  while (first != last && first != --last) {
    std::swap(*first, *last);
    ++first;
  }
}

template <class InputIt, class UnaryPred>
bool all_of(InputIt first, InputIt last, UnaryPred p) {
  for (; first != last; ++first) {
    if (!p(*first)) return false;
  }
  return true;
}

template <class ForwardIt, class T>
ForwardIt remove(ForwardIt first, ForwardIt last, const T& value) {
  ForwardIt out = first;
  for (; first != last; ++first) {
    if (!(*first == value)) {
      if (out != first) *out = std::move(*first);
      ++out;
    }
  }
  return out;
}

template <class T> struct is_trivially_copyable {
  static constexpr bool value = __is_trivially_copyable(T);
};
template <class T> inline constexpr bool is_trivially_copyable_v = is_trivially_copyable<T>::value;

template <class T> struct is_trivially_default_constructible {
  static constexpr bool value = __is_trivially_constructible(T);
};
template <class T> inline constexpr bool is_trivially_default_constructible_v =
    is_trivially_default_constructible<T>::value;

template <class T, class U>
struct pair {
  T first;
  U second;
  constexpr pair() = default;
  constexpr pair(const T& a, const U& b) : first(a), second(b) {}
  template <class A, class B>
  constexpr pair(A&& a, B&& b) : first(std::forward<A>(a)), second(std::forward<B>(b)) {}
};

template <class T, class U>
constexpr pair<decay_t<T>, decay_t<U>> make_pair(T&& a, U&& b) {
  return pair<decay_t<T>, decay_t<U>>(std::forward<T>(a), std::forward<U>(b));
}

template <class T, size_t N>
struct array {
  T data_[N];
  constexpr T* data() noexcept { return data_; }
  constexpr const T* data() const noexcept { return data_; }
  constexpr size_t size() const noexcept { return N; }
  constexpr T& operator[](size_t i) noexcept { return data_[i]; }
  constexpr const T& operator[](size_t i) const noexcept { return data_[i]; }
};

template <class T> struct numeric_limits;
template <> struct numeric_limits<unsigned int> {
  static constexpr unsigned int max() noexcept { return 0xFFFFFFFFu; }
  static constexpr unsigned int min() noexcept { return 0u; }
};
template <> struct numeric_limits<int> {
  static constexpr int max() noexcept { return 2147483647; }
  static constexpr int min() noexcept { return -2147483647 - 1; }
};
template <> struct numeric_limits<unsigned long> {
  static constexpr unsigned long max() noexcept { return ~0UL; }
  static constexpr unsigned long min() noexcept { return 0UL; }
};
template <> struct numeric_limits<unsigned long long> {
  static constexpr unsigned long long max() noexcept { return 0xFFFFFFFFFFFFFFFFULL; }
  static constexpr unsigned long long min() noexcept { return 0ULL; }
};
template <> struct numeric_limits<uint16_t> {
  static constexpr uint16_t max() noexcept { return 0xFFFFu; }
  static constexpr uint16_t min() noexcept { return 0u; }
};

class string_view {
 public:
  using value_type = char;
  using const_iterator = const char*;
  using iterator = const char*;
  static constexpr size_t npos = static_cast<size_t>(-1);

  constexpr string_view() noexcept : data_(nullptr), size_(0) {}
  constexpr string_view(const char* s, size_t n) noexcept : data_(s), size_(n) {}
  constexpr string_view(const char* s) noexcept : data_(s), size_(s ? cstr_len(s) : 0) {}

  constexpr const char* data() const noexcept { return data_; }
  constexpr size_t size() const noexcept { return size_; }
  constexpr size_t length() const noexcept { return size_; }
  constexpr bool empty() const noexcept { return size_ == 0; }
  constexpr const char* begin() const noexcept { return data_; }
  constexpr const char* end() const noexcept { return data_ + size_; }
  constexpr const char* rbegin() const noexcept { return size_ > 0u ? (data_ + size_ - 1u) : data_; }
  constexpr char operator[](size_t i) const noexcept { return data_[i]; }
  constexpr char front() const noexcept { return data_[0]; }
  constexpr char back() const noexcept { return data_[size_ - 1]; }

  constexpr void remove_prefix(size_t n) noexcept {
    if (n > size_) n = size_;
    data_ += n;
    size_ -= n;
  }
  constexpr void remove_suffix(size_t n) noexcept {
    if (n > size_) n = size_;
    size_ -= n;
  }

  constexpr string_view substr(size_t pos = 0, size_t count = npos) const noexcept {
    if (pos >= size_) return string_view(data_ + size_, 0);
    const size_t avail = size_ - pos;
    return string_view(data_ + pos, count < avail ? count : avail);
  }

  constexpr size_t find(char c, size_t pos = 0) const noexcept {
    for (size_t i = pos; i < size_; ++i) {
      if (data_[i] == c) return i;
    }
    return npos;
  }

  constexpr size_t find(string_view s, size_t pos = 0) const noexcept {
    if (s.size_ == 0) return pos <= size_ ? pos : npos;
    if (pos >= size_ || s.size_ > size_ - pos) return npos;
    for (size_t i = pos; i <= size_ - s.size_; ++i) {
      bool ok = true;
      for (size_t j = 0; j < s.size_; ++j) {
        if (data_[i + j] != s.data_[j]) { ok = false; break; }
      }
      if (ok) return i;
    }
    return npos;
  }

  constexpr bool starts_with(char c) const noexcept {
    return size_ > 0 && data_[0] == c;
  }
  constexpr bool starts_with(string_view s) const noexcept {
    if (s.size_ > size_) return false;
    for (size_t i = 0; i < s.size_; ++i) {
      if (data_[i] != s.data_[i]) return false;
    }
    return true;
  }

  friend constexpr bool operator==(string_view a, string_view b) noexcept {
    if (a.size_ != b.size_) return false;
    for (size_t i = 0; i < a.size_; ++i) {
      if (a.data_[i] != b.data_[i]) return false;
    }
    return true;
  }
  friend constexpr bool operator!=(string_view a, string_view b) noexcept {
    return !(a == b);
  }

 private:
  static constexpr size_t cstr_len(const char* s) noexcept {
    size_t n = 0;
    while (s[n] != '\0') ++n;
    return n;
  }

  const char* data_;
  size_t size_;
};

}  // namespace std

#endif  // __wasm__ || HEX_DEMANGLE_FREESTANDING_STD

// ============================================================================
// 3. Pre-define LLVM DemangleConfig, StringViewExtras, Utility (Zero-Malloc OutputBuffer),
//    and Demangle.h guards before #including upstream LLVM sources.
// ============================================================================
#define LLVM_DEMANGLE_DEMANGLECONFIG_H
#define DEMANGLE_STRINGVIEW_H
#define DEMANGLE_UTILITY_H
#define LLVM_DEMANGLE_DEMANGLE_H
#define NDEBUG 1

#define DEMANGLE_ATTRIBUTE_USED
#define DEMANGLE_UNREACHABLE __builtin_unreachable()
#define DEMANGLE_ATTRIBUTE_NOINLINE __attribute__((noinline))
#define DEMANGLE_DUMP_METHOD
#define DEMANGLE_FALLTHROUGH [[fallthrough]]
#define DEMANGLE_ASSERT(__expr, __msg) ((void)0)
#define DEMANGLE_NAMESPACE_BEGIN namespace llvm { namespace itanium_demangle {
#define DEMANGLE_NAMESPACE_END } }
#define DEMANGLE_ABI

namespace llvm {
char* rustDemangle(std::string_view MangledName);
}  // namespace llvm

DEMANGLE_NAMESPACE_BEGIN

class Node;

inline bool starts_with(std::string_view self, char C) noexcept {
  return !self.empty() && *self.begin() == C;
}

inline bool starts_with(std::string_view haystack, std::string_view needle) noexcept {
  if (needle.size() > haystack.size()) return false;
  haystack.remove_suffix(haystack.size() - needle.size());
  return haystack == needle;
}

// Bounds-checked, zero-malloc OutputBuffer backed by hex_demangle_detail::g_out_buf.
// Never calls realloc() or abort(); records truncation in both Overflowed and g_out_overflowed.
class OutputBuffer {
  char* Buffer = hex_demangle_detail::g_out_buf;
  size_t CurrentPosition = 0;
  size_t BufferCapacity = hex_demangle_detail::kOutputBufCap - 1u;
  bool Overflowed = false;

  void markOverflow() {
    Overflowed = true;
    hex_demangle_detail::g_out_overflowed = true;
  }

  OutputBuffer& writeUnsigned(uint64_t N, bool isNeg = false) {
    char Temp[24];
    char* TempPtr = Temp + sizeof(Temp);
    do {
      *--TempPtr = static_cast<char>('0' + (N % 10u));
      N /= 10u;
    } while (N);
    if (isNeg) *--TempPtr = '-';
    return operator+=(std::string_view(TempPtr, static_cast<size_t>((Temp + sizeof(Temp)) - TempPtr)));
  }

 public:
  OutputBuffer(char* StartBuf, size_t Size)
      : Buffer(StartBuf ? StartBuf : hex_demangle_detail::g_out_buf),
        BufferCapacity(StartBuf ? (Size > 0 ? Size - 1u : 0u) : (hex_demangle_detail::kOutputBufCap - 1u)) {}
  OutputBuffer() = default;
  OutputBuffer(const OutputBuffer&) = delete;
  OutputBuffer& operator=(const OutputBuffer&) = delete;
  ~OutputBuffer() = default;

  operator std::string_view() const { return std::string_view(Buffer, CurrentPosition); }

  void printLeft(const Node& N);
  void printRight(const Node& N);

  unsigned CurrentPackIndex = std::numeric_limits<unsigned>::max();
  unsigned CurrentPackMax = std::numeric_limits<unsigned>::max();

  struct {
    unsigned ParenDepth = 0;
    bool InsideTemplate = false;
  } TemplateTracker;

  bool isInParensInTemplateArgs() const { return TemplateTracker.ParenDepth > 0; }
  bool isInsideTemplateArgs() const { return TemplateTracker.InsideTemplate; }

  void printOpen(char Open = '(') {
    if (isInsideTemplateArgs()) TemplateTracker.ParenDepth++;
    *this += Open;
  }
  void printClose(char Close = ')') {
    if (isInsideTemplateArgs()) TemplateTracker.ParenDepth--;
    *this += Close;
  }

  OutputBuffer& operator+=(std::string_view R) {
    const size_t Size = R.size();
    if (Size == 0u) return *this;
    const size_t avail = (CurrentPosition < BufferCapacity) ? (BufferCapacity - CurrentPosition) : 0u;
    if (Size > avail) {
      markOverflow();
      if (avail > 0u) {
        hex::mem_copy(Buffer + CurrentPosition, R.data(), avail);
        CurrentPosition += avail;
      }
      return *this;
    }
    hex::mem_copy(Buffer + CurrentPosition, R.data(), Size);
    CurrentPosition += Size;
    return *this;
  }

  OutputBuffer& operator+=(char C) {
    if (CurrentPosition < BufferCapacity) {
      Buffer[CurrentPosition++] = C;
    } else if (C != '\0') {
      markOverflow();
    }
    return *this;
  }

  OutputBuffer& prepend(std::string_view R) {
    const size_t Size = R.size();
    if (Size == 0u) return *this;
    if (Size > BufferCapacity) {
      markOverflow();
      hex::mem_copy(Buffer, R.data(), BufferCapacity);
      CurrentPosition = BufferCapacity;
      return *this;
    }
    const size_t keep = (CurrentPosition + Size <= BufferCapacity)
                            ? CurrentPosition
                            : (BufferCapacity - Size);
    if (keep < CurrentPosition) markOverflow();
    if (keep > 0u) hex::mem_move(Buffer + Size, Buffer, keep);
    hex::mem_copy(Buffer, R.data(), Size);
    CurrentPosition = Size + keep;
    return *this;
  }

  OutputBuffer& operator<<(std::string_view R) { return (*this += R); }
  OutputBuffer& operator<<(char C) { return (*this += C); }
  OutputBuffer& operator<<(long long N) {
    const uint64_t mag = (N < 0) ? (static_cast<uint64_t>(-(N + 1)) + 1ULL) : static_cast<uint64_t>(N);
    return writeUnsigned(mag, N < 0);
  }
  OutputBuffer& operator<<(unsigned long long N) { return writeUnsigned(N, false); }
  OutputBuffer& operator<<(long N) { return this->operator<<(static_cast<long long>(N)); }
  OutputBuffer& operator<<(unsigned long N) { return this->operator<<(static_cast<unsigned long long>(N)); }
  OutputBuffer& operator<<(int N) { return this->operator<<(static_cast<long long>(N)); }
  OutputBuffer& operator<<(unsigned int N) { return this->operator<<(static_cast<unsigned long long>(N)); }

  void insert(size_t Pos, const char* S, size_t N) {
    if (N == 0u || Pos > CurrentPosition) return;
    if (Pos >= BufferCapacity) {
      markOverflow();
      return;
    }
    const size_t avail_after_pos = BufferCapacity - Pos;
    const size_t ins = (N <= avail_after_pos) ? N : avail_after_pos;
    if (ins < N) markOverflow();
    const size_t tail = CurrentPosition - Pos;
    const size_t max_tail = BufferCapacity - (Pos + ins);
    const size_t keep_tail = (tail <= max_tail) ? tail : max_tail;
    if (keep_tail < tail) markOverflow();
    if (keep_tail > 0u) hex::mem_move(Buffer + Pos + ins, Buffer + Pos, keep_tail);
    hex::mem_copy(Buffer + Pos, S, ins);
    CurrentPosition = Pos + ins + keep_tail;
  }

  size_t getCurrentPosition() const { return CurrentPosition; }
  void setCurrentPosition(size_t NewPos) {
    if (NewPos <= CurrentPosition) CurrentPosition = NewPos;
  }
  char back() const { return CurrentPosition > 0u ? Buffer[CurrentPosition - 1u] : '\0'; }
  bool empty() const { return CurrentPosition == 0u; }
  bool isOverflowed() const { return Overflowed; }
  char* getBuffer() {
    Buffer[CurrentPosition] = '\0';
    return Buffer;
  }
  char* getBufferEnd() { return CurrentPosition > 0u ? (Buffer + CurrentPosition - 1u) : Buffer; }
  size_t getBufferCapacity() const { return BufferCapacity; }
};

template <class T>
class ScopedOverride {
  T& Loc;
  T Original;

 public:
  ScopedOverride(T& Loc_) : ScopedOverride(Loc_, Loc_) {}
  ScopedOverride(T& Loc_, T NewVal) : Loc(Loc_), Original(Loc_) { Loc_ = std::move(NewVal); }
  ~ScopedOverride() { Loc = std::move(Original); }
  ScopedOverride(const ScopedOverride&) = delete;
  ScopedOverride& operator=(const ScopedOverride&) = delete;
};

DEMANGLE_NAMESPACE_END

// ============================================================================
// 4. Include Upstream LLVM ItaniumDemangle.h and RustDemangle.cpp
// ============================================================================
#include "../../third_party/llvm-demangle/ItaniumDemangle.h"

namespace llvm::itanium_demangle {
const char* parse_discriminator(const char* first, const char* last) {
  if (first != last) {
    if (*first == '_') {
      const char* t1 = first + 1;
      if (t1 != last) {
        if (std::isdigit(*t1)) {
          first = t1 + 1;
        } else if (*t1 == '_') {
          for (++t1; t1 != last && std::isdigit(*t1); ++t1) {}
          if (t1 != last && *t1 == '_') first = t1 + 1;
        }
      }
    } else if (std::isdigit(*first)) {
      const char* t1 = first + 1;
      for (; t1 != last && std::isdigit(*t1); ++t1) {}
      if (t1 != last && *t1 == '_') first = t1 + 1;
    }
  }
  return first;
}
}  // namespace llvm::itanium_demangle

#include "../../third_party/llvm-demangle/RustDemangle.cpp"

// ============================================================================
// 5. Freestanding AST Allocator, Nesting/DoS Guards, Rust Legacy Post-Processor,
//    and C ABI WASM Exports
// ============================================================================
namespace {

class FreestandingAstAllocator {
 public:
  void reset() { hex_demangle_detail::g_ast_cursor = 0u; }

  void* allocate(size_t N) {
    const size_t aligned = (hex_demangle_detail::g_ast_cursor + 7u) & ~size_t(7u);
    if (aligned > hex_demangle_detail::kAstArenaCap ||
        N > hex_demangle_detail::kAstArenaCap - aligned) {
      hex_demangle_detail::g_arena_oom = true;
      return nullptr;
    }
    void* p = hex_demangle_detail::g_ast_arena + aligned;
    hex_demangle_detail::g_ast_cursor = aligned + N;
    return p;
  }

  template <typename T, typename... Args>
  T* makeNode(Args&&... args) {
    void* mem = allocate(sizeof(T));
    if (mem == nullptr) return nullptr;
    return new (mem) T(std::forward<Args>(args)...);
  }

  void* allocateNodeArray(size_t sz) {
    return allocate(sz * sizeof(llvm::itanium_demangle::Node*));
  }
};

inline bool is_hex_lower(uint8_t c) {
  return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f');
}

// Detect Rust legacy hash suffix: "17h<16 lower hex digits>E" at end of Itanium _ZN...E symbol.
bool is_rust_legacy_symbol(const uint8_t* p, uint32_t len) {
  if (len < 24u) return false;
  uint32_t off = 0u;
  if (p[0] == '_' && p[1] == '_' && p[2] == 'Z' && p[3] == 'N') {
    off = 1u;
  } else if (p[0] == '_' && p[1] == 'Z' && p[2] == 'N') {
    off = 0u;
  } else {
    return false;
  }
  if (len - off < 24u) return false;
  if (p[len - 1u] != 'E') return false;
  const uint32_t hpos = len - 20u;
  if (p[hpos] != '1' || p[hpos + 1u] != '7' || p[hpos + 2u] != 'h') return false;
  for (uint32_t i = 0u; i < 16u; ++i) {
    if (!is_hex_lower(p[hpos + 3u + i])) return false;
  }
  return true;
}

// Strict pre-parse nesting & substitution-bomb guard for Itanium recursive descent.
// Bounds N/I/F/X/L/Z/A depth, P/R/O/K/V/r/U/D/M/C/G/J modifier chains (<= 32),
// and S_/T_ substitution references (<= 64) so g_heap_arena / stack can never exhaust.
bool is_itanium_nesting_safe(const char* s, uint32_t len) {
  uint32_t depth = 0u;
  uint32_t chain = 0u;
  uint32_t subst_refs = 0u;
  uint32_t i = 0u;
  if (len >= 2u && s[0] == '_' && s[1] == 'Z') i = 2u;

  while (i < len) {
    const char c = s[i];
    if (c >= '1' && c <= '9') {
      uint32_t num = 0u;
      while (i < len && s[i] >= '0' && s[i] <= '9') {
        num = num * 10u + static_cast<uint32_t>(s[i] - '0');
        if (num > len) return false;
        ++i;
      }
      if (num > len - i) return false;
      i += num;
      chain = 0u;
      continue;
    }
    if (c == 'N' || c == 'I' || c == 'F' || c == 'X' || c == 'L' || c == 'Z' || c == 'A') {
      depth += 1u;
      chain = 0u;
      if (depth > hex_demangle_detail::kMaxItaniumDepth) return false;
    } else if (c == 'E') {
      if (depth > 0u) depth -= 1u;
      chain = 0u;
    } else if (c == 'P' || c == 'R' || c == 'O' || c == 'K' || c == 'V' || c == 'r' ||
               c == 'U' || c == 'D' || c == 'M' || c == 'C' || c == 'G' || c == 'J') {
      chain += 1u;
      if (depth + chain > hex_demangle_detail::kMaxItaniumDepth) return false;
    } else if (c == 'S' || c == 'T') {
      subst_refs += 1u;
      if (subst_refs > hex_demangle_detail::kMaxItaniumSubstRefs) return false;
      chain = 0u;
    } else {
      chain = 0u;
    }
    ++i;
  }
  return true;
}

// Pre-parse nesting/DoS guard for Rust v0 symbols (_R...).
// Skips length-prefixed identifiers and base-62 disambiguators/backrefs while bounding
// recursive prefix depth (R/Q/P/S/A/T/F/K/B/M/N/I/X/Y/O/D/G) <= 40.
bool is_rust_v0_nesting_safe(const char* s, uint32_t len) {
  if (len < 3u || s[0] != '_' || s[1] != 'R') return false;
  uint32_t i = 2u;
  uint32_t nest_depth = 0u;
  uint32_t prefix_chain = 0u;
  uint32_t backref_count = 0u;

  while (i < len) {
    const char c = s[i];
    // Length-prefixed identifier (optionally preceded by 'u' for punycode)
    if (c >= '0' && c <= '9') {
      uint32_t num = 0u;
      while (i < len && s[i] >= '0' && s[i] <= '9') {
        num = num * 10u + static_cast<uint32_t>(s[i] - '0');
        if (num > len) return false;
        ++i;
      }
      if (i < len && s[i] == '_') ++i;
      if (num > len - i) return false;
      i += num;
      prefix_chain = 0u;
      continue;
    }
    if (c == 's' && i + 1u < len) {
      // Base-62 disambiguator: s<base62>_
      ++i;
      while (i < len && s[i] != '_') ++i;
      if (i < len && s[i] == '_') ++i;
      continue;
    }
    if (c == 'B') {
      // Backref: B<base62>_
      backref_count += 1u;
      prefix_chain += 1u;
      if (backref_count > hex_demangle_detail::kMaxRustV0Depth ||
          nest_depth + prefix_chain > hex_demangle_detail::kMaxRustV0Depth) {
        return false;
      }
      ++i;
      while (i < len && s[i] != '_') ++i;
      if (i < len && s[i] == '_') ++i;
      continue;
    }
    if (c == 'N' || c == 'I' || c == 'T' || c == 'F' || c == 'D' || c == 'G') {
      nest_depth += 1u;
      if (nest_depth + prefix_chain > hex_demangle_detail::kMaxRustV0Depth) return false;
      ++i;
      if (c == 'N' && i < len) ++i;  // skip namespace tag char
      continue;
    }
    if (c == 'E') {
      if (nest_depth > 0u) nest_depth -= 1u;
      prefix_chain = 0u;
      ++i;
      continue;
    }
    if (c == 'R' || c == 'Q' || c == 'P' || c == 'O' || c == 'S' || c == 'A' ||
        c == 'K' || c == 'M' || c == 'X' || c == 'Y') {
      prefix_chain += 1u;
      if (nest_depth + prefix_chain > hex_demangle_detail::kMaxRustV0Depth) return false;
      ++i;
      continue;
    }
    prefix_chain = 0u;
    ++i;
  }
  return true;
}

// Expand Rust legacy escapes ($LT$, $GT$, $u20$, $BP$, $RF$, $C$, $SP$, $LP$, $RP$, .. -> ::)
// and strip trailing ::h<16hex> hash component.
size_t decode_rust_legacy_postprocess(const char* in, size_t in_len, char* out, size_t out_cap) {
  size_t eff_len = in_len;
  if (eff_len >= 19u && in[eff_len - 19u] == ':' && in[eff_len - 18u] == ':' && in[eff_len - 17u] == 'h') {
    bool all_hex = true;
    for (size_t k = 0u; k < 16u; ++k) {
      if (!is_hex_lower(static_cast<uint8_t>(in[eff_len - 16u + k]))) {
        all_hex = false;
        break;
      }
    }
    if (all_hex) eff_len -= 19u;
  }

  size_t o = 0u;
  auto emit = [&](char ch) {
    if (o < out_cap) out[o++] = ch;
  };

  size_t i = 0u;
  while (i < eff_len) {
    if (in[i] == '.' && i + 1u < eff_len && in[i + 1u] == '.') {
      emit(':');
      emit(':');
      i += 2u;
      continue;
    }
    if (in[i] == '$') {
      size_t end = i + 1u;
      while (end < eff_len && in[end] != '$' && (end - i) <= 10u) ++end;
      if (end < eff_len && in[end] == '$') {
        const std::string_view tok(in + i + 1u, end - (i + 1u));
        bool matched = true;
        if (tok == "LT") emit('<');
        else if (tok == "GT") emit('>');
        else if (tok == "C") emit(',');
        else if (tok == "SP") emit('@');
        else if (tok == "BP") emit('*');
        else if (tok == "RF") emit('&');
        else if (tok == "LP") emit('(');
        else if (tok == "RP") emit(')');
        else if (tok == "u20") emit(' ');
        else if (tok == "u22") emit('"');
        else if (tok == "u27") emit('\'');
        else if (tok == "u2b") emit('+');
        else if (tok == "u3b") emit(';');
        else if (tok == "u5b") emit('[');
        else if (tok == "u5d") emit(']');
        else if (tok == "u7b") emit('{');
        else if (tok == "u7d") emit('}');
        else if (tok == "u7e") emit('~');
        else if (tok == "u21") emit('!');
        else if (tok == "u3d") emit('=');
        else if (tok == "u2d") emit('-');
        else if (tok == "u2f") emit('/');
        else if (tok == "u3a") emit(':');
        else matched = false;
        if (matched) {
          i = end + 1u;
          continue;
        }
      }
    }
    emit(in[i++]);
  }
  return o;
}

// Always NUL-terminates out_ptr[copy_n] = '\0' whenever out_cap >= 1.
int32_t copy_result_to_user(const char* src, size_t src_len, bool truncated,
                            uint8_t* out_ptr, uint32_t out_cap, uint32_t* out_len) {
  if (out_cap == 0u) {
    *out_len = 0u;
    return HEX_ERR_OOM;
  }
  const size_t max_copy = static_cast<size_t>(out_cap) - 1u;
  const bool user_trunc = src_len > max_copy;
  const size_t copy_n = user_trunc ? max_copy : src_len;
  if (copy_n > 0u) hex::mem_copy(out_ptr, src, copy_n);
  out_ptr[copy_n] = 0u;
  *out_len = static_cast<uint32_t>(copy_n);
  return (truncated || user_trunc) ? HEX_ERR_OOM : HEX_OK;
}

}  // namespace

#ifdef HEX_HAS_SWIFT_DEMANGLE
extern "C" int32_t hex_demangle_swift_impl(
    const uint8_t* in_ptr,
    uint32_t in_len,
    uint8_t* out_ptr,
    uint32_t out_cap,
    uint32_t* out_len);
#endif

extern "C" {

HEX_WASM_EXPORT("hex_demangle_in_buf_ptr")
uint8_t* hex_demangle_in_buf_ptr(void) {
  return hex_demangle_detail::g_io_in_buf;
}

HEX_WASM_EXPORT("hex_demangle_in_buf_cap")
uint32_t hex_demangle_in_buf_cap(void) {
  return hex_demangle_detail::kMaxInputLen;
}

HEX_WASM_EXPORT("hex_demangle_out_buf_ptr")
uint8_t* hex_demangle_out_buf_ptr(void) {
  return hex_demangle_detail::g_io_out_buf;
}

HEX_WASM_EXPORT("hex_demangle_out_buf_cap")
uint32_t hex_demangle_out_buf_cap(void) {
  return hex_demangle_detail::kIoOutBufCap;
}

HEX_WASM_EXPORT("hex_demangle_out_len_ptr")
uint32_t* hex_demangle_out_len_ptr(void) {
  return &hex_demangle_detail::g_io_out_len;
}

HEX_WASM_EXPORT("hex_demangle_detect_kind")
uint32_t hex_demangle_detect_kind(const uint8_t* in_ptr, uint32_t in_len) {
  if (in_ptr == nullptr || in_len < 3u) return HEX_DEMANGLE_NONE;

  // Swift 5+ ($s, $S, $e, _$s, _$S, _$e) and Swift 4 (_T0, __T0)
  if ((in_ptr[0] == '$' && (in_ptr[1] == 's' || in_ptr[1] == 'S' || in_ptr[1] == 'e')) ||
      (in_len >= 4u && in_ptr[0] == '_' && in_ptr[1] == '$' &&
       (in_ptr[2] == 's' || in_ptr[2] == 'S' || in_ptr[2] == 'e')) ||
      (in_ptr[0] == '_' && in_ptr[1] == 'T' && in_ptr[2] == '0') ||
      (in_len >= 4u && in_ptr[0] == '_' && in_ptr[1] == '_' && in_ptr[2] == 'T' && in_ptr[3] == '0')) {
    return HEX_DEMANGLE_SWIFT;
  }

  if ((in_ptr[0] == '_' && in_ptr[1] == 'R') ||
      (in_len >= 4u && in_ptr[0] == '_' && in_ptr[1] == '_' && in_ptr[2] == 'R')) {
    return HEX_DEMANGLE_RUST_V0;
  }

  if (is_rust_legacy_symbol(in_ptr, in_len)) {
    return HEX_DEMANGLE_RUST_LEGACY;
  }

  if ((in_ptr[0] == '_' && in_ptr[1] == 'Z') ||
      (in_len >= 4u && in_ptr[0] == '_' && in_ptr[1] == '_' && in_ptr[2] == 'Z')) {
    return HEX_DEMANGLE_ITANIUM_CPP;
  }

  return HEX_DEMANGLE_NONE;
}

HEX_WASM_EXPORT("hex_demangle_symbol")
int32_t hex_demangle_symbol(
    const uint8_t* in_ptr,
    uint32_t in_len,
    uint8_t* out_ptr,
    uint32_t out_cap,
    uint32_t* out_len) {
  if (out_len != nullptr) *out_len = 0u;
  if (in_ptr == nullptr || in_len == 0u || out_ptr == nullptr || out_len == nullptr) {
    return HEX_ERR_INVALID_ARG;
  }
  if (out_cap == 0u) {
    return HEX_ERR_OOM;
  }
  if (in_len > hex_demangle_detail::kMaxInputLen) {
    return HEX_ERR_RESOURCE_LIMIT;
  }

  const uint32_t kind = hex_demangle_detect_kind(in_ptr, in_len);
  if (kind == HEX_DEMANGLE_NONE) {
    return HEX_ERR_INVALID_ARG;
  }

  hex_demangle_detail::reset_arenas();

  // Strip Darwin leading '_' if present ("__Z..." -> "_Z...", "__R..." -> "_R...")
  const char* sym = reinterpret_cast<const char*>(in_ptr);
  uint32_t sym_len = in_len;
  if (sym_len >= 4u && sym[0] == '_' && sym[1] == '_' && (sym[2] == 'Z' || sym[2] == 'R')) {
    sym += 1u;
    sym_len -= 1u;
  }

#ifdef HEX_HAS_SWIFT_DEMANGLE
  if (kind == HEX_DEMANGLE_SWIFT) {
    return hex_demangle_swift_impl(in_ptr, in_len, out_ptr, out_cap, out_len);
  }
#endif

  if (kind == HEX_DEMANGLE_RUST_V0) {
    if (!is_rust_v0_nesting_safe(sym, sym_len)) {
      return HEX_ERR_RESOURCE_LIMIT;
    }
    char* demangled = llvm::rustDemangle(std::string_view(sym, sym_len));
    if (hex_demangle_detail::g_arena_oom) {
      return HEX_ERR_OOM;
    }
    if (demangled == nullptr) {
      return HEX_ERR_INVALID_ARG;
    }
    const size_t dlen = std::strlen(demangled);
    return copy_result_to_user(
        demangled, dlen, hex_demangle_detail::g_out_overflowed, out_ptr, out_cap, out_len);
  }

  // Itanium C++ or Rust Legacy (parsed via upstream LLVM ManglingParser)
  if (!is_itanium_nesting_safe(sym, sym_len)) {
    return HEX_ERR_RESOURCE_LIMIT;
  }

  llvm::itanium_demangle::ManglingParser<FreestandingAstAllocator> parser(sym, sym + sym_len);
  llvm::itanium_demangle::Node* ast = parser.parse();
  if (hex_demangle_detail::g_arena_oom) {
    return HEX_ERR_OOM;
  }
  if (ast == nullptr) {
    return HEX_ERR_INVALID_ARG;
  }

  llvm::itanium_demangle::OutputBuffer ob;
  ast->print(ob);
  if (hex_demangle_detail::g_arena_oom) {
    return HEX_ERR_OOM;
  }

  if (kind == HEX_DEMANGLE_RUST_LEGACY) {
    alignas(4) static char g_rust_legacy_tmp[hex_demangle_detail::kOutputBufCap];
    const std::string_view raw = static_cast<std::string_view>(ob);
    const size_t n = decode_rust_legacy_postprocess(
        raw.data(), raw.size(), g_rust_legacy_tmp, sizeof(g_rust_legacy_tmp) - 1u);
    g_rust_legacy_tmp[n] = '\0';
    return copy_result_to_user(
        g_rust_legacy_tmp, n, ob.isOverflowed() || hex_demangle_detail::g_out_overflowed,
        out_ptr, out_cap, out_len);
  }

  const std::string_view res = static_cast<std::string_view>(ob);
  return copy_result_to_user(
      res.data(), res.size(), ob.isOverflowed() || hex_demangle_detail::g_out_overflowed,
      out_ptr, out_cap, out_len);
}

}  // extern "C"
