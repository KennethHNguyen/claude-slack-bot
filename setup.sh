#!/bin/zsh
# One-time setup for the Claude Code Slack bot. Safe to re-run.
#  1. Checks prerequisites (macOS, Node 20+, Claude Code)
#  2. Installs dependencies
#  3. Detects a TLS-inspecting proxy and, if present, exports its CA so Node can reach Slack
#  4. Stores your Slack tokens in the macOS Keychain (hidden input) and verifies them with Slack
#  5. Creates config.json
#  6. Optionally runs a one-prompt Claude test
set -uo pipefail
cd "$(dirname "$0")"

SERVICE="claude-slack-bot"
ok()   { print "  ✓ $*"; }
warn() { print "  ! $*"; }
fail() { print "  ✗ $*"; exit 1; }

print "\n== 1/6 Checking prerequisites"
[[ "$(uname)" == "Darwin" ]] || fail "This bot is built for macOS."
command -v node >/dev/null || fail "Node.js not found. Install Node 20+ (e.g. 'brew install node' or nvm), then re-run."
node_major=$(node -p 'process.versions.node.split(".")[0]')
(( node_major >= 20 )) || fail "Node $(node -v) is too old - need 20 or newer."
ok "Node $(node -v)"
command -v claude >/dev/null && ok "Claude Code CLI found" \
  || warn "'claude' not found on PATH - make sure Claude Code is installed and works in your terminal."

print "\n== 2/6 Installing dependencies"
npm ci --no-audit --no-fund --loglevel=error || fail "npm install failed (see errors above)."
ok "Dependencies installed"

print "\n== 3/6 Checking for a TLS-inspecting proxy"
node_reaches_slack() { node -e "fetch('https://slack.com/api/api.test').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"; }
mkdir -p certs
if node_reaches_slack; then
  rm -f certs/proxy-ca.pem
  ok "Node can reach Slack directly - no proxy certificate needed"
else
  # Something between you and Slack is re-signing TLS. Export the issuing CAs it presents
  # (and their roots, from your Keychain) so Node trusts what macOS already trusts.
  : > certs/proxy-ca.pem
  chain=$(echo | openssl s_client -connect slack.com:443 -servername slack.com -showcerts 2>/dev/null)
  # Intermediate certificates presented by the proxy (everything after the leaf)
  print -r -- "$chain" | awk '/BEGIN CERTIFICATE/{n++} n>1' | awk '/BEGIN CERTIFICATE/,/END CERTIFICATE/' >> certs/proxy-ca.pem
  # Root(s): look up each issuer CN in the macOS keychains
  print -r -- "$chain" | grep -oE 'i:.*CN ?= ?[^,/]+' | sed -E 's/.*CN ?= ?//' | sort -u | while read -r cn; do
    for kc in /Library/Keychains/System.keychain /System/Library/Keychains/SystemRootCertificates.keychain ~/Library/Keychains/login.keychain-db; do
      security find-certificate -a -c "$cn" -p "$kc" >> certs/proxy-ca.pem 2>/dev/null && break
    done
  done
  if grep -q "BEGIN CERTIFICATE" certs/proxy-ca.pem && NODE_EXTRA_CA_CERTS="$PWD/certs/proxy-ca.pem" node_reaches_slack; then
    ok "Proxy detected - exported $(grep -c 'BEGIN CERTIFICATE' certs/proxy-ca.pem) CA certificate(s) to certs/proxy-ca.pem; Node can now reach Slack"
  else
    rm -f certs/proxy-ca.pem
    fail "Node can't reach slack.com. If you're behind a proxy, export its root CA (Keychain Access → right-click → Export, .pem) to certs/proxy-ca.pem and re-run."
  fi
fi
[[ -s certs/proxy-ca.pem ]] && export NODE_EXTRA_CA_CERTS="$PWD/certs/proxy-ca.pem"

print "\n== 4/6 Slack tokens (input is hidden; nothing appears as you paste)"
store_secret() {   # account label prefix
  local account="$1" label="$2" prefix="$3" value
  while true; do
    print -n "  Paste your ${label} (starts with ${prefix}): "
    read -rs value; print
    value="${value//[[:space:]]/}"
    [[ "$value" == ${prefix}* ]] && break
    warn "That doesn't start with ${prefix} - try again (copy only the token itself)."
  done
  # Feed the command through stdin so the token never appears in the process list.
  print -r -- "add-generic-password -U -s $SERVICE -a $account -w $value" | security -i >/dev/null \
    || fail "Couldn't save to Keychain."
}
check_bot() { curl -s -X POST https://slack.com/api/auth.test -H "Authorization: Bearer $(security find-generic-password -s $SERVICE -a bot-token -w 2>/dev/null)" | python3 -c 'import sys,json;d=json.load(sys.stdin);print("ok" if d.get("ok") else d.get("error","error"))'; }
check_app() { curl -s -X POST https://slack.com/api/apps.connections.open -H "Authorization: Bearer $(security find-generic-password -s $SERVICE -a app-token -w 2>/dev/null)" | python3 -c 'import sys,json;d=json.load(sys.stdin);print("ok" if d.get("ok") else d.get("error","error"))'; }

reuse=""
if security find-generic-password -s $SERVICE -a bot-token >/dev/null 2>&1 && security find-generic-password -s $SERVICE -a app-token >/dev/null 2>&1; then
  print -n "  Tokens are already saved. Keep them? [Y/n]: "; read -r reuse
fi
if [[ "$reuse" == [Nn]* || -z "$(security find-generic-password -s $SERVICE -a bot-token 2>/dev/null)" ]]; then
  store_secret bot-token "Bot User OAuth Token (OAuth & Permissions page)" "xoxb-"
  store_secret app-token "App-Level Token (Basic Information → App-Level Tokens)" "xapp-"
fi
r=$(check_bot); [[ "$r" == ok ]] && ok "Bot token accepted by Slack" || fail "Slack rejected the bot token ($r). Re-copy it from OAuth & Permissions and re-run ./setup.sh (answer 'n' to keep tokens)."
r=$(check_app); [[ "$r" == ok ]] && ok "App-level token accepted by Slack (Socket Mode)" || fail "Slack rejected the app-level token ($r). Make sure it has the connections:write scope, then re-run ./setup.sh."

print "\n== 5/6 Config"
if [[ -f config.json ]]; then
  ok "config.json already exists - leaving it unchanged"
else
  print -n "  Your Slack member ID (Slack → profile picture → Profile → ⋮ menu → Copy member ID; starts with U): "
  read -r uid; uid="${uid//[[:space:]]/}"
  [[ "$uid" == U* || "$uid" == W* ]] || fail "That doesn't look like a member ID (it should start with U)."
  print -n "  First name for the help text (e.g. Jane): "; read -r first
  python3 - "$uid" "${first:-your}" <<'EOF'
import json, os, sys
uid, first = sys.argv[1], sys.argv[2]
c = json.load(open("config.example.json"))
c["allowedSlackUserId"] = uid
c["botName"] = f"{first}'s Mac" if first != "your" else "your Mac"
c["defaultCwd"] = os.path.expanduser("~")
c["allowedRoots"] = [os.path.expanduser("~")]
json.dump(c, open("config.json", "w"), indent=2); open("config.json", "a").write("\n")
EOF
  ok "Created config.json (responds only to $uid)"
fi
mkdir -p logs && chmod 700 logs

print "\n== 6/6 Claude test (optional - sends one tiny prompt using your Claude Code login)"
print -n "  Run it now? [Y/n]: "; read -r t
if [[ "$t" != [Nn]* ]]; then
  node --input-type=module -e '
    import { query } from "@anthropic-ai/claude-agent-sdk";
    const q = query({ prompt: "Reply with exactly: CLAUDE OK", options: { cwd: process.env.HOME, maxTurns: 1, canUseTool: async () => ({ behavior: "deny", message: "test" }) } });
    for await (const m of q) {
      if (m.type === "system" && m.subtype === "init") console.log("  • model:", m.model);
      if (m.type === "result") { console.log(m.subtype === "success" ? "  ✓ Claude replied: " + m.result : "  ✗ Claude test failed: " + (m.errors || []).join("; ")); }
    }' || warn "Claude test didn't complete - check that 'claude' works in your terminal."
fi

print "\nSetup complete. Start the bot with:  ./start.sh"
print "Then in Slack: Apps → your Claude Code app → Messages → send 'help'.\n"
