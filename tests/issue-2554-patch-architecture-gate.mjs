import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createCapabilityCatalog } from '../js/ai/capabilities/catalog.js';
import { createCapabilityExecutor } from '../js/ai/capabilities/executor.js';

const source = fs.readFileSync(new URL('../js/tools-base.js', import.meta.url), 'utf8');
const capability = source.slice(source.indexOf('function instructionPatchCapability'), source.indexOf('export function showPatches'));
assert.match(capability, /instructionPatchArchitectureSupported\(architecture\)/);
assert.match(capability, /supported \? null :/);
assert.match(capability, /const hasOwnerResolver/);
assert.match(capability, /return hasOwnerResolver \? null : app\?\.codeRegion/,
  'an address-owner miss must not fall back to the primary region when the host can resolve owners');
const editor = source.slice(source.indexOf('export async function showPatchEditor'), source.indexOf('async function savePatched'));
assert.ok(editor.indexOf('if (!capability.supported)') < editor.indexOf('assemble(text, addr)'),
  'unsupported architectures must return before the ARM64 assembler is reachable');
assert.match(editor, /const region = patchRegionForAddress\(app, addr\)/);
assert.doesNotMatch(editor, /regionForAddress\(addr\).*\|\| app\.codeRegion/);
const instructionAt = source.slice(source.indexOf('async function instructionAt'), source.indexOf('export async function showPatchEditor'));
assert.match(instructionAt, /if \(!instructionPatchCapability\(app\)\.supported\) return null/);
assert.match(instructionAt, /const region = patchRegionForAddress\(app, addr\)/);

const appFor = (architecture) => ({
  store:{ get(key) { if (key === 'architecture') return architecture; if (key === 'regions') return [{ vmAddr:0x1000n, size:0x100n, fileOffset:0n }]; return null; } },
  file:{ size:0x100 },
  backend:{ async readAt(address, length) { return { found:true, bytes:new Uint8Array(length).fill(0x90) }; } },
});
const catalog = createCapabilityCatalog();
for (const architecture of ['x86_64','riscv64']) {
  const app = appFor(architecture);
  const listed = catalog.list({ app }).find((entry) => entry.id === 'patch.preview');
  assert.equal(listed.available.ok, true, `${architecture} generic raw byte patch capability must remain available`);
  const executor = createCapabilityExecutor({ catalog, app });
  await assert.rejects(
    executor.execute('patch.preview', { address:'4096', before:[0x90,0x90,0x90,0x90], after:[0x90,0x90,0x90,0x90] }),
    /unsupported for architecture/,
    `${architecture} instruction patching must fail closed before producer access`,
  );
  const raw = await executor.execute('patch.preview', { address:'4097', before:[0x90,0x90,0x90], after:[0xcc,0xcc,0xcc], instruction:false });
  assert.equal(raw.ok, true, `${architecture} explicit raw byte patching must remain available`);
  assert.equal(raw.fileOffset, 1n);
}
for (const architecture of ['arm64','arm64e']) {
  const listed = catalog.list({ app:appFor(architecture) }).find((entry) => entry.id === 'patch.preview');
  assert.equal(listed.available.ok, true, `${architecture} patch capability must remain available`);
}
console.log('issue #2554 patch architecture/region gate: PASS');
