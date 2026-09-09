#!/bin/sh
set -eu
. "$(dirname "$0")/common.sh"

record_state=$(session_record_state)
case "$record_state" in
  owned)
    read -r pid start < "$PID_FILE"
    echo "session=running supervisor_pid=$pid start_time=$start"
    ;;
  foreign|invalid)
    echo "session=blocked reason=inspect_foreign_or_invalid_pid_record pid_file=$PID_FILE"
    ;;
  stale) echo "session=stopped" ;;
  absent) echo "session=stopped" ;;
esac
for name in xvfb x11vnc novnc launcher; do
  file="$RUNTIME_DIR/$name.pid"
  [ -f "$file" ] && printf '%s_pid=%s\n' "$name" "$(cat "$file")"
done
printf 'vnc_listener=%s port=%s\n' "$(port_is_listening "$VNC_PORT" && echo yes || echo no)" "$VNC_PORT"
printf 'novnc_listener=%s port=%s\n' "$(port_is_listening "$NOVNC_PORT" && echo yes || echo no)" "$NOVNC_PORT"
printf 'root=%s\n' "$APP_ROOT"
