// Freestanding ABI stubs for the C++ recovery fixture.
//
// The fixture is linked with `-nostdlib`, so the Itanium C++ ABI typeinfo
// vtables and the handful of runtime hooks the compiler emits must be provided
// here. Only the declarations matter: they make clang emit the standard
// `_ZTVN10__cxxabiv1*__*_type_infoE` records and the `_ZTI*` objects that a real
// C++ program would get from libc++abi.

namespace __cxxabiv1 {

struct __class_type_info {
  virtual ~__class_type_info();
};
__class_type_info::~__class_type_info() {}

struct __si_class_type_info : __class_type_info {
  virtual ~__si_class_type_info();
};
__si_class_type_info::~__si_class_type_info() {}

}  // namespace __cxxabiv1

void operator delete(void*) noexcept {}
void operator delete(void*, unsigned long) noexcept {}

extern "C" int __cxa_atexit(void (*)(void*), void*, void*) { return 0; }
extern "C" int __cxa_guard_acquire(long long*) { return 1; }
extern "C" void __cxa_guard_release(long long*) {}
extern "C" void __cxa_guard_abort(long long*) {}
extern "C" void __cxa_pure_virtual() {}
