#!/bin/sh
set -eu

command_name=$(basename "$0")
case "$command_name" in
  pi-workgraph-chatgpt-web-install) script=install.sh ;;
  codex-web-gpt-lifecycle.sh|pi-workgraph-chatgpt-web-start) script=start.sh ;;
  pi-workgraph-chatgpt-web-status) script=status.sh ;;
  pi-workgraph-chatgpt-web-stop) script=stop.sh ;;
  *)
    echo "Invoke this entry point as a pi-workgraph-chatgpt-web-* package bin" >&2
    exit 2
    ;;
esac

script_dir=$(CDPATH= cd -- "$(dirname -- "$(readlink -f "$0")")" && pwd)
exec sh "$script_dir/../scripts/codex-web-gpt-headless/$script" "$@"
