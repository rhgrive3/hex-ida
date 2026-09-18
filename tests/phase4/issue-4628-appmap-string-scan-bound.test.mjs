import assert from 'node:assert/strict';
import { buildStringMap } from '../../js/appmap.js';

const MAX_INSPECTED = 4000;

function stringEntry(index, text = 'login') {
  return {
    addr: BigInt(index * 16),
    text,
    byteLength: Buffer.byteLength(text, 'utf8'),
  };
}

// Classified strings without xrefs must still consume the inspection budget.
{
  let xrefQueries = 0;
  const strings = Array.from({ length: 10_000 }, (_, index) => stringEntry(index));
  const result = buildStringMap({
    strings,
    program: {
      functionsReferencing() {
        xrefQueries++;
        return [];
      },
    },
  });

  assert.equal(xrefQueries, MAX_INSPECTED);
  assert.equal(result.subsystems.length, 0);
}

// Unclassified strings must not make classifyString inspect the whole input.
{
  let textReads = 0;
  const strings = Array.from({ length: 10_000 }, (_, index) => ({
    addr: BigInt(index * 16),
    byteLength: 1,
    get text() {
      textReads++;
      return '';
    },
  }));
  const result = buildStringMap({
    strings,
    program: {
      functionsReferencing() {
        throw new Error('unclassified string reached xref lookup');
      },
    },
  });

  assert.equal(textReads, MAX_INSPECTED);
  assert.equal(result.subsystems.length, 0);
}

// A useful entry within the first 4,000 remains visible, while later entries
// cannot extend the synchronous AppMap work past the resource boundary.
{
  let xrefQueries = 0;
  const strings = Array.from({ length: MAX_INSPECTED + 1 }, (_, index) => stringEntry(index));
  const inside = strings[MAX_INSPECTED - 1];
  const outside = strings[MAX_INSPECTED];
  const result = buildStringMap({
    strings,
    program: {
      functionsReferencing(addr) {
        xrefQueries++;
        if (addr === inside.addr) return [{ addr: 0x1234n }];
        if (addr === outside.addr) return [{ addr: 0x5678n }];
        return [];
      },
    },
  });

  assert.equal(xrefQueries, MAX_INSPECTED);
  const login = result.subsystems.find((entry) => entry.id === 'login');
  assert.ok(login, 'expected login subsystem from an in-budget string');
  assert.deepEqual(login.functions.map((entry) => entry.addr), [0x1234n]);
}

console.log('issue-4628-appmap-string-scan-bound: ok');
