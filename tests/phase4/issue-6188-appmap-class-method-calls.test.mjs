import assert from 'node:assert/strict';
import { buildAppMap } from '../../js/appmap.js';

function fieldsFor(classes) {
  return {
    classCount: classes.length,
    classes: new Map(classes.map((entry) => [entry.name, entry])),
  };
}

function classRecord(name, methods = [], classMethods = []) {
  return {
    name,
    superName: null,
    methods,
    classMethods,
    ivars: [],
    instanceSize: 0,
  };
}

// Class methods must contribute even when a class has no instance methods.
{
  const classMethod = { addr: 0x1000n };
  const map = buildAppMap({
    fields: fieldsFor([classRecord('BattleManager', [], [classMethod])]),
    strings: [],
    program: {
      functionRange: () => null,
      callCountOf: (addr) => (addr === classMethod.addr ? 3 : 0),
    },
  });

  assert.equal(map.classes[0].calls, 3);
  const battle = map.subsystems.find((subsystem) => subsystem.id === 'battle');
  assert.equal(battle?.calls, 3);
}

// Instance and class methods share the existing bounded scan budget.
{
  const methods = Array.from({ length: 20 }, (_, index) => ({ addr: BigInt(index + 1) }));
  const classMethod = { addr: 0x2000n };
  const map = buildAppMap({
    fields: fieldsFor([classRecord('BattleManager', methods, [classMethod])]),
    strings: [],
    program: { functionRange: () => null, callCountOf: () => 1 },
  });

  assert.equal(map.classes[0].calls, 20);
}

// Missing or address-less method records remain harmless.
{
  const map = buildAppMap({
    fields: fieldsFor([classRecord('BattleManager', [{ addr: null }], [{ name: '+[BattleManager start]' }])]),
    strings: [],
    program: {
      functionRange: () => null,
      callCountOf: () => { throw new Error('address-less method was counted'); },
    },
  });

  assert.equal(map.classes[0].calls, 0);
}

console.log('issue-6188-appmap-class-method-calls: ok');
