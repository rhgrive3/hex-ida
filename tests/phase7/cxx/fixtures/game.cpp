// Game-oriented C++ fixture for C++ recovery measurement.
//
// This file is intentionally freestanding: it is cross-compiled with clang for
// aarch64 and linked with ld.lld without libc/ libc++abi, so the fixture is a
// genuine compiler-produced ARM64 ELF with real vtables, RTTI records and
// inheritance relations. Nothing here is hand-written binary data.
//
// The shape mirrors a small game object model:
//   Entity (base, virtual dtor/takeDamage/update, integer + pointer members)
//     -> Actor (overrides, float + aggregate members)
//          -> Player (overrides, int/char[]/bool members)

struct Vec3 { float x; float y; float z; };

class Entity {
public:
  Entity();
  virtual ~Entity();
  virtual int takeDamage(int amount);
  virtual void update(float dt);

  int health;      // +0x08
  int state;       // +0x0c
  Entity* target;  // +0x10
};

class Actor : public Entity {
public:
  Actor();
  ~Actor() override;
  int takeDamage(int amount) override;
  void update(float dt) override;

  float speed;     // +0x18
  Vec3 position;   // +0x1c
};

class Player : public Actor {
public:
  Player();
  ~Player() override;
  // takeDamage is overridden; update is inherited from Actor.
  int takeDamage(int amount) override;

  int ammo;        // +0x28
  char name[16];   // +0x2c
  bool alive;      // +0x3c
};

Entity::Entity() : health(100), state(0), target(nullptr) {}
Entity::~Entity() {}
int Entity::takeDamage(int amount) { health -= amount; return health; }
void Entity::update(float dt) { (void)dt; state += 1; }

Actor::Actor() : Entity(), speed(1.5f), position{0.0f, 0.0f, 0.0f} {}
Actor::~Actor() {}
int Actor::takeDamage(int amount) { health -= amount / 2; return health; }
void Actor::update(float dt) { (void)dt; speed += 0.5f; }

Player::Player() : Actor(), ammo(30), alive(true) { name[0] = 'P'; name[1] = 0; }
Player::~Player() {}
int Player::takeDamage(int amount) {
  health -= amount / 4;
  if (health < 0) alive = false;
  return health;
}

// A second polymorphic base. `Enemy` therefore has two subobjects, and the
// Itanium ABI packs both into ONE `_ZTV` symbol: the primary table followed by
// the `Component` sub-table, which restarts with its own
// `[offset-to-top, typeinfo]` header. That header is data, not a method, and the
// producer must never publish it as a slot.
class Component {
public:
  Component();
  virtual ~Component();
  virtual void tick();

  int uid;         // +0x08 within the Component subobject
};

class Enemy : public Entity, public Component {
public:
  Enemy();
  ~Enemy() override;
  void tick() override;

  int aggro;       // +0x28
};

Component::Component() : uid(0) {}
Component::~Component() {}
void Component::tick() { uid += 1; }

Enemy::Enemy() : Entity(), Component(), aggro(0) {}
Enemy::~Enemy() {}
void Enemy::tick() { uid += 2; }

// Indirect (virtual) dispatch through a parameter whose dynamic type is not
// statically exact, so the call site really goes through the vtable.
int entityDamage(Entity* e, int amount) { return e->takeDamage(amount); }
int playerDamage(Player* p, int amount) { return p->takeDamage(amount); }
void entityUpdate(Entity* e, float dt) { e->update(dt); }

// Direct member reads: each load width/register class carries member type
// evidence (int32_t / float / pointer / bool-like / array-like).
int readHealth(Entity* e) { return e->health + e->state; }
float readSpeed(Actor* a) { return a->speed; }
Entity* readTarget(Entity* e) { return e->target; }
bool isAlive(Player* p) { return p->alive; }
char readNameChar(Player* p, int index) { return p->name[index]; }

// Virtual-call target evidence: an object of a statically known class whose
// vtable pointer is stored by its constructor.
__attribute__((noinline)) int damageOwnedActor(Actor* a) { return a->takeDamage(7); }

static Player g_player;
static Actor g_actor;
static Enemy g_enemy;

extern "C" int _start() {
  int result = 0;
  result += entityDamage(&g_player, 10);
  result += playerDamage(&g_player, 10);
  result += damageOwnedActor(&g_actor);
  result += readHealth(&g_player);
  result += (int)readSpeed(&g_actor);
  result += readTarget(&g_player) != nullptr;
  result += isAlive(&g_player) ? 1 : 0;
  result += readNameChar(&g_player, 0);
  entityUpdate(&g_player, 0.5f);
  // Touches the multiple-inheritance class so both its sub-tables are emitted.
  g_enemy.tick();
  Component* component = &g_enemy;
  component->tick();
  return result;
}
