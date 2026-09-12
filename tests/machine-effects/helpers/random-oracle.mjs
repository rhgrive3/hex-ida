import assert from 'node:assert/strict';

const GPRS = ['rax','rcx','rdx','rbx','rsp','rbp','rsi','rdi','r8','r9','r10','r11','r12','r13','r14','r15'];
const LOW16 = ['ax','cx','dx','bx','sp','bp','si','di'];
const LOW32 = ['eax','ecx','edx','ebx','esp','ebp','esi','edi'];
export const RANDOM_CASES = [];
for (const family of ['rdrand','rdseed']) for (const size66 of [false,true]) {
  for (const rex of [null,...Array.from({ length:16 }, (_, i) => 0x40+i)]) for (let rm=0; rm<8; rm++) {
    const index = rm + (rex != null && (rex & 1) ? 8 : 0);
    const bits = rex != null && (rex & 8) ? 64 : size66 ? 16 : 32;
    const register = bits === 64 ? GPRS[index] : index >= 8 ? `r${index}${bits === 16 ? 'w' : 'd'}`
      : (bits === 16 ? LOW16 : LOW32)[index];
    RANDOM_CASES.push({ family, bits, register, physical:GPRS[index],
      bytes:[...(size66 ? [0x66] : []),...(rex == null ? [] : [rex]),0x0f,0xc7,(family === 'rdrand' ? 0xf0 : 0xf8)+rm] });
  }
}
const mask = bits => (1n << BigInt(bits)) - 1n;
const FLAGS = { 'RFLAGS.CF':0n,'RFLAGS.PF':2n,'RFLAGS.AF':4n,'RFLAGS.ZF':6n,'RFLAGS.SF':7n,'RFLAGS.OF':11n };

// A small instruction-agnostic primitive interpreter. Nondeterministic
// intrinsic outputs are supplied independently by the test/native observer;
// this verifies their architectural projection, not randomness quality.
export function evaluateRandomTransfer(bundle, physical, initial, flags, sample, ready) {
  const temps = new Map();
  const read = value => {
    if (value.kind === 'bitvector') return BigInt(value.value);
    assert.equal(value.kind,'temporary');
    assert.ok(temps.has(value.temporaryId));
    return temps.get(value.temporaryId);
  };
  let register = initial;
  for (const op of bundle.operations) {
    if (op.kind === 'intrinsic') {
      assert.equal(op.effectSummary.outputs.length,2);
      assert.equal(op.effectSummary.inputs.length,0);
      temps.set(op.effectSummary.outputs[0].temporaryId,sample);
      temps.set(op.effectSummary.outputs[1].temporaryId,ready);
    } else if (op.kind === 'register-read' || op.kind === 'register-write') {
      assert.equal(op.register.registerId,physical,'only the encoded destination may be touched');
      if (op.kind === 'register-read') temps.set(op.value.temporaryId,register);
      else register = read(op.value) & mask(64);
    } else if (op.kind === 'flag-write') {
      assert.ok(Object.hasOwn(FLAGS,op.flag.flagId));
      const shift=FLAGS[op.flag.flagId];
      flags=(flags & ~(1n<<shift)) | ((read(op.value)&1n)<<shift);
    } else {
      assert.equal(op.kind,'value');
      const args=op.inputs.map(read), bits=op.outputs[0].valueType.widthBits;
      let value;
      if (op.opcode === 'select') value=args[0] ? args[1] : args[2];
      else if (op.opcode === 'zext' || op.opcode === 'trunc') value=args[0];
      else if (op.opcode === 'insert') {
        const field=mask(op.metadata.widthBits), shift=BigInt(op.metadata.lsb);
        value=(args[0]&~(field<<shift)) | ((args[1]&field)<<shift);
      } else assert.fail(`unsupported random-transfer primitive: ${op.opcode}`);
      temps.set(op.outputs[0].temporaryId,value&mask(bits));
    }
  }
  return { register, flags };
}

export function verifyRandomStructure(bundle, row) {
  assert.equal(bundle.completeness,'exact-with-intrinsic');
  assert.equal(bundle.metadata.terminalizedBy,undefined,'dedicated semantics, not trusted catch-all');
  assert.equal(bundle.controlEffect.kind,'fallthrough');
  assert.equal(bundle.unknownEffects,undefined);
  assert.equal(bundle.possibleFaults.length,1);
  const fault=bundle.possibleFaults[0];
  assert.equal(fault.kind,'undefined-opcode');
  assert.equal(fault.condition.feature,row.family==='rdrand' ? 'CPUID.01H:ECX[30]' : 'CPUID.07H.0:EBX[18]');
  assert.equal(fault.condition.faultWhen,'feature-bit-clear');
  assert.equal(fault.condition.requiredValue,1);
  assert.equal(bundle.metadata.normalCompletionOnly,true);
  assert.equal(bundle.metadata.noHostFeatureAssumption,true);
  assert.equal(bundle.metadata.privileged,false);
  const intrinsic=bundle.operations.filter(op=>op.kind==='intrinsic');
  assert.equal(intrinsic.length,1);
  assert.equal(intrinsic[0].intrinsicId,`x86.system.${row.family}`);
  const summary=intrinsic[0].effectSummary;
  assert.equal(summary.determinism,'nondeterministic');
  assert.deepEqual(summary.outputs.map(value=>value.valueType.widthBits),[row.bits,1]);
  assert.deepEqual(summary.memoryRead,{scope:'none'});
  assert.deepEqual(summary.memoryWrite,{scope:'none'});
  assert.ok(summary.registersRead.includes('sys:x86.random-generator-state'));
  assert.ok(summary.registersWritten.includes('sys:x86.random-generator-state'));
  assert.deepEqual(bundle.operations.filter(op=>op.kind==='flag-write').map(op=>op.flag.flagId).sort(),Object.keys(FLAGS).sort());
  assert.equal(bundle.operations.filter(op=>op.kind==='register-write').length,1);
  assert.ok(!bundle.operations.some(op=>op.kind==='flag-read' || op.kind.startsWith('memory-')));
}

export function verifyRandomValues(bundle, row) {
  verifyRandomStructure(bundle,row);
  let cases=0;
  for (const initial of [0x0123456789abcdefn,0xfedcba9876543210n]) for (const ready of [0n,1n]) {
    for (const sample of [0n,1n,0x8001n,0x81234567n,0x89abcdef01234567n,mask(row.bits)]) {
      for (const before of [0x202n,0xed7n,0x246n,0xe93n]) {
        const value=(row.family==='rdseed' && !ready ? 0n : sample)&mask(row.bits);
        const register=row.bits===16 ? (initial&~0xffffn)|value : value;
        const flags=(before&~0x8d5n)|ready;
        assert.deepEqual(evaluateRandomTransfer(bundle,row.physical,initial,before,sample&mask(row.bits),ready),
          {register,flags},`${row.family}:${row.register}:${ready}:${sample}:${before}`);
        cases++;
      }
    }
  }
  return cases;
}
