__attribute__((objc_root_class))
@interface ScopedReceiver
- (unsigned long long)read;
@end
__attribute__((noinline)) unsigned long long selector_open(ScopedReceiver *r) { return [r read]; }
