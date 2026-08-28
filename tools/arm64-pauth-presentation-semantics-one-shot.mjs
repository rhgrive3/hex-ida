import fs from 'node:fs';

const path = 'js/arm64.js';
let source = fs.readFileSync(path, 'utf8');

const oldCategory = "cat('nop hint bti svc hvc smc brk hlt dmb dsb isb yield wfe wfi sev sevl mrs msr sys eret clrex paciasp pacibsp autiasp autibsp pacia pacib autia autib xpaclri pacia1716 dc ic tlbi', 'system');";
const newCategory = "cat('nop hint bti svc hvc smc brk hlt dmb dsb isb yield wfe wfi sev sevl mrs msr sys eret clrex paciasp pacibsp pacia pacib pacda pacdb paciza pacizb pacdza pacdzb pacia1716 pacib1716 autiasp autibsp autia autib autda autdb autiza autizb autdza autdzb autia1716 autib1716 xpaci xpacd xpaclri pacga dc ic tlbi', 'system');";
if (source.split(oldCategory).length !== 2) throw new Error('unexpected PAuth system-category state');
source = source.replace(oldCategory, newCategory);

const startMarker = "for (const n of ['paciasp', 'pacibsp', 'pacia', 'pacib']) {";
const endMarker = "\n\nfor (const n of ['dmb', 'dsb', 'isb']) {";
const start = source.indexOf(startMarker);
const end = source.indexOf(endMarker, start);
if (start < 0 || end < 0) throw new Error('unable to locate PAuth presentation handler block');

const replacement = `for (const n of ['paciasp', 'pacibsp']) {
  HANDLERS[n] = (o) => {
    o.title = J('戻り先アドレスに封をする', 'Sign the return address');
    o.pseudo = 'lr = sign(lr, sp)';
    o.summary = J('戻り先アドレス (x30) を SP を使って署名し、書き換えを検出できるようにする。', 'Sign the return address in x30 using SP as the modifier.');
    o.terms = ['pac', 'security', 'lr'];
  };
}
for (const n of ['pacia', 'pacib', 'pacda', 'pacdb']) {
  HANDLERS[n] = (o, ops) => {
    const destination = opShort(ops[0]); const modifier = opShort(ops[1]);
    o.title = J('ポインタに認証コードを付ける', 'Sign a pointer');
    o.pseudo = destination + ' = sign(' + destination + ', ' + modifier + ')';
    o.summary = J(destination + ' のポインタを ' + modifier + ' を修飾値として署名し、結果を同じレジスタへ戻す。', 'Sign the pointer in ' + destination + ' using ' + modifier + ' as the modifier, writing the result back.');
    o.terms = ['pac', 'security'];
  };
}
for (const n of ['paciza', 'pacizb', 'pacdza', 'pacdzb']) {
  HANDLERS[n] = (o, ops) => {
    const destination = opShort(ops[0]);
    o.title = J('ゼロ修飾値でポインタに封をする', 'Sign a pointer with zero modifier');
    o.pseudo = destination + ' = sign(' + destination + ', 0)';
    o.summary = J(destination + ' のポインタを修飾値 0 で署名し、結果を同じレジスタへ戻す。', 'Sign the pointer in ' + destination + ' with a zero modifier and write it back.');
    o.terms = ['pac', 'security'];
  };
}
for (const n of ['pacia1716', 'pacib1716']) {
  HANDLERS[n] = (o) => {
    o.title = J('x17 のポインタに封をする', 'Sign the pointer in x17');
    o.pseudo = 'x17 = sign(x17, x16)';
    o.summary = J('x17 のポインタを x16 を修飾値として署名する。', 'Sign the pointer in x17 using x16 as the modifier.');
    o.terms = ['pac', 'security'];
  };
}
for (const n of ['autiasp', 'autibsp']) {
  HANDLERS[n] = (o) => {
    o.title = J('戻り先アドレスの封を確かめる', 'Authenticate the return address');
    o.pseudo = 'lr = authenticate(lr, sp)';
    o.summary = J('SP を修飾値として戻り先アドレス (x30) の署名を検証する。', 'Authenticate the return address in x30 using SP as the modifier.');
    o.terms = ['pac', 'security', 'lr'];
  };
}
for (const n of ['autia', 'autib', 'autda', 'autdb']) {
  HANDLERS[n] = (o, ops) => {
    const destination = opShort(ops[0]); const modifier = opShort(ops[1]);
    o.title = J('ポインタの署名を確かめる', 'Authenticate a pointer');
    o.pseudo = destination + ' = authenticate(' + destination + ', ' + modifier + ')';
    o.summary = J(destination + ' のポインタを ' + modifier + ' を修飾値として認証し、結果を同じレジスタへ戻す。', 'Authenticate the pointer in ' + destination + ' using ' + modifier + ' as the modifier, writing the result back.');
    o.terms = ['pac', 'security'];
  };
}
for (const n of ['autiza', 'autizb', 'autdza', 'autdzb']) {
  HANDLERS[n] = (o, ops) => {
    const destination = opShort(ops[0]);
    o.title = J('ゼロ修飾値でポインタを認証する', 'Authenticate a pointer with zero modifier');
    o.pseudo = destination + ' = authenticate(' + destination + ', 0)';
    o.summary = J(destination + ' のポインタを修飾値 0 で認証し、結果を同じレジスタへ戻す。', 'Authenticate the pointer in ' + destination + ' with a zero modifier and write it back.');
    o.terms = ['pac', 'security'];
  };
}
for (const n of ['autia1716', 'autib1716']) {
  HANDLERS[n] = (o) => {
    o.title = J('x17 のポインタの封を確かめる', 'Authenticate the pointer in x17');
    o.pseudo = 'x17 = authenticate(x17, x16)';
    o.summary = J('x17 のポインタを x16 を修飾値として認証する。', 'Authenticate the pointer in x17 using x16 as the modifier.');
    o.terms = ['pac', 'security'];
  };
}
for (const n of ['xpaci', 'xpacd']) {
  HANDLERS[n] = (o, ops) => {
    const destination = opShort(ops[0]);
    o.title = J('ポインタ認証コードを取り除く', 'Strip pointer authentication code');
    o.pseudo = destination + ' = strip_pac(' + destination + ')';
    o.summary = J(destination + ' からポインタ認証コードを取り除く。', 'Strip the pointer authentication code from ' + destination + '.');
    o.terms = ['pac', 'security'];
  };
}
HANDLERS.xpaclri = (o) => {
  o.title = J('戻り先アドレスの認証コードを取り除く', 'Strip the return-address authentication code');
  o.pseudo = 'lr = strip_pac(lr)';
  o.summary = J('x30 (LR) からポインタ認証コードを取り除く。', 'Strip the pointer authentication code from x30 (LR).');
  o.terms = ['pac', 'security', 'lr'];
};
HANDLERS.pacga = (o, ops) => {
  const destination = opShort(ops[0]); const source = opShort(ops[1]); const modifier = opShort(ops[2]);
  o.title = J('汎用ポインタ認証コードを作る', 'Generate a generic pointer authentication code');
  o.pseudo = destination + ' = pacga(' + source + ', ' + modifier + ')';
  o.summary = J(source + ' と ' + modifier + ' から汎用認証コードを作り、' + destination + ' に入れる。', 'Generate a generic authentication code from ' + source + ' and ' + modifier + ', storing it in ' + destination + '.');
  o.terms = ['pac', 'security'];
};`;

source = source.slice(0, start) + replacement + source.slice(end);
fs.writeFileSync(path, source);

fs.writeFileSync('tests/arm64-pauth-presentation-semantics.test.mjs', `import assert from 'node:assert/strict';
import { brief, categoryOf } from '../js/arm64.js';
import { arm64ePointerAuthenticationMnemonics } from '../js/targets/architecture/arm64e/effects.js';

const control = new Set(['braa','brab','braaz','brabz','blraa','blrab','blraaz','blrabz','retaa','retab']);
for (const mnemonic of arm64ePointerAuthenticationMnemonics()) {
  assert.equal(categoryOf(mnemonic), control.has(mnemonic) ? 'flow' : 'system', mnemonic + ': presentation category must cover canonical PAuth inventory');
}
assert.equal(brief('paciasp', '', 'pseudo'), 'lr = sign(lr, sp)');
assert.equal(brief('pacia', 'x0, x1', 'pseudo'), 'x0 = sign(x0, x1)');
assert.equal(brief('pacda', 'x2, sp', 'pseudo'), 'x2 = sign(x2, sp)');
assert.equal(brief('paciza', 'x3', 'pseudo'), 'x3 = sign(x3, 0)');
assert.equal(brief('pacia1716', '', 'pseudo'), 'x17 = sign(x17, x16)');
assert.equal(brief('autiasp', '', 'pseudo'), 'lr = authenticate(lr, sp)');
assert.equal(brief('autia', 'x4, x5', 'pseudo'), 'x4 = authenticate(x4, x5)');
assert.equal(brief('autdza', 'x6', 'pseudo'), 'x6 = authenticate(x6, 0)');
assert.equal(brief('autib1716', '', 'pseudo'), 'x17 = authenticate(x17, x16)');
assert.equal(brief('xpaci', 'x7', 'pseudo'), 'x7 = strip_pac(x7)');
assert.equal(brief('xpaclri', '', 'pseudo'), 'lr = strip_pac(lr)');
assert.equal(brief('pacga', 'x8, x9, sp', 'pseudo'), 'x8 = pacga(x9, sp)');
assert.notEqual(brief('pacia', 'x0, x1', 'pseudo'), 'lr = sign(lr)');
assert.notEqual(brief('autia', 'x0, x1', 'pseudo'), 'lr = verify(lr)');
console.log('ARM64 PAuth presentation semantics: PASS');
`);
