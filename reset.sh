#!/bin/bash

echo "==> Killing NETH ORION processes..."

if pkill -9 -f "index.js|ddos.js" 2>/dev/null; then
    echo "    Processes terminated."
else
    echo "    No running processes found."
fi

echo "==> Removing saved state..."

if [ -f attackState.json ]; then
    rm -f attackState.json && echo "    State file removed."
else
    echo "    No state file to remove."
fi

echo "==> Reset complete."
