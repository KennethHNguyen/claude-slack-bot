#!/bin/zsh
# Starts the bot. `caffeinate -i` keeps the Mac from idle-sleeping while the bot runs
# (it does not prevent sleep when a MacBook lid is closed without external power/display).
# Stop it with Ctrl-C, or DM the bot "shutdown".
set -euo pipefail
cd "$(dirname "$0")"

[[ -f config.json ]] || { print "config.json not found - run ./setup.sh first."; exit 1; }
[[ -d node_modules ]] || { print "Dependencies missing - run ./setup.sh first."; exit 1; }

# If you're behind a TLS-inspecting proxy, setup.sh exports its CA certificates here.
# macOS trusts them, but Node uses its own CA list, so point Node at them.
if [[ -s certs/proxy-ca.pem ]]; then
  export NODE_EXTRA_CA_CERTS="$PWD/certs/proxy-ca.pem"
fi

exec caffeinate -i npx tsx src/bot.ts
