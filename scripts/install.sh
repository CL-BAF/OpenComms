#!/bin/sh
# OpenComms POSIX installer (macOS/Linux) - spec: Windows first (the exe's
# built-in wizard), then this script. A Node SEA binary cannot be
# cross-compiled: build on the TARGET OS first (npm install && npm run
# build:exe produces dist-opencomms/opencomms), then run this script:
#
#   sh scripts/install.sh dist-opencomms/opencomms
#
# It copies the binary into ~/.local/bin/opencomms and adds that directory
# to your PATH (idempotent). Uninstall: rm ~/.local/bin/opencomms and the
# PATH line from your shell rc.
set -eu

BIN="${1:-dist-opencomms/opencomms}"
DEST_DIR="${OPENCOMMS_INSTALL_DIR:-$HOME/.local/bin}"
DEST="$DEST_DIR/opencomms"

if [ ! -f "$BIN" ]; then
  echo "OpenComms installer: binary not found at '$BIN'." >&2
  echo "Build it on THIS platform first:" >&2
  echo "  npm install && npm run build:exe   # -> dist-opencomms/opencomms" >&2
  echo "then re-run: sh scripts/install.sh dist-opencomms/opencomms" >&2
  exit 1
fi

mkdir -p "$DEST_DIR"
cp "$BIN" "$DEST"
chmod +x "$DEST"

case ":$PATH:" in
  *":$DEST_DIR:"*) ;;
  *) PATH_LINE='export PATH="$HOME/.local/bin:$PATH"'
     for rc in "$HOME/.profile" "$HOME/.zshrc" "$HOME/.bashrc"; do
       if [ -f "$rc" ] && ! grep -q 'HOME/.local/bin' "$rc" 2>/dev/null; then
         printf '\n%s\n' "$PATH_LINE" >> "$rc"
         echo "Added ~/.local/bin to PATH via $rc"
       fi
     done
     ;;
esac

echo "Installed: $DEST"
echo "Next steps:"
echo "  opencomms version"
echo "  opencomms gui      # local console on http://127.0.0.1:4919 (loopback-only)"
echo "  opencomms doctor --project <dir>"
