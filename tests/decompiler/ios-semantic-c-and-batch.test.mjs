import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { buildSemanticModel } from '../../js/blocks.js';
import { buildIR } from '../../js/ir-core.js';
import { OP } from '../../js/ir.js';
import { decompileSemantic, renderMemoryLocation, renderValue } from '../../js/decompiler/semantic-core.js';
import { semanticSignature, reachingRegisterTypeValue } from '../../js/decompiler/type-recovery.js';
import { printExpression } from '../../js/decompiler/pretty/c.js';
import { captureRecoveryDominators } from '../../js/decompiler/phase8/projection-origin.js';
import { analyzeGraph } from '../../js/controlflow.js';
import {
  createCppClassIdentity,
  createCppReceiverEvidence,
  createCppVirtualSlotEvidence,
} from '../../js/analysis/cxx/object-evidence.js';

function makeFixture(lines, opts = {}) {
  const base = opts.addr ?? 0x100000n;
  const rows = lines.map((text, row) => {
    const trimmed = text.trim();
    const split = trimmed.indexOf(' ');
    return {
      row,
      address: base + BigInt(row * 4),
      mn: split < 0 ? trimmed : trimmed.slice(0, split),
      ops: split < 0 ? '' : trimmed.slice(split + 1).trim(),
    };
  });
  const rowOfAddress = (address) => rows.find((r) => r.address === BigInt(address))?.row ?? null;
  const model = buildSemanticModel(rows, { rowOfAddress, startRow: 0, endRow: rows.length - 1 });
  const ir = buildIR(model, { rowOfAddress, returnType: 'uint64', ...(opts.irOpts || {}) });
  return {
    model,
    ir,
    opts: {
      addr: base,
      name: 'test_fn',
      returnType: 'uint64',
      ir,
      ...opts,
    },
  };
}

function checkGccSyntax(cCode, label) {
  const wrapped = `#include <stdint.h>\n#define __HEX_ANY_ARGS ...\ntypedef unsigned long long uint64;\ntypedef long long int64;\ntypedef unsigned int uint32;\ntypedef int int32;\ntypedef unsigned short uint16;\ntypedef short int16;\ntypedef unsigned char uint8;\ntypedef signed char int8;\ntypedef void * id;\n${cCode}\n`;
  try {
    execFileSync('gcc', ['-fsyntax-only', '-x', 'c', '-'], { input: wrapped, stdio: ['pipe', 'pipe', 'pipe'] });
  } catch (err) {
    if (err.code === 'ENOENT') return; // gcc not installed in environment
    throw new Error(`GCC syntax check failed for ${label}:\n${err.stderr?.toString() || err.message}\n--- C ---\n${wrapped}`);
  }
}

// 1. C++ semanticSignature sanitization (CryptoPP template + simple class preserved)
{
  const { ir, opts } = makeFixture(['ldr x0, [x0, #8]', 'ret']);
  const arg0 = ir.args.get('x0');
  const makeRec = (className) => createCppReceiverEvidence({
    functionAddress: opts.addr,
    functionId: 'cxx_test',
    canonicalValueId: arg0.id,
    classIdentity: createCppClassIdentity({ kind: 'named', className }),
    receiverRole: 'this',
    nonStaticProof: { rule: 'proven-vtable-slot' },
    abiBinding: { architecture: 'arm64', register: 'x0', argumentIndex: 0 },
    completeness: 'complete',
    snapshotId: 'snap-cxx',
  });

  const recovered = { args: [{ index: 0, type: 'void *' }], ret: { type: 'uint64' } };
  const tmplSig = semanticSignature(
    'ZN8CryptoPP38CipherModeFinalTemplate',
    recovered,
    null,
    opts.addr,
    { cxxEvidence: { receiver: makeRec('CryptoPP::CipherModeFinalTemplate<CryptoPP::ECB_OneWay>') } },
    ir,
  );
  assert.equal(
    tmplSig,
    'uint64 ZN8CryptoPP38CipherModeFinalTemplate(CryptoPP_CipherModeFinalTemplate_CryptoPP_ECB_OneWay * this)',
  );
  assert.ok(!tmplSig.includes('::') && !tmplSig.includes('<') && !tmplSig.includes('>'));
  checkGccSyntax(`typedef struct CryptoPP_CipherModeFinalTemplate_CryptoPP_ECB_OneWay CryptoPP_CipherModeFinalTemplate_CryptoPP_ECB_OneWay;\n${tmplSig} { return 0; }`, 'C++ template signature');

  const simpleSig = semanticSignature(
    'Player_getHp',
    recovered,
    null,
    opts.addr,
    { cxxEvidence: { receiver: makeRec('Player') } },
    ir,
  );
  assert.equal(simpleSig, 'uint64 Player_getHp(Player * this)');
}

// 2. reachingRegisterTypeValue WeakMap cache bit-exactness
{
  const { ir } = makeFixture([
    'mov x0, #1',
    'cmp x1, #0',
    'b.eq #0x100018',
    'mov x0, #2',
    'bl #0x200000',
    'ret',
    'bl #0x200000',
    'ret',
  ]);
  const calls = ir.instructions.filter((i) => i.op === OP.CALL);
  assert.equal(calls.length, 2);
  const callAtRow4 = calls.find((c) => c.row === 4);
  const callAtRow6 = calls.find((c) => c.row === 6);
  assert.ok(callAtRow4 && callAtRow6);
  const first1 = reachingRegisterTypeValue(ir, callAtRow4, 'x0');
  const first2 = reachingRegisterTypeValue(ir, callAtRow4, 'x0');
  assert.equal(first1, first2);
  assert.equal(first1?.const, 2n);
  const second = reachingRegisterTypeValue(ir, callAtRow6, 'x0');
  assert.equal(second?.const, 1n);
}

// 3. renderMemoryLocation: unscaled memory[...] -> *(elemType *)(uintptr_t)(...)
{
  const { ir } = makeFixture(['ldr x0, [x1, x2]', 'ret']);
  const load = ir.instructions.find((i) => i.op === OP.LOAD);
  assert.ok(load);
  const ctx = {
    ir,
    opts: {},
    model: { addressRefs: [] },
    types: { values: new Map() },
    exprCache: new Map(),
    exprActive: new Set(),
    exprNodes: 0,
    materialNames: new Map(),
  };
  const rendered = renderMemoryLocation(load.loc, load, ctx);
  assert.ok(!rendered.includes('memory['), `Unexpected memory[ in: ${rendered}`);
  assert.equal(rendered, '*(uint64_t *)(uintptr_t)(a2 + a3)');
  checkGccSyntax(`uint64 f(uint64 a2, uint64 a3) { return ${rendered}; }`, 'renderMemoryLocation unscaled');
}

// 4. renderCall: objcSyntax: 'c' vs default, trailing comma removal, valid C indirect virtual call
{
  const { model, opts } = makeFixture([
    'adrp x1, #0x200000',
    'bl #0x300000',
    'ret',
  ]);
  const call = model.calls.find((c) => c.row === 1);
  if (call) {
    call.name = '_objc_msgSend';
    call.selector = 'setObject:forKey:';
  }
  const cMode = decompileSemantic(model, { ...opts, objcSyntax: 'c', receiverType: 'NSMutableDictionary' });
  assert.match(cMode.pseudocode, /objc_msgSend\((?:self|receiver), "setObject:forKey:"/);
  assert.doesNotMatch(cMode.pseudocode, /\[(?:self|receiver) setObject:/);

  const objcMode = decompileSemantic(model, { ...opts, receiverType: 'NSMutableDictionary' });
  assert.match(objcMode.pseudocode, /\[(?:self|receiver) setObject:/);
}

{
  // Virtual slot with unknown arity + unclosed candidate -> no trailing comma, no (*(code **)(...))
  const { model, ir, opts } = makeFixture([
    'ldr x8, [x0]',
    'ldr x8, [x8, #0x10]',
    'blr x8',
    'ret',
  ]);
  const callInst = ir.instructions.find((i) => i.op === OP.CALL);
  const arg0 = ir.args.get('x0');
  const receiver = createCppReceiverEvidence({
    functionAddress: opts.addr,
    functionId: 'vcall_unknown_arity',
    canonicalValueId: arg0.id,
    receiverRole: 'this',
    nonStaticProof: { rule: 'proven-vtable-slot' },
    abiBinding: { architecture: 'arm64', register: 'x0', argumentIndex: 0 },
    completeness: 'complete',
    snapshotId: 'snap-vcall',
  });
  const slot = createCppVirtualSlotEvidence({
    callSiteId: callInst.id,
    callSiteAddress: callInst.address,
    receiverValueId: arg0.id,
    vptrValueId: 'vptr',
    slotIndex: 2,
    slotByteOffset: 16,
    virtualSlotKnown: true,
    closureProven: false,
  });
  const res = decompileSemantic(model, { ...opts, cxxEvidence: { receiver, virtualSlots: [slot] } });
  assert.doesNotMatch(res.pseudocode, /\(\*\(code \*\*\)\(\.\.\.\)\)/);
  assert.doesNotMatch(res.pseudocode, /this,\s*\/\*\s*additional arguments unknown/);
  assert.match(res.pseudocode, /this \/\* , additional arguments unknown \*\//);
  assert.match(res.pseudocode, /\(\(uint64 \(\*\)\(__HEX_ANY_ARGS\)\)\(uintptr_t\)\(/);
}

// 5. unaryText sxtb..uxtw & OP.BFX/OP.BFI width fallback 0
{
  const makeCtx = () => ({
    ir: { instructions: [], values: [], blocks: [] },
    opts: {},
    model: { addressRefs: [] },
    types: { values: new Map() },
    exprCache: new Map(),
    exprActive: new Set(),
    exprNodes: 0,
    materialNames: new Map(),
  });
  const argVal = { id: 1, kind: 'arg', reg: 'x0', bits: 64 };
  for (const [sub, expected] of [
    ['sxtb', '(int8)a1'],
    ['sxth', '(int16)a1'],
    ['sxtw', '(int32)a1'],
    ['uxtb', '(uint8)a1'],
    ['uxth', '(uint16)a1'],
    ['uxtw', '(uint32)a1'],
  ]) {
    const v = { id: 2, def: { op: OP.UN, sub, args: [{ value: argVal }] } };
    assert.equal(renderValue(v, makeCtx()), expected);
  }
  const bfxVal = { id: 3, def: { op: OP.BFX, args: [{ value: argVal }], extra: { lsb: 4 } } };
  assert.equal(renderValue(bfxVal, makeCtx()), 'bit_extract(a1, 4, 0)');
  const bfiVal = { id: 4, def: { op: OP.BFI, args: [{ value: argVal }, { value: argVal }], extra: { lsb: 2 } } };
  assert.equal(renderValue(bfiVal, makeCtx()), 'bit_insert(a1, a1, 2, 0)');
}

// 6. pretty/c.js call and intrinsic sanitization
{
  assert.equal(
    printExpression({ kind: 'call', callee: 'CryptoPP::ECB<int>::Process', args: [{ kind: 'var', name: 'x' }] }),
    'CryptoPP_ECB_int_Process(x)',
  );
  assert.equal(
    printExpression({ kind: 'intrinsic', name: 'ns::op<u8>', args: [{ kind: 'var', name: 'x' }] }),
    'ns_op_u8(x)',
  );
  assert.equal(
    printExpression({ kind: 'call', callee: 'valid_fn_1', args: [{ kind: 'var', name: 'x' }] }),
    'valid_fn_1(x)',
  );
  assert.equal(
    printExpression({ kind: 'call', callee: 'obj->method', args: [{ kind: 'var', name: 'x' }] }),
    'obj->method(x)',
  );
}

// 7. captureRecoveryDominators deduplication & fail-closed mutation detection
{
  const graph = analyzeGraph([[1], [2], []], 0);
  const snap = captureRecoveryDominators(graph.dominators);
  assert.equal(snap.matches(), true);
  // Mutating shared idom array must fail closed
  const orig = graph.immediateDominators[2];
  graph.immediateDominators[2] = 0;
  assert.equal(snap.matches(), false);
  graph.immediateDominators[2] = orig;
  assert.equal(snap.matches(), true);
}

// 8. createValidationBatch in decompileSemantic: clean pass vs mid-emission mutation fail-closed
{
  const { model, opts } = makeFixture([
    'bl #0x200000',
    'add x0, x0, #1',
    'bl #0x200004',
    'ret',
  ]);
  const clean = decompileSemantic(model, opts);
  assert.equal(clean.semanticStatementRenderHistory?.completeness, 'complete');

  // Mutate model.calls during emitRegion via symbolFor callback -> settle() > 0 -> fail-closed incomplete
  const { model: m2, opts: o2 } = makeFixture([
    'bl #0x200000',
    'add x0, x0, #1',
    'bl #0x200004',
    'ret',
  ]);
  let mutated = false;
  const tampered = decompileSemantic(m2, {
    ...o2,
    symbolFor(addr) {
      if (!mutated && addr === 0x200004n) {
        mutated = true;
        m2.calls.push({ row: 999, name: 'injected' });
      }
      return null;
    },
  });
  assert.equal(mutated, true);
  assert.equal(tampered.semanticStatementRenderHistory?.completeness, 'incomplete');
  assert.ok(tampered.semanticStatementRenderHistory?.reasons.includes('initial-statement-binding-unavailable'));
}

console.log('ios-semantic-c-and-batch.test.mjs: ALL PASS');
