import base64
from pathlib import Path

p=Path('js/decompiler/phase8/structuring.js')
s=p.read_text()
old="const { byIndex, loopsByHeader, innermostLoopOf, postDominates, ipdom } = context;"
new="const { byIndex, loopsByHeader, innermostLoopOf, dispatcherLoopOf, postDominates, ipdom } = context;"
if old not in s: raise SystemExit('classify context anchor missing')
s=s.replace(old,new,1)
anchor="""  const enclosing = innermostLoopOf(from);\n\n  // 2. An edge inside an irreducible region is emitted as an explicit jump. The\n"""
insert="""  const dispatcher = typeof dispatcherLoopOf === 'function'\n    ? (dispatcherLoopOf(from) ?? dispatcherLoopOf(to))\n    : null;\n  if (dispatcher != null) {\n    return {\n      construct: 'residual-goto',\n      reason: `switch-headed loop ${dispatcher.header} has multiple direct state arms returning to its header, so it is retained as explicit control flow rather than guessed as a structured loop`,\n    };\n  }\n\n  const enclosing = innermostLoopOf(from);\n\n  // 2. An edge inside an irreducible region is emitted as an explicit jump. The\n"""
if anchor not in s: raise SystemExit('dispatcher classify anchor missing')
s=s.replace(anchor,insert,1)
anchor="""  const nodeSets = new Map(loops.map((loop) => [loop.header, new Set(loop.nodes)]));\n\n  const innermostLoopOf = (index) => {\n"""
insert="""  const nodeSets = new Map(loops.map((loop) => [loop.header, new Set(loop.nodes)]));\n\n  // A switch-headed natural loop whose distinct case blocks are all direct\n  // latches back to the same header is dispatcher-shaped control flow. It may\n  // be a flattened state machine, and this pass has no independent state-machine\n  // proof. Preserve every edge as a residual jump instead of minting a loop or\n  // switch region from the shape alone.\n  const dispatcherLoopHeaders = new Set();\n  for (const loop of loops) {\n    if (loop.classification !== 'natural') continue;\n    const nodes = nodeSets.get(loop.header);\n    const header = byIndex.get(loop.header);\n    if (!nodes || !header || terminatorOf(header)?.op !== 'switch') continue;\n    const internal = successorEdgesOf(header).filter((edge) => nodes.has(edge.to));\n    if (internal.length < 2 || internal.some((edge) => edge.to === loop.header)) continue;\n    const latches = new Set(loop.latches);\n    const allDirectLatches = internal.every((edge) => {\n      if (!latches.has(edge.to)) return false;\n      const armEdges = successorEdgesOf(byIndex.get(edge.to));\n      return armEdges.length === 1 && armEdges[0].to === loop.header\n        && armEdges[0].kinds.every((kind) => STRUCTURED_EDGE_KINDS.has(kind));\n    });\n    if (allDirectLatches) dispatcherLoopHeaders.add(loop.header);\n  }\n\n  const dispatcherLoopOf = (index) => {\n    let best = null;\n    for (const loop of loops) {\n      if (!dispatcherLoopHeaders.has(loop.header) || !nodeSets.get(loop.header).has(index)) continue;\n      if (best == null || loop.nodes.length < best.nodes.length) best = loop;\n    }\n    return best;\n  };\n\n  const innermostLoopOf = (index) => {\n"""
if anchor not in s: raise SystemExit('dispatcher detection anchor missing')
s=s.replace(anchor,insert,1)
old="const accountingContext = { byIndex, blockOrder, loopsByHeader, innermostLoopOf, loopExitedBy, postDominates, ipdom, sharedPostDominator };"
new="const accountingContext = { byIndex, blockOrder, loopsByHeader, innermostLoopOf, dispatcherLoopOf, loopExitedBy, postDominates, ipdom, sharedPostDominator };"
if old not in s: raise SystemExit('accounting context anchor missing')
s=s.replace(old,new,1)
old="""  for (const loop of loops) {\n    const exits = [...new Set(loop.exitEdges.map((edge) => edge.to))].sort((left, right) => left - right);\n"""
new="""  for (const loop of loops) {\n    if (dispatcherLoopHeaders.has(loop.header)) continue;\n    const exits = [...new Set(loop.exitEdges.map((edge) => edge.to))].sort((left, right) => left - right);\n"""
if old not in s: raise SystemExit('loop region anchor missing')
s=s.replace(old,new,1)
old="""    const successors = successorEdgesOf(block);\n    if (successors.length < 2) continue;\n    if (loopsByHeader.has(index) && loopsByHeader.get(index).guardBlock === index) continue;\n"""
new="""    const successors = successorEdgesOf(block);\n    if (successors.length < 2) continue;\n    if (dispatcherLoopHeaders.has(index)) continue;\n    if (loopsByHeader.has(index) && loopsByHeader.get(index).guardBlock === index) continue;\n"""
if old not in s: raise SystemExit('branch region anchor missing')
s=s.replace(old,new,1)
p.write_text(s)

p=Path('tests/phase8/structuring/edge-accounting.test.mjs')
s=p.read_text()
marker="test('nested loops name the back edge, the entry and the guard exit at each level', () => {"
if marker not in s: raise SystemExit('test insertion anchor missing')
tests=base64.b64decode('dGVzdCgnc3dpdGNoIGNhc2UgZmFsbHRocm91Z2ggcmVtYWlucyBhbiBleHBsaWNpdCBhY2NvdW50ZWQgZWRnZSBpbnNpZGUgdGhlIHN3aXRjaCByZWdpb24nLCAoKSA9PiB7CiAgY29uc3QgZiA9IGZpeHR1cmUoJ3N3aXRjaC1mYWxsdGhyb3VnaCcpOwogIGNvbnN0IHNlbGVjdG9yID0gZi5ibG9jaygwLCB7IHN1Y2M6IFsxLCAyLCAzXSB9KS5vcGFxdWUoMzIpOwogIGYuc3dpdGNoQnJhbmNoKHNlbGVjdG9yLCBbWzAsIDFdLCBbMSwgMl1dLCAzKTsKICBmLmJsb2NrKDEsIHsgc3VjYzogWzJdLCBlZGdlczogW3sgdG86IDIsIGtpbmQ6ICdmYWxsdGhyb3VnaCcgfV0gfSkuYnJhbmNoKDIpOwogIGYuYmxvY2soMiwgeyBzdWNjOiBbNF0gfSkuYnJhbmNoKDQpOwogIGYuYmxvY2soMywgeyBzdWNjOiBbNF0gfSkuYnJhbmNoKDQpOwogIGYuYmxvY2soNCkucmV0KCk7CiAgY29uc3QgaXIgPSBmLmJ1aWxkKCk7CiAgY29uc3QgeyBmYWN0cyB9ID0gc3RydWN0dXJpbmcoaXIpOwogIGFzc2VydC5lcXVhbChmYWN0cy5lZGdlcy5maW5kKChlZGdlKSA9PiBlZGdlLmZyb20gPT09IDEgJiYgZWRnZS50byA9PT0gMik/LmNvbnN0cnVjdCwgJ3NlcXVlbmNlJyk7CiAgYXNzZXJ0Lm9rKGZhY3RzLmVkZ2VzLmZpbmQoKGVkZ2UpID0+IGVkZ2UuZnJvbSA9PT0gMSAmJiBlZGdlLnRvID09PSAyKT8ua2luZHMuaW5jbHVkZXMoJ2ZhbGx0aHJvdWdoJykpOwogIGFzc2VydC5vayhmYWN0cy5yZWdpb25zLnNvbWUoKGVudHJ5KSA9PiBlbnRyeS5raW5kID09PSAnc3dpdGNoJyAmJiBlbnRyeS5lbnRyeSA9PT0gMCkpOwogIGFzc2VydC5kZWVwRXF1YWwoZWRnZUFjY291bnRpbmdGYWlsdXJlcyhpciwgZmFjdHMpLCBbXSk7Cn0pOwoKdGVzdCgnZmxhdHRlbmVkIHN3aXRjaCBkaXNwYXRjaGVyIHJlbWFpbnMgcmVzaWR1YWwgY29udHJvbCBmbG93IGluc3RlYWQgb2YgYSBndWVzc2VkIGxvb3AnLCAoKSA9PiB7CiAgY29uc3QgZiA9IGZpeHR1cmUoJ2ZsYXR0ZW5lZC1kaXNwYXRjaGVyJyk7CiAgZi5ibG9jaygwLCB7IHN1Y2M6IFsxXSB9KS5icmFuY2goMSk7CiAgY29uc3Qgc3RhdGUgPSBmLmJsb2NrKDEsIHsgc3VjYzogWzIsIDMsIDRdIH0pLm9wYXF1ZSgzMik7CiAgZi5zd2l0Y2hCcmFuY2goc3RhdGUsIFtbMCwgMl0sIFsxLCAzXV0sIDQpOwogIGYuYmxvY2soMiwgeyBzdWNjOiBbMV0gfSkuYnJhbmNoKDEpOwogIGYuYmxvY2soMywgeyBzdWNjOiBbMV0gfSkuYnJhbmNoKDEpOwogIGYuYmxvY2soNCkucmV0KCk7CiAgY29uc3QgaXIgPSBmLmJ1aWxkKCk7CiAgY29uc3QgeyBmYWN0cyB9ID0gc3RydWN0dXJpbmcoaXIpOwogIGFzc2VydC5lcXVhbChmYWN0cy5yZXNpZHVhbEdvdG9Db3VudCwgZmFjdHMuZWRnZUNvdW50KTsKICBhc3NlcnQub2soZmFjdHMuZWRnZXMuZXZlcnkoKGVkZ2UpID0+IGVkZ2UuY29uc3RydWN0ID09PSAncmVzaWR1YWwtZ290bycpKTsKICBhc3NlcnQub2soIWZhY3RzLnJlZ2lvbnMuc29tZSgoZW50cnkpID0+IGVudHJ5LmVudHJ5ID09PSAxICYmIChlbnRyeS5raW5kID09PSAnbG9vcCcgfHwgZW50cnkua2luZCA9PT0gJ3N3aXRjaCcpKSk7CiAgYXNzZXJ0LmRlZXBFcXVhbChlZGdlQWNjb3VudGluZ0ZhaWx1cmVzKGlyLCBmYWN0cyksIFtdKTsKfSk7Cgo=').decode()
s=s.replace(marker,tests+marker,1)
p.write_text(s)
