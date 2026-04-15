#!/usr/bin/env bash
set -euo pipefail

OBSIDIAN_PATH="/Applications/Obsidian.app"

if [ ! -d "$OBSIDIAN_PATH" ]; then
  echo "Error: Obsidian not found at $OBSIDIAN_PATH"
  exit 1
fi

ELECTRON_VERSION=$(strings "$OBSIDIAN_PATH/Contents/Frameworks/Electron Framework.framework/Electron Framework" \
  | grep -oE 'Electron/[0-9.]+' | head -1 | cut -d/ -f2)

if [ -z "$ELECTRON_VERSION" ]; then
  echo "Could not detect Electron version from Obsidian. Specify manually:"
  echo "  npx @electron/rebuild --version <electron-version> --module-dir . --which-module node-pty --force"
  exit 1
fi

echo "Obsidian Electron version: $ELECTRON_VERSION"
echo "Rebuilding node-pty..."

npx @electron/rebuild \
  --version "$ELECTRON_VERSION" \
  --module-dir . \
  --which-module node-pty \
  --force

echo "Done. node-pty rebuilt for Electron $ELECTRON_VERSION"
