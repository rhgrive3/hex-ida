from pathlib import Path
import re

path = Path('js/adapters/index.js')
text = path.read_text()
replacements = [
    (
        "function isRegisterName(reg) { return /^(x([0-9]|[12][0-9]|30)|w([0-9]|[12][0-9]|30)|sp|pc)$/.test(reg); }",
        "function isRegisterName(reg) { return /^(x([0-9]|[12][0-9]|30)|w([0-9]|[12][0-9]|30)|sp|pc)$/.test(reg); }\n"
        "function breakpointRemovalId(id) {\n"
        "  const value = id && typeof id === 'object' && !Array.isArray(id) ? id.id : id;\n"
        "  if (typeof value !== 'string' || !value) throw new DebugAdapterError('invalid-breakpoint', 'breakpoint id must be a non-empty string');\n"
        "  return value;\n"
        "}\n"
        "function registerSelector(reg) {\n"
        "  if (typeof reg !== 'string' || !isRegisterName(reg)) throw new DebugAdapterError('invalid-register', 'unsupported register selector');\n"
        "  return reg;\n"
        "}\n"
        "function memoryReadSize(size, fallback) {\n"
        "  const value = size == null ? fallback : size;\n"
        "  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) throw new DebugAdapterError('invalid-size','memory read size must be a positive safe integer');\n"
        "  return value;\n"
        "}"
    ),
    (
        "const key = typeof id === 'object' ? id.id : String(id); const bp = this.breakpoints.get(key); if (!bp) return false;",
        "const key = breakpointRemovalId(id); const bp = this.breakpoints.get(key); if (!bp) return false;"
    ),
    (
        "const name = String(reg);\n    if (!isRegisterName(name)) throw new DebugAdapterError('invalid-register', `unsupported register: ${name}`);",
        "const name = registerSelector(reg);"
    ),
    (
        "const sandbox = this.ensureSandbox(); const epoch = this.epoch; const memoryMap = this.memoryMap; const n = Number(size == null ? 8 : size);\n    if (!Number.isSafeInteger(n) || n < 1) throw new DebugAdapterError('invalid-size','memory read size must be a positive safe integer');",
        "const sandbox = this.ensureSandbox(); const epoch = this.epoch; const memoryMap = this.memoryMap; const n = memoryReadSize(size, 8);"
    ),
    (
        "removeBreakpoint(id){const key=typeof id==='object'?id.id:id;return this.call('removeBreakpoint',{id:String(key)})}",
        "removeBreakpoint(id){return this.call('removeBreakpoint',{id:breakpointRemovalId(id)})}"
    ),
    (
        "writeRegister(reg,value,threadId){return this.call('writeRegister',{reg:String(reg),value:String(value),threadId})}",
        "writeRegister(reg,value,threadId){return this.call('writeRegister',{reg:registerSelector(reg),value:String(value),threadId})}"
    ),
]
for old, new in replacements:
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'expected exactly one match, found {count}: {old[:100]}')
    text = text.replace(old, new)

remote_read_pattern = re.compile(
    r"async readMemory\(address,size\)\{const n=Number\(size==null\?1:size\);\s*"
    r"if\(!Number\.isSafeInteger\(n\)\|\|n<1\) throw new DebugAdapterError\('invalid-size','memory read size must be a positive safe integer'\);\s*"
    r"if\(n>256\*1024\) throw new DebugAdapterError\('too-large','remote memory read exceeds 256 KiB'\);\s*"
    r"return remoteBytes\(await this\.call\('readMemory',\{address:String\(asAddress\(address\)\),size:n\}\),n\)\}"
)
text, count = remote_read_pattern.subn(
    "async readMemory(address,size){const n=memoryReadSize(size,1); if(n>256*1024) throw new DebugAdapterError('too-large','remote memory read exceeds 256 KiB'); return remoteBytes(await this.call('readMemory',{address:String(asAddress(address)),size:n}),n)}",
    text,
)
if count != 1:
    raise SystemExit(f'expected exactly one remote readMemory match, found {count}')
path.write_text(text)

Path('tests/phase10/adapter-strict-boundaries.test.mjs').write_text("""import assert from 'node:assert/strict';
import { LocalFunctionSandboxAdapter, RemoteDebugAdapter } from '../../js/adapters/index.js';

function expectCode(error, code) {
  assert.equal(error?.code, code, `expected ${code}, got ${error?.code}: ${error?.message}`);
  return true;
}

const local = new LocalFunctionSandboxAdapter({});
local.sandbox = { emulator: { dump: async (_address, size) => new Uint8Array(size) } };
local.memoryMap = { assert() {} };
for (const bad of ['8', ['8'], true, { valueOf: () => 8 }]) {
  await assert.rejects(local.readMemory(0n, bad), (error) => expectCode(error, 'invalid-size'));
}
assert.equal((await local.readMemory(0n, 8)).length, 8);
assert.equal((await local.readMemory(0n, null)).length, 8);

local.breakpoints.set('1', { id:'1', kind:'address', address:0n, enabled:false });
await assert.rejects(local.removeBreakpoint(1), (error) => expectCode(error, 'invalid-breakpoint'));
assert.equal(local.breakpoints.has('1'), true);
local.breakpoints.set('bp:a', { id:'bp:a', kind:'address', address:4n, enabled:false });
await assert.rejects(local.removeBreakpoint({ id:['bp:a'] }), (error) => expectCode(error, 'invalid-breakpoint'));
assert.equal(local.breakpoints.has('bp:a'), true);

local.sandbox.setRegister = () => { throw new Error('must not mutate'); };
local.sandbox.getRegister = () => 0n;
await assert.rejects(local.writeRegister(['x0'], 1n), (error) => expectCode(error, 'invalid-register'));

const sent = [];
const remote = new RemoteDebugAdapter({ send: async (packet) => { sent.push(packet); } }, {
  capabilities: { removeBreakpoint:true, writeRegister:true, readMemory:true },
  protocol: { timeoutMs:10000 },
});
for (const bad of ['16', [16], true, { valueOf: () => 16 }]) {
  await assert.rejects(remote.readMemory(0n, bad), (error) => expectCode(error, 'invalid-size'));
}
assert.throws(() => remote.removeBreakpoint({ id:['bp:a'] }), (error) => expectCode(error, 'invalid-breakpoint'));
assert.throws(() => remote.removeBreakpoint(1), (error) => expectCode(error, 'invalid-breakpoint'));
assert.throws(() => remote.writeRegister(['x0'], 1n), (error) => expectCode(error, 'invalid-register'));
assert.equal(sent.length, 0, 'malformed selectors/sizes must not reach remote transport');
remote.protocol.close();
console.log('adapter strict boundaries: ok');
""")

for transient in [
    Path('.github/workflows/one-shot-adapter-3066-3067.yml'),
    Path('.github/workflows/one-shot-adapter-3066-3067-pr.yml'),
    Path('.github/workflows/one-shot-adapter-3066-3067-simple.yml'),
    Path('.github/scripts/apply-adapter-3066-3067.py'),
]:
    if transient.exists():
        transient.unlink()
