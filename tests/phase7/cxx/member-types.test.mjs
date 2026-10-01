import assert from 'node:assert/strict';
import test from 'node:test';

import { buildIR } from '../../../js/ir-core.js';
import { buildSemanticModel } from '../../../js/blocks.js';
import {
  classifyMemberAccess,
  memberTypeResolver,
  recoverMemberTypeEvidence,
} from '../../../js/analysis/cxx/member-types.js';

function createIr(lines) {
  const rows = lines.map((text, row) => {
    const split = text.indexOf(' ');
    return {
      row,
      address: 0x100000000n + BigInt(row * 4),
      mn: split < 0 ? text : text.slice(0, split),
      ops: split < 0 ? '' : text.slice(split + 1),
    };
  });
  const rowOfAddress = (address) => rows.find((row) => row.address === BigInt(address))?.row ?? null;
  const model = buildSemanticModel(rows, { rowOfAddress, startRow: 0, endRow: rows.length - 1 });
  const prototype = { returnType: 'uint64', returnBits: 64, returnsValue: true, args: [{ type: 'uint64', bits: 64 }] };
  return buildIR(model, {
    rowOfAddress,
    returnType: 'uint64',
    callPrototypeFor: () => prototype,
    semanticMigrationMode: 'semantic-v2-compat',
  });
}

const allBases = () => true;

test('single-bit masked input stores retain caller provenance and reject transformed or oversized masks',()=>{
  const ir=createIr(['and w2, w1, #1','strb w2, [x0, #4]','mov w2, #1','strb w2, [x0, #5]','ret']);
  const report=recoverMemberTypeEvidence({ir,isReceiverBase:allBases});
  assert.deepEqual(fieldAt(report,4).writtenArgumentBits,['x1:0']);
  assert.deepEqual(fieldAt(report,4).writtenArgumentRegisters,[]);
  assert.ok(fieldAt(report,4).accessRoles.includes('argument-written'));
  assert.deepEqual(fieldAt(report,5).writtenArgumentBits,[]);
  assert.ok(fieldAt(report,5).accessRoles.includes('one-written'));
  assert.equal(fieldAt(report,4).memberName,undefined);
  const base={id:'b'},argument={id:'a',kind:'arg',reg:'x1'},mask={id:'m'},masked={id:'v'};
  const toy={values:[argument],instructions:[{op:'const',dst:mask,extra:{value:1n}},
    {op:'bin',sub:'and',dst:masked,args:[argument,mask]},
    {op:'store',args:[masked],loc:{kind:'field',base,disp:4n,size:1}}]};
  const read=()=>recoverMemberTypeEvidence({ir:toy,isReceiverBase:v=>v===base}).fields[0].writtenArgumentBits;
  assert.deepEqual(read(),['x1:0']);
  for(const value of [0n,-1n,3n,256n,1n<<128n]) {
    toy.instructions[0].extra.value=value;assert.deepEqual(read(),[]);
  }
  toy.instructions[0].extra.value=1n;
  toy.instructions.splice(1,0,{op:'un',sub:'neg',dst:{id:'neg'},args:[argument]});
  toy.instructions[2].args[0]={id:'neg'};
  assert.deepEqual(read(),[],'transformed inputs cannot claim an entry argument bit');
});

function fieldAt(report, offset) {
  return report.fields.find((field) => field.offset === BigInt(offset)) ?? null;
}

test('member access roles distinguish returned and compared loads without naming or strengthening the field type', () => {
  const ir=createIr(['ldr w1, [x0, #0x38]','cmp w1, #0x3','ldr w0, [x0, #0x40]','ret']);
  const report=recoverMemberTypeEvidence({ir,isReceiverBase:allBases});
  assert.ok(fieldAt(report,56).accessRoles.includes('comparison-input'));
  assert.equal(fieldAt(report,56).accessRoles.includes('return-input'),false);
  assert.deepEqual(fieldAt(report,64).accessRoles,['return-input']);
  assert.equal(fieldAt(report,64).category,'int32');assert.equal(fieldAt(report,64).widthOnly,true);
  assert.equal(fieldAt(report,64).memberName,undefined);
});

test('direct SSA uses retain member roles even without an intermediate copy',()=>{
  const base={id:1},loaded={id:2};
  const ir={instructions:[{op:'load',dst:loaded,loc:{kind:'field',base,disp:8n,size:4}},{op:'ret',args:[loaded]}]};
  assert.deepEqual(recoverMemberTypeEvidence({ir,isReceiverBase:v=>v===base}).fields[0].accessRoles,['return-input']);
});

test('stored constants and bounded argument flows remain machine context without naming members',()=>{
  const base={id:'object'},argument={id:'input',kind:'arg',reg:'x1'},one={id:'one'},copy={id:'copy'};
  const ir={values:[argument],instructions:[
    {op:'const',dst:one,extra:{value:1n}},
    {op:'mov',dst:copy,args:[argument]},
    {op:'store',args:[copy],loc:{kind:'field',base,disp:8n,size:1}},
    {op:'store',args:[one],loc:{kind:'field',base,disp:9n,size:1}}]};
  const result=recoverMemberTypeEvidence({ir,isReceiverBase:v=>v===base});
  assert.deepEqual(fieldAt(result,8).accessRoles,['argument-written']);
  assert.deepEqual(fieldAt(result,8).writtenArgumentRegisters,['x1']);
  assert.deepEqual(fieldAt(result,9).writtenArgumentRegisters,[]);
  assert.deepEqual(fieldAt(result,9).accessRoles,['constant-written','one-written']);
  assert.equal(fieldAt(result,8).category,'int8');
  assert.equal(fieldAt(result,9).category,'bool-like');
  assert.equal(fieldAt(result,9).memberName,undefined);
  ir.instructions[1]={op:'mov',dst:copy,args:[copy]};
  assert.deepEqual(fieldAt(recoverMemberTypeEvidence({ir,isReceiverBase:v=>v===base}),8).accessRoles,[]);
  assert.deepEqual(fieldAt(recoverMemberTypeEvidence({ir,isReceiverBase:v=>v===base}),8).writtenArgumentRegisters,[]);
  ir.instructions.splice(1,0,{op:'un',dst:{id:'negated'},args:[one],extra:{kind:'not'}},
    {op:'store',args:[{id:'negated'}],loc:{kind:'field',base,disp:10n,size:1}},
    {op:'const',dst:{id:'zero'},extra:{value:0n}},
    {op:'store',args:[{id:'zero'}],loc:{kind:'field',base,disp:11n,size:1}});
  const literalResult=recoverMemberTypeEvidence({ir,isReceiverBase:v=>v===base});
  assert.deepEqual(fieldAt(literalResult,10).accessRoles,['constant-written']);
  assert.equal(fieldAt(literalResult,10).category,'int8','arbitrary unary operations cannot prove a 0/1 store');
  assert.deepEqual(fieldAt(literalResult,11).accessRoles,['constant-written','zero-written']);
  ir.instructions.push({op:'un',dst:{id:'modified-input'},args:[argument],extra:{kind:'not'}},
    {op:'store',args:[{id:'modified-input'}],loc:{kind:'field',base,disp:12n,size:1}});
  const modified=fieldAt(recoverMemberTypeEvidence({ir,isReceiverBase:v=>v===base}),12);
  assert.ok(modified.accessRoles.includes('argument-written'));
  assert.deepEqual(modified.writtenArgumentRegisters,[],'unary argument-derived values cannot claim an unmodified entry source');
});

// ── pure classifier ────────────────────────────────────────────────────────

test('classifier proves only what the access evidence proves', () => {
  // A plain word access proves the width, not the signedness.
  const word = classifyMemberAccess({ size: 4, signed: false });
  assert.equal(word.category, 'int32');
  assert.equal(word.signedness, null);
  assert.equal(word.label, 'int32_t|uint32_t');
  assert.deepEqual(word.candidates, ['int32_t', 'uint32_t']);

  // A sign-extending load proves signedness.
  const signedWord = classifyMemberAccess({ size: 4, signed: true });
  assert.equal(signedWord.signedness, true);
  assert.equal(signedWord.label, 'int32_t');

  assert.equal(classifyMemberAccess({ size: 4, fp: true }).category, 'float');
  assert.equal(classifyMemberAccess({ size: 8, fp: true }).category, 'double');
  assert.equal(classifyMemberAccess({ size: 8, pointerUse: true }).category, 'pointer');
  assert.equal(classifyMemberAccess({ size: 1, boolLike: true }).category, 'bool-like');
  assert.equal(classifyMemberAccess({ size: 4, indexed: true }).category, 'array-like');
  assert.equal(classifyMemberAccess({ size: 3 }).category, null);
  assert.equal(classifyMemberAccess({ size: 0 }).reason, 'unknown-access-width');
});

// ── access evidence from the semantic IR ───────────────────────────────────

test('a 32-bit member access reports a width-proven integer category', () => {
  const ir = createIr(['ldr w1, [x0, #0x38]', 'ldr w2, [x0, #0x40]', 'add w0, w1, w2', 'ret']);
  const report = recoverMemberTypeEvidence({ ir, isReceiverBase: allBases });
  assert.equal(report.fieldCount, 2);
  assert.equal(fieldAt(report, 0x38).category, 'int32');
  assert.equal(fieldAt(report, 0x38).widthOnly, true);
  assert.equal(fieldAt(report, 0x40).category, 'int32');
  assert.equal(report.typedFieldCount, 0);
  assert.equal(report.widthOnlyFieldCount, 2);
});

test('a float member is proven by flow into a vector register', () => {
  const ir = createIr(['ldr s0, [x0, #0x38]', 'ret']);
  const report = recoverMemberTypeEvidence({ ir, isReceiverBase: allBases });
  const field = fieldAt(report, 0x38);
  assert.equal(field.category, 'float');
  assert.equal(field.typeLabel, 'float');
  assert.equal(field.widthOnly, false);
  assert.equal(field.rule, 'vector-register-flow');
  assert.equal(report.typedFieldCount, 1);
});

test('a double member is proven at 8 bytes', () => {
  const ir = createIr(['ldr d0, [x0, #0x38]', 'ret']);
  const report = recoverMemberTypeEvidence({ ir, isReceiverBase: allBases });
  assert.equal(fieldAt(report, 0x38).category, 'double');
});

test('a pointer member is proven when the loaded value becomes an address', () => {
  const ir = createIr(['ldr x8, [x0, #0x10]', 'ldr w0, [x8, #0x8]', 'ret']);
  const report = recoverMemberTypeEvidence({ ir, isReceiverBase: allBases });
  const field = fieldAt(report, 0x10);
  assert.equal(field.category, 'pointer');
  assert.equal(field.rule, 'loaded-value-used-as-address-or-argument');
});

test('a bool-like member is proven from a byte compared against zero', () => {
  const ir = createIr(['ldrb w1, [x0, #0x3c]', 'cbz w1, #0x100000020', 'ret']);
  const report = recoverMemberTypeEvidence({ ir, isReceiverBase: allBases });
  const field = fieldAt(report, 0x3c);
  assert.equal(field.category, 'bool-like');
  assert.equal(field.widthOnly, false);
});

test('a byte compared against a non-boolean literal is not bool-like', () => {
  // `cmp`/`b.ne` is the general path: the compared literal must be 0 or 1 for
  // the byte to read as boolean. 42 is an ordinary small integer.
  const ir = createIr(['ldrb w1, [x0, #0x3c]', 'cmp w1, #0x2a', 'b.ne #0x100000030', 'ret']);
  const report = recoverMemberTypeEvidence({ ir, isReceiverBase: allBases });
  const field = fieldAt(report, 0x3c);
  assert.equal(field.category, 'int8');
  assert.notEqual(field.category, 'bool-like');
});

test('a bool-like member is proven from a store of a literal zero', () => {
  const ir = createIr(['mov w1, #0x0', 'strb w1, [x0, #0x3c]', 'ret']);
  const report = recoverMemberTypeEvidence({ ir, isReceiverBase: allBases });
  assert.equal(fieldAt(report, 0x3c).category, 'bool-like');
});

test('an indexed access with a matching scale is array-like', () => {
  const ir = createIr(['ldr w0, [x0, x1, lsl #2]', 'ret']);
  const report = recoverMemberTypeEvidence({ ir, isReceiverBase: allBases });
  const field = fieldAt(report, 0);
  assert.ok(field, 'the indexed access must be attributed to the receiver base');
  assert.equal(field.category, 'array-like');
  assert.equal(field.indexed, true);
  assert.equal(field.typeLabel, 'int32_t|uint32_t[]');
});

test('an indexed access whose scale contradicts the element width fails closed', () => {
  // A 4-byte access scaled by 8 cannot be one array of 4-byte elements. The
  // guard is exercised directly because the decoder only emits register-offset
  // forms whose shift matches the access width.
  const ir = {
    values: [],
    instructions: [{
      op: 'load',
      dst: { id: 1, bits: 32 },
      loc: { kind: 'unknown', base: null, disp: undefined, index: null },
      addr: { disp: 0n, base: { id: 2, reg: 'x0' }, index: { id: 3, reg: 'x1' }, scale: 3 },
    }],
  };
  const report = recoverMemberTypeEvidence({ ir, isReceiverBase: allBases });
  const field = fieldAt(report, 0);
  assert.ok(field);
  assert.equal(field.category, null);
  assert.equal(field.reason, 'indexed-access-scale-mismatch');
});

test('an indexed access alongside a direct one at the same offset fails closed', () => {
  // `this->field` and `this->array[i]` at the same offset are two different
  // shapes. Letting the representative decide would make the category depend on
  // instruction order, so only all-indexed or all-direct is allowed to classify.
  const ir = {
    values: [],
    instructions: [
      {
        op: 'load',
        dst: { id: 1, bits: 32 },
        loc: { kind: 'field', base: { id: 2, reg: 'x0' }, disp: 0x10n, size: 4 },
        addr: null,
      },
      {
        op: 'load',
        dst: { id: 4, bits: 32 },
        loc: { kind: 'unknown', base: null, disp: undefined, index: null },
        addr: { disp: 0x10n, base: { id: 2, reg: 'x0' }, index: { id: 3, reg: 'x1' }, scale: 2 },
      },
    ],
  };
  const report = recoverMemberTypeEvidence({ ir, isReceiverBase: allBases });
  const field = fieldAt(report, 0x10);
  assert.ok(field, 'both accesses are on the receiver base');
  assert.equal(field.category, null);
  assert.equal(field.reason, 'mixed-indexed-and-direct-access');
});

test('mixed access widths on one offset refuse to claim a category', () => {
  const ir = createIr(['ldr w1, [x0, #0x38]', 'ldr x2, [x0, #0x38]', 'ret']);
  const report = recoverMemberTypeEvidence({ ir, isReceiverBase: allBases });
  const field = fieldAt(report, 0x38);
  assert.equal(field.mixedWidths, true);
  assert.equal(field.category, null);
  assert.equal(field.reason, 'mixed-access-widths');
});

test('only accesses through the receiver are reported', () => {
  const ir = createIr(['ldr w1, [x0, #0x38]', 'ldr w2, [x1, #0x40]', 'ret']);
  const onlyArg0 = (value) => value?.reg === 'x0';
  const report = recoverMemberTypeEvidence({ ir, isReceiverBase: onlyArg0 });
  assert.ok(report.fields.every((field) => field.offset === 0x38n));
});

test('the resolver hands back a type label and never a field name', () => {
  const ir = createIr(['ldr s0, [x0, #0x38]', 'ldr w1, [x0, #0x40]', 'ret']);
  const report = recoverMemberTypeEvidence({ ir, isReceiverBase: allBases });
  const resolve = memberTypeResolver(report);

  const float = resolve(0x38n);
  assert.equal(float.type, 'float');
  assert.equal(float.widthOnly, false);
  assert.equal(Object.prototype.hasOwnProperty.call(float, 'name'), false);

  const word = resolve(0x40n);
  assert.equal(word.type, 'int32_t|uint32_t');
  assert.equal(word.widthOnly, true);

  assert.equal(resolve(0x999n), null);
  assert.equal(resolve(null), null);
});

test('the receiver predicate is mandatory', () => {
  assert.throws(() => recoverMemberTypeEvidence({ ir: createIr(['ret']) }), /receiver-predicate-required/);
});

test('the same IR produces the same member type digest', () => {
  const lines = ['ldr s0, [x0, #0x38]', 'ldr x8, [x0, #0x10]', 'ldr w0, [x8, #0x8]', 'ret'];
  const first = recoverMemberTypeEvidence({ ir: createIr(lines), isReceiverBase: allBases });
  const second = recoverMemberTypeEvidence({ ir: createIr(lines), isReceiverBase: allBases });
  assert.equal(first.digest, second.digest);
});
