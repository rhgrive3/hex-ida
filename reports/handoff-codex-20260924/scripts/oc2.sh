#!/bin/bash
# usage: oc2.sh <name> <dir> <promptfile> [maxRounds]
# Runs an opencode session and keeps continuing the SAME session until the
# model prints ALL-DONE (Gemini often ends a turn after a todo list).
S=/tmp/claude-0/-mnt-workspace-hex-ida/40472aea-bded-46c9-8e0c-871b3f42be35/scratchpad
name=$1; dir=$2; prompt=$3; max=${4:-12}
log="$S/oc-$name.log"
title="hexlane-$name-$(date +%s%N)"
M="-m proxlane/gemini-3.8-flash-high --variant high"
cd "$dir" || exit 1
: > "$log"
body="$(cat "$prompt")

When (and only when) every step is complete, including the git commit and passing tests, print the exact final line: ALL-DONE"
opencode run --auto $M --title "$title" "$body" >> "$log" 2>&1
for ((i=1; i<=max; i++)); do
  if tail -n 40 "$log" | grep -q "^ALL-DONE"; then break; fi
  sid=$(opencode session list --format json 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const a=JSON.parse(s);const x=a.find(r=>r.title===process.argv[1]);process.stdout.write(x?x.id:"")}catch{}})' "$title")
  if [ -z "$sid" ]; then echo "NO-SESSION-FOUND" >> "$log"; break; fi
  echo "=== CONTINUE round $i ($sid)" >> "$log"
  opencode run --auto $M --session "$sid" "Continue now with the remaining steps of the original task. Do not stop to plan or summarize until the commit exists and tests pass. When everything is complete, print the exact final line: ALL-DONE" >> "$log" 2>&1
done
echo "EXIT $?" >> "$log"
