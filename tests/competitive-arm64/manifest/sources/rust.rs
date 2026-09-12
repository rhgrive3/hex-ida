#![no_std]
#[inline(never)]
pub fn slice_bounds(values: &[u64], index: usize) -> Option<u64> { values.get(index).copied() }
