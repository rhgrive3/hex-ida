import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import * as E from '../../../js/symbolic/expr/index.js';

export function publishMatrixReport(report,file) {
  if (!file) return;
  const destination = path.resolve(file);
  const parent = fs.realpathSync(path.dirname(destination));
  assert.ok(!['/tmp','/var/tmp','/dev/shm'].some(root => parent === root || parent.startsWith(`${root}/`)));
  const pending = `${destination}.pending`;
  assert.ok(!fs.existsSync(destination));
  const fd = fs.openSync(pending,'wx',0o600);
  try { fs.writeFileSync(fd,JSON.stringify(report,null,2)+'\n'); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  fs.renameSync(pending,destination);
}

export function boolFixtures() {
  const p = E.createFreshSymbol(E.boolSort(),'matrix_bool_p'), q = E.createFreshSymbol(E.boolSort(),'matrix_bool_q');
  const c = E.createConnective, yes = E.createBool(true), no = E.createBool(false);
  const cases = [
    ['double-not',c('not',c('not',p)),a => a],
    ['and-self',c('and',p,p),a => a], ['or-self',c('or',p,p),a => a],
    ['xor-self',c('xor',p,p),() => false], ['ne-self',c('ne',p,p),() => false],
    ['eq-self',c('eq',p,p),() => true], ['implies-self',c('implies',p,p),() => true],
    ['and-complement',c('and',p,c('not',p)),() => false],
    ['or-complement',c('or',p,c('not',p)),() => true],
    ['and-true',c('and',p,yes),a => a], ['or-false',c('or',no,p),a => a],
    ['and-false',c('and',no,p),() => false], ['or-true',c('or',p,yes),() => true],
    ['select-same',E.createIte(q,p,p),a => a],
  ];
  return {p,q,cases};
}

// These are measured, explicitly incomplete proof cells, not waived semantic
// successes. Keep all other cells as mandatory positive capability floors. If a
// backend later proves one of these, its genuine receipt still faces the oracle.
export function boundedProofCell(family,width) {
  return width >= (['xor-cancel','add-sub-cancel','mba-add'].includes(family) ? 8 : 16)
    && ['double-neg','xor-cancel','add-sub-cancel','absorb-and','absorb-or','mba-add','factor-mul'].includes(family);
}

export function assertWithheld(r,id) {
  assert.equal(r.status,'partial',id);
  assert.match(r.reason,/^(cancelled|timeout|deadline-exceeded|budget:.*)$/,`${id}:${r.reason}`);
  assert.deepEqual(r.candidates,[],id);
}

export function values(width) {
  if (width <= 4) return Array.from({length:2 ** width},(_,i) => BigInt(i));
  const sign = 1n << BigInt(width - 1), mask = (sign << 1n) - 1n;
  return [...new Set([0n,1n,2n,sign - 1n,sign,sign + 1n,mask - 1n,mask,0x5555555555555555n & mask,0xaaaaaaaaaaaaaaaan & mask])];
}

export function checkConcrete(f,after) {
  let comparisons = 0;
  for (const a of values(f.width)) for (const d of values(f.width)) {
    const env = new Map([[f.x.symbolId,a],[f.y.symbolId,d]]), expected = f.expected(a,d);
    for (const term of [f.before,after]) {
      const actual = E.evaluateExpr(term,env);
      assert.equal(actual.status,E.EVAL_STATUS.VALUE,f.id);
      assert.equal(actual.value,expected,`${f.id}/${a}/${d}`);
    }
    comparisons++;
  }
  return comparisons;
}

// Shared frozen C4-05 denominator. Direct formulas are independent of rules.
export const WIDTHS = Object.freeze([1,2,3,4,8,16,32,64]);
const b = E.createBinary, n = E.createUnary;
export const FAMILY_IDS = Object.freeze([
  'xor-self','sub-self','and-self','or-self','add-zero','sub-zero','mul-one',
  'and-zero','mul-zero','and-mask','shl-zero','lshr-zero','ashr-zero',
  'double-add','double-not','double-neg','xor-cancel','add-sub-cancel',
  'absorb-and','absorb-or','mba-add','mul-power-two','factor-mul',
  'fold-wrap','fold-shift-last','fold-shift-width','fold-ashr-width',
  'trunc-zext','trunc-sext','select-same','select-constant',
  'compare-constant','concat-constant','extract-constant',
]);

export function fixture(family,width) {
  const x = E.createFreshSymbol(E.bvSort(width),`${family}_${width}_x`);
  const y = E.createFreshSymbol(E.bvSort(width),`${family}_${width}_y`);
  const c = value => E.createBv(width,BigInt(value));
  const mask = (1n << BigInt(width)) - 1n;
  const mba = () => b('add',b('xor',x,y),b('shl',b('and',x,y),c(1)));
  const cases = {
    'xor-self': [() => b('xor',x,x),() => 0n],
    'sub-self': [() => b('sub',x,x),() => 0n],
    'and-self': [() => b('and',x,x),a => a],
    'or-self': [() => b('or',x,x),a => a],
    'add-zero': [() => b('add',x,c(0)),a => a],
    'sub-zero': [() => b('sub',x,c(0)),a => a],
    'mul-one': [() => b('mul',x,c(1)),a => a],
    'and-zero': [() => b('and',x,c(0)),() => 0n],
    'mul-zero': [() => b('mul',x,c(0)),() => 0n],
    'and-mask': [() => b('and',x,c(mask)),a => a],
    'shl-zero': [() => b('shl',x,c(0)),a => a],
    'lshr-zero': [() => b('lshr',x,c(0)),a => a],
    'ashr-zero': [() => b('ashr',x,c(0)),a => a],
    'double-add': [() => b('add',x,x),a => (a + a) & mask],
    'double-not': [() => n('not',n('not',x)),a => a],
    'double-neg': [() => n('neg',n('neg',x)),a => a],
    'xor-cancel': [() => b('xor',b('xor',x,y),y),a => a],
    'add-sub-cancel': [() => b('sub',b('add',x,y),y),a => a],
    'absorb-and': [() => b('and',x,b('or',x,y)),a => a],
    'absorb-or': [() => b('or',x,b('and',x,y)),a => a],
    'mba-add': [mba,(a,d) => (a + d) & mask],
    'mul-power-two': [() => b('mul',x,c(2)),a => (a * 2n) & mask],
    'factor-mul': [() => b('add',b('mul',x,c(3)),b('mul',x,c(5))),a => (a * 8n) & mask],
    'fold-wrap': [() => b('add',c(mask),c(1)),() => 0n],
    'fold-shift-last': [() => b('shl',c(1),c(width - 1)),() => 1n << BigInt(width - 1)],
    'fold-shift-width': [() => b('shl',c(1),c(width)),() => 0n],
    'fold-ashr-width': [() => b('ashr',c(mask),c(width)),() => mask],
    'trunc-zext': [() => E.createCast('trunc',E.createCast('zext',x,width + 1),width),a => a],
    'trunc-sext': [() => E.createCast('trunc',E.createCast('sext',x,width + 1),width),a => a],
    'select-same': [() => E.createIte(E.createCompare('ult',x,y),x,x),a => a],
    'select-constant': [() => E.createIte(E.createBool(false),y,x),a => a],
    'compare-constant': [() => E.createCompare('slt',c(mask),c(0)),() => true],
    'concat-constant': [() => E.createConcat(c(mask),E.createBv(1,1n)),() => (mask << 1n) | 1n],
    'extract-constant': [() => E.createExtract(c(mask),width - 1,width - 1),() => 1n],
  };
  assert.deepEqual(Object.keys(cases),FAMILY_IDS,'new families must enter the frozen denominator');
  const [build,expected] = cases[family];
  return {before:build(),expected,x,y,width,family,id:`${family}/bv${width}`};
}
