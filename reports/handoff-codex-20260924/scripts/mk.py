S='/tmp/claude-0/-mnt-workspace-hex-ida/40472aea-bded-46c9-8e0c-871b3f42be35/scratchpad'
d=open(S+'/prompts/digest.txt').read()
d=d.replace("DO NOT edit those two files.","DO NOT edit those two files. Also DO NOT edit js/semantics/compat/semantic-ir-v2-to-v1-finalize.js or js/decompiler/types/high-variables.js: valueFeedsAddressOrCall/state-flow indexing was already fixed on main by PR #9526 and high-variable address indexing by PR #9531. Skip the valueFeedsAddressOrCall item and its test (c).")
open(S+'/prompts/digest-2.txt','w').write("IMPORTANT: Execute ALL steps to completion in this single run; do not stop after planning. Commit intermediate progress.\n\n"+d)
c=open(S+'/prompts/cxx-2.txt').read()
c=c.replace("PROBLEM: Hex detects","NOTE: PR #9527 (already merged on this base; files js/decompiler/cxx-evidence.js, pipeline-core.js, semantic-core.js, types/high-variables.js, tests/phase8/cxx-object-decompiler-projection.test.mjs) already projects canonical C++ member types into decompiler output. Read git log -8 --stat -- js/decompiler/cxx-evidence.js and that test first; BUILD ON IT, do not duplicate it. Measure first with the realgame harness on OpenTTD on this base to see what still shows 0 in pseudocode, then fix only what remains.\n\nPROBLEM (as measured before #9527): Hex detects",1)
open(S+'/prompts/cxx-3.txt','w').write(c)
