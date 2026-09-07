import assert from 'node:assert/strict';
import { readArtifactPage } from '../js/core/artifacts/index.js';

const controller = new AbortController();
let resolveRead;
const source = {
  readExactly() {
    return new Promise((resolve) => { resolveRead = resolve; });
  },
};

const reason = new Error('cancelled-during-read');
const pending = readArtifactPage(source, {
  offset: 0n,
  length: 1,
  signal: controller.signal,
});

controller.abort(reason);
resolveRead(Uint8Array.of(0x41));

await assert.rejects(pending, (error) => error === reason);
console.log('artifact-page-abort-race: PASS');
