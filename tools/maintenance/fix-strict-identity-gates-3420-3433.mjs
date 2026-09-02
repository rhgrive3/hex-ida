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

await patchFile('js/analysis/summary/contract.js', (text) => {
  let out = text;
  const replacements = [
    [
      "if (functionId != null && String(summary.functionId ?? '') !== String(functionId)) return false;",
      "if (functionId != null && (typeof functionId !== 'string' || summary.functionId !== functionId)) return false;",
      'functionId',
    ],
    [
      "if (snapshotId != null && status.snapshotId !== String(snapshotId)) return false;",
      "if (snapshotId != null && (typeof snapshotId !== 'string' || status.snapshotId !== snapshotId)) return false;",
      'snapshotId',
    ],
    [
      "if (analyzerId != null && status.analyzerId !== String(analyzerId)) return false;",
      "if (analyzerId != null && (typeof analyzerId !== 'string' || status.analyzerId !== analyzerId)) return false;",
      'analyzerId',
    ],
    [
      "if (analyzerVersion != null && status.analyzerVersion !== String(analyzerVersion)) return false;",
      "if (analyzerVersion != null && (typeof analyzerVersion !== 'string' || status.analyzerVersion !== analyzerVersion)) return false;",
      'analyzerVersion',
    ],
  ];
  for (const [before, after, label] of replacements) {
    out = replaceOnce(out, before, after, `#3420 ${label}`);
  }
  return out;
});

const pdbClassAnchor = 'export class PdbDebugInfoProvider extends DebugInfoProvider {';
const pdbIdentityHelper = `function expectedCodeViewIdentity(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (typeof value.guid !== 'string' || !value.guid.trim()) return null;
  if (typeof value.age !== 'number' || !Number.isSafeInteger(value.age) || value.age < 0) return null;
  return \`${'${value.guid.trim().toUpperCase()}/${value.age}'}\`;
}

`;

await patchFile('js/analysis/debug/pdb.js', (text) => {
  let out = text;
  if (!out.includes(pdbIdentityHelper)) {
    out = replaceOnce(out, pdbClassAnchor, pdbIdentityHelper + pdbClassAnchor, '#3433 identity helper');
  }
  out = replaceOnce(
    out,
    "expected: expectedCodeView ? `${expectedCodeView.guid}/${expectedCodeView.age}` : null,",
    'expected: expectedCodeViewIdentity(expectedCodeView),',
    '#3433 missing-PDB identity normalization',
  );
  out = replaceOnce(
    out,
    "const expected = expectedCodeView ? `${String(expectedCodeView.guid).toUpperCase()}/${expectedCodeView.age}` : null;",
    'const expected = expectedCodeViewIdentity(expectedCodeView);',
    '#3433 present-PDB identity normalization',
  );
  out = replaceOnce(
    out,
    "detail = expected == null ? 'the binary carries no CodeView debug directory entry' : 'the PDB has no info stream';",
    "detail = expected == null\n        ? (expectedCodeView == null\n          ? 'the binary carries no CodeView debug directory entry'\n          : 'the binary CodeView GUID/age is malformed')\n        : 'the PDB has no info stream';",
    '#3433 malformed identity diagnostic',
  );
  return out;
});

console.log('Applied #3420/#3433 strict identity-gate fixes.');
