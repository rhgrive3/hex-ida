#!/bin/bash
# usage: oc.sh <name> <dir> <promptfile>
S=/tmp/claude-0/-mnt-workspace-hex-ida/40472aea-bded-46c9-8e0c-871b3f42be35/scratchpad
cd "$2" && opencode run --auto -m proxlane/gemini-3.8-flash-high --variant high "$(cat "$3")" > "$S/oc-$1.log" 2>&1
echo "EXIT $?" >> "$S/oc-$1.log"
