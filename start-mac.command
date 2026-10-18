#!/bin/bash
cd "$(dirname "$0")"
if ! command -v node >/dev/null 2>&1; then
  echo
  echo "  Node.js is not installed."
  echo "  Install the LTS version from https://nodejs.org, then double-click this file again."
  echo
  read -p "  Press Enter to close." _
  exit 1
fi
echo
echo "  Starting Dispatch Copilot..."
echo "  Your browser will open at http://localhost:8080"
echo "  Keep this window open while you use the app. Close it to stop the app."
echo
(sleep 3; open http://localhost:8080) &
node server.js
