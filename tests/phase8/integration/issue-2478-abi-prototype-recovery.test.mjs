import assert from 'node:assert/strict';
import { recoverFunctionPrototype } from '../../../js/decompiler/types/prototype.js';
import { semanticAbiAdapter } from '../../../js/analysis/semantic-function.js';
import { resolveABIPlugin, AAPCS64_ABI, MICROSOFT_X64_ABI, UNKNOWN_ABI } from '../../../js/targets/abi/index.js';

function value(id, reg, kind = null) {
  return { id, reg, uses:[{}], ...(kind ? { kind } : {}) };
}
function stackLoad(id, baseReg, frameEpoch, disp, bits = 64) {
  return { op:'load', loc:{kind:'stack',baseReg,frameEpoch,disp:BigInt(disp),key:`stack:${baseReg}:${frameEpoch}:${disp}`}, memUse:{kind:'entry'}, dst:{id,bits} };
}
function recover(adapter, args, instructions, values = new Map(), ret = null, opts = {}) {
  return recoverFunctionPrototype({ args:new Map(args), instructions }, { values, ret }, { ...opts, abiAdapter:adapter });
}

const sysv = semanticAbiAdapter(resolveABIPlugin({ architecture:'x86_64', platform:'linux', abiId:'sysv-amd64' }));
const riscv = semanticAbiAdapter(resolveABIPlugin({ architecture:'riscv64', platform:'linux', abiId:'lp64' }));
const aapcs = semanticAbiAdapter(AAPCS64_ABI);
const microsoft = semanticAbiAdapter(MICROSOFT_X64_ABI);

// 1. SysV MEMORY-class input may live on stack while a later integer input still uses RDI.
{
  const rsp=value(1,'rsp'), rdi=value(2,'rdi');
  const p=recover(sysv,[['rsp',rsp],['rdi',rdi]],[stackLoad(3,'rsp',1,16)],new Map([[2,{kind:'pointer',name:'void *'}],[3,{name:'long double',bits:80}]]));
  assert.equal(p.convention,'sysv-amd64');
  assert.ok(p.arguments.some((a)=>a.reg==='rdi'));
  assert.ok(p.argumentBanks.stack.some((a)=>a.stackOffset===16n));
}

// 2. A >16-byte SysV MEMORY aggregate stack evidence does not suppress a later EDI/RDI-family register input.
{
  const rsp=value(10,'rsp'), rdi=value(11,'rdi');
  const p=recover(sysv,[['rsp',rsp],['rdi',rdi]],[stackLoad(12,'rsp',10,8,64),stackLoad(13,'rsp',10,16,64)]);
  assert.ok(p.arguments.some((a)=>a.reg==='rdi'));
  assert.deepEqual(p.argumentBanks.stack.map((a)=>a.stackOffset),[8n,16n]);
}

// 3. Ordinary SysV register inputs remain ABI-driven.
{
  const p=recover(sysv,[['rdi',value(20,'rdi')],['rsi',value(21,'rsi')]],[]);
  assert.deepEqual(p.argumentBanks.integer.map((a)=>a.reg),['rdi','rsi']);
}

// 4. AAPCS64 x0/x1 and entry-SP stack arguments coexist and FP return comes from the ABI plugin.
{
  const sp=value(30,'sp');
  const p=recover(aapcs,[['sp',sp],['x0',value(31,'x0')],['x1',value(32,'x1')]],[stackLoad(33,'sp',30,0)],new Map(),{kind:'double',name:'double',bits:64});
  assert.deepEqual(p.argumentBanks.integer.map((a)=>a.reg),['x0','x1']);
  assert.equal(p.argumentBanks.stack[0].stackOffset,0n);
  assert.equal(p.returnLocations[0].reg,'v0');
}

// 5. RISC-V accepts the canonical x2 stack pointer and ABI alias sp while recovering a0/x10.
{
  const sp=value(40,'x2');
  const p=recover(riscv,[['x2',sp],['x10',value(41,'x10')]],[stackLoad(42,'sp',40,0)]);
  assert.ok(p.argumentBanks.integer.some((a)=>a.reg==='x10'));
  assert.equal(p.argumentBanks.stack[0].stackBaseRegister,'x2');
  assert.equal(p.argumentBanks.stack[0].stackOffset,0n);
}

// 6. Microsoft x64 shadow space is not fabricated as stack parameters; first stack argument begins at RSP+40.
{
  const rsp=value(50,'rsp');
  const p=recover(microsoft,[['rsp',rsp],['rcx',value(51,'rcx')]],[stackLoad(52,'rsp',50,32),stackLoad(53,'rsp',50,40)]);
  assert.ok(p.argumentBanks.integer.some((a)=>a.reg==='rcx'));
  assert.deepEqual(p.argumentBanks.stack.map((a)=>a.stackOffset),[40n]);
}

// 7. Unknown ABI is explicit and fail-closed.
{
  const unknown=semanticAbiAdapter(UNKNOWN_ABI);
  const p=recover(unknown,[['x0',value(60,'x0')]],[]);
  assert.equal(p.convention,'unknown');
  assert.equal(p.conventionKnown,false);
  assert.deepEqual(p.arguments,[]);
  assert.deepEqual(p.returnLocations,[]);
}

// 8. Return and hidden-result locations are ABI-owned rather than x0/x8 literals in the decompiler.
{
  const x8=value(70,'x8');
  const types=new Map([[70,{kind:'pointer',name:'Pair *'}]]);
  const p=recover(aapcs,[['x8',x8]],[],types,null,{indirectResult:true});
  assert.equal(p.indirectResultRegister,'x8');
  assert.deepEqual(p.returnLocations,[{kind:'indirect',reg:'x8',role:'result-address'}]);
}
