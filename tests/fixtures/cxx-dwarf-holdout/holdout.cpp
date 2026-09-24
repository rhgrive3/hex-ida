struct Base {
  int health;
  virtual int update(int amount) const = 0;
  virtual ~Base() = default;
};
struct Thing : Base {
  int power;
  float ratio;
  int update(int amount) const override { return health + power + amount; }
  virtual int interact(Base* other) const { return other->update(power); }
};
Thing global_thing;
extern "C" int read_fields(Thing* value) { return value->health + value->power; }
extern "C" int virtual_call(Base* value) { return value->update(7); }
extern "C" void __cxa_pure_virtual() {}
extern "C" void _start() { for (;;) {} }
extern "C" int atexit(void (*)()) { return 0; }
void operator delete(void*) noexcept {}
