from pathlib import Path

p = Path('js/ai/ui/local-engine-base.js')
s = p.read_text()
old = "async function runAgent({ app, localContext, question, mode, style, signal, onActivity }) {\n  if (signal?.aborted) throw new Error('cancelled');\n\n"
new = """async function runAgent({ app, localContext, question, mode, style, signal, onActivity, context }) {
  if (signal?.aborted) throw new Error('cancelled');

  const anchor = context?.function || null;
  const anchorParts = [];
  if (anchor?.address) anchorParts.push(String(anchor.address));
  if (anchor?.name) anchorParts.push(pick('関数: ' + anchor.name, 'function: ' + anchor.name));
  onActivity({
    label: pick('解析地点を特定', 'Locating analysis target'),
    detail: anchorParts.join(pick('、', ', ')) || pick('現在の解析コンテキスト', 'current analysis context'),
  });

"""
count = s.count(old)
if count != 1:
    raise SystemExit(f'runAgent anchor insertion expected one match, got {count}')
p.write_text(s.replace(old, new, 1))
