import json
from pathlib import Path

p = Path('tools/validation/analysis-roadmap/ownership.json')
data = json.loads(p.read_text())
additions = [
    'js/decompiler/phase8/structuring.js',
    'tests/phase8/structuring/edge-accounting.test.mjs',
]
for path in additions:
    if path not in data['owners']['phase8']:
        data['owners']['phase8'].append(path)
p.write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n')
