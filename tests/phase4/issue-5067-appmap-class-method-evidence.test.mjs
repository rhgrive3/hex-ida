import assert from 'node:assert/strict';
import { buildAppMap } from '../../js/appmap.js';

function fieldsFor(cls) {
  return { classCount: 1, classes: new Map([[cls.name, cls]]) };
}

function classRecord(name, methods = [], classMethods = []) {
  return { name, superName: null, methods, classMethods, ivars: [], instanceSize: 0 };
}

function classFrom(map, name) {
  const cls = map.classes.find((entry) => entry.name === name);
  assert.ok(cls, `missing class ${name}`);
  return cls;
}

// Minimal #5067 regression: class-method-only string evidence must reach the
// same classifier path as instance-method evidence.
{
  const classMethod = { addr: 0x1000n, sel: 'load' };
  const cls = classRecord('PlainClass', [], [classMethod]);
  const map = buildAppMap({
    fields: fieldsFor(cls),
    strings: [{ addr: 0x2000n, text: 'https://example.test/api' }],
    program: {
      functionRange: (addr) => addr === classMethod.addr ? { start: 0x1000n, end: 0x1010n } : null,
      refsFrom: () => [{ target: 0x2000n }],
      calleesOf: () => [],
      callCountOf: () => 0,
    },
  });

  const mapped = classFrom(map, cls.name);
  assert.equal(mapped.category, 'network');
  assert.ok(mapped.why.some((entry) => entry.code === 'string' && entry.id === 'network'));
}

// Class-method-only API evidence must also contribute.
{
  const classMethod = { addr: 0x3000n, sel: 'connect' };
  const cls = classRecord('PlainClass', [], [classMethod]);
  const map = buildAppMap({
    fields: fieldsFor(cls),
    strings: [],
    symbols: { nameAt: (addr) => addr === 0x4000n ? 'connect' : null },
    program: {
      functionRange: (addr) => addr === classMethod.addr ? { start: 0x3000n, end: 0x3010n } : null,
      refsFrom: () => [],
      calleesOf: () => [{ addr: 0x4000n }],
      callCountOf: () => 0,
    },
  });

  const mapped = classFrom(map, cls.name);
  assert.equal(mapped.category, 'network');
  assert.ok(mapped.why.some((entry) => entry.code === 'api' && entry.id === 'network'));
}

// Instance and class methods share the existing 60-method classification
// budget instead of multiplying it. Class methods consume the remaining room.
{
  const methods = Array.from({ length: 50 }, (_, index) => ({ addr: BigInt(index + 1) }));
  const classMethods = Array.from({ length: 50 }, (_, index) => ({ addr: BigInt(1000 + index) }));
  const visited = [];
  const cls = classRecord('PlainClass', methods, classMethods);
  buildAppMap({
    fields: fieldsFor(cls),
    strings: [],
    program: {
      functionRange(addr) { visited.push(addr); return null; },
      callCountOf: () => 0,
    },
  });

  assert.equal(visited.length, 60);
  assert.deepEqual(visited.slice(50), classMethods.slice(0, 10).map((method) => method.addr));
}

// #5208 remains true for class methods too: an unproven function end must not
// become an unbounded string/API evidence scan.
{
  const classMethod = { addr: 0x5000n, sel: 'load' };
  const cls = classRecord('PlainClass', [], [classMethod]);
  let refsCalls = 0;
  let calleeCalls = 0;
  const map = buildAppMap({
    fields: fieldsFor(cls),
    strings: [{ addr: 0x6000n, text: 'https://example.test/api' }],
    symbols: { nameAt: () => 'connect' },
    program: {
      functionRange: () => ({ start: 0x5000n, end: null }),
      refsFrom: () => { refsCalls++; return [{ target: 0x6000n }]; },
      calleesOf: () => { calleeCalls++; return [{ addr: 0x7000n }]; },
      callCountOf: () => 0,
    },
  });

  assert.equal(classFrom(map, cls.name).category, 'unknown');
  assert.equal(refsCalls, 0);
  assert.equal(calleeCalls, 0);
}

console.log('issue-5067 appmap class-method evidence: PASS');
