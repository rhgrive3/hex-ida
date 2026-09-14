struct Receiver { virtual unsigned long long read() const = 0; virtual ~Receiver() = default; };
extern "C" __attribute__((noinline)) unsigned long long virtual_open(const Receiver *r) { return r->read(); }
