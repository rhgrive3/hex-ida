import test from 'node:test';
import assert from 'node:assert/strict';
import { buildIR } from '../../../js/ir-core.js';
import { buildSemanticModel } from '../../../js/blocks.js';
import { decompileSemantic } from '../../../js/decompiler/semantic-core.js';
import {
  createCppReceiverEvidence,
  createCppClassIdentity,
  createCppVirtualSlotEvidence,
} from '../../../js/analysis/cxx/object-evidence.js';

test('typed this and virtual call projection with canonical C++ evidence', () => {
  const rows = [
    { row: 0, address: 0x100000000n, mn: 'ldr', ops: 'x1, [x0]' },
    { row: 1, address: 0x100000004n, mn: 'ldr', ops: 'x2, [x1, #0x10]' },
    { row: 2, address: 0x100000008n, mn: 'blr', ops: 'x2' },
    { row: 3, address: 0x10000000cn, mn: 'ret', ops: '' },
  ];
  const rowOfAddress = (address) => rows.find((r) => r.address === BigInt(address))?.row ?? null;
  const model = buildSemanticModel(rows, { rowOfAddress, startRow: 0, endRow: rows.length - 1 });
  const prototype = { returnType: 'void', returnBits: 0, returnsValue: false, args: [{ type: 'uint64', bits: 64 }] };
  const ir = buildIR(model, { rowOfAddress, returnType: 'void', callPrototypeFor: () => prototype, semanticMigrationMode: 'semantic-v2-compat' });

  const receiverVal = ir?.args?.get?.('x0')
    ?? ir?.values?.find?.(v => v.kind === 'arg' && (v.reg === 'x0' || v.index === 0));
  assert.ok(receiverVal, 'must have receiver argument');

  const classIdentity = createCppClassIdentity({
    kind: 'named',
    className: 'Widget',
    vtableAddress: 0x100020000n,
  });

  const receiverEvidence = createCppReceiverEvidence({
    functionAddress: 0x100000000n,
    functionId: 'func_widget_draw',
    canonicalValueId: receiverVal.id,
    receiverRole: 'this',
    classIdentity,
    nonStaticProof: {
      source: 'rtti-vtable-member',
      rule: 'vtable-slot-entry',
    },
    abiBinding: {
      architecture: 'arm64',
      register: 'x0',
      argumentIndex: 0,
    },
    completeness: 'complete',
    snapshotId: 'snap-1',
  });

  const opts = {
    ir,
    addr: 0x100000000n,
    name: '_ZNK6Widget4drawEv',
    cxxEvidence: {
      receiver: receiverEvidence,
    }
  };

  const result = decompileSemantic(model, opts);
  assert.ok(result);
  // Signature must project Widget * this
  assert.match(result.signature, /Widget\s*\*\s*this/);
});
