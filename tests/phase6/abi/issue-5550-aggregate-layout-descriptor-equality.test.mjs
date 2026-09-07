import assert from 'node:assert/strict';

import { canonicalAggregateLayout } from '../../../js/targets/abi/aggregate-layout.js';

function member(bits, bytes, byteOffset, extra = {}) {
  return { bits, bytes, byteOffset, ...extra };
}

function aggregate({ members, nestedMembers = members, padding, nestedPadding = padding, bits = 32, bytes = 4 }) {
  return {
    bits,
    bytes,
    members,
    ...(padding === undefined ? {} : { padding }),
    layout:{
      members:nestedMembers,
      ...(nestedPadding === undefined ? {} : { padding:nestedPadding }),
    },
  };
}

{
  const descriptor = member(32, 4, 0);
  const result = canonicalAggregateLayout(aggregate({
    members:[descriptor],
    nestedMembers:[{ bits:32, bytes:4, byteOffset:0 }],
  }));
  assert.ok(result, 'identical descriptor spellings must remain accepted');
  assert.equal(result.members[0].byteOffset, 0);
}

{
  const topMember = { bits:32, bytes:4, byteOffset:0 };
  const nestedMember = { byteOffset:0, bytes:4, bits:32 };
  const result = canonicalAggregateLayout(aggregate({ members:[topMember], nestedMembers:[nestedMember] }));
  assert.ok(result, 'object key insertion order must not create a false aggregate-layout conflict');
  assert.deepEqual(
    { bits:result.members[0].bits, bytes:result.members[0].bytes, byteOffset:result.members[0].byteOffset },
    { bits:32, bytes:4, byteOffset:0 },
  );
}

{
  const topMember = member(32, 4, 0, {
    evidence:{ class:'integer', detail:{ signed:true, laneBits:32 } },
  });
  const nestedMember = {
    evidence:{ detail:{ laneBits:32, signed:true }, class:'integer' },
    byteOffset:0,
    bytes:4,
    bits:32,
  };
  assert.ok(
    canonicalAggregateLayout(aggregate({ members:[topMember], nestedMembers:[nestedMember] })),
    'nested plain-data key order must not affect semantic descriptor equality',
  );
}

{
  assert.equal(
    canonicalAggregateLayout(aggregate({
      members:[member(32, 4, 0)],
      nestedMembers:[member(16, 4, 0)],
    })),
    null,
    'a real member field contradiction must remain ambiguous',
  );
}

{
  const first = member(32, 4, 0);
  const second = member(32, 4, 4);
  assert.equal(
    canonicalAggregateLayout(aggregate({
      bits:64,
      bytes:8,
      members:[first, second],
      nestedMembers:[second, first],
    })),
    null,
    'member array order remains authoritative and must not be canonicalized away',
  );
}

{
  const topMembers = [member(32, 4, 0)];
  topMembers[Symbol('authority')] = 'x';
  assert.equal(
    canonicalAggregateLayout(aggregate({
      members:topMembers,
      nestedMembers:[member(32, 4, 0)],
    })),
    null,
    'enumerable symbol-backed array evidence must fail closed',
  );
}

{
  const topMembers = [member(32, 4, 0)];
  topMembers.authority = 'x';
  assert.equal(
    canonicalAggregateLayout(aggregate({
      members:topMembers,
      nestedMembers:[member(32, 4, 0)],
    })),
    null,
    'enumerable non-index array evidence must fail closed',
  );
}

{
  assert.equal(
    canonicalAggregateLayout(aggregate({
      bits:64,
      bytes:8,
      members:[member(32, 4, 0)],
      nestedMembers:[{ byteOffset:0, bytes:4, bits:32 }],
      padding:[{ byteOffset:4, bytes:4 }],
      nestedPadding:[{ bytes:4, byteOffset:5 }],
    })),
    null,
    'padding/offset contradictions must remain fail-closed',
  );
}

{
  let getterCalls = 0;
  const hostile = { bits:32, bytes:4 };
  Object.defineProperty(hostile, 'byteOffset', {
    enumerable:true,
    get() {
      getterCalls += 1;
      return 0;
    },
  });
  assert.equal(
    canonicalAggregateLayout(aggregate({
      members:[member(32, 4, 0)],
      nestedMembers:[hostile],
    })),
    null,
    'accessor-backed alternate descriptors are not canonical plain data',
  );
  assert.equal(getterCalls, 0, 'descriptor equality must not invoke accessor evidence');
}

{
  const { proxy, revoke } = Proxy.revocable({ bits:32, bytes:4, byteOffset:0 }, {});
  revoke();
  assert.doesNotThrow(() => {
    assert.equal(
      canonicalAggregateLayout(aggregate({
        members:[member(32, 4, 0)],
        nestedMembers:[proxy],
      })),
      null,
      'revoked proxy evidence must fail closed rather than escaping the validator',
    );
  });
}

{
  const topMember = {};
  Object.defineProperty(topMember, 'bits', { value:32, enumerable:true });
  Object.defineProperty(topMember, 'bytes', { value:4, enumerable:true });
  Object.defineProperty(topMember, 'byteOffset', { value:0, enumerable:true });
  Object.defineProperty(topMember, 'padding', { value:0, enumerable:false });
  const nestedMember = { bits:16, bytes:4, byteOffset:0, padding:0 };
  assert.equal(
    canonicalAggregateLayout(aggregate({ members:[topMember], nestedMembers:[nestedMember] })),
    null,
    'non-enumerable own fields must not be silently omitted from descriptor equality',
  );
}

{
  const shared = {};
  Object.defineProperty(shared, 'bits', { get() { throw new Error('accessor must never be invoked'); }, enumerable:true });
  const topMember = { bytes:4, byteOffset:0, detail:shared };
  const nestedMember = { bits:32, bytes:4, byteOffset:0, detail:shared };
  assert.doesNotThrow(() => {
    assert.equal(
      canonicalAggregateLayout(aggregate({ members:[topMember], nestedMembers:[nestedMember] })),
      null,
      'a shared reference must traverse the fail-closed validation path, not the identity shortcut',
    );
  });
}

console.log('issue #5550 aggregate layout semantic descriptor equality regression: ok');
