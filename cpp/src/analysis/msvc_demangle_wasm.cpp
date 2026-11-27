// Freestanding WASM32 integration of upstream LLVM MicrosoftDemangle
// (third_party/llvm-demangle/MicrosoftDemangle*.{h,cpp}, Apache-2.0 WITH LLVM-exception).
// Compiles under: clang++ --target=wasm32 -std=c++20 -Os -nostdlib -fno-exceptions -fno-rtti -mbulk-memory
// Produces 0 external WASM imports, zero libc dependency, bounded bump arena reset per call.

#include "hex_abi.hpp"
#include "hex_core/types.hpp"

#include <limits.h>
#include <stddef.h>
#include <stdint.h>

namespace hex_msvc_demangle_detail {

constexpr size_t   kMsvcHeapArenaCap = 256u * 1024u;
constexpr uint32_t kMaxMsvcInputLen  = 2048u;
constexpr size_t   kOutBufCap        = 16384u;

alignas(8) static uint8_t g_heap_arena[kMsvcHeapArenaCap];
alignas(8) static char    g_out_buf[kOutBufCap];
static size_t g_heap_cursor = 0u;
static bool   g_arena_oom   = false;
static bool   g_out_overflow = false;

inline void reset_arena() {
  g_heap_cursor = 0u;
  g_arena_oom   = false;
  g_out_overflow = false;
}

inline void* arena_alloc(size_t sz, size_t align = 8u) {
  if (sz == 0u) sz = 1u;
  if (align < 8u) align = 8u;
  const size_t mask = align - 1u;
  const size_t aligned = (g_heap_cursor + mask) & ~mask;
  if (aligned > kMsvcHeapArenaCap || sz > kMsvcHeapArenaCap - aligned) {
    g_arena_oom = true;
    return nullptr;
  }
  void* p = g_heap_arena + aligned;
  g_heap_cursor = aligned + sz;
  return p;
}

inline size_t c_strlen(const char* s) {
  if (!s) return 0u;
  size_t n = 0u;
  while (s[n] != '\0') ++n;
  return n;
}

inline int c_memcmp(const void* a, const void* b, size_t n) {
  const uint8_t* pa = static_cast<const uint8_t*>(a);
  const uint8_t* pb = static_cast<const uint8_t*>(b);
  for (size_t i = 0u; i < n; ++i) {
    if (pa[i] != pb[i]) return pa[i] < pb[i] ? -1 : 1;
  }
  return 0;
}

}  // namespace hex_msvc_demangle_detail

#ifndef NDEBUG
#define NDEBUG 1
#endif
#ifndef assert
#define assert(x) ((void)0)
#endif

static inline void* malloc(size_t sz) { return hex_msvc_demangle_detail::arena_alloc(sz, 8u); }
static inline void  free(void*) {}
static inline int   isdigit(int c) { return (c >= '0' && c <= '9') ? 1 : 0; }
static inline int   isspace(int c) { return (c == ' ' || c == '\t' || c == '\n' || c == '\r' || c == '\f' || c == '\v') ? 1 : 0; }
static inline int   isxdigit(int c) { return isdigit(c) || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F'); }
static inline int   isprint(int c) { return (c >= 0x20 && c <= 0x7e) ? 1 : 0; }
static inline int   isalnum(int c) { return isdigit(c) || (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') ? 1 : 0; }
static inline void* memcpy(void* d, const void* s, size_t n) { hex::mem_copy(d, s, n); return d; }
static inline void* memmove(void* d, const void* s, size_t n) { hex::mem_move(d, s, n); return d; }
static inline void* memset(void* d, int v, size_t n) { hex::mem_set(d, static_cast<uint8_t>(v), n); return d; }
static inline int   memcmp(const void* a, const void* b, size_t n) { return hex_msvc_demangle_detail::c_memcmp(a, b, n); }
static inline size_t strlen(const char* s) { return hex_msvc_demangle_detail::c_strlen(s); }

inline void* operator new(size_t, void* p) noexcept { return p; }
inline void* operator new[](size_t, void* p) noexcept { return p; }

namespace std {

using ::size_t;
using ::ptrdiff_t;
using ::int8_t;
using ::uint8_t;
using ::int16_t;
using ::uint16_t;
using ::int32_t;
using ::uint32_t;
using ::int64_t;
using ::uint64_t;
using ::uintptr_t;
using ::memcpy;
using ::memmove;
using ::memset;
using ::memcmp;
using ::strlen;
using ::isdigit;
using ::isspace;
using ::isxdigit;
using ::isprint;
using ::isalnum;
using ::free;
using ::malloc;
inline int printf(const char*, ...) { return 0; }

[[noreturn]] inline void abort() noexcept { __builtin_trap(); }

template <class T> struct remove_reference { using type = T; };
template <class T> struct remove_reference<T&> { using type = T; };
template <class T> struct remove_reference<T&&> { using type = T; };
template <class T> using remove_reference_t = typename remove_reference<T>::type;

template <class T> constexpr remove_reference_t<T>&& move(T&& t) noexcept { return static_cast<remove_reference_t<T>&&>(t); }
template <class T> constexpr T&& forward(remove_reference_t<T>& t) noexcept { return static_cast<T&&>(t); }
template <class T> constexpr T&& forward(remove_reference_t<T>&& t) noexcept { return static_cast<T&&>(t); }
template <class T> constexpr const T& min(const T& a, const T& b) { return (b < a) ? b : a; }
template <class T> constexpr const T& max(const T& a, const T& b) { return (a < b) ? b : a; }
template <class T> inline void swap(T& a, T& b) noexcept { T t = move(a); a = move(b); b = move(t); }

template <class T, size_t N>
struct array {
  T elems[N];
  constexpr T& operator[](size_t i) noexcept { return elems[i]; }
  constexpr const T& operator[](size_t i) const noexcept { return elems[i]; }
  constexpr size_t size() const noexcept { return N; }
  constexpr T* begin() noexcept { return elems; }
  constexpr T* end() noexcept { return elems + N; }
  constexpr const T* begin() const noexcept { return elems; }
  constexpr const T* end() const noexcept { return elems + N; }
};

template <class T1, class T2>
struct pair {
  T1 first;
  T2 second;
  constexpr pair() : first(), second() {}
  constexpr pair(const T1& a, const T2& b) : first(a), second(b) {}
};
template <class T1, class T2>
constexpr pair<T1, T2> make_pair(T1 a, T2 b) { return {move(a), move(b)}; }

template <class T1, class T2>
struct tuple {
  T1 first;
  T2 second;
  constexpr tuple() : first(), second() {}
  constexpr tuple(T1 a, T2 b) : first(a), second(b) {}
  template <class U1, class U2>
  tuple& operator=(const pair<U1, U2>& p) {
    first = p.first;
    second = p.second;
    return *this;
  }
};
template <class T1, class T2>
constexpr tuple<T1&, T2&> tie(T1& a, T2& b) noexcept { return {a, b}; }
template <class T1, class T2>
inline tuple<T1&, T2&>& assign_pair(tuple<T1&, T2&>& lhs, const pair<T1, T2>& rhs) {
  lhs.first = rhs.first;
  lhs.second = rhs.second;
  return lhs;
}

struct nullopt_t { explicit constexpr nullopt_t(int) {} };
inline constexpr nullopt_t nullopt{0};

template <class T>
class optional {
  alignas(T) uint8_t storage_[sizeof(T)];
  bool has_ = false;
  T* ptr() noexcept { return reinterpret_cast<T*>(storage_); }
  const T* ptr() const noexcept { return reinterpret_cast<const T*>(storage_); }
 public:
  optional() noexcept : has_(false) {}
  optional(nullopt_t) noexcept : has_(false) {}
  optional(const T& v) : has_(true) { new (storage_) T(v); }
  optional(T&& v) : has_(true) { new (storage_) T(move(v)); }
  optional(const optional& o) : has_(o.has_) { if (has_) new (storage_) T(*o.ptr()); }
  optional(optional&& o) noexcept : has_(o.has_) { if (has_) new (storage_) T(move(*o.ptr())); }
  ~optional() { if (has_) ptr()->~T(); }
  optional& operator=(const optional& o) {
    if (this != &o) { if (has_) ptr()->~T(); has_ = o.has_; if (has_) new (storage_) T(*o.ptr()); }
    return *this;
  }
  bool has_value() const noexcept { return has_; }
  explicit operator bool() const noexcept { return has_; }
  T& operator*() noexcept { return *ptr(); }
  const T& operator*() const noexcept { return *ptr(); }
  T* operator->() noexcept { return ptr(); }
  const T* operator->() const noexcept { return ptr(); }
};

class string_view {
  const char* data_ = nullptr;
  size_t size_ = 0u;
 public:
  static constexpr size_t npos = static_cast<size_t>(-1);
  constexpr string_view() noexcept = default;
  constexpr string_view(const char* s, size_t n) noexcept : data_(s), size_(n) {}
  constexpr string_view(const char* s) noexcept : data_(s), size_(s ? __builtin_strlen(s) : 0u) {}
  constexpr const char* data() const noexcept { return data_; }
  constexpr size_t size() const noexcept { return size_; }
  constexpr size_t length() const noexcept { return size_; }
  constexpr bool empty() const noexcept { return size_ == 0u; }
  constexpr const char* begin() const noexcept { return data_; }
  constexpr const char* end() const noexcept { return data_ + size_; }
  constexpr char operator[](size_t i) const noexcept { return data_[i]; }
  constexpr char front() const noexcept { return data_[0]; }
  constexpr char back() const noexcept { return data_[size_ - 1u]; }
  constexpr void remove_prefix(size_t n) noexcept { if (n > size_) n = size_; data_ += n; size_ -= n; }
  constexpr void remove_suffix(size_t n) noexcept { if (n > size_) n = size_; size_ -= n; }
  constexpr string_view substr(size_t pos = 0u, size_t count = npos) const noexcept {
    if (pos >= size_) return string_view(data_ + size_, 0u);
    size_t avail = size_ - pos;
    return string_view(data_ + pos, count < avail ? count : avail);
  }
  constexpr size_t find(char c, size_t pos = 0u) const noexcept {
    for (size_t i = pos; i < size_; ++i) if (data_[i] == c) return i;
    return npos;
  }
  constexpr size_t find(string_view s, size_t pos = 0u) const noexcept {
    if (s.size_ == 0u) return pos <= size_ ? pos : npos;
    if (pos >= size_ || s.size_ > size_ - pos) return npos;
    for (size_t i = pos; i <= size_ - s.size_; ++i) {
      bool ok = true;
      for (size_t j = 0u; j < s.size_; ++j) if (data_[i + j] != s.data_[j]) { ok = false; break; }
      if (ok) return i;
    }
    return npos;
  }
  constexpr bool starts_with(char c) const noexcept { return size_ > 0u && data_[0] == c; }
  constexpr bool starts_with(string_view s) const noexcept {
    if (s.size_ > size_) return false;
    for (size_t i = 0u; i < s.size_; ++i) if (data_[i] != s.data_[i]) return false;
    return true;
  }
  friend constexpr bool operator==(string_view a, string_view b) noexcept {
    if (a.size_ != b.size_) return false;
    for (size_t i = 0u; i < a.size_; ++i) if (a.data_[i] != b.data_[i]) return false;
    return true;
  }
  friend constexpr bool operator!=(string_view a, string_view b) noexcept { return !(a == b); }
};

class string {
  char* data_ = nullptr;
  size_t size_ = 0u;
  size_t cap_ = 0u;
  static char* empty_c() noexcept { static char z = '\0'; return &z; }
  void ensure(size_t need) {
    if (need + 1u <= cap_) return;
    size_t nc = cap_ ? cap_ * 2u : 32u;
    while (nc < need + 1u) nc *= 2u;
    char* nb = static_cast<char*>(hex_msvc_demangle_detail::arena_alloc(nc, 8u));
    if (!nb) return;
    if (data_ && size_) hex::mem_copy(nb, data_, size_);
    nb[size_] = '\0';
    data_ = nb; cap_ = nc;
  }
 public:
  string() noexcept = default;
  string(const char* s) { if (s) append(s, hex_msvc_demangle_detail::c_strlen(s)); }
  string(const char* s, size_t n) { if (s && n) append(s, n); }
  string(const char* first, const char* last) { if (first && last && last > first) append(first, static_cast<size_t>(last - first)); }
  string(string_view sv) { if (!sv.empty()) append(sv.data(), sv.size()); }
  const char* data() const noexcept { return data_ ? data_ : empty_c(); }
  const char* c_str() const noexcept { return data(); }
  size_t size() const noexcept { return size_; }
  bool empty() const noexcept { return size_ == 0u; }
  void push_back(char c) { ensure(size_ + 1u); if (data_ && size_ + 1u < cap_) { data_[size_++] = c; data_[size_] = '\0'; } }
  string& append(const char* s, size_t n) {
    if (!s || !n) return *this;
    ensure(size_ + n);
    if (data_ && size_ + n < cap_) { hex::mem_copy(data_ + size_, s, n); size_ += n; data_[size_] = '\0'; }
    return *this;
  }
  operator string_view() const noexcept { return string_view(data(), size()); }
};

}  // namespace std

// Pre-define LLVM Demangle headers with our freestanding OutputBuffer + StringViewExtras
#define LLVM_DEMANGLE_DEMANGLECONFIG_H
#define DEMANGLE_STRINGVIEW_H
#define DEMANGLE_UTILITY_H
#define LLVM_DEMANGLE_DEMANGLE_H

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

enum : int {
  demangle_unknown_error = -4,
  demangle_invalid_args = -3,
  demangle_invalid_mangled_name = -2,
  demangle_memory_alloc_failure = -1,
  demangle_success = 0,
};

enum MSDemangleFlags {
  MSDF_None = 0,
  MSDF_DumpBackrefs = 1 << 0,
  MSDF_NoAccessSpecifier = 1 << 1,
  MSDF_NoCallingConvention = 1 << 2,
  MSDF_NoReturnType = 1 << 3,
  MSDF_NoMemberType = 1 << 4,
  MSDF_NoVariableType = 1 << 5,
  MSDF_NoTagSpecifier = 1 << 6,
  MSDF_NoVoidParameter = 1 << 7,
  MSDF_NoDecorativeRTTITypeDescriptor = 1 << 8,
  MSDF_CompactTemplateLists = 1 << 9,
  MSDF_SplitTemplateClosers = 1 << 10,
};

namespace itanium_demangle {

inline bool starts_with(std::string_view self, char c) { return self.starts_with(c); }
inline bool starts_with(std::string_view self, std::string_view p) { return self.starts_with(p); }
inline bool consumeFront(std::string_view& S, char C) {
  if (!S.starts_with(C)) return false;
  S.remove_prefix(1);
  return true;
}
inline bool consumeFront(std::string_view& S, std::string_view P) {
  if (!S.starts_with(P)) return false;
  S.remove_prefix(P.size());
  return true;
}

class OutputBuffer {
  char* Buffer = nullptr;
  size_t CurrentPosition = 0u;
  size_t BufferCapacity = 0u;
  bool Overflowed = false;

  void writeUnsignedMsvc(uint64_t N, bool isNeg = false) {
    char Temp[24];
    char* TempPtr = Temp + sizeof(Temp);
    do {
      *--TempPtr = char('0' + N % 10u);
      N /= 10u;
    } while (N != 0u);
    if (isNeg) *--TempPtr = '-';
    append(std::string_view(TempPtr, static_cast<size_t>((Temp + sizeof(Temp)) - TempPtr)));
  }

  void append(std::string_view R) {
    if (R.empty()) return;
    if (!Buffer) {
      Buffer = hex_msvc_demangle_detail::g_out_buf;
      BufferCapacity = hex_msvc_demangle_detail::kOutBufCap;
    }
    const size_t avail = (CurrentPosition + 1u < BufferCapacity) ? (BufferCapacity - 1u - CurrentPosition) : 0u;
    const size_t n = R.size() < avail ? R.size() : avail;
    if (n > 0u) {
      hex::mem_copy(Buffer + CurrentPosition, R.data(), n);
      CurrentPosition += n;
    }
    if (n < R.size()) {
      Overflowed = true;
      hex_msvc_demangle_detail::g_out_overflow = true;
    }
    Buffer[CurrentPosition] = '\0';
  }

 public:
  OutputBuffer(char* StartBuf, size_t* Size)
      : Buffer(StartBuf ? StartBuf : hex_msvc_demangle_detail::g_out_buf),
        CurrentPosition(0u),
        BufferCapacity((StartBuf && Size && *Size > 0u) ? *Size : hex_msvc_demangle_detail::kOutBufCap) {
    if (Buffer && BufferCapacity > 0u) Buffer[0] = '\0';
  }
  OutputBuffer()
      : Buffer(hex_msvc_demangle_detail::g_out_buf),
        CurrentPosition(0u),
        BufferCapacity(hex_msvc_demangle_detail::kOutBufCap) {
    Buffer[0] = '\0';
  }

  OutputBuffer& operator<<(std::string_view R) { append(R); return *this; }
  OutputBuffer& operator<<(char C) { append(std::string_view(&C, 1u)); return *this; }
  OutputBuffer& operator+=(char C) { if (C == '\0') { if (Buffer && CurrentPosition < BufferCapacity) Buffer[CurrentPosition] = '\0'; } else { append(std::string_view(&C, 1u)); } return *this; }
  OutputBuffer& operator+=(std::string_view R) { append(R); return *this; }
  OutputBuffer& operator<<(long long N) {
    if (N < 0) writeUnsignedMsvc(static_cast<uint64_t>(-(N + 1)) + 1ULL, true);
    else writeUnsignedMsvc(static_cast<uint64_t>(N), false);
    return *this;
  }
  OutputBuffer& operator<<(unsigned long long N) { writeUnsignedMsvc(N, false); return *this; }
  OutputBuffer& operator<<(long N) { return (*this << static_cast<long long>(N)); }
  OutputBuffer& operator<<(unsigned long N) { return (*this << static_cast<unsigned long long>(N)); }
  OutputBuffer& operator<<(int N) { return (*this << static_cast<long long>(N)); }
  OutputBuffer& operator<<(unsigned int N) { return (*this << static_cast<unsigned long long>(N)); }

  OutputBuffer& prepend(std::string_view R) {
    if (R.empty()) return *this;
    const size_t max_len = BufferCapacity > 0u ? BufferCapacity - 1u : 0u;
    const size_t keep = (R.size() < max_len) ? std::min(CurrentPosition, max_len - R.size()) : 0u;
    if (R.size() + CurrentPosition > max_len) {
      Overflowed = true;
      hex_msvc_demangle_detail::g_out_overflow = true;
    }
    if (keep > 0u) hex::mem_move(Buffer + R.size(), Buffer, keep);
    const size_t copy_r = R.size() < max_len ? R.size() : max_len;
    if (copy_r > 0u) hex::mem_copy(Buffer, R.data(), copy_r);
    CurrentPosition = copy_r + keep;
    Buffer[CurrentPosition] = '\0';
    return *this;
  }

  void insert(size_t Pos, const char* S, size_t N) {
    if (N == 0u || Pos > CurrentPosition) return;
    const size_t max_len = BufferCapacity > 0u ? BufferCapacity - 1u : 0u;
    const size_t tail = CurrentPosition - Pos;
    const size_t new_pos = Pos + N;
    if (new_pos + tail > max_len) {
      Overflowed = true;
      hex_msvc_demangle_detail::g_out_overflow = true;
    }
    const size_t keep_tail = (new_pos < max_len) ? std::min(tail, max_len - new_pos) : 0u;
    if (keep_tail > 0u) hex::mem_move(Buffer + new_pos, Buffer + Pos, keep_tail);
    const size_t copy_n = (Pos < max_len) ? std::min(N, max_len - Pos) : 0u;
    if (copy_n > 0u) hex::mem_copy(Buffer + Pos, S, copy_n);
    CurrentPosition = Pos + copy_n + keep_tail;
    Buffer[CurrentPosition] = '\0';
  }

  char* getBuffer() const { return Buffer; }
  char* getBufferEnd() const { return Buffer + CurrentPosition; }
  size_t getCurrentPosition() const { return CurrentPosition; }
  void setCurrentPosition(size_t NewPos) { if (NewPos <= CurrentPosition) { CurrentPosition = NewPos; Buffer[CurrentPosition] = '\0'; } }
  char back() const { return CurrentPosition > 0u ? Buffer[CurrentPosition - 1u] : '\0'; }
  bool empty() const { return CurrentPosition == 0u; }
  operator std::string_view() const { return std::string_view(Buffer, CurrentPosition); }
  bool isOverflowed() const { return Overflowed; }
};

inline bool initializeOutputBuffer(char* Buf, size_t* N, OutputBuffer& OB, size_t) {
  OB = OutputBuffer(Buf, N);
  return false;
}

}  // namespace itanium_demangle

char* microsoftDemangle(std::string_view MangledName, size_t* NMangled, int* Status, MSDemangleFlags Flags = MSDF_None);
std::optional<size_t> getArm64ECInsertionPointInMangledName(std::string_view MangledName);

}  // namespace llvm

#include "../../third_party/llvm-demangle/MicrosoftDemangleNodes.cpp"
#include "../../third_party/llvm-demangle/MicrosoftDemangle.cpp"

extern "C" int32_t hex_demangle_msvc_impl(
    const uint8_t* in_ptr,
    uint32_t in_len,
    uint8_t* out_ptr,
    uint32_t out_cap,
    uint32_t* out_len) {
  if (!in_ptr || !out_ptr || !out_len || in_len == 0u || out_cap == 0u) {
    if (out_len) *out_len = 0u;
    if (out_ptr && out_cap > 0u) out_ptr[0] = '\0';
    return HEX_ERR_INVALID_ARG;
  }
  *out_len = 0u;
  out_ptr[0] = '\0';
  if (in_len > hex_msvc_demangle_detail::kMaxMsvcInputLen) {
    return HEX_ERR_RESOURCE_LIMIT;
  }

  hex_msvc_demangle_detail::reset_arena();

  int status = 0;
  char* res = llvm::microsoftDemangle(
      std::string_view(reinterpret_cast<const char*>(in_ptr), in_len),
      nullptr,
      &status,
      llvm::MSDF_None);
  if (hex_msvc_demangle_detail::g_arena_oom) {
    return HEX_ERR_OOM;
  }
  if (status != llvm::demangle_success || !res) {
    return HEX_ERR_INVALID_ARG;
  }

  const size_t n = hex_msvc_demangle_detail::c_strlen(res);
  const size_t max_copy = static_cast<size_t>(out_cap - 1u);
  const size_t copy_n = n < max_copy ? n : max_copy;
  if (copy_n > 0u) hex::mem_copy(out_ptr, res, copy_n);
  out_ptr[copy_n] = '\0';
  *out_len = static_cast<uint32_t>(copy_n);
  return (n > max_copy || hex_msvc_demangle_detail::g_out_overflow) ? HEX_ERR_OOM : HEX_OK;
}
