# Quickstart: Apple Knowledge Matrix

```javascript
import {
  buildAppleKnowledge,
  parseDyldSharedCache,
  probeAppleLanguageMetadata,
  serializeAppleKnowledge,
  parseSerializedAppleKnowledge,
} from './js/apple/knowledge.js';

const sharedCache = parseDyldSharedCache(cacheBytes);
const swift = await probeAppleLanguageMetadata(parsedMachO, 'swift');
const objc = await probeAppleLanguageMetadata(parsedMachO, 'objc');

const matrix = buildAppleKnowledge({
  image: parsedMachO,
  swift,
  objc,
  dyldCache: sharedCache,
});

const reparsed = parseSerializedAppleKnowledge(serializeAppleKnowledge(matrix));
console.log(reparsed.cells.codeSigning.evidence.validity); // "unknown"
console.log(reparsed.complete); // false: serialized evidence must be rederived from source
```
