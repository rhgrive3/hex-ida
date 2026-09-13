import test from 'node:test';
import assert from 'node:assert/strict';
import { captureProjectionIrData, createProjectionIrObserver } from '../../../js/core/identity/live-data.js';

const captures = [
  ['ordinary', roots=>captureProjectionIrData(roots)],
  ['graph', roots=>createProjectionIrObserver().captureGraph(roots)],
  ['certified', roots=>createProjectionIrObserver().captureCertifiedDataGraph(roots)],
];

for (const [name,capture] of captures) {
  test(`${name}: frozen own fields are stable while mutable descendants remain observed`, () => {
    const child={value:1},parent=Object.freeze({child,rows:Object.freeze([child])});
    const observed=capture([parent]);
    assert.equal(observed.matches(),true);
    child.value=2;
    assert.equal(observed.matches(),false);
  });
  test(`${name}: freezing after capture cannot refresh changed fields`, () => {
    const value={value:1},observed=capture([value]);
    value.value=2;Object.freeze(value);
    assert.equal(observed.matches(),false);
  });
  test(`${name}: a revoked frozen proxy cannot remain current`, () => {
    const {proxy,revoke}=Proxy.revocable(Object.freeze({value:1}),{});
    const observed=capture([proxy]);assert.equal(observed.matches(),true);
    revoke();assert.equal(observed.matches(),false);
  });
  test(`${name}: throwing frozen-proxy descriptor traps fail closed`, () => {
    let fail=false;
    const value=new Proxy(Object.freeze({value:1}),{getOwnPropertyDescriptor(target,key){
      if(fail)throw new Error('unavailable');return Reflect.getOwnPropertyDescriptor(target,key);
    }});
    const observed=capture([value]);assert.equal(observed.matches(),true);
    fail=true;assert.equal(observed.matches(),false);
  });
  test(`${name}: frozen cycles retain mutable leaves and replacement detection`, () => {
    const leaf={value:1},a={leaf},b={a};a.b=b;Object.freeze(a);Object.freeze(b);
    const envelope={a},observed=capture([envelope]);
    assert.equal(observed.matches(),true);
    leaf.value=2;assert.equal(observed.matches(),false);
    leaf.value=1;assert.equal(observed.matches(),true);
    envelope.a={...a};assert.equal(observed.matches(),false);
  });
  test(`${name}: repeated reads do not rescan frozen own descriptors`, () => {
    const child={value:1};
    const frozen=Object.freeze(Object.fromEntries(Array.from({length:256},(_,i)=>['field'+i,i])));
    const parent=Object.freeze({frozen,child}),observed=capture([parent]);
    const original=Object.getOwnPropertyDescriptor;let frozenVisits=0,childVisits=0;
    Object.getOwnPropertyDescriptor=(value,key)=>{
      if(value===frozen||value===parent)frozenVisits++;
      if(value===child)childVisits++;
      return original(value,key);
    };
    try { assert.equal(observed.matches(),true); }
    finally { Object.getOwnPropertyDescriptor=original; }
    assert.equal(frozenVisits,0,'frozen own descriptors cannot change');
    assert.ok(childVisits>0,'mutable descendants still require a live scan');
  });
}

test('frozen accessors remain invalid data and are never evaluated', () => {
  let calls=0;const value=Object.freeze({get value(){calls++;return 1;}});
  for(const [,capture] of captures)assert.throws(()=>capture([value]),/accessor/);
  assert.equal(calls,0);
});
