// Regression for #4561: one corrupt NoteStore delta must not make
// _loadDeltas() abandon the later valid deltas in the same overlay.
import assert from 'node:assert/strict';

class StorageMock {
  constructor() { this.map = new Map(); }
  get length() { return this.map.size; }
  key(index) { return [...this.map.keys()][index] ?? null; }
  getItem(key) { return this.map.has(String(key)) ? this.map.get(String(key)) : null; }
  setItem(key, value) { this.map.set(String(key), String(value)); }
  removeItem(key) { this.map.delete(String(key)); }
  clear() { this.map.clear(); }
}

globalThis.localStorage = new StorageMock();
const { NoteStore } = await import('../js/names.js');

localStorage.clear();
localStorage.setItem('hex.notes.demo', JSON.stringify({ names: {} }));
// Lexicographically first delta is unreadable.
localStorage.setItem('hex.notes.demo.delta.names.a', '{');
// Later delta is valid and must survive.
localStorage.setItem(
  'hex.notes.demo.delta.names.z',
  JSON.stringify({ kind: 'names', key: 'z', value: 'survives' }),
);

const notes = new NoteStore('demo');
assert.equal(notes.names.get('z'), 'survives',
  'a corrupt delta must be isolated per-record; later valid deltas still restore');

console.log('issue #4561 notestore delta isolation PASS');
