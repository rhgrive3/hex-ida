import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

function replaceOnce(path, before, after) {
  const text = fs.readFileSync(path, 'utf8');
  const first = text.indexOf(before);
  if (first < 0 || text.indexOf(before, first + 1) >= 0) {
    throw new Error(`${path}: expected exactly one patch target`);
  }
  fs.writeFileSync(path, text.slice(0, first) + after + text.slice(first + before.length));
}

replaceOnce(
  'js/binary/elf-core.js',
  `  for (const sec of sections) {\n    if (sec.index === 0 || sec.size <= 0n) { sec.syntheticAddr = 0n; continue; }\n    const requested = sec.addralign > 0n ? sec.addralign : 1n;\n    if (!validELFSectionAlignment(requested)) {\n      sec.syntheticAddr = null;\n      markELFMetadataPartial(image, \`section-addralign:\${sec.index}\`, \`ELF ET_REL section \${sec.index} has invalid sh_addralign \${sec.addralign}; synthetic address authority was withheld\`);\n      continue;\n    }\n    cursor = alignUp(cursor, requested);\n`,
  `  for (const sec of sections) {\n    if (sec.index === 0) { sec.syntheticAddr = 0n; continue; }\n    const requested = sec.addralign > 0n ? sec.addralign : 1n;\n    if (!validELFSectionAlignment(requested)) {\n      sec.syntheticAddr = null;\n      markELFMetadataPartial(image, \`section-addralign:\${sec.index}\`, \`ELF ET_REL section \${sec.index} has invalid sh_addralign \${sec.addralign}; synthetic address authority was withheld\`);\n      continue;\n    }\n    if (sec.size <= 0n) { sec.syntheticAddr = 0n; continue; }\n    cursor = alignUp(cursor, requested);\n`,
);

replaceOnce(
  'tests/phase4/binary/issue-4227-elf-et-rel-addralign.test.mjs',
  `function makeRelocatableElf64({ textAlign = 0x02000000n } = {}) {`,
  `function makeRelocatableElf64({ textAlign = 0x02000000n, textSize = 0x80n } = {}) {`,
);
replaceOnce(
  'tests/phase4/binary/issue-4227-elf-et-rel-addralign.test.mjs',
  `  sh(2, names.text, 1, 0x6n, 0x120, 0x80, 0, 0, textAlign, 0n);`,
  `  sh(2, names.text, 1, 0x6n, 0x120, textSize, 0, 0, textAlign, 0n);`,
);
replaceOnce(
  'tests/phase4/binary/issue-4227-elf-et-rel-addralign.test.mjs',
  `console.log('issue #4227 ET_REL sh_addralign synthetic-layout regression: PASS');`,
  `const zeroSizedInvalid = parseELF(makeRelocatableElf64({ textAlign: 3n, textSize: 0n }));\nconst zeroSizedText = textOf(zeroSizedInvalid);\nassert.equal(zeroSizedText.source, 'unmapped-section', 'zero-sized ET_REL sections must still validate sh_addralign');\nassert.equal(zeroSizedInvalid.metadata.elfMetadata?.complete, false);\nassert.ok(zeroSizedInvalid.metadata.elfMetadata?.reasons?.some((reason) => reason.includes('section-addralign')));\n\nconsole.log('issue #4227 ET_REL sh_addralign synthetic-layout regression: PASS');`,
);

for (const [path, expected] of [
  ['js/binary/elf-core.js', 'bd8c29a6ff7d37b72c189450fd5b9f5e334bdb1f'],
  ['tests/phase4/binary/issue-4227-elf-et-rel-addralign.test.mjs', '7d0a5171f20cbe2a4ac71013946390f9e0468e3e'],
]) {
  const actual = execFileSync('git', ['hash-object', path], { encoding: 'utf8' }).trim();
  if (actual !== expected) throw new Error(`${path}: blob mismatch ${actual} != ${expected}`);
}
