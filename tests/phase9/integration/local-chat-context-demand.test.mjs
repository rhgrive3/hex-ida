import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { localChatDependencies } from '../../../js/ai/ui/local-engine-base.js';

const SOURCE_URL = new URL('../../../js/ai/ui/local-engine-base.js', import.meta.url);

test('local fallback skips current-function analysis for file and project scope', () => {
  assert.deepEqual(
    localChatDependencies({ question: 'このファイルの形式とCPUを教えて', scope: 'file', hasFunction: true }),
    { functionContext: false, assembly: false },
  );
  assert.deepEqual(
    localChatDependencies({ question: 'このプロジェクトの状況を教えて', scope: 'project', hasFunction: true }),
    { functionContext: false, assembly: false },
  );
});

test('local fallback only requests raw assembly for assembly-specific function questions', () => {
  assert.deepEqual(
    localChatDependencies({ question: 'この関数の概要を教えて', scope: 'function', hasFunction: true }),
    { functionContext: true, assembly: false },
  );
  assert.deepEqual(
    localChatDependencies({ question: 'この関数のARM64命令を見せて', scope: 'function', hasFunction: true }),
    { functionContext: true, assembly: true },
  );
  assert.deepEqual(
    localChatDependencies({ question: 'show the disassembly for this function', scope: 'function', hasFunction: true }),
    { functionContext: true, assembly: true },
  );
});

test('local fallback preserves the turn AbortSignal when loading function context', async () => {
  const source = await readFile(SOURCE_URL, 'utf8');
  assert.match(source, /analyzeModelAt\(app, addr, null, \{ signal \}\)/);
  assert.doesNotMatch(source, /analyzeModelAt\(app, addr\)\s*;/);
});
