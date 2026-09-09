#!/bin/sh
set -eu
. "$(dirname "$0")/common.sh"

record_state=$(session_record_state)
case "$record_state" in
  owned)
    read -r pid _ < "$PID_FILE"
    echo "Headless launcher is already running (supervisor PID $pid)"
    exit 0
    ;;
  foreign|invalid)
    foreign_session_message
    exit 1
    ;;
  stale) rm -f "$PID_FILE" ;;
esac

[ -x "$APPIMAGE" ] && [ -x "$APPIMAGE_RUNNER" ] || {
  echo "Run $SCRIPT_DIR/install.sh first" >&2
  exit 1
}
for port in "$VNC_PORT" "$NOVNC_PORT"; do
  if port_is_listening "$port"; then
    echo "Refusing to reuse occupied TCP port $port" >&2
    exit 1
  fi
done
if [ -e "/tmp/.X11-unix/X$DISPLAY_NUMBER" ]; then
  echo "Refusing to reuse occupied display :$DISPLAY_NUMBER" >&2
  exit 1
fi

umask 077
mkdir -p "$STATE_DIR" "$RUNTIME_DIR" "$LOG_DIR" "$XDG_RUNTIME_DIR"
chmod 0700 "$STATE_DIR" "$RUNTIME_DIR" "$LOG_DIR" "$XDG_RUNTIME_DIR"
if [ ! -f "$STATE_DIR/vnc.passwd" ]; then
  password=$(od -An -N12 -tx1 /dev/urandom | tr -d ' \n')
  printf '%s\n' "$password" > "$STATE_DIR/vnc-password.txt"
  nix shell nixpkgs#x11vnc --command x11vnc -storepasswd "$password" "$STATE_DIR/vnc.passwd" >/dev/null
  chmod 0600 "$STATE_DIR/vnc-password.txt" "$STATE_DIR/vnc.passwd"
fi
: > "$LOG_DIR/session.log"
# AppImage bundles Electron but expects the host's standard Linux GUI libraries. Nix shells
# expose packages on PATH, not to the dynamic linker, so construct an explicit library path from
# the same configured nixpkgs used by the shell. This avoids nix-ld/system configuration changes.
NIX_GUI_LIBS=$(nix eval --impure --raw --expr 'with import <nixpkgs> {}; lib.makeLibraryPath [ glib gtk3 nss nspr atk at-spi2-atk cups dbus cairo pango libX11 libXcomposite libXdamage libXext libXfixes libXrandr libgbm expat libxcb libxkbcommon systemd alsa-lib at-spi2-core libdrm mesa ]')
nohup nix shell nixpkgs#xorg-server nixpkgs#x11vnc nixpkgs#novnc \
  nixpkgs#glib nixpkgs#gtk3 nixpkgs#nss nixpkgs#nspr nixpkgs#atk nixpkgs#at-spi2-atk \
  nixpkgs#cups nixpkgs#dbus nixpkgs#cairo nixpkgs#pango nixpkgs#libX11 \
  nixpkgs#libXcomposite nixpkgs#libXdamage nixpkgs#libXext nixpkgs#libXfixes \
  nixpkgs#libXrandr nixpkgs#libgbm nixpkgs#expat nixpkgs#libxcb \
  nixpkgs#libxkbcommon nixpkgs#systemd nixpkgs#alsa-lib nixpkgs#at-spi2-core \
  nixpkgs#libdrm nixpkgs#mesa --command env \
  "LD_LIBRARY_PATH=$NIX_GUI_LIBS${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}" \
  sh "$SCRIPT_DIR/session.sh" >> "$LOG_DIR/session.log" 2>&1 &
pid=$!
start=$(process_start_time "$pid")
printf '%s %s\n' "$pid" "$start" > "$PID_FILE"

i=0
while [ "$i" -lt 600 ]; do
  if ! owned_session_running; then
    echo "Headless launcher failed; see $LOG_DIR/session.log and $LOG_DIR/launcher.log" >&2
    exit 1
  fi
  if port_is_listening "$VNC_PORT" && port_is_listening "$NOVNC_PORT" \
    && [ -f "$RUNTIME_DIR/launcher.pid" ]; then
    echo "Headless launcher started (supervisor PID $pid)"
    echo "Tunnel: ssh -N -L $NOVNC_PORT:127.0.0.1:$NOVNC_PORT USER@HOST"
    echo "Open: http://127.0.0.1:$NOVNC_PORT/vnc.html?autoconnect=1&resize=scale"
    echo "VNC password: $STATE_DIR/vnc-password.txt"
    exit 0
  fi
  i=$((i + 1)); sleep 0.1
done
echo "Headless launcher did not become ready; see $LOG_DIR" >&2
exit 1
