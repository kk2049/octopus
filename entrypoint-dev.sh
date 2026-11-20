#!/bin/bash
set -e

# Start SSH server
/usr/sbin/sshd

echo "SSH server started on port 22"
echo "Starting Claude Bot..."

# Start bot
exec node --no-turbo-inline-js-wasm-calls --import tsx packages/bot/src/bootstrap-v3.ts
