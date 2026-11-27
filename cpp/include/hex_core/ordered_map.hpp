#ifndef HEX_CORE_ORDERED_MAP_HPP
#define HEX_CORE_ORDERED_MAP_HPP

#include <stdint.h>
#include <stddef.h>
#include "types.hpp"
#include "js_compat.hpp"
#include "string_view.hpp"
#include "arena.hpp"

namespace hex {

template <typename K> struct DefaultKeyTraits;
template <> struct DefaultKeyTraits<uint32_t> {
  static uint64_t hash(uint32_t k) { return js::hash_u32(k); }
  static bool equal(uint32_t a, uint32_t b) { return a == b; }
};
template <> struct DefaultKeyTraits<int32_t> {
  static uint64_t hash(int32_t k) { return js::hash_u32(static_cast<uint32_t>(k)); }
  static bool equal(int32_t a, int32_t b) { return a == b; }
};
template <> struct DefaultKeyTraits<uint64_t> {
  static uint64_t hash(uint64_t k) { return js::hash_u64(k); }
  static bool equal(uint64_t a, uint64_t b) { return a == b; }
};
template <> struct DefaultKeyTraits<int64_t> {
  static uint64_t hash(int64_t k) { return js::hash_u64(static_cast<uint64_t>(k)); }
  static bool equal(int64_t a, int64_t b) { return a == b; }
};
template <> struct DefaultKeyTraits<double> {
  static uint64_t hash(double k) { return js::hash_f64_svz(k); }
  static bool equal(double a, double b) { return js::same_value_zero(a, b); }
};
template <> struct DefaultKeyTraits<StringView> {
  static uint64_t hash(StringView k) { return k.hash(); }
  static bool equal(StringView a, StringView b) { return a == b; }
};
template <> struct DefaultKeyTraits<U16StringView> {
  static uint64_t hash(U16StringView k) { return k.hash(); }
  static bool equal(U16StringView a, U16StringView b) { return a == b; }
};

template <typename K, typename V, typename Traits = DefaultKeyTraits<K>>
class OrderedMap {
 public:
  static constexpr uint32_t kNone = 0xffffffffu;
  static constexpr uint32_t kEmptyBucket = 0xffffffffu;
  static constexpr uint32_t kTombstoneBucket = 0xfffffffeu;
  static constexpr uint32_t kMaxBuckets = (1u << 29);
  static constexpr uint32_t kMaxEntries = (1u << 28);

  struct Entry {
    K key;
    V value;
    uint64_t hash;
    uint32_t prev;
    uint32_t next;
    uint8_t alive;
  };

  class Iterator {
   public:
    Iterator(Entry* entries, uint32_t idx) : entries_(entries), idx_(idx) {}
    Entry& operator*() const { return entries_[idx_]; }
    Entry* operator->() const { return &entries_[idx_]; }
    Iterator& operator++() { idx_ = entries_[idx_].next; return *this; }
    bool operator==(const Iterator& o) const { return idx_ == o.idx_; }
    bool operator!=(const Iterator& o) const { return idx_ != o.idx_; }
   private:
    Entry* entries_;
    uint32_t idx_;
  };

  class ConstIterator {
   public:
    ConstIterator(const Entry* entries, uint32_t idx) : entries_(entries), idx_(idx) {}
    const Entry& operator*() const { return entries_[idx_]; }
    const Entry* operator->() const { return &entries_[idx_]; }
    ConstIterator& operator++() { idx_ = entries_[idx_].next; return *this; }
    bool operator==(const ConstIterator& o) const { return idx_ == o.idx_; }
    bool operator!=(const ConstIterator& o) const { return idx_ != o.idx_; }
   private:
    const Entry* entries_;
    uint32_t idx_;
  };

  explicit OrderedMap(Arena* arena = nullptr)
      : arena_(arena), entries_(nullptr), entry_count_(0), entry_cap_(0),
        buckets_(nullptr), bucket_cap_(0), size_(0), used_buckets_(0),
        head_(kNone), tail_(kNone), free_head_(kNone) {}

  void init(Arena* arena) {
    arena_ = arena; entries_ = nullptr; entry_count_ = 0; entry_cap_ = 0;
    buckets_ = nullptr; bucket_cap_ = 0; size_ = 0; used_buckets_ = 0;
    head_ = kNone; tail_ = kNone; free_head_ = kNone;
  }

  void clear() {
    if (buckets_ && bucket_cap_ > 0) for (uint32_t i = 0; i < bucket_cap_; ++i) buckets_[i] = kEmptyBucket;
    entry_count_ = 0; size_ = 0; used_buckets_ = 0; head_ = kNone; tail_ = kNone; free_head_ = kNone;
  }

  uint32_t size() const { return size_; }
  bool empty() const { return size_ == 0; }
  Iterator begin() { return Iterator(entries_, head_); }
  Iterator end() { return Iterator(entries_, kNone); }
  ConstIterator begin() const { return ConstIterator(entries_, head_); }
  ConstIterator end() const { return ConstIterator(entries_, kNone); }

  bool reserve(uint32_t expected_items) {
    if (expected_items == 0) return true;
    if (expected_items > kMaxEntries) return false;
    uint32_t needed_buckets = 16u;
    while (static_cast<uint64_t>(needed_buckets) * 5ULL < static_cast<uint64_t>(expected_items) * 8ULL) {
      if (needed_buckets >= kMaxBuckets) return false;
      needed_buckets <<= 1;
    }
    if (needed_buckets > bucket_cap_ && !rehash(needed_buckets)) return false;
    if (expected_items > entry_cap_ && !grow_entries(expected_items)) return false;
    return true;
  }

  V* find(const K& key) {
    if (size_ == 0 || bucket_cap_ == 0) return nullptr;
    const uint64_t h = Traits::hash(key);
    const uint32_t mask = bucket_cap_ - 1u;
    uint32_t slot = static_cast<uint32_t>(h) & mask;
    for (uint32_t probe = 0; probe < bucket_cap_; ++probe) {
      const uint32_t b = buckets_[slot];
      if (b == kEmptyBucket) return nullptr;
      if (b != kTombstoneBucket) {
        Entry& e = entries_[b];
        if (e.hash == h && Traits::equal(e.key, key)) return &e.value;
      }
      slot = (slot + 1u) & mask;
    }
    return nullptr;
  }

  const V* find(const K& key) const { return const_cast<OrderedMap*>(this)->find(key); }
  bool has(const K& key) const { return find(key) != nullptr; }

  bool set(const K& key, const V& value) {
    if (bucket_cap_ == 0) {
      if (!rehash(16u)) return false;
    } else if (static_cast<uint64_t>(used_buckets_ + 1u) * 8ULL > static_cast<uint64_t>(bucket_cap_) * 5ULL) {
      const bool should_double = static_cast<uint64_t>(size_) * 2ULL > static_cast<uint64_t>(bucket_cap_);
      const uint32_t next_cap = should_double ? (bucket_cap_ >= kMaxBuckets ? 0u : bucket_cap_ * 2u) : bucket_cap_;
      if (next_cap == 0u || !rehash(next_cap)) return false;
    }
    const uint64_t h = Traits::hash(key);
    const uint32_t mask = bucket_cap_ - 1u;
    uint32_t slot = static_cast<uint32_t>(h) & mask;
    uint32_t first_tombstone = kNone;
    for (uint32_t probe = 0; probe < bucket_cap_; ++probe) {
      const uint32_t b = buckets_[slot];
      if (b == kEmptyBucket) {
        const uint32_t target_slot = (first_tombstone != kNone) ? first_tombstone : slot;
        uint32_t idx = kNone;
        if (free_head_ != kNone) {
          idx = free_head_;
          free_head_ = entries_[idx].next;
        } else {
          if (entry_count_ >= kMaxEntries) return false;
          if (entry_count_ == entry_cap_) {
            const uint32_t next_ecap = entry_cap_ == 0 ? 16u : (entry_cap_ > (kMaxEntries >> 1) ? kMaxEntries : entry_cap_ * 2u);
            if (!grow_entries(next_ecap)) return false;
          }
          idx = entry_count_++;
        }
        Entry& e = entries_[idx];
        e.key = key; e.value = value; e.hash = h; e.prev = tail_; e.next = kNone; e.alive = 1u;
        if (tail_ != kNone) entries_[tail_].next = idx; else head_ = idx;
        tail_ = idx;
        buckets_[target_slot] = idx;
        if (first_tombstone == kNone) ++used_buckets_;
        ++size_;
        return true;
      }
      if (b == kTombstoneBucket) {
        if (first_tombstone == kNone) first_tombstone = slot;
      } else {
        Entry& e = entries_[b];
        if (e.hash == h && Traits::equal(e.key, key)) { e.value = value; return true; }
      }
      slot = (slot + 1u) & mask;
    }
    return false;
  }

  bool erase(const K& key) {
    if (size_ == 0 || bucket_cap_ == 0) return false;
    const uint64_t h = Traits::hash(key);
    const uint32_t mask = bucket_cap_ - 1u;
    uint32_t slot = static_cast<uint32_t>(h) & mask;
    for (uint32_t probe = 0; probe < bucket_cap_; ++probe) {
      const uint32_t b = buckets_[slot];
      if (b == kEmptyBucket) return false;
      if (b != kTombstoneBucket) {
        Entry& e = entries_[b];
        if (e.hash == h && Traits::equal(e.key, key)) {
          buckets_[slot] = kTombstoneBucket;
          if (e.prev != kNone) entries_[e.prev].next = e.next; else head_ = e.next;
          if (e.next != kNone) entries_[e.next].prev = e.prev; else tail_ = e.prev;
          e.alive = 0u; e.prev = kNone; e.next = free_head_; free_head_ = b;
          --size_;
          return true;
        }
      }
      slot = (slot + 1u) & mask;
    }
    return false;
  }

 private:
  bool grow_entries(uint32_t new_cap) {
    if (!arena_) return false;
    Entry* next = arena_->alloc<Entry>(new_cap);
    if (!next) return false;
    if (entry_count_ > 0) mem_copy(next, entries_, entry_count_ * sizeof(Entry));
    entries_ = next; entry_cap_ = new_cap;
    return true;
  }
  bool rehash(uint32_t new_bucket_cap) {
    if (!arena_) return false;
    uint32_t* next_buckets = arena_->alloc<uint32_t>(new_bucket_cap);
    if (!next_buckets) return false;
    for (uint32_t i = 0; i < new_bucket_cap; ++i) next_buckets[i] = kEmptyBucket;
    const uint32_t mask = new_bucket_cap - 1u;
    uint32_t re_used = 0;
    for (uint32_t idx = head_; idx != kNone; idx = entries_[idx].next) {
      uint32_t slot = static_cast<uint32_t>(entries_[idx].hash) & mask;
      while (next_buckets[slot] != kEmptyBucket) slot = (slot + 1u) & mask;
      next_buckets[slot] = idx;
      ++re_used;
    }
    buckets_ = next_buckets; bucket_cap_ = new_bucket_cap; used_buckets_ = re_used;
    return true;
  }

  Arena* arena_; Entry* entries_; uint32_t entry_count_; uint32_t entry_cap_;
  uint32_t* buckets_; uint32_t bucket_cap_; uint32_t size_; uint32_t used_buckets_;
  uint32_t head_; uint32_t tail_; uint32_t free_head_;
};

template <typename K, typename Traits = DefaultKeyTraits<K>>
class OrderedSet {
 public:
  struct Unit {};
  using MapType = OrderedMap<K, Unit, Traits>;
  class ConstIterator {
   public:
    explicit ConstIterator(typename MapType::ConstIterator it) : it_(it) {}
    const K& operator*() const { return it_->key; }
    ConstIterator& operator++() { ++it_; return *this; }
    bool operator==(const ConstIterator& o) const { return it_ == o.it_; }
    bool operator!=(const ConstIterator& o) const { return it_ != o.it_; }
   private:
    typename MapType::ConstIterator it_;
  };
  explicit OrderedSet(Arena* arena = nullptr) : map_(arena) {}
  void init(Arena* arena) { map_.init(arena); }
  void clear() { map_.clear(); }
  uint32_t size() const { return map_.size(); }
  bool empty() const { return map_.empty(); }
  bool reserve(uint32_t expected) { return map_.reserve(expected); }
  bool has(const K& key) const { return map_.has(key); }
  bool add(const K& key) { return map_.set(key, Unit{}); }
  bool erase(const K& key) { return map_.erase(key); }
  ConstIterator begin() const { return ConstIterator(map_.begin()); }
  ConstIterator end() const { return ConstIterator(map_.end()); }
 private:
  MapType map_;
};

}  // namespace hex
#endif
