#!/usr/bin/env bash
set -euo pipefail

VAULT_PLUGIN_DIR="${GTFO_VAULT:-/Users/patrick.lynch/obsidian/gtfotest}/.obsidian/plugins/gtfo"
REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"

echo "Building plugin..."
cd "$REPO_DIR"
npm run build

echo "Linking to vault at: $VAULT_PLUGIN_DIR"
mkdir -p "$VAULT_PLUGIN_DIR"

for f in main.js manifest.json styles.css; do
  if [ -f "$REPO_DIR/$f" ]; then
    ln -sf "$REPO_DIR/$f" "$VAULT_PLUGIN_DIR/$f"
    echo "  linked $f"
  fi
done

# node-pty native module needs to be in node_modules/ for require() resolution
if [ -d "$REPO_DIR/node_modules/node-pty" ]; then
  mkdir -p "$VAULT_PLUGIN_DIR/node_modules"
  ln -sfn "$REPO_DIR/node_modules/node-pty" "$VAULT_PLUGIN_DIR/node_modules/node-pty"
  echo "  linked node-pty native module"
fi

echo ""
echo "Done. Now open the vault in Obsidian:"
echo "  1. Open Obsidian"
echo "  2. Open vault at: ${VAULT_PLUGIN_DIR%/.obsidian/plugins/gtfo}"
echo "  3. Settings > Community Plugins > Turn off Restricted Mode"
echo "  4. Enable 'Glean Tab For Obsidian'"
echo "  5. Reload Obsidian (Cmd+R) after each rebuild"
