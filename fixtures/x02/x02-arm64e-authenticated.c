__attribute__((noinline)) int x02_leaf(int x) {
    return x + 7;
}

__attribute__((noinline)) int x02_call(int x) {
    return x02_leaf(x) ^ 0x5a;
}
