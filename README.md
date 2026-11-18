# Claude Code in Slack

Prompt **Claude Code running on your own Mac** from Slack, including from your phone. DM your own private bot; it runs the prompt through your local Claude Code (same login, settings, hooks, and MCP servers as your `claude` CLI) and replies in the thread. Risky actions show up as **Approve / Deny** buttons.

```
Phone or laptop (Slack DM) → Slack ← outbound Socket Mode connection ← your Mac → Claude Agent SDK → Claude Code
```

- **Personal by design.** Each person runs their own copy with their own Slack app. The bot ignores everyone except you and only works in your DM.
- **Nothing exposed.** No inbound ports, no public URL, no tunnel. Your Mac only makes an outbound WebSocket connection to Slack.
- **Your Claude Code, unchanged.** Built on the [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk), so your existing authentication, `~/.claude/settings.json`, managed settings, hooks, and MCP servers all apply.

> **Using a claude.ai plan?** Claude Code's built-in [Remote Control](https://code.claude.com/docs/en/remote-control) lets you drive a local session from the Claude mobile app with no setup. This project is mainly for setups where Remote Control isn't available, such as Claude Code configured with an API key or a cloud provider (Amazon Bedrock, Google Vertex AI, Microsoft Foundry).

> Not affiliated with or endorsed by Anthropic or Slack.

## Features

- **Threads are conversations.** Reply in a thread to continue; a new message starts a fresh session.
- **Warm sessions.** Each thread keeps one long-lived Claude Code process, so follow-ups are fast and MCP servers start once per thread.
- **Approvals in Slack.** Edits, shell commands, MCP tools, and reads outside your allowed folders post **Approve / Always (this thread) / Deny** buttons. Unanswered requests are denied after a timeout.
- **Auto mode.** Optionally let Claude Code's classifier approve safe actions. MCP tools can still be forced to ask (`mcpAlwaysAsk`).
- **Live progress.** A status message updates as Claude reads files and runs tools.
- **Hand off to your terminal.** `session` gives you the `claude --resume …` command for any Slack thread.
- **Guardrails.** Single-user allowlist, folder limits, idle auto-shutdown, single-instance lock, local audit log, and tokens stored in the macOS Keychain.
- **Works behind TLS-inspecting proxies.** Setup detects them and exports the proxy CA for Node.

## Requirements

- macOS
- **Xcode Command Line Tools** (provides `git` and `python3`; install with `xcode-select --install` if needed)
- **Claude Code** installed and working (`claude` answers in your terminal)
- **Node.js 20+** (`brew install node`)
- A Slack workspace where you can create apps (or request installation from an admin)

## Setup (about 20 minutes)

### 1. Get the code
```bash
git clone https://github.com/<you>/claude-slack-bot.git ~/claude-slack-bot
cd ~/claude-slack-bot
```

### 2. Create your Slack app
1. Run `./make-manifest.sh` and enter your first name. It generates your manifest and copies it to the clipboard.
2. Go to **https://api.slack.com/apps**, click **Create New App**, choose **From a manifest**, and pick your workspace.
3. On the **YAML** tab, paste, click **Next**, then **Create**.
4. Open **Basic Information**, scroll to **App-Level Tokens**, and click **Generate Token and Scopes**. Name it `socket`, add the scope **`connections:write`**, and click **Generate**. Copy the **`xapp-…`** token.
5. Open **Install App** and click **Install to Workspace**, then **Allow**.
   - If your workspace requires admin approval, click **Request to Install** instead and wait for approval. The notes below help with the request.
6. Copy the **Bot User OAuth Token** (**`xoxb-…`**) from **Install App** or **OAuth & Permissions**.
7. Get your **member ID**: in Slack, click your profile picture, then **Profile**, then the **⋮** menu, then **Copy member ID**. It starts with `U`.

<details>
<summary><b>Notes for an admin or security review</b></summary>

- **Scopes:** bot token `im:history` (read DMs sent to the bot) and `chat:write` (reply; edit and delete its own messages). App-level token `connections:write` (Socket Mode). No user token, no incoming webhooks, no channel access.
- **Network:** Socket Mode only, which is an outbound WebSocket from the user's machine. No public endpoint.
- **Access:** responds only to one configured Slack user ID, only in direct messages.
- **Data:** prompts and Claude's replies pass through the user's Slack DM. Claude Code may access whatever the user's local Claude Code can access (files, MCP tools); risky actions require explicit approval in Slack. A local audit log records prompts, approvals, and results.
</details>

### 3. Run setup
In Terminal (setup uses hidden input for tokens):
```bash
./setup.sh
```
It checks prerequisites, installs dependencies, handles proxy certificates if needed, stores both tokens in your **Keychain** and verifies them with Slack, creates `config.json`, and optionally sends one test prompt.

### 4. Start
```bash
./start.sh
```
In Slack, open **Apps**, then **Claude Code - YourName**, then **Messages**, and send **`help`**.

## Usage

| Command | What it does |
|---|---|
| *(any other message)* | Prompt Claude. Reply in the thread to continue. |
| `stop` | Interrupt the current run in this thread |
| `restart` | Restart this thread's Claude process (keeps the conversation) |
| `mode` / `mode auto` / `mode default` | Show or switch the approval mode for this thread |
| `session` | Show the `claude --resume …` command to continue this thread in your terminal |
| `pwd` / `cd <folder>` | Show or change the working folder (`cd` starts a new session) |
| `clear` | Delete the bot's messages in this thread |
| `cleanup` | Delete the bot's replies in threads whose first message you deleted |
| `status` | Show running threads and pending approvals |
| `shutdown` | Stop the bot |

**Keep the Mac reachable.** `start.sh` prevents idle sleep while the bot runs. The screen can lock. A closed MacBook lid without external power and display will still sleep, and the bot can't respond while the Mac is asleep.

## Configuration (`config.json`)

| Key | Default | Meaning |
|---|---|---|
| `allowedSlackUserId` | *(required)* | The only Slack user the bot responds to |
| `botName` | `your Mac` | Shown in `help` |
| `defaultCwd` | `~` | Starting folder for new threads |
| `allowedRoots` | `["~"]` | Folders where reads are auto-allowed and `cd` is permitted |
| `permissionMode` | `default` | Starting mode for new threads: `default` (ask) or `auto` (classifier) |
| `mcpAlwaysAsk` | `true` | MCP tools always require approval, even in auto mode |
| `mcpWaitFor` | `[]` | MCP server names to wait for (up to 60s) before a thread's first prompt, for servers that start slowly |
| `idleShutdownHours` | `8` | Bot exits after this long with no activity |
| `threadIdleMinutes` | `30` | A thread's Claude process closes after this long idle (the conversation is kept) |
| `approvalTimeoutMinutes` | `15` | Unanswered approvals are denied after this |

Restart the bot after editing.

## Security model

- **Single user.** Messages and button clicks from anyone other than `allowedSlackUserId` are ignored and logged.
- **Approvals.** Claude Code's permission system decides what needs approval; those requests go to Slack. "Always (this thread)" only adds allow rules for the current session and never changes modes or writes settings files.
- **Folder limits.** Read, Glob, and Grep are auto-allowed only inside `allowedRoots` (symlinks resolved). Narrow it to specific projects for tighter control.
- **Secrets.** Slack tokens are stored in the macOS Keychain (service `claude-slack-bot`) and never written to disk by the bot.
- **Audit log.** `logs/audit.jsonl` (mode 600) records prompts, tool approvals, and results. It may contain sensitive content; it grows until you delete it.
- **Data in Slack.** Claude's replies are posted to your DM, so treat anything you ask about as stored in Slack.
- **Your own policies apply.** Check your organization's rules for Slack apps and AI tools before using this at work.

## Troubleshooting

Run `./doctor.sh` first.

| Symptom | Fix |
|---|---|
| `bolt-app http request failed fetch failed` | A proxy is re-signing TLS. Re-run `./setup.sh` to export its CA. |
| Setup says `invalid_auth` | Re-copy only the `xoxb-` token, re-run `./setup.sh`, and answer **n** to keep tokens. |
| `Another bot instance is already running` | It's already running. Find that Terminal window or DM the bot `shutdown`. |
| *"Some MCP tools aren't available"* | Send `restart`. For slow-starting servers, add their names to `mcpWaitFor`. |
| No response | Check the Terminal window is still running and the Mac is awake. |
| Slack sessions missing from the VS Code Claude panel | Use `session` in the thread and run the command it gives you. |

## How it works

- **Slack:** [Bolt for JavaScript](https://slack.dev/bolt-js) in Socket Mode.
- **Claude:** the Claude Agent SDK's `query()` in streaming-input mode, with one long-lived process per thread. Permission prompts come through `canUseTool` and are rendered as Block Kit buttons.
- **MCP:** with `mcpAlwaysAsk`, the bot pins every configured MCP server to per-action approval via `setMcpPermissionModeOverride` (tighten-only).

## Uninstall

```bash
# Stop the bot (Ctrl-C or DM "shutdown"), then:
security delete-generic-password -s claude-slack-bot -a bot-token
security delete-generic-password -s claude-slack-bot -a app-token
rm -rf ~/claude-slack-bot
```
Then delete the app at **https://api.slack.com/apps**: open the app, then **Basic Information**, then **Delete App**.
