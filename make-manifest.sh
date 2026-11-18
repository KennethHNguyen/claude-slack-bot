#!/bin/zsh
# Generates your personal Slack app manifest and copies it to the clipboard.
# Usage: ./make-manifest.sh            (asks for your first name)
#        ./make-manifest.sh Jane
set -euo pipefail
cd "$(dirname "$0")"

first="${1:-}"
if [[ -z "$first" ]]; then
  print -n "Your first name (used in the app name, e.g. Jane): "
  read -r first
fi
first="${first//[^A-Za-z0-9 -]/}"           # keep it simple and YAML-safe
[[ -z "$first" ]] && { print "✗ Name can't be empty."; exit 1; }
handle="${(L)first// /-}"                    # lowercase, spaces → dashes

sed -e "s/__FIRST__/${first}/" -e "s/__HANDLE__/${handle}/" slack-app-manifest.template.yaml > slack-app-manifest.yaml
pbcopy < slack-app-manifest.yaml

print "✓ Created slack-app-manifest.yaml for \"Claude Code - ${first}\" (bot name: claude-code-${handle})"
print "✓ Copied it to your clipboard - paste it at https://api.slack.com/apps → Create New App → From a manifest"
