# Task-owned WebKit GSettings repair

Date: 2026-09-08

The retained UI trace `/tmp/hex-ui-browser-with-runtime-trace-3RXotG/full.log`
failed in WebKit with `GLib-GIO-ERROR: No GSettings schemas are installed on
the system`, followed by a WebKit internal load error. Chromium viewports passed.

## Repair

No tracked repository or global package was changed. The Ubuntu Jammy
`gsettings-desktop-schemas` 42.0-1ubuntu1 `all` package was downloaded to the
task-owned directory
`/mnt/workspace/.dev-state/hex-development-batch/gsettings-download/` and
extracted into the task-owned browser dependency root
`/mnt/workspace/.local/hex-development-batch-webkit-deps/root/`.

Package SHA-256:

```
5b420af7d77735d1bcc0494134b6810d20d168cd9407febed32d77baccd9e993
```

`glib-compile-schemas` generated:

```
/mnt/workspace/.local/hex-development-batch-webkit-deps/root/usr/share/glib-2.0/schemas/gschemas.compiled
sha256 af84b3c7e434a0cb207d5f9a12b9508bce3dac1dcd69ac1eae4c6a28efc26961
```

The task-owned environment file
`/mnt/workspace/.dev-state/hex-development-batch/browser-env.sh` now exports:

```
GSETTINGS_SCHEMA_DIR=$HEX_WEBKIT_DEPS/usr/share/glib-2.0/schemas
XDG_DATA_DIRS=$HEX_WEBKIT_DEPS/usr/share${XDG_DATA_DIRS:+:$XDG_DATA_DIRS}
XDG_CACHE_HOME=/mnt/workspace/.dev-state/hex-development-batch/xdg/cache
```

It creates the task-owned data/cache directories when sourced. `gsettings
list-schemas` reports 41 schemas with this environment.

## Verification

Actual primary page preflight, with retained browser stderr:

```
source /mnt/workspace/.dev-state/hex-development-batch/browser-env.sh
export DEBUG=pw:browser NO_PROXY=localhost,127.0.0.1 no_proxy=$NO_PROXY
HEX_REPRO_WAIT=networkidle \
HEX_REPRO_LOG=/mnt/workspace/.dev-state/hex-development-batch/repro-webkit-gsettings.jsonl \
  $HEX_NODE22/node /mnt/workspace/.dev-state/hex-development-batch/repro-webkit-actual-page.mjs \
  > /mnt/workspace/.dev-state/hex-development-batch/repro-webkit-gsettings.log 2>&1
```

Exit `0`; 521 browser requests, 470 local server requests, zero page errors,
zero request failures, and zero crashes. The log contains no GSettings or WebKit
internal-error line; it retains only the existing automation warning.

The retained one-run UI browser command was:

```
source /mnt/workspace/.dev-state/hex-development-batch/browser-env.sh
export DEBUG=pw:browser NO_PROXY=localhost,127.0.0.1
$HEX_NODE22/node tests/ui/browser.mjs \
  > /mnt/workspace/.dev-state/hex-development-batch/ui-browser-gsettings.log 2>&1
```

It exited `0` with `UI browser viewport matrix passed` across all configured
Chromium and WebKit viewports. The log contains no GSettings or WebKit
internal-error lines.

These are environment/preflight observations only; they do not certify the
full UI chain or release evidence.
