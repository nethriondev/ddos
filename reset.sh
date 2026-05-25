#!/bin/bash

echo "==> Killing NETH ORION processes..."

if pkill -9 -f "index.js|ddos.js|spawn|child_process" 2>/dev/null; then
    echo "    Processes terminated."
else
    echo "    No running processes found."
fi

echo "==> Killing parent spawner..."
killall -9 node 2>/dev/null

echo "==> Removing saved state..."
rm -f attackState.json && echo "    State file removed."

echo "==> Reset complete."
tmux kill-session