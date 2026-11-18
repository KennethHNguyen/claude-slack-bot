/**
 * Claude Code Slack DM bot.
 *
 * DM the bot from Slack on your phone; it runs your prompt through Claude Code on this Mac
 * (via the Claude Agent SDK, using the same authentication, settings, hooks and MCP servers as
 * your `claude` CLI) and replies in the thread. Risky tool calls are sent to you as Approve / Deny buttons.
 *
 * Each Slack thread keeps ONE long-lived Claude Code process (streaming input mode), so MCP
 * servers start once per thread instead of on every prompt. A thread's
 * process is closed after `threadIdleMinutes` of inactivity; the next prompt resumes the same
 * conversation in a fresh process.
 *
 * Guardrails:
 *  - Only responds to ONE Slack user ID, only in direct messages.
 *  - Reads are auto-allowed only inside configured folders; everything else needs approval
 *    (or the auto-mode classifier, if the thread is in auto mode).
 *  - Unanswered approvals are denied after a timeout.
 *  - Idle auto-shutdown; "shutdown" command; local audit log.
 *  - Tokens are read from the macOS Keychain, never from files.
 */
import { App, type BlockAction, type ButtonAction } from "@slack/bolt";
import {
  query,
  type CanUseTool,
  type PermissionResult,
  type Query,
  type SDKMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

// ---------- config ----------
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

type BotMode = "default" | "auto";
type Config = {
  allowedSlackUserId: string;
  defaultCwd: string;
  allowedRoots: string[];
  idleShutdownHours: number;
  approvalTimeoutMinutes: number;
  /** Close a thread's Claude process after this many idle minutes (conversation is kept). */
  threadIdleMinutes: number;
  /** "default" = ask in Slack for risky actions; "auto" = classifier decides, asks only when unsure. */
  permissionMode: BotMode;
  /** MCP tools always ask for approval, even in auto mode. */
  mcpAlwaysAsk: boolean;
  /** MCP servers to wait for (up to 60s) before the first prompt in a thread, so their tools are ready. */
  mcpWaitFor: string[];
  /** Shown in the help text, e.g. "Jane's Mac". */
  botName: string;
};

function loadConfig(): Config {
  const file = path.join(ROOT, "config.json");
  if (!existsSync(file)) throw new Error("config.json not found - run ./setup.sh first");
  const c = JSON.parse(readFileSync(file, "utf8")) as Partial<Config>;
  if (!c.allowedSlackUserId || !/^[UW][A-Z0-9]+$/.test(c.allowedSlackUserId)) {
    throw new Error("config.json: allowedSlackUserId is not set");
  }
  const allowedRoots = (c.allowedRoots ?? [homedir()]).map((r) => realpathSync(expandHome(r)));
  const defaultCwd = realpathSync(expandHome(c.defaultCwd ?? homedir()));
  if (!isInsideRoots(defaultCwd, allowedRoots)) throw new Error("config.json: defaultCwd must be inside allowedRoots");
  return {
    allowedSlackUserId: c.allowedSlackUserId,
    allowedRoots,
    defaultCwd,
    idleShutdownHours: c.idleShutdownHours ?? 8,
    approvalTimeoutMinutes: c.approvalTimeoutMinutes ?? 15,
    threadIdleMinutes: c.threadIdleMinutes ?? 30,
    permissionMode: c.permissionMode === "auto" ? "auto" : "default",
    mcpAlwaysAsk: c.mcpAlwaysAsk !== false,
    mcpWaitFor: Array.isArray(c.mcpWaitFor) ? c.mcpWaitFor.filter((x): x is string => typeof x === "string") : [],
    botName: c.botName?.trim() || "your Mac",
  };
}

function expandHome(p: string): string {
  return p === "~" || p.startsWith("~/") ? path.join(homedir(), p.slice(1)) : p;
}

function isInsideRoots(p: string, roots: string[]): boolean {
  let abs = path.resolve(p);
  try {
    abs = realpathSync(abs); // follow symlinks so a link inside a root can't point outside it
  } catch {
    /* path doesn't exist yet - check it as written */
  }
  return roots.some((r) => abs === r || abs.startsWith(r + path.sep));
}

function keychain(account: string): string {
  try {
    return execFileSync("security", ["find-generic-password", "-s", "claude-slack-bot", "-a", account, "-w"], {
      encoding: "utf8",
    }).trim();
  } catch {
    throw new Error(`Keychain item "${account}" not found - run ./setup.sh first`);
  }
}

const config = loadConfig();

// ---------- audit log ----------
const LOG_DIR = path.join(ROOT, "logs");
mkdirSync(LOG_DIR, { recursive: true, mode: 0o700 });
function audit(event: string, data: Record<string, unknown>) {
  const line = JSON.stringify({ ts: new Date().toISOString(), event, ...data });
  appendFileSync(path.join(LOG_DIR, "audit.jsonl"), line + "\n", { mode: 0o600 });
}

// ---------- single instance ----------
// Two bots on the same Socket Mode app would split Slack events between them (and button clicks
// could reach the instance that doesn't own the approval), so refuse to start a second one.
const PID_FILE = path.join(LOG_DIR, "bot.pid");
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
if (existsSync(PID_FILE)) {
  const other = Number(readFileSync(PID_FILE, "utf8").trim());
  if (other && other !== process.pid && isAlive(other)) {
    console.error(`Another bot instance is already running (PID ${other}). Stop it first (Ctrl-C in its terminal, or DM the bot "shutdown").`);
    process.exit(1);
  }
}
writeFileSync(PID_FILE, String(process.pid), { mode: 0o600 });
function removePidFile() {
  try {
    if (readFileSync(PID_FILE, "utf8").trim() === String(process.pid)) unlinkSync(PID_FILE);
  } catch {
    /* already gone */
  }
}

// ---------- slack app ----------
const app = new App({
  token: keychain("bot-token"),
  appToken: keychain("app-token"),
  socketMode: true,
});

let lastActivity = Date.now();
const SLACK_CHUNK = 3500;
const READ_ONLY_TOOLS = new Set(["Read", "Glob", "Grep"]);
const MCP_WAIT_MS = 60_000; // max wait for `mcpWaitFor` servers to finish starting on a cold start

// ---------- formatting helpers ----------
function toMrkdwn(s: string): string {
  return s
    .replace(/\*\*(.+?)\*\*/g, "*$1*")
    .replace(/^#{1,6}\s+(.+)$/gm, "*$1*")
    .replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, "<$2|$1>");
}

function chunks(s: string, size = SLACK_CHUNK): string[] {
  const out: string[] = [];
  let rest = s;
  while (rest.length > size) {
    let cut = rest.lastIndexOf("\n", size);
    if (cut < size / 2) cut = size;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest.trim()) out.push(rest);
  return out;
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + "…" : s;
}

function describeTool(name: string, input: Record<string, unknown>): string {
  if (name === "Bash") return "`$ " + truncate(String(input.command ?? ""), 150) + "`";
  if (typeof input.file_path === "string") return `${name} \`${input.file_path}\``;
  if (typeof input.pattern === "string") return `${name} \`${truncate(input.pattern, 80)}\``;
  if (typeof input.url === "string") return `${name} ${input.url}`;
  return name;
}

function toolPaths(name: string, input: Record<string, unknown>, cwd: string): string[] {
  if (name === "Read") return [String(input.file_path ?? "")];
  if (name === "Glob" || name === "Grep") return [typeof input.path === "string" ? input.path : cwd];
  return [];
}

// ---------- approvals ----------
type CanUseToolSuggestions = Parameters<CanUseTool>[2]["suggestions"];
type PendingApproval = { resolve: (r: PermissionResult) => void; suggestions?: CanUseToolSuggestions };
const pendingApprovals = new Map<string, PendingApproval>();

function makeCanUseTool(channel: string, threadTs: string, cwd: string): CanUseTool {
  return async (toolName, input, { signal, suggestions, decisionReason }) => {
    if (toolName === "AskUserQuestion") {
      return { behavior: "deny", message: "Interactive questions aren't supported over Slack. Ask in plain text instead." };
    }

    if (READ_ONLY_TOOLS.has(toolName)) {
      const paths = toolPaths(toolName, input, cwd);
      if (paths.length && paths.every((p) => p && isInsideRoots(path.resolve(cwd, p), config.allowedRoots))) {
        audit("auto_allow", { toolName, input });
        return { behavior: "allow", updatedInput: input };
      }
    }

    const id = randomUUID();
    const detail = "```" + truncate(JSON.stringify(input, null, 2), 2500) + "```";
    const reason = decisionReason ? `\n_${truncate(decisionReason, 300)}_` : "";
    audit("approval_requested", { id, threadTs, toolName, input });

    const msg = await app.client.chat.postMessage({
      channel,
      thread_ts: threadTs,
      text: `Approval needed: ${toolName}`,
      blocks: [
        { type: "section", text: { type: "mrkdwn", text: `:raised_hand: *Approval needed:* ${describeTool(toolName, input)}${reason}` } },
        { type: "section", text: { type: "mrkdwn", text: detail } },
        {
          type: "actions",
          elements: [
            { type: "button", text: { type: "plain_text", text: "Approve" }, style: "primary", action_id: "perm_allow", value: id },
            { type: "button", text: { type: "plain_text", text: "Always (this thread)" }, action_id: "perm_always", value: id },
            { type: "button", text: { type: "plain_text", text: "Deny" }, style: "danger", action_id: "perm_deny", value: id },
          ],
        },
      ],
    });

    return new Promise<PermissionResult>((resolve) => {
      const finish = (r: PermissionResult, note: string) => {
        if (!pendingApprovals.has(id)) return;
        pendingApprovals.delete(id);
        clearTimeout(timer);
        audit("approval_result", { id, toolName, behavior: r.behavior, note });
        if (msg.ts) {
          app.client.chat
            .update({
              channel,
              ts: msg.ts,
              text: `${toolName}: ${note}`,
              blocks: [{ type: "section", text: { type: "mrkdwn", text: `${describeTool(toolName, input)} — *${note}*` } }],
            })
            .catch(() => {});
        }
        resolve(r);
      };
      const timer = setTimeout(
        () => finish({ behavior: "deny", message: "No approval received in time." }, "timed out (denied)"),
        config.approvalTimeoutMinutes * 60_000,
      );
      signal.addEventListener("abort", () => finish({ behavior: "deny", message: "Interrupted." }, "cancelled"), { once: true });
      pendingApprovals.set(id, {
        suggestions,
        resolve: (r) => finish(r, r.behavior === "allow" ? "approved" : "denied"),
      });
    });
  };
}

app.action<BlockAction>(/^perm_(allow|always|deny)$/, async ({ ack, body, action }) => {
  await ack();
  if (body.user.id !== config.allowedSlackUserId) return;
  const btn = action as ButtonAction;
  const pending = pendingApprovals.get(btn.value ?? "");
  if (!pending) return;
  lastActivity = Date.now();
  if (btn.action_id === "perm_deny") {
    pending.resolve({ behavior: "deny", message: "The user denied this action from Slack." });
  } else if (btn.action_id === "perm_always") {
    // Remember for this session only - never write rules to settings files.
    const updatedPermissions = (pending.suggestions ?? [])
      .filter((s) => s.type === "addRules" && s.behavior === "allow")
      .map((s) => ({ ...s, destination: "session" as const }));
    pending.resolve({ behavior: "allow", updatedPermissions });
  } else {
    pending.resolve({ behavior: "allow" });
  }
});

// ---------- per-thread long-lived Claude session ----------
/** Async iterable the SDK reads user messages from; stays open so the process stays warm. */
function makeInput() {
  const buf: SDKUserMessage[] = [];
  let wake: (() => void) | null = null;
  let closed = false;
  async function* iter(): AsyncGenerator<SDKUserMessage> {
    while (true) {
      while (buf.length) yield buf.shift()!;
      if (closed) return;
      await new Promise<void>((r) => (wake = r));
      wake = null;
    }
  }
  return {
    iter: iter(),
    push(text: string) {
      buf.push({ type: "user", message: { role: "user", content: text }, parent_tool_use_id: null });
      wake?.();
    },
    close() {
      closed = true;
      wake?.();
    },
  };
}

type Turn = {
  onMessage: (m: SDKMessage) => void | Promise<void>;
  done: (err?: unknown) => void;
};

class ThreadSession {
  sessionId?: string;
  cwd = config.defaultCwd;
  mode: BotMode = config.permissionMode;
  private q?: Query;
  private input?: ReturnType<typeof makeInput>;
  private abort?: AbortController;
  private turn?: Turn;
  private idleTimer?: NodeJS.Timeout;
  private mcpWarned = false;

  constructor(readonly channel: string, readonly threadTs: string) {}

  get busy() {
    return !!this.turn;
  }
  get warm() {
    return !!this.q;
  }

  private start() {
    this.input = makeInput();
    this.abort = new AbortController();
    this.mcpWarned = false;
    this.q = query({
      prompt: this.input.iter,
      options: {
        cwd: this.cwd,
        resume: this.sessionId,
        abortController: this.abort,
        permissionMode: this.mode,
        canUseTool: makeCanUseTool(this.channel, this.threadTs, this.cwd),
        disallowedTools: ["AskUserQuestion"],
      },
    });
    if (config.mcpAlwaysAsk) void this.applyMcpOverrides(this.q);
    audit("process_start", { threadTs: this.threadTs, cwd: this.cwd, resume: this.sessionId ?? null, mode: this.mode, mcpAlwaysAsk: config.mcpAlwaysAsk });
    void this.pump(this.q);
  }

  /** Reads every message from the long-lived process and routes it to the current turn. */
  private async pump(q: Query) {
    let error: unknown;
    try {
      for await (const m of q) {
        if (m.type === "system" && m.subtype === "init") this.sessionId = m.session_id;
        if (m.type === "result") this.sessionId = m.session_id;
        await this.turn?.onMessage(m);
        if (m.type === "result") {
          const t = this.turn;
          this.turn = undefined;
          t?.done();
          this.armIdleTimer();
        }
      }
    } catch (err) {
      error = err;
    }
    // Process ended (closed, idle, aborted, or crashed).
    if (this.q === q) {
      this.q = undefined;
      this.input = undefined;
      this.abort = undefined;
    }
    const t = this.turn;
    this.turn = undefined;
    t?.done(error ?? new Error("Claude process exited"));
    audit("process_end", { threadTs: this.threadTs, error: error ? String(error) : null });
  }

  private armIdleTimer() {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      if (!this.busy && this.q) {
        audit("process_idle_close", { threadTs: this.threadTs });
        this.close();
      }
    }, config.threadIdleMinutes * 60_000);
    this.idleTimer.unref();
  }

  /** Send one prompt and resolve when its result arrives. */
  async send(text: string, onMessage: Turn["onMessage"]): Promise<void> {
    if (this.turn) throw new Error("busy");
    clearTimeout(this.idleTimer);
    const done = new Promise<void>((resolve, reject) => {
      this.turn = { onMessage, done: (err) => (err ? reject(err) : resolve()) };
    });
    if (!this.q) {
      this.start();
      await this.waitForMcp();
    }
    if (!this.input) return done; // process exited during startup - pump() has already rejected `done`
    this.input.push(text);
    return done;
  }

  /**
   * Tighten-only: in auto mode, route every MCP tool call to Slack approval instead of the classifier.
   * Overrides are stored by server name and apply once that server connects.
   */
  private async applyMcpOverrides(q: Query) {
    for (let i = 0; i < 10 && this.q === q; i++) {
      try {
        const servers = await q.mcpServerStatus();
        for (const srv of servers) await q.setMcpPermissionModeOverride(srv.name, "default");
        audit("mcp_overrides", { threadTs: this.threadTs, servers: servers.map((x) => x.name) });
        return;
      } catch {
        await new Promise((r) => setTimeout(r, 1000)); // process still initialising
      }
    }
    audit("mcp_override_failed", { threadTs: this.threadTs });
  }

  /** On a cold start, wait until the `mcpWaitFor` servers have finished starting so the first prompt can use their tools. */
  private async waitForMcp() {
    if (!config.mcpWaitFor.length) return;
    const t0 = Date.now();
    while (this.q && Date.now() - t0 < MCP_WAIT_MS) {
      try {
        const servers = await this.q.mcpServerStatus();
        const pending = config.mcpWaitFor.filter((n) => servers.find((x) => x.name === n)?.status === "pending");
        if (!pending.length) {
          audit("mcp_ready", { threadTs: this.threadTs, waited_ms: Date.now() - t0 });
          return;
        }
      } catch {
        /* process still initialising */
      }
      await new Promise((r) => setTimeout(r, 1500));
    }
    audit("mcp_wait_timeout", { threadTs: this.threadTs, waited_ms: Date.now() - t0 });
  }

  async interrupt() {
    if (!this.q) return;
    await this.q.interrupt().catch(() => this.abort?.abort());
  }

  async setMode(mode: BotMode) {
    this.mode = mode;
    if (this.q) await this.q.setPermissionMode(mode).catch(() => {});
  }

  /** Returns a warning if an MCP server failed, needs auth, or (for `mcpWaitFor` servers) has no tools. */
  async mcpProblem(): Promise<string | undefined> {
    if (!this.q || this.mcpWarned) return;
    try {
      const problems: string[] = [];
      for (const srv of await this.q.mcpServerStatus()) {
        if (srv.status === "failed") problems.push(`\`${srv.name}\` failed to start${srv.error ? ` (${truncate(srv.error, 160)})` : ""}`);
        else if (srv.status === "needs-auth") problems.push(`\`${srv.name}\` needs authentication`);
        else if (srv.status === "connected" && config.mcpWaitFor.includes(srv.name) && !(srv.tools?.length ?? 0)) {
          problems.push(`\`${srv.name}\` is connected but has no tools`);
        }
      }
      if (!problems.length) return;
      this.mcpWarned = true;
      audit("mcp_problem", { threadTs: this.threadTs, problems });
      return problems.join("; ");
    } catch {
      return;
    }
  }

  /** Stop the process but keep the conversation (next prompt resumes it). */
  close() {
    clearTimeout(this.idleTimer);
    const q = this.q;
    this.input?.close();
    this.q = undefined;
    this.input = undefined;
    this.abort = undefined;
    q?.close();
  }
}

const threads = new Map<string, ThreadSession>();

// ---------- running a prompt ----------
async function runPrompt(s: ThreadSession, prompt: string) {
  const { channel, threadTs } = s;
  const coldStart = !s.warm;
  const status = await app.client.chat.postMessage({
    channel,
    thread_ts: threadTs,
    text: coldStart ? ":hourglass_flowing_sand: Starting Claude…" : ":hourglass_flowing_sand: Working…",
  });
  const steps: string[] = [];
  let lastUpdate = 0;
  const recent = () => (steps.length ? "\n" + steps.slice(-6).map((x) => "• " + x).join("\n") : "");
  const updateStatus = async () => {
    if (!status.ts || Date.now() - lastUpdate < 2500) return;
    lastUpdate = Date.now();
    await app.client.chat.update({ channel, ts: status.ts, text: ":hourglass_flowing_sand: Working…" + recent() }).catch(() => {});
  };

  audit("prompt", { threadTs, cwd: s.cwd, mode: s.mode, warm: !coldStart, resume: s.sessionId ?? null, prompt });

  let finalText = "";
  let footer = "";
  try {
    await s.send(prompt, async (m) => {
      if (m.type === "assistant" && m.parent_tool_use_id === null) {
        for (const block of m.message.content) {
          if (block.type === "tool_use") {
            steps.push(describeTool(block.name, block.input as Record<string, unknown>));
            await updateStatus();
          }
        }
      } else if (m.type === "result") {
        const secs = Math.round(m.duration_ms / 1000);
        if (m.subtype === "success") {
          finalText = m.result;
          footer = `:white_check_mark: Done in ${secs}s · ${m.num_turns} turns · ${s.mode} mode${coldStart ? "" : " · warm"}`;
        } else {
          finalText = m.errors?.join("\n") || "The run ended with an error.";
          footer = `:warning: Stopped (${m.subtype}) after ${secs}s`;
        }
        audit("result", { threadTs, subtype: m.subtype, turns: m.num_turns, duration_ms: m.duration_ms });
      }
    });
  } catch (err) {
    footer = ":x: The Claude process stopped unexpectedly.";
    finalText = String(err instanceof Error ? err.message : err);
    audit("error", { threadTs, error: String(err) });
  }

  if (status.ts) await app.client.chat.update({ channel, ts: status.ts, text: footer + recent() }).catch(() => {});
  for (const part of chunks(toMrkdwn(finalText || "_(no text output)_"))) {
    await app.client.chat.postMessage({ channel, thread_ts: threadTs, text: part });
  }

  const problem = await s.mcpProblem();
  if (problem) {
    await app.client.chat.postMessage({
      channel,
      thread_ts: threadTs,
      text:
        `:warning: *Some MCP tools aren't available in this thread:* ${problem}. ` +
        "Send `restart` to start a fresh process (the conversation is kept), then resend your question.",
    });
  }
}

// ---------- message cleanup (bot's own messages only) ----------
let botUserId = "";
let botId = "";

type SlackMsg = { ts?: string; user?: string; bot_id?: string; subtype?: string; reply_count?: number; thread_ts?: string };
const isMine = (m: SlackMsg) => !!m.ts && ((!!botId && m.bot_id === botId) || (!!botUserId && m.user === botUserId));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function threadReplies(channel: string, ts: string): Promise<SlackMsg[]> {
  const out: SlackMsg[] = [];
  let cursor: string | undefined;
  do {
    const r = await app.client.conversations.replies({ channel, ts, cursor, limit: 200 });
    out.push(...((r.messages ?? []) as SlackMsg[]));
    cursor = r.response_metadata?.next_cursor || undefined;
  } while (cursor);
  return out;
}

/** Deletes the bot's own messages in one thread. Returns how many were deleted. */
async function deleteBotMessagesInThread(channel: string, ts: string): Promise<number> {
  let n = 0;
  for (const m of await threadReplies(channel, ts)) {
    if (!isMine(m)) continue;
    try {
      await app.client.chat.delete({ channel, ts: m.ts! });
      n++;
      await sleep(300); // stay well under chat.delete rate limits
    } catch (err) {
      audit("delete_failed", { channel, ts: m.ts, error: String(err) });
    }
  }
  return n;
}

/** Finds threads whose first message was deleted ("This message was deleted.") and removes the bot's replies. */
async function cleanupDeletedThreads(channel: string): Promise<{ threads: number; deleted: number; yours: number }> {
  let cursor: string | undefined;
  let threadsFound = 0;
  let deleted = 0;
  let yours = 0;
  do {
    const r = await app.client.conversations.history({ channel, cursor, limit: 200 });
    for (const m of (r.messages ?? []) as SlackMsg[]) {
      if (m.subtype !== "tombstone" || !m.ts) continue;
      const busy = threads.get(m.ts)?.busy;
      if (busy) continue;
      threadsFound++;
      threads.get(m.ts)?.close();
      threads.delete(m.ts);
      deleted += await deleteBotMessagesInThread(channel, m.ts);
      yours += (await threadReplies(channel, m.ts)).filter((x) => x.ts !== m.ts && !isMine(x)).length;
    }
    cursor = r.response_metadata?.next_cursor || undefined;
  } while (cursor);
  return { threads: threadsFound, deleted, yours };
}

/** Posts a short notice that removes itself after a delay, so cleanup doesn't leave new clutter behind. */
async function sayTemporarily(channel: string, threadTs: string | undefined, text: string, ms = 20_000) {
  const r = await app.client.chat.postMessage({ channel, thread_ts: threadTs, text });
  if (r.ts) setTimeout(() => app.client.chat.delete({ channel, ts: r.ts! }).catch(() => {}), ms).unref();
}

// ---------- commands ----------
const HELP = [
  `*Claude Code on ${config.botName}*`,
  "Send any message to prompt Claude. Reply in a thread to continue that conversation; a new top-level message starts a fresh session.",
  "*Commands* (send as the whole message):",
  "• `stop` - interrupt the run in this thread",
  "• `restart` - restart this thread's Claude process (keeps the conversation; use if MCP tools didn't load)",
  "• `pwd` - show this thread's working folder",
  "• `cd <folder>` - change this thread's working folder (must be inside allowed folders; starts a new session)",
  "• `mode` / `mode auto` / `mode default` - show or switch approval mode for this thread",
  "• `session` - show this thread's session ID and the command to open it on the Mac",
  "• `clear` - delete the bot's messages in this thread (then delete yours to remove the thread entirely)",
  "• `cleanup` - for threads whose first message you deleted, delete the bot's replies so the thread can disappear",
  "• `status` - show running threads",
  "• `shutdown` - stop the bot on the Mac",
  "• `help` - this message",
].join("\n");

async function handleCommand(text: string, s: ThreadSession): Promise<boolean> {
  const say = (t: string) => app.client.chat.postMessage({ channel: s.channel, thread_ts: s.threadTs, text: t });
  const [cmd, ...rest] = text.trim().split(/\s+/);
  switch (cmd.toLowerCase()) {
    case "help":
      await say(HELP);
      return true;
    case "stop":
      if (s.busy) {
        await s.interrupt();
        await say(":octagonal_sign: Interrupting…");
      } else await say("Nothing is running in this thread.");
      return true;
    case "restart":
      if (s.busy) {
        await say("A prompt is still running - send `stop` first.");
        return true;
      }
      s.close();
      audit("process_restart", { threadTs: s.threadTs });
      await say(":arrows_counterclockwise: Restarted. Your next message starts a fresh Claude process and continues this conversation.");
      return true;
    case "pwd":
      await say("`" + s.cwd + "`");
      return true;
    case "cd": {
      const target = path.resolve(s.cwd, expandHome(rest.join(" ") || "~"));
      let real: string;
      try {
        real = realpathSync(target);
        if (!statSync(real).isDirectory()) throw new Error();
      } catch {
        await say(`:x: Not a folder: \`${target}\``);
        return true;
      }
      if (!isInsideRoots(real, config.allowedRoots)) {
        await say(":no_entry: That folder is outside the allowed folders in config.json.");
        return true;
      }
      if (s.busy) {
        await say("Wait for the current run to finish (or `stop` it) before changing folders.");
        return true;
      }
      s.close();
      s.cwd = real;
      s.sessionId = undefined; // sessions are tied to a folder; start fresh
      await say(`:file_folder: Now in \`${real}\` (new session).`);
      return true;
    }
    case "mode": {
      const want = (rest[0] ?? "").toLowerCase();
      if (!want) {
        await say(
          `This thread is in *${s.mode}* mode.\n• \`default\`: you approve risky actions in Slack\n• \`auto\`: a classifier approves safe actions and blocks risky ones; you're asked only when it can't decide`,
        );
        return true;
      }
      if (want !== "auto" && want !== "default") {
        await say("Usage: `mode auto` or `mode default`");
        return true;
      }
      await s.setMode(want);
      audit("mode_change", { threadTs: s.threadTs, mode: want });
      await say(
        want === "auto"
          ? ":robot_face: *Auto mode* for this thread. Safe actions run without asking; risky ones are blocked or sent to you." +
              (config.mcpAlwaysAsk ? " MCP tools still ask for approval." : "") +
              " Note: reads outside your allowed folders may be auto-approved in this mode."
          : ":raised_hand: *Default mode* for this thread. Risky actions will ask for your approval.",
      );
      return true;
    }
    case "session":
      if (!s.sessionId) {
        await say("No session yet in this thread - send a prompt first.");
      } else {
        await say(
          `*Session:* \`${s.sessionId}\`\n*Folder:* \`${s.cwd}\`\n` +
            "Open it on the Mac (VS Code terminal or any terminal):\n" +
            "```cd " + JSON.stringify(s.cwd) + " && claude --resume " + s.sessionId + "```\n" +
            "_Don't continue the same session from Slack and the Mac at the same time._",
        );
      }
      return true;
    case "status": {
      const all = [...threads.values()];
      await say(
        `${all.filter((t) => t.busy).length} running · ${all.filter((t) => t.warm).length} warm process(es) · ` +
          `${pendingApprovals.size} pending approval(s) · ${all.length} thread(s) this session`,
      );
      return true;
    }
    case "clear": {
      if (s.busy) {
        await say("A prompt is still running in this thread - send `stop` first.");
        return true;
      }
      s.close();
      threads.delete(s.threadTs);
      const n = await deleteBotMessagesInThread(s.channel, s.threadTs);
      audit("clear_thread", { threadTs: s.threadTs, deleted: n });
      await sayTemporarily(
        s.channel,
        s.threadTs,
        `:broom: Deleted ${n} bot message(s) in this thread. Delete your own messages here (including this \`clear\`) and the thread disappears. _This note removes itself in 20s._`,
      );
      return true;
    }
    case "cleanup": {
      await say(":broom: Looking for threads whose first message was deleted…");
      const r = await cleanupDeletedThreads(s.channel);
      audit("cleanup", r);
      const tail =
        r.yours > 0
          ? `\n${r.yours} of *your* message(s) remain in those threads - delete them (hover → ⋯ → Delete) and the "This message was deleted" placeholders will disappear.`
          : r.threads > 0
            ? "\nThose placeholders should now be gone."
            : "";
      await say(`Found ${r.threads} deleted-parent thread(s); deleted ${r.deleted} bot message(s).${tail}`);
      return true;
    }
    case "shutdown":
      await say(":wave: Shutting down the bot on the Mac.");
      audit("shutdown", { by: "slack" });
      await shutdown();
      return true;
    default:
      return false;
  }
}

// ---------- message entry point ----------
app.message(async ({ message }) => {
  if (message.channel_type !== "im" || message.subtype !== undefined) return;
  if (!("user" in message) || message.user !== config.allowedSlackUserId) {
    audit("rejected_user", { user: "user" in message ? message.user : null });
    return;
  }
  const text = (message.text ?? "").trim();
  if (!text) return;
  lastActivity = Date.now();

  const threadTs = message.thread_ts ?? message.ts;
  let s = threads.get(threadTs);
  if (!s) {
    s = new ThreadSession(message.channel, threadTs);
    threads.set(threadTs, s);
  }

  if (await handleCommand(text, s)) return;

  if (s.busy) {
    await app.client.chat.postMessage({
      channel: message.channel,
      thread_ts: threadTs,
      text: "Still working on the previous prompt in this thread. Send `stop` to interrupt, or start a new top-level message.",
    });
    return;
  }

  runPrompt(s, text).catch((err) => {
    audit("error", { threadTs, error: String(err) });
    app.client.chat.postMessage({ channel: message.channel, thread_ts: threadTs, text: `:x: ${String(err)}` }).catch(() => {});
  });
});

// ---------- lifecycle ----------
async function shutdown() {
  for (const p of pendingApprovals.values()) p.resolve({ behavior: "deny", message: "Bot shutting down." });
  for (const s of threads.values()) s.close();
  await app.stop().catch(() => {});
  removePidFile();
  process.exit(0);
}

setInterval(() => {
  const busy = [...threads.values()].some((s) => s.busy) || pendingApprovals.size > 0;
  if (!busy && Date.now() - lastActivity > config.idleShutdownHours * 3_600_000) {
    console.log(`Idle for ${config.idleShutdownHours}h - shutting down.`);
    audit("shutdown", { by: "idle" });
    void shutdown();
  }
}, 60_000).unref();

process.on("unhandledRejection", (err) => audit("unhandled_rejection", { error: String(err) }));
process.on("exit", removePidFile);
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());

await app.start();
try {
  const who = await app.client.auth.test();
  botUserId = who.user_id ?? "";
  botId = who.bot_id ?? "";
} catch (err) {
  audit("auth_test_failed", { error: String(err) });
}
audit("startup", { user: config.allowedSlackUserId, roots: config.allowedRoots, mode: config.permissionMode, mcpAlwaysAsk: config.mcpAlwaysAsk });
console.log(`Claude Slack bot running. Responding only to ${config.allowedSlackUserId}. Ctrl-C to stop.`);
