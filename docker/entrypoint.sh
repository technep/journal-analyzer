#!/usr/bin/env bash
# Entrypoint for the build-artifact image. Not a server — it hands out the
# built web app and launches the GUI tool.
set -euo pipefail

cmd="${1:-help}"
case "$cmd" in
  extract)
    dest="${2:-/out}"
    if [ ! -d "$dest" ]; then
      echo "error: '$dest' is not a directory — mount one, e.g.:" >&2
      echo "  docker run --rm -v \"\$PWD/dist-out:/out\" <image> extract" >&2
      exit 1
    fi
    cp -r /dist/. "$dest/"
    echo "dist/ extracted to $dest"
    ;;
  analyze)
    shift
    exec python3 /opt/journal-log-analyzer/journal_log_analyzer.py "$@"
    ;;
  help|*)
    cat <<'EOF'
journal-analyzer build image — artifacts and tools, not a server.

  extract [dir]  copy the built web app (/dist) to dir (default /out)
                 docker run --rm -v "$PWD/dist-out:/out" <image> extract
  analyze        launch the journal-log-analyzer GUI (needs X11):
                 docker run --rm -e DISPLAY="$DISPLAY" \
                   -v /tmp/.X11-unix:/tmp/.X11-unix <image> analyze
EOF
    ;;
esac
