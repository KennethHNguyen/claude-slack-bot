#!/bin/zsh
# Health check for the Claude Code Slack bot. Read-only; doesn't send any prompts to Claude.
# Usage: ./doctor.sh
cd "$(dirname "$0")"
SERVICE="claude-slack-bot"
pass() { print "  ✓ $*"; }
bad()  { print "  ✗ $*"; problems=$((problems+1)); }
note() { print "  ! $*"; }
problems=0

print "== Environment"
command -v node >/dev/null && (( $(node -p 'process.versions.node.split(".")[0]') >= 20 )) && pass "Node $(node -v)" || bad "Node 20+ is required"
[[ -d node_modules/@anthropic-ai/claude-agent-sdk && -d node_modules/@slack/bolt ]] && pass "Dependencies installed" || bad "Dependencies missing - run ./setup.sh"
command -v claude >/dev/null && pass "Claude Code CLI found" || note "'claude' not on PATH"
[[ -s certs/proxy-ca.pem ]] && pass "Proxy CA present (certs/proxy-ca.pem)" || note "No proxy CA (fine unless you're behind TLS inspection)"

print "== Slack"
[[ -s certs/proxy-ca.pem ]] && export NODE_EXTRA_CA_CERTS="$PWD/certs/proxy-ca.pem"
for a in bot-token app-token; do
  security find-generic-password -s $SERVICE -a $a >/dev/null 2>&1 && pass "$a in Keychain" || bad "$a missing from Keychain - run ./setup.sh"
done
r=$(curl -s -X POST https://slack.com/api/auth.test -H "Authorization: Bearer $(security find-generic-password -s $SERVICE -a bot-token -w 2>/dev/null)" | python3 -c 'import sys,json;d=json.load(sys.stdin);print("ok "+d.get("user","") if d.get("ok") else d.get("error","error"))' 2>/dev/null)
[[ "$r" == ok* ]] && pass "Bot token valid (bot user: ${r#ok })" || bad "Bot token rejected: $r"
r=$(curl -s -X POST https://slack.com/api/apps.connections.open -H "Authorization: Bearer $(security find-generic-password -s $SERVICE -a app-token -w 2>/dev/null)" | python3 -c 'import sys,json;d=json.load(sys.stdin);print("ok" if d.get("ok") else d.get("error","error"))' 2>/dev/null)
[[ "$r" == ok ]] && pass "App-level token valid (Socket Mode)" || bad "App-level token rejected: $r"
node -e "fetch('https://slack.com/api/api.test').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" && pass "Node can reach Slack" || bad "Node can't reach Slack (proxy?) - re-run ./setup.sh"

print "== Config"
if [[ -f config.json ]]; then
  python3 - <<'EOF'
import json
c = json.load(open("config.json"))
print(f"  ✓ Responds only to: {c.get('allowedSlackUserId')}")
print(f"  • Default mode: {c.get('permissionMode','default')} · MCP tools always ask: {c.get('mcpAlwaysAsk', True)}")
print(f"  • Allowed folders: {', '.join(c.get('allowedRoots', []))}")
if c.get("mcpWaitFor"): print(f"  • Waits for MCP servers: {', '.join(c['mcpWaitFor'])}")
EOF
else
  bad "config.json missing - run ./setup.sh"
fi

print "== Bot process"
if [[ -f logs/bot.pid ]] && kill -0 "$(cat logs/bot.pid)" 2>/dev/null; then
  pass "Bot is running (PID $(cat logs/bot.pid))"
else
  note "Bot is not running - start it with ./start.sh"
fi

print ""
(( problems == 0 )) && print "All checks passed." || print "$problems problem(s) found - see ✗ lines above."
