#!/bin/sh
set -eu
. "$(dirname "$0")/common.sh"

record_state=$(session_record_state)
case "$record_state" in
  owned)
    echo "Stop the owned launcher session before reinstalling" >&2
    exit 1
    ;;
  foreign|invalid)
    foreign_session_message
    exit 1
    ;;
  stale) rm -f "$PID_FILE" ;;
esac

if [ "$(uname -s)" != Linux ] || [ "$(uname -m)" != x86_64 ]; then
  echo "The pinned launcher package requires Linux x86_64" >&2
  exit 1
fi
umask 077
mkdir -p "$APP_ROOT/app" "$STATE_DIR" "$RUNTIME_DIR" "$LOG_DIR" \
  "$CODEX_HOME" "$CODEX_CHATGPT_WEB_HOME" "$CODEX_WEB_GPT_LAUNCHER_DATA_DIR" \
  "$XDG_CONFIG_HOME" "$XDG_DATA_HOME" "$XDG_CACHE_HOME" "$XDG_RUNTIME_DIR"
chmod 0700 "$APP_ROOT" "$APP_ROOT/app" "$STATE_DIR" "$RUNTIME_DIR" "$LOG_DIR" \
  "$CODEX_HOME" "$CODEX_CHATGPT_WEB_HOME" "$CODEX_WEB_GPT_LAUNCHER_DATA_DIR" \
  "$XDG_CONFIG_HOME" "$XDG_DATA_HOME" "$XDG_CACHE_HOME" "$XDG_RUNTIME_DIR"

tmp=$(mktemp -d "${TMPDIR:-/tmp}/codex-web-gpt-headless.XXXXXX")
trap 'rm -rf "$tmp"' EXIT HUP INT TERM
base="https://github.com/miuuyy/codex-chatgpt-web/releases/download/v$APP_VERSION"
curl -fsSL --retry 3 --retry-all-errors --connect-timeout 15 --max-time 900 \
  "$base/$APP_ASSET" -o "$tmp/$APP_ASSET"
curl -fsSL --retry 3 --retry-all-errors --connect-timeout 15 --max-time 60 \
  "$base/checksums.txt" -o "$tmp/checksums.txt"
published=$(awk -v asset="$APP_ASSET" '$2 == asset { print $1 }' "$tmp/checksums.txt")
actual=$(sha256sum "$tmp/$APP_ASSET" | awk '{ print $1 }')
if [ "$published" != "$APP_SHA256" ] || [ "$actual" != "$APP_SHA256" ]; then
  echo "Pinned and published SHA-256 verification failed for $APP_ASSET" >&2
  exit 1
fi
chmod 0700 "$tmp/$APP_ASSET"
mkdir "$tmp/extract"
(
  cd "$tmp/extract"
  "$tmp/$APP_ASSET" --appimage-extract >/dev/null
)
runner=$(find "$tmp/extract/squashfs-root" -type f \
  -path '*/app.asar.unpacked/assets/linux-appimage-runner.sh' -print -quit)
if [ -z "$runner" ]; then
  echo "Verified AppImage does not contain its bounded Linux runner" >&2
  exit 1
fi
install -m 0700 "$tmp/$APP_ASSET" "$APPIMAGE.next"
mv -f "$APPIMAGE.next" "$APPIMAGE"
install -m 0700 "$runner" "$APPIMAGE_RUNNER.next"
mv -f "$APPIMAGE_RUNNER.next" "$APPIMAGE_RUNNER"
install -m 0600 "$tmp/checksums.txt" "$APP_ROOT/app/checksums-v$APP_VERSION.txt"
cat > "$APP_ROOT/PROVENANCE" <<PROVENANCE
repository=https://github.com/miuuyy/codex-chatgpt-web.git
release=v$APP_VERSION
revision=$UPSTREAM_REVISION
asset=$APP_ASSET
sha256=$APP_SHA256
PROVENANCE
chmod 0600 "$APP_ROOT/PROVENANCE"
echo "Installed verified v$APP_VERSION launcher at $APPIMAGE"
