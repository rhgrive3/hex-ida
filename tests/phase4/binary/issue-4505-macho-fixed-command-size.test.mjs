import assert from 'node:assert/strict';

import { parseMachO } from '../../../js/binary/macho.js';

const FIXED_COMMANDS = [
  { name: 'LC_SYMTAB', cmd: 0x2, size: 24 },
  { name: 'LC_MAIN', cmd: 0x80000028, size: 24 },
  { name: 'LC_VERSION_MIN', cmd: 0x25, size: 16 },
  { name: 'LC_FUNCTION_STARTS', cmd: 0x26, size: 16 },
  { name: 'LC_DYLD_CHAINED_FIXUPS', cmd: 0x80000034, size: 16 },
  { name: 'LC_DYLD_EXPORTS_TRIE', cmd: 0x80000033, size: 16 },
  { name: 'LC_DYLD_INFO', cmd: 0x22, size: 48 },
  { name: 'LC_DYLD_INFO_ONLY', cmd: 0x80000022, size: 48 },
];

function macho64(command, cmdsize, configure = () => {}) {
  const bytes = new Uint8Array(32 + cmdsize + 0x100);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 0xfeedfacf, true);
  view.setInt32(4, 0x0100000c, true);
  view.setInt32(8, 0, true);
  view.setUint32(12, 2, true);
  view.setUint32(16, 1, true);
  view.setUint32(20, cmdsize, true);
  view.setUint32(24, 0, true);
  view.setUint32(28, 0, true);
  view.setUint32(32, command, true);
  view.setUint32(36, cmdsize, true);
  configure(view, 32, bytes);
  return bytes;
}

function configurePayload(view, offset, bytes) {
  view.setUint32(offset + 8, 0x100, true);
  view.setUint32(offset + 12, 1, true);
  bytes[0x100] = 0;
}

function reasons(image) {
  return image.metadata.machoMetadata.reasons;
}

function configureFixedCommand(command, view, offset, bytes) {
  if (command.name === 'LC_MAIN') {
    view.setBigUint64(offset + 8, 0x300n, true);
    view.setBigUint64(offset + 16, 0n, true);
  } else if (command.name === 'LC_SYMTAB') {
    view.setUint32(offset + 8, 0, true);
    view.setUint32(offset + 12, 0, true);
    view.setUint32(offset + 16, 0, true);
    view.setUint32(offset + 20, 0, true);
  } else if (command.name === 'LC_VERSION_MIN') {
    view.setUint32(offset + 8, 0x00110002, true);
    view.setUint32(offset + 12, 0x00120000, true);
  } else if (command.name.startsWith('LC_DYLD_INFO')) {
    for (let i = 8; i < 48; i += 4) view.setUint32(offset + i, 0, true);
  } else {
    configurePayload(view, offset, bytes);
  }
}

for (const command of FIXED_COMMANDS) {
  const image = parseMachO(macho64(command.cmd, command.size + 8, (view, offset, bytes) => configureFixedCommand(command, view, offset, bytes)));

  assert.equal(image.metadata.machoMetadata.complete, false, `${command.name} oversized command must be partial`);
  assert.ok(
    reasons(image).some((reason) => reason === `load-command-0x${command.cmd.toString(16)}-parse-error`),
    `${command.name} must report a parse error: ${reasons(image).join(', ')}`,
  );
  assert.equal(image.metadata.entrypointSource, undefined, `${command.name} must not publish LC_MAIN authority`);
  assert.equal(image.metadata.buildVersion, undefined, `${command.name} must not publish legacy version authority`);
  assert.equal(image.metadata.exportTrie, undefined, `${command.name} must not parse an oversized export trie`);
  assert.equal(image.metadata.chainedFixups, undefined, `${command.name} must not parse oversized chained fixups`);
}

for (const command of FIXED_COMMANDS) {
  const image = parseMachO(macho64(command.cmd, command.size, (view, offset, bytes) => configureFixedCommand(command, view, offset, bytes)));
  assert.ok(
    !reasons(image).includes(`load-command-0x${command.cmd.toString(16)}-parse-error`),
    `${command.name} exact size must not report a command-size parse error: ${reasons(image).join(', ')}`,
  );
}

const validExportsTrie = parseMachO(macho64(0x80000033, 16, (view, offset, bytes) => configurePayload(view, offset, bytes)));
assert.equal(validExportsTrie.metadata.machoMetadata.complete, true, 'exact-sized LC_DYLD_EXPORTS_TRIE remains valid');
assert.equal(validExportsTrie.metadata.exportTrie.complete, true);

const validBuildVersion = parseMachO(macho64(0x32, 32, (view, offset) => {
  view.setUint32(offset + 8, 1, true);
  view.setUint32(offset + 12, 0x00110002, true);
  view.setUint32(offset + 16, 0x00120000, true);
  view.setUint32(offset + 20, 0, true);
}));
assert.equal(validBuildVersion.metadata.machoMetadata.complete, true, 'variable-sized LC_BUILD_VERSION remains valid when oversized');
assert.equal(validBuildVersion.metadata.buildVersion.source, 'LC_BUILD_VERSION');

console.log('issue-4505-macho-fixed-command-size: ok');
