#!/bin/bash

echo "==> Killing spawner (index.js)..."
if pkill -9 -f "index.js" 2>/dev/null; then
    echo "    index.js terminated."
else
    echo "    No index.js process found."
fi

echo "==> Killing attack process (ddos.js)..."
if pkill -9 -f "ddos.js" 2>/dev/null; then
    echo "    ddos.js terminated."
else
    echo "    No ddos.js process found."
fi

echo "==> Removing saved state..."
if [ -f attackState.json ]; then
    rm -f attackState.json && echo "    State file removed."
else
    echo "    No state file to remove."
fi

echo "==> Reset complete."
