from pathlib import Path

path = Path('.github/workflows/cross-binary-accuracy.yml')
text = path.read_text()

old_comment = "  # Two non-pseudocode processes + two persistent pseudocode workers fit the\n  # four CPUs of the public ubuntu runner without creating another Actions job.\n  LOCAL_PSEUDOC_WORKERS: 2"
new_comment = "  # Keep two persistent pseudocode workers, but run their memory-heavy phase\n  # after the two non-pseudocode lanes so the runner never hosts both pools at once.\n  LOCAL_PSEUDOC_WORKERS: 2"
if old_comment not in text:
    raise SystemExit('expected worker comment not found')
text = text.replace(old_comment, new_comment, 1)

old = '''          if [[ "$PSEUDOC_CACHE_HIT" != "true" ]]; then
            node tests/accuracy-pseudoc-parallel.mjs \\
              --target="$target" \\
              --oracle="$oracle" \\
              --workers="$LOCAL_PSEUDOC_WORKERS" \\
              --json > "${pseudoc_output}.tmp" \\
              2> accuracy-local-pseudoc.log &
            pids+=("$!")
            labels+=("pseudoc")
          fi

          status=0
          for i in "${!pids[@]}"; do
            if ! wait "${pids[$i]}"; then status=1; fi
            log="accuracy-local-${labels[$i]}.log"
            if [[ -f "$log" ]]; then cat "$log"; fi
          done
          if [[ "$status" -ne 0 ]]; then exit "$status"; fi
'''
new = '''          # Join both non-pseudocode lanes before starting pseudocode. The
          # feature sets and worker counts are unchanged; only their memory-heavy
          # phases no longer overlap on the same hosted runner.
          status=0
          for i in "${!pids[@]}"; do
            if ! wait "${pids[$i]}"; then status=1; fi
            log="accuracy-local-${labels[$i]}.log"
            if [[ -f "$log" ]]; then cat "$log"; fi
          done
          if [[ "$status" -ne 0 ]]; then exit "$status"; fi

          if [[ "$PSEUDOC_CACHE_HIT" != "true" ]]; then
            if ! node tests/accuracy-pseudoc-parallel.mjs \\
              --target="$target" \\
              --oracle="$oracle" \\
              --workers="$LOCAL_PSEUDOC_WORKERS" \\
              --json > "${pseudoc_output}.tmp" \\
              2> accuracy-local-pseudoc.log; then
              cat accuracy-local-pseudoc.log
              exit 1
            fi
            cat accuracy-local-pseudoc.log
          fi
'''
if old not in text:
    raise SystemExit('expected cross-binary scheduling block not found')
text = text.replace(old, new, 1)
path.write_text(text)
