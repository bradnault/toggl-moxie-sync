#!/usr/bin/env bash
# Installs the toggl-moxie-sync launchd agent (runs every 3 hours). Idempotent.
set -euo pipefail
REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
AGENTS_DIR="$HOME/Library/LaunchAgents"
mkdir -p "$AGENTS_DIR" "$REPO_DIR/logs"
label="com.signalpath.toggl-moxie-sync"
target="$AGENTS_DIR/$label.plist"
template="$REPO_DIR/deploy/$label.plist.template"
if launchctl list "$label" >/dev/null 2>&1; then launchctl unload "$target" 2>/dev/null || true; fi
sed "s|__REPO_DIR__|$REPO_DIR|g" "$template" > "$target"
launchctl load "$target"
echo "Installed $label (every 3 hours)."
echo "Watch:    tail -f $REPO_DIR/logs/toggl-moxie-sync.out.log"
echo "Run now:  launchctl kickstart -k gui/\$(id -u)/$label"
