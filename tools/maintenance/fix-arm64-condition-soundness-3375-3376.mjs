import fs from 'node:fs/promises';

function replaceOnce(text, before, after, label) {
  const first = text.indexOf(before);
  if (first < 0) {
    if (text.includes(after)) return text;
    throw new Error(`${label}: expected source snippet not found`);
  }
  if (text.indexOf(before, first + before.length) >= 0) {
    throw new Error(`${label}: source snippet is not unique`);
  }
  return text.slice(0, first) + after + text.slice(first + before.length);
}

async function patchFile(path, transform) {
  const before = await fs.readFile(path, 'utf8');
  const after = transform(before);
  if (after !== before) await fs.writeFile(path, after);
}

await patchFile('js/expr.js', (text) => replaceOnce(
  text,
  "    case 'al': return true; case 'nv': return false; default: return null;",
  "    case 'al': case 'nv': return true; default: return null;",
  '#3375 NV condition semantics',
));

const oldConditionFromFlags = `function conditionFromFlags(inst, state, ir, opts, memo, active) {
  // Semantic-v2 compatibility carries the comparison result explicitly as a
  // value whose defining instruction is CMP. Prefer that architecture-neutral
  // proof. The legacy nzcv register identity remains a fallback for the old IR.
  const carrierArg = (inst.args || []).find((a) => a?.value?.def?.op === OP.CMP)
    ?? (inst.args || []).find((a) => a?.value?.reg === 'nzcv');
  const carrier = carrierArg?.value ?? null;
  return conditionFromCmp(carrier?.def, inst.cond, state, ir, opts, memo, active);
}`;

const newConditionFromFlags = `function conditionFromFlags(inst, state, ir, opts, memo, active) {
  // Conditional-select/branch compatibility IR has a positional condition
  // carrier. Never scan data operands for an arbitrary CMP definition: a
  // compare result is also a valid data value and would silently select the
  // wrong predicate. Legacy IR may still identify the carrier as \`nzcv\`.
  const args = Array.isArray(inst.args) ? inst.args : [];
  const positional = inst.op === OP.SEL
    ? args[2]
    : inst.op === OP.CBR
      ? args.at(-1)
      : null;
  const carrierArg = (positional?.value?.def?.op === OP.CMP || positional?.value?.reg === 'nzcv')
    ? positional
    : args.find((a) => a?.value?.reg === 'nzcv') ?? null;
  const carrier = carrierArg?.value ?? null;
  return conditionFromCmp(carrier?.def, inst.cond, state, ir, opts, memo, active);
}`;

await patchFile('js/symbolic/executor.js', (text) => replaceOnce(
  text,
  oldConditionFromFlags,
  newConditionFromFlags,
  '#3376 symbolic condition carrier',
));

const exprImport = "import { buildValues, constOf } from '../js/expr.js';\n";
const integrationAnchor = "import { findValueUpdates } from '../js/dataflow.js';\n";
const symbolicTestAnchor = "await test('symbolic executor proves simple branch relations and field updates', () => {";

const regressions = `await test('#3375 NV condition is always true across legacy expression recovery', () => {
  reset();
  const csel = modelOf([
    I('mov','x1, #1'),
    I('mov','x2, #2'),
    I('cmp','x1, x1'),
    I('csel','x0, x1, x2, nv'),
  ]);
  assert.equal(constOf(buildValues(csel).defAt(3, 'x0')), 1n, 'CSEL nv must choose the then arm');

  reset();
  const cset = modelOf([
    I('mov','x1, #1'),
    I('cmp','x1, x1'),
    I('cset','x0, nv'),
  ]);
  assert.equal(constOf(buildValues(cset).defAt(2, 'x0')), 1n, 'CSET nv must produce one');
});

await test('#3376 symbolic SEL uses the positional NZCV carrier, not a CMP-defined data arm', () => {
  let id = 1;
  const value = (reg, bits = 64, extra = {}) => ({ id:id++, reg, bits, def:null, uses:[], ...extra });
  const arg0 = value('x0', 64, { kind:'arg' });
  const arg1 = value('x1', 64, { kind:'arg' });
  const arg2 = value('x2', 64, { kind:'arg' });
  const arg3 = value('x3', 64, { kind:'arg' });

  const dataCmpValue = value('cmp-data', 1);
  const dataCmp = {
    id:id++, op:OP.CMP, sub:'sub', row:0, address:0x1000n,
    args:[{ value:arg0, bits:64 }, { value:arg1, bits:64 }], dst:dataCmpValue,
  };
  dataCmpValue.def = dataCmp;

  const carrierValue = value('nzcv', 4);
  const carrierCmp = {
    id:id++, op:OP.CMP, sub:'sub', row:1, address:0x1004n,
    args:[{ value:arg2, bits:64 }, { value:arg3, bits:64 }], dst:carrierValue,
  };
  carrierValue.def = carrierCmp;

  const one = value(null, 64, { const:1n });
  const selected = value('x4', 64);
  const sel = {
    id:id++, op:OP.SEL, sub:'sel', cond:'eq', row:2, address:0x1008n,
    args:[{ value:dataCmpValue, bits:1 }, { value:one, bits:64 }, { value:carrierValue, bits:4 }], dst:selected,
  };
  selected.def = sel;
  const ret = { id:id++, op:OP.RET, row:3, address:0x100cn, args:[{ value:selected, bits:64 }] };
  const ir = {
    entry:0,
    blocks:[{ index:0, phis:[], insts:[dataCmp, carrierCmp, sel, ret], succ:[] }],
    instructions:[dataCmp, carrierCmp, sel, ret],
  };

  const result = symbolicExecute(ir, { timeoutMs:1000 });
  assert.equal(result.paths.length, 1);
  assert.match(result.paths[0].returnText, /arg2 == arg3/, 'condition must come from args[2] carrier');
  assert.doesNotMatch(result.paths[0].returnText, /arg0 == arg1/, 'CMP-defined data arm must not become condition carrier');
});

`;

await patchFile('tests/integration-review.mjs', (text) => {
  let out = text;
  if (!out.includes(exprImport)) {
    out = replaceOnce(out, integrationAnchor, integrationAnchor + exprImport, '#3375 test import');
  }
  if (!out.includes("await test('#3375 NV condition is always true across legacy expression recovery'")) {
    out = replaceOnce(out, symbolicTestAnchor, regressions + symbolicTestAnchor, '#3375/#3376 regression insertion');
  }
  return out;
});

console.log('Applied #3375/#3376 guarded soundness fixes and regressions.');
