#!/bin/sh
set -eu
. "$(dirname "$0")/common.sh"

mkdir -p "$RUNTIME_DIR" "$LOG_DIR" "$XDG_RUNTIME_DIR"
chmod 0700 "$RUNTIME_DIR" "$LOG_DIR" "$XDG_RUNTIME_DIR"

xvfb_pid= x11vnc_pid= novnc_pid= launcher_pid=
record_pid() {
  printf '%s\n' "$2" > "$RUNTIME_DIR/$1.pid"
}
# Recursive state must not overwrite the caller's root in POSIX shell.
process_tree() (
  root=$1
  [ -d "/proc/$root" ] || return 0
  for child in $(ps -eo pid=,ppid= | awk -v parent="$root" '$2 == parent { print $1 }'); do
    process_tree "$child"
  done
  printf '%s\n' "$root"
)
stop_tree() {
  root=$1
  [ -n "$root" ] || return 0
  pids=$(process_tree "$root")
  for pid in $pids; do kill -TERM "$pid" 2>/dev/null || true; done
  i=0
  while [ "$i" -lt 50 ]; do
    alive=false
    for pid in $pids; do
      if kill -0 "$pid" 2>/dev/null; then alive=true; break; fi
    done
    [ "$alive" = false ] && return 0
    i=$((i + 1)); sleep 0.1
  done
  # Electron can remain stuck in shutdown on a headless display. These PIDs are the recorded
  # process tree created by this supervisor, so force only this owned tree after the grace period.
  for pid in $pids; do kill -KILL "$pid" 2>/dev/null || true; done
}
cleanup() {
  trap - EXIT HUP INT TERM
  stop_tree "$launcher_pid"
  stop_tree "$novnc_pid"
  stop_tree "$x11vnc_pid"
  stop_tree "$xvfb_pid"
  wait 2>/dev/null || true
  rm -f "$RUNTIME_DIR/xvfb.pid" "$RUNTIME_DIR/x11vnc.pid" \
    "$RUNTIME_DIR/novnc.pid" "$RUNTIME_DIR/launcher.pid" "$PID_FILE"
}
trap cleanup EXIT HUP INT TERM

Xvfb ":$DISPLAY_NUMBER" -screen 0 1440x900x24 -nolisten tcp -noreset \
  >> "$LOG_DIR/xvfb.log" 2>&1 &
xvfb_pid=$!
record_pid xvfb "$xvfb_pid"
i=0
while [ "$i" -lt 100 ] && [ ! -S "/tmp/.X11-unix/X$DISPLAY_NUMBER" ]; do
  kill -0 "$xvfb_pid" 2>/dev/null || { echo "Xvfb exited; see $LOG_DIR/xvfb.log" >&2; exit 1; }
  i=$((i + 1)); sleep 0.1
done
[ -S "/tmp/.X11-unix/X$DISPLAY_NUMBER" ] || { echo "Xvfb did not become ready" >&2; exit 1; }

x11vnc -display ":$DISPLAY_NUMBER" -localhost -rfbport "$VNC_PORT" \
  -rfbauth "$STATE_DIR/vnc.passwd" -forever -shared -noxdamage \
  >> "$LOG_DIR/x11vnc.log" 2>&1 &
x11vnc_pid=$!
record_pid x11vnc "$x11vnc_pid"

novnc --listen "127.0.0.1:$NOVNC_PORT" --vnc "127.0.0.1:$VNC_PORT" --file-only \
  >> "$LOG_DIR/novnc.log" 2>&1 &
novnc_pid=$!
record_pid novnc "$novnc_pid"

export DISPLAY=":$DISPLAY_NUMBER"
"$APPIMAGE_RUNNER" "$APPIMAGE" >> "$LOG_DIR/launcher.log" 2>&1 &
launcher_pid=$!
record_pid launcher "$launcher_pid"

wait "$launcher_pid"
