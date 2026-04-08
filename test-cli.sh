#!/bin/bash

# Start the CLI in the background
bun run index.ts &
PID=$!

# Give it time to start
sleep 1

# Send some input
echo "/help" | nc localhost 3000 &
sleep 2

# Kill the background process
kill $PID 2>/dev/null || true
wait $PID 2>/dev/null || true
