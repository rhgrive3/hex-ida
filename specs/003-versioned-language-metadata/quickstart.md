# Quickstart: Language and Runtime Metadata Providers

```javascript
import { parseLanguageMetadata, applyLanguageMetadataTypesToGraph } from './js/metadata/index.js';
import { TypeConstraintGraph } from './js/analysis/types/graph.js';

// 1. Parse metadata from binary sections
const result = await parseLanguageMetadata({
  sections,
  readAt: reader,
  architecture: 'arm64',
  platform: 'darwin',
  binaryIdentity: 'sha256:...',
});

// 2. Inspect ecosystem results
console.log(`Detected ecosystems: ${result.results.map(r => r.ecosystem).join(', ')}`);

// 3. Apply types safely to TypeConstraintGraph
const graph = new TypeConstraintGraph({ snapshotId: 'analysis-v1' });
for (const subResult of result.results) {
  const page = subResult.provider.types();
  applyLanguageMetadataTypesToGraph(graph, subResult, page);
}

// 4. Query solved types
const resolved = graph.solveEntity('type@0x1100');
console.log('Resolved type:', resolved);
```
