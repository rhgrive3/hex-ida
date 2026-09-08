import assert from 'node:assert/strict';
import { parseMachO } from '../../../js/binary/macho.js';

function macho64({ ncmds = 0, sizeofcmds = 0, commands = [] } = {}) {
  const bytes = new Uint8Array(32 + sizeofcmds);
  const view = new DataView(bytes.buffer);
  bytes.set([0xcf, 0xfa, 0xed, 0xfe], 0);
  view.setInt32(4, 0x0100000c, true);
  view.setInt32(8, 0, true);
  view.setUint32(12, 2, true);
  view.setUint32(16, ncmds, true);
  view.setUint32(20, sizeofcmds, true);
  view.setUint32(24, 0, true);
  view.setUint32(28, 0, true);
  let offset = 32;
  for (const { cmd = 0x7fffffff, cmdsize = 8 } of commands) {
    if (offset + 8 > bytes.length) break;
    view.setUint32(offset, cmd, true);
    view.setUint32(offset + 4, cmdsize, true);
    offset += Math.min(cmdsize, Math.max(0, bytes.length - offset));
  }
  return bytes;
}

function reasons(image) {
  return image.metadata?.machoMetadata?.reasons || [];
}

{
  const image = parseMachO(macho64());
  assert.equal(image.metadata.machoMetadata.complete, true);
  assert.deepEqual(reasons(image), []);
}

{
  const image = parseMachO(macho64({
    ncmds: 1,
    sizeofcmds: 8,
    commands: [{ cmdsize: 8 }],
  }));
  assert.equal(image.metadata.machoMetadata.complete, true);
  assert.equal(image.metadata.loadCommands, 1);
}

{
  const image = parseMachO(macho64({
    ncmds: 0,
    sizeofcmds: 8,
    commands: [{ cmdsize: 8 }],
  }));
  assert.equal(image.metadata.machoMetadata.complete, false);
  assert.ok(reasons(image).includes('load-command-count-size-mismatch'));
  assert.equal(image.metadata.loadCommands, 0);
}

{
  const image = parseMachO(macho64({
    ncmds: 1,
    sizeofcmds: 16,
    commands: [{ cmdsize: 8 }, { cmdsize: 8 }],
  }));
  assert.equal(image.metadata.machoMetadata.complete, false);
  assert.ok(reasons(image).includes('load-command-count-size-mismatch'));
  assert.equal(image.metadata.loadCommands, 1);
}

{
  const image = parseMachO(macho64({
    ncmds: 2,
    sizeofcmds: 16,
    commands: [{ cmdsize: 8 }, { cmdsize: 8 }],
  }));
  assert.equal(image.metadata.machoMetadata.complete, true);
  assert.equal(image.metadata.loadCommands, 2);
  assert.ok(!reasons(image).includes('load-command-count-size-mismatch'));
}

{
  const image = parseMachO(macho64({
    ncmds: 1,
    sizeofcmds: 8,
    commands: [{ cmdsize: 4 }],
  }));
  assert.equal(image.metadata.machoMetadata.complete, false);
  assert.ok(reasons(image).includes('load-command-invalid-size'));
  assert.ok(!reasons(image).includes('load-command-count-size-mismatch'));
}

console.log('issue-3743-macho-load-command-size: PASS');
