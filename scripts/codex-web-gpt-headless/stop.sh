#!/bin/sh
set -eu
. "$(dirname "$0")/common.sh"

record_state=$(session_record_state)
case "$record_state" in
  foreign|invalid)
    foreign_session_message
    exit 1
    ;;
  stale)
    rm -f "$PID_FILE"
    echo "No owned headless launcher session is running"
    exit 0
    ;;
  absent)
    echo "No owned headless launcher session is running"
    exit 0
    ;;
esac
read -r pid _ < "$PID_FILE"
# Isolate recursive variables: POSIX shell variables otherwise overwrite the caller's root.
process_tree() (
  root=$1
  [ -d "/proc/$root" ] || return 0
  for child in $(ps -eo pid=,ppid= | awk -v parent="$root" '$2 == parent { print $1 }'); do
    process_tree "$child"
  done
  printf '%s\n' "$root"
)
kill_tree() {
  signal=$1
  root=$2
  pids=$(process_tree "$root")
  for child in $pids; do kill "-$signal" "$child" 2>/dev/null || true; done
}
initial_tree=$(process_tree "$pid")
kill -TERM "$pid"
i=0
while [ "$i" -lt 50 ] && kill -0 "$pid" 2>/dev/null; do
  i=$((i + 1)); sleep 0.1
done
if kill -0 "$pid" 2>/dev/null; then
  # A shell waiting for Electron may defer its trap until the child exits. Revalidate the
  # supervisor identity, then terminate only its current process tree.
  if owned_session_running; then
    for child in $initial_tree; do kill -TERM "$child" 2>/dev/null || true; done
    sleep 1
    for child in $initial_tree; do kill -KILL "$child" 2>/dev/null || true; done
    kill_tree KILL "$pid"
  fi
fi
i=0
while [ "$i" -lt 50 ] && kill -0 "$pid" 2>/dev/null; do
  i=$((i + 1)); sleep 0.1
done
if kill -0 "$pid" 2>/dev/null; then
  echo "Owned supervisor PID $pid did not stop" >&2
  exit 1
fi
rm -f "$RUNTIME_DIR"/*.pid "$PID_FILE"
echo "Stopped owned headless launcher session $pid"
