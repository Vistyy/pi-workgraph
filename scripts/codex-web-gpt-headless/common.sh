#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
APP_ROOT=${CODEX_WEB_GPT_HEADLESS_ROOT:-"$HOME/.local/share/codex-web-gpt-headless"}
APP_VERSION=5.0.4
UPSTREAM_REVISION=c648c09501bb1b704c7ad5273fb5f5d6b8992dd2
APP_ASSET="codex-web-gpt-$APP_VERSION-linux-x64.AppImage"
APP_SHA256=53b2bda3691774fa588ae3f9b0fcdeea49b35e72966934631d172cac0adf0d76
APPIMAGE="$APP_ROOT/app/$APP_ASSET"
APPIMAGE_RUNNER="$APP_ROOT/app/run-appimage"
STATE_DIR="$APP_ROOT/state"
RUNTIME_DIR="$APP_ROOT/runtime"
LOG_DIR="$APP_ROOT/logs"
PID_FILE="$RUNTIME_DIR/session.pid"
DISPLAY_NUMBER=${CODEX_WEB_GPT_DISPLAY_NUMBER:-97}
VNC_PORT=${CODEX_WEB_GPT_VNC_PORT:-5905}
NOVNC_PORT=${CODEX_WEB_GPT_NOVNC_PORT:-6085}

export CODEX_CHATGPT_WEB_HOME="$STATE_DIR/core"
export CODEX_HOME="$STATE_DIR/codex-home"
export CODEX_WEB_GPT_LAUNCHER_DATA_DIR="$STATE_DIR/launcher"
export CODEX_WEB_GPT_LAUNCHER_EXECUTABLE="$SCRIPT_DIR/../../bin/codex-web-gpt-lifecycle.sh"
export CODEX_WEB_GPT_APPIMAGE="$APPIMAGE"
export XDG_CONFIG_HOME="$STATE_DIR/xdg/config"
export XDG_DATA_HOME="$STATE_DIR/xdg/data"
export XDG_CACHE_HOME="$STATE_DIR/xdg/cache"
export XDG_RUNTIME_DIR="$RUNTIME_DIR/xdg"

process_start_time() {
  sed 's/^[^)]*) //' "/proc/$1/stat" 2>/dev/null | awk 'NR == 1 { print $20 }'
}

session_record_state() {
  [ -f "$PID_FILE" ] || { printf '%s\n' absent; return; }
  pid= expected_start=
  read -r pid expected_start < "$PID_FILE" || { printf '%s\n' invalid; return; }
  case "$pid:$expected_start" in *[!0-9:]*|:|*:|:*) printf '%s\n' invalid; return ;; esac
  [ "$(process_start_time "$pid")" = "$expected_start" ] || {
    printf '%s\n' stale
    return
  }
  command_line=$(tr '\000' ' ' < "/proc/$pid/cmdline" 2>/dev/null || true)
  case "$command_line" in
    *"$SCRIPT_DIR/session.sh"*) printf '%s\n' owned ;;
    *) printf '%s\n' foreign ;;
  esac
}

owned_session_running() {
  [ "$(session_record_state)" = owned ]
}

foreign_session_message() {
  echo "A live headless launcher from another script directory owns $PID_FILE; preserve it and inspect/migrate it through that source path before retrying." >&2
}

port_is_listening() {
  ss -H -ltn "sport = :$1" 2>/dev/null | grep -q .
}
