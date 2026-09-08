# Remaining canonical UI chain

The prior unchanged viewport matrix pass was retained and not rerun. The
remaining chain was run once with the task-owned repaired browser environment:

```
node tests/ui/analysis-navigation.mjs
node tests/ui/mobile-state.mjs
node tests/ui/accessibility.mjs
npm run ai:browser
```

It was executed through:

```
source /mnt/workspace/.dev-state/hex-development-batch/browser-env.sh
export DEBUG=pw:browser
export NO_PROXY="localhost,127.0.0.1${NO_PROXY:+,${NO_PROXY}}"
export no_proxy="$NO_PROXY"
$HEX_NODE22/node scripts/run-quiet-command.mjs --label ui-remaining -- \
  bash /mnt/workspace/.dev-state/hex-development-batch/t019-ui-remaining.sh
```

The primary was `1dab32bab503ad3ee0c8e82e5b41177966f9e68f` when the command
started and remained clean. It advanced during the run to
`ea367a7f6f39d66008b119b15bf6383bfeb7d00e`; that commit only retained review
documents and changed evidence text, while the tested runtime stayed at the
same source. The wrapper result was:

```
ui-remaining: PASS (107.4s)
exit=0
```

Retained files:

- [command record](t019-ui-remaining-commands.txt)
- [task script](/mnt/workspace/.dev-state/hex-development-batch/t019-ui-remaining.sh)
- [quiet-wrapper log](ui-remaining-wrapper.txt)

The quiet wrapper removes the child full log after a successful run; the
wrapper summary above is the retained success log. No device execution or
additional viewport run was performed.
