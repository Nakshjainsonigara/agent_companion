#!/usr/bin/env node
import { spawn, execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const argv = process.argv.slice(2);
const dividerIndex = argv.indexOf("--");
const optionArgs = dividerIndex >= 0 ? argv.slice(0, dividerIndex) : argv;
const command = dividerIndex >= 0 ? argv.slice(dividerIndex + 1) : [];

if (command.length === 0) {
  printUsageAndExit(1);
}

const options = parseOptions(optionArgs);
const agentType = options.agent === "CLAUDE" ? "CLAUDE" : "CODEX";
const launchOptions = {
  fullWorkspaceAccess: parseBooleanEnv(options.fullWorkspaceAccess, false),
  skipPermissions: parseBooleanEnv(options.skipPermissions, false),
  planMode: parseBooleanEnv(options.planMode, false)
};
normalizeCommand(command, {
  agentType,
  fullWorkspaceAccess: launchOptions.fullWorkspaceAccess,
  skipPermissions: launchOptions.skipPermissions,
  planMode: launchOptions.planMode
});

const sessionId = options.session || `${agentType.toLowerCase()}_${Date.now()}`;
const title = options.title || command.join(" ").slice(0, 120);
const repo = options.repo || path.basename(process.cwd());
const branch = options.branch || detectBranch();
const bridgeUrl = options.bridge || process.env.AGENT_BRIDGE_URL || "http://localhost:8787";

const usage = {
  promptTokens: safeInt(options.promptTokens, 0),
  completionTokens: safeInt(options.completionTokens, 0),
  totalTokens: safeInt(options.totalTokens, 0),
  costUsd: safeFloat(options.costUsd, 0)
};

if (usage.totalTokens === 0) {
  usage.totalTokens = usage.promptTokens + usage.completionTokens;
}

const startTime = Date.now();
let lastPendingAt = 0;
let lastUpsertAt = 0;
let done = false;
let codexThreadId = "";
let codexRolloutPromoted = false;
let codexPromotionNoticeShown = false;
const CODEX_GLOBAL_STATE_FILE = path.join(os.homedir(), ".codex", ".codex-global-state.json");
const CODEX_SESSIONS_ROOT = path.join(os.homedir(), ".codex", "sessions");
const ENABLE_CODEX_RESUME_PROMOTION = parseBooleanEnv(
  process.env.AGENT_ENABLE_CODEX_RESUME_PROMOTION,
  true
);
const ENABLE_CODEX_THREAD_INDEX = parseBooleanEnv(process.env.AGENT_ENABLE_CODEX_THREAD_INDEX, true);

const child = spawn(command[0], command.slice(1), {
  cwd: process.cwd(),
  env: process.env,
  stdio: ["pipe", "pipe", "pipe"]
});

let stdoutBuffer = "";
let stderrBuffer = "";

child.stdout.on("data", (chunk) => {
  const text = chunk.toString();
  process.stdout.write(text);
  stdoutBuffer += text;
  stdoutBuffer = consumeBuffer(stdoutBuffer, handleOutputLine);
});

child.stderr.on("data", (chunk) => {
  const text = chunk.toString();
  process.stderr.write(text);
  stderrBuffer += text;
  stderrBuffer = consumeBuffer(stderrBuffer, handleOutputLine);
});

// Forward remote action replies (phone approvals/replies) to the running CLI command.
process.stdin.on("data", (chunk) => {
  if (!child.stdin || child.stdin.destroyed || !child.stdin.writable) return;
  child.stdin.write(chunk);
});

process.on("SIGINT", () => {
  child.kill("SIGINT");
});

process.on("SIGTERM", () => {
  child.kill("SIGTERM");
});

await safePost("/api/sessions/upsert", {
  id: sessionId,
  agentType,
  title,
  repo,
  branch,
  state: "RUNNING",
  progress: 6,
  lastUpdated: Date.now(),
  tokenUsage: usage
});

await safePost("/api/events/add", {
  sessionId,
  summary: `Session started: ${title}`,
  category: "INFO",
  timestamp: Date.now()
});

console.log(`\n[agent-runner] session=${sessionId} agent=${agentType}`);
console.log(`[agent-runner] bridge=${bridgeUrl}\n`);

const heartbeat = setInterval(async () => {
  if (done) return;

  const progress = Math.min(95, 6 + Math.floor((Date.now() - startTime) / 6000));
  usage.totalTokens = Math.max(usage.totalTokens, usage.promptTokens + usage.completionTokens);
  if (usage.costUsd === 0 && usage.totalTokens > 0) {
    usage.costUsd = Number((usage.totalTokens * 0.00001).toFixed(2));
  }

  await safePost("/api/sessions/upsert", {
    id: sessionId,
    agentType,
    title,
    repo,
    branch,
    state: "RUNNING",
    progress,
    lastUpdated: Date.now(),
    tokenUsage: usage
  });
}, 4000);

child.on("close", async (code) => {
  done = true;
  clearInterval(heartbeat);

  const exitCode = Number.isInteger(code) ? code : 1;
  const completed = exitCode === 0;

  usage.totalTokens = Math.max(usage.totalTokens, usage.promptTokens + usage.completionTokens);
  if (usage.costUsd === 0 && usage.totalTokens > 0) {
    usage.costUsd = Number((usage.totalTokens * 0.00001).toFixed(2));
  }

  await safePost("/api/sessions/upsert", {
    id: sessionId,
    agentType,
    title,
    repo,
    branch,
    state: completed ? "COMPLETED" : "FAILED",
    progress: completed ? 100 : Math.min(99, 6 + Math.floor((Date.now() - startTime) / 8000)),
    lastUpdated: Date.now(),
    tokenUsage: usage
  });

  await safePost("/api/events/add", {
    sessionId,
    summary: completed ? "Session completed." : `Session failed with exit code ${exitCode}.`,
    category: completed ? "ACTION" : "ERROR",
    timestamp: Date.now()
  });

  if (codexThreadId) {
    if (ENABLE_CODEX_RESUME_PROMOTION && !codexRolloutPromoted) {
      codexRolloutPromoted =
        (await promoteExecRolloutToCliWithRetry(codexThreadId, {
          attempts: 12,
          delayMs: 250
        })) || codexRolloutPromoted;
    }

    await safePost("/api/events/add", {
      sessionId,
      summary: `Resume later: codex exec resume ${codexThreadId}`,
      category: "INFO",
      timestamp: Date.now()
    });
  }

  process.exit(exitCode);
});

function handleOutputLine(line) {
  if (tryHandleCodexJsonLine(line)) return;
  parseTokenSignals(line);
  maybeEmitInputRequest(line);
  maybeEmitMilestoneEvent(line);
}

function tryHandleCodexJsonLine(line) {
  const trimmed = line.trim();
  if (!trimmed || trimmed[0] !== "{") return false;

  let payload;
  try {
    payload = JSON.parse(trimmed);
  } catch {
    return false;
  }

  if (!payload || typeof payload !== "object") return true;

  if (payload.type === "thread.started" && typeof payload.thread_id === "string") {
    const threadId = payload.thread_id.trim();
    if (threadId && !codexThreadId) {
      codexThreadId = threadId;
      console.log(`[agent-runner] codex_thread=${threadId}`);
      if (ENABLE_CODEX_THREAD_INDEX) {
        upsertThreadInCodexGlobalState(threadId, title);
      }
      if (ENABLE_CODEX_RESUME_PROMOTION && !codexPromotionNoticeShown) {
        codexPromotionNoticeShown = true;
        console.log(`[agent-runner] will promote resume metadata after run completes: ${threadId}`);
      }
      void safePost("/api/events/add", {
        sessionId,
        summary: `Codex thread ready: ${threadId} (resume: codex exec resume ${threadId})`,
        category: "INFO",
        timestamp: Date.now()
      });
    }
    return true;
  }

  if (payload.type === "turn.completed" && payload.usage && typeof payload.usage === "object") {
    const inputTokens =
      safeInt(payload.usage.input_tokens, 0) + safeInt(payload.usage.cached_input_tokens, 0);
    const outputTokens = safeInt(payload.usage.output_tokens, 0);
    if (inputTokens > 0) usage.promptTokens = inputTokens;
    if (outputTokens > 0) usage.completionTokens = outputTokens;
    if (inputTokens > 0 || outputTokens > 0) {
      usage.totalTokens = usage.promptTokens + usage.completionTokens;
      if (usage.costUsd === 0 && usage.totalTokens > 0) {
        usage.costUsd = Number((usage.totalTokens * 0.00001).toFixed(2));
      }
    }
    return true;
  }

  if (payload.type === "item.completed" && payload.item && typeof payload.item === "object") {
    if (payload.item.type === "agent_message" && typeof payload.item.text === "string") {
      const message = payload.item.text.trim();
      if (message) {
        maybeEmitInputRequest(message);
        maybeEmitMilestoneEvent(message);
      }
    }
    return true;
  }

  return true;
}

function maybeEmitMilestoneEvent(line) {
  const trimmed = line.trim();
  if (!trimmed) return;

  const shouldEmit = /completed|finished|patched|updated|created|error|failed/i.test(trimmed);
  if (!shouldEmit) return;

  if (Date.now() - lastUpsertAt < 2500) return;
  lastUpsertAt = Date.now();

  void safePost("/api/events/add", {
    sessionId,
    summary: trimmed.slice(0, 220),
    category: /error|failed/i.test(trimmed) ? "ERROR" : "INFO",
    timestamp: Date.now()
  });
}

function maybeEmitInputRequest(line) {
  const trimmed = line.trim();
  if (!trimmed) return;

  const needsInput = /input required|needs input|approval[_\s-]*required|awaiting approval|please approve|approve (?:this|the) plan|should i (?:proceed|implement|execute)|would you like me to (?:proceed|implement|execute)|ready to (?:implement|execute)|want me to (?:implement|execute)/i.test(
    trimmed
  );

  if (!needsInput) return;
  if (Date.now() - lastPendingAt < 30_000) return;

  lastPendingAt = Date.now();

  void safePost("/api/pending/add", {
    sessionId,
    prompt: trimmed.slice(0, 220),
    priority: "HIGH",
    requestedAt: Date.now(),
    actionable: true,
    source: "RUNNER"
  });

  void safePost("/api/sessions/upsert", {
    id: sessionId,
    agentType,
    title,
    repo,
    branch,
    state: "WAITING_INPUT",
    progress: Math.min(99, 6 + Math.floor((Date.now() - startTime) / 7000)),
    lastUpdated: Date.now(),
    tokenUsage: usage
  });
}

function parseTokenSignals(line) {
  const promptMatch = line.match(/prompt[_\s-]*tokens?\s*[:=]\s*(\d+)/i);
  const completionMatch = line.match(/completion[_\s-]*tokens?\s*[:=]\s*(\d+)/i);
  const totalMatch = line.match(/total[_\s-]*tokens?\s*[:=]\s*(\d+)/i);
  const costMatch = line.match(/cost(?:[_\s-]*usd)?\s*[:=]\s*\$?([0-9]+(?:\.[0-9]+)?)/i);

  if (promptMatch) usage.promptTokens = safeInt(promptMatch[1], usage.promptTokens);
  if (completionMatch) usage.completionTokens = safeInt(completionMatch[1], usage.completionTokens);
  if (totalMatch) usage.totalTokens = safeInt(totalMatch[1], usage.totalTokens);
  if (costMatch) usage.costUsd = safeFloat(costMatch[1], usage.costUsd);

  if (!totalMatch && (promptMatch || completionMatch)) {
    usage.totalTokens = usage.promptTokens + usage.completionTokens;
  }
}

function consumeBuffer(buffer, onLine) {
  const lines = buffer.split(/\r?\n/);
  const trailing = lines.pop() ?? "";

  for (const line of lines) {
    onLine(line);
  }

  return trailing;
}

async function safePost(pathname, payload) {
  try {
    const response = await fetch(`${bridgeUrl}${pathname}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      const text = await response.text();
      console.error(`[agent-runner] bridge error ${response.status}: ${text}`);
    }
  } catch (error) {
    console.error(`[agent-runner] unable to reach bridge: ${String(error)}`);
  }
}

function parseOptions(args) {
  const out = {};

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith("--")) continue;

    const key = arg.slice(2);
    const next = args[index + 1];

    if (!next || next.startsWith("--")) {
      out[key] = "true";
      continue;
    }

    out[key] = next;
    index += 1;
  }

  return out;
}

function detectBranch() {
  try {
    return execSync("git rev-parse --abbrev-ref HEAD", { stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
  } catch {
    return "main";
  }
}

function safeInt(value, fallback) {
  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function safeFloat(value, fallback) {
  const parsed = Number.parseFloat(String(value));
  return Number.isFinite(parsed) ? parsed : fallback;
}

function printUsageAndExit(code) {
  console.log(`Usage:\n  node scripts/agent-runner.mjs [options] -- <command> [args...]\n\nOptions:\n  --agent CODEX|CLAUDE\n  --session <session-id>\n  --title <display-title>\n  --repo <repo-name>\n  --branch <branch-name>\n  --bridge <bridge-url>\n  --fullWorkspaceAccess\n  --skipPermissions\n  --planMode\n  --promptTokens <n>\n  --completionTokens <n>\n  --totalTokens <n>\n  --costUsd <n>\n`);
  process.exit(code);
}

function normalizeCommand(commandArgs, options = {}) {
  const fullWorkspaceAccess = Boolean(options.fullWorkspaceAccess);
  const skipPermissions = Boolean(options.skipPermissions);
  const planMode = Boolean(options.planMode);

  if (commandArgs[0] === "claude") {
    normalizeClaudeCommand(commandArgs, { fullWorkspaceAccess, skipPermissions, planMode });
    return;
  }

  if (commandArgs[0] !== "codex") return;
  if (commandArgs[1] === "run") {
    commandArgs[1] = "exec";
    console.log("[agent-runner] normalized `codex run ...` to `codex exec ...`");
  }

  const knownSubcommands = new Set([
    "exec",
    "review",
    "login",
    "logout",
    "mcp",
    "mcp-server",
    "app-server",
    "app",
    "completion",
    "sandbox",
    "debug",
    "apply",
    "resume",
    "fork",
    "cloud",
    "features",
    "help"
  ]);

  if (commandArgs[1] && !commandArgs[1].startsWith("-") && !knownSubcommands.has(commandArgs[1])) {
    const prompt = commandArgs.slice(1);
    commandArgs.splice(1, commandArgs.length - 1, "exec", ...prompt);
    console.log("[agent-runner] normalized `codex <prompt>` to `codex exec <prompt>`");
  } else if (!commandArgs[1]) {
    commandArgs.push("exec");
    console.log("[agent-runner] normalized bare `codex` to `codex exec`");
  }

  if (commandArgs[1] !== "exec") {
    return;
  }

  if (!commandArgs.includes("--skip-git-repo-check")) {
    commandArgs.splice(2, 0, "--skip-git-repo-check");
    console.log("[agent-runner] added `--skip-git-repo-check` for Codex CLI");
  }

  if (!commandArgs.includes("--json")) {
    commandArgs.splice(2, 0, "--json");
    console.log("[agent-runner] enabled `--json` for Codex session tracking");
  }

  if (
    planMode &&
    !fullWorkspaceAccess &&
    !commandArgs.includes("--sandbox") &&
    !commandArgs.includes("--dangerously-bypass-approvals-and-sandbox")
  ) {
    commandArgs.splice(2, 0, "--sandbox", "read-only");
    console.log("[agent-runner] enabled Codex plan mode (`--sandbox read-only`)");
  }

  if (fullWorkspaceAccess && !commandArgs.includes("--dangerously-bypass-approvals-and-sandbox")) {
    commandArgs.splice(2, 0, "--dangerously-bypass-approvals-and-sandbox");
    console.log("[agent-runner] enabled dangerous full workspace access for Codex");
  }

  if (skipPermissions && !commandArgs.includes("--dangerously-bypass-approvals-and-sandbox")) {
    commandArgs.splice(2, 0, "--dangerously-bypass-approvals-and-sandbox");
    console.log("[agent-runner] enabled dangerous permission bypass for Codex");
  }
}

function normalizeClaudeCommand(commandArgs, options = {}) {
  // `claude code <prompt>` fails in print/non-interactive mode.
  // Convert to the supported one-shot form `claude -p <prompt>`.
  if (commandArgs[1] === "code") {
    const promptParts = commandArgs.slice(2).filter((part) => part !== "--");
    const prompt = promptParts.join(" ").trim();
    if (prompt) {
      commandArgs.splice(1, commandArgs.length - 1, "-p", prompt);
      console.log("[agent-runner] normalized `claude code <prompt>` to `claude -p <prompt>`");
    }
  }

  if ((options.fullWorkspaceAccess || options.skipPermissions) && !commandArgs.includes("--dangerously-skip-permissions")) {
    commandArgs.splice(1, 0, "--dangerously-skip-permissions");
    console.log("[agent-runner] enabled dangerous permission bypass for Claude");
  }

  if (
    options.planMode &&
    !options.fullWorkspaceAccess &&
    !options.skipPermissions &&
    !commandArgs.includes("--permission-mode")
  ) {
    commandArgs.splice(1, 0, "--permission-mode", "plan");
    console.log("[agent-runner] enabled Claude plan mode (`--permission-mode plan`)");
  }
}

function upsertThreadInCodexGlobalState(threadId, sessionTitle) {
  if (!threadId) return;

  try {
    if (!fs.existsSync(CODEX_GLOBAL_STATE_FILE)) return;

    const raw = fs.readFileSync(CODEX_GLOBAL_STATE_FILE, "utf8");
    if (!raw.trim()) return;

    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return;

    const current = parsed["thread-titles"];
    const titles =
      current && typeof current === "object" && current.titles && typeof current.titles === "object"
        ? { ...current.titles }
        : {};
    const order =
      current && typeof current === "object" && Array.isArray(current.order)
        ? current.order.filter((item) => typeof item === "string")
        : [];

    const cleanedTitle = String(sessionTitle || "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 120);
    const fallbackTitle = `Phone task ${threadId.slice(0, 8)}`;
    titles[threadId] = cleanedTitle || titles[threadId] || fallbackTitle;

    const nextOrder = [threadId, ...order.filter((id) => id !== threadId)].slice(0, 600);
    parsed["thread-titles"] = {
      ...(current && typeof current === "object" ? current : {}),
      titles,
      order: nextOrder
    };

    atomicWriteText(CODEX_GLOBAL_STATE_FILE, JSON.stringify(parsed));
    console.log(`[agent-runner] indexed thread in Codex resume list: ${threadId}`);
  } catch (error) {
    console.error(`[agent-runner] unable to update Codex global state: ${String(error)}`);
  }
}

async function promoteExecRolloutToCliWithRetry(threadId, options = {}) {
  const attempts = Math.max(1, safeInt(options.attempts, 8));
  const delayMs = Math.max(10, safeInt(options.delayMs, 250));

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const promoted = promoteExecRolloutToCli(threadId, { silentMissing: attempt < attempts });
    if (promoted) return true;
    if (attempt < attempts) {
      await sleep(delayMs);
    }
  }

  console.log(`[agent-runner] rollout metadata unchanged for ${threadId} after ${attempts} attempts`);
  return false;
}

function promoteExecRolloutToCli(threadId, options = {}) {
  if (!threadId) return false;
  const silentMissing = Boolean(options.silentMissing);

  try {
    const rolloutPath = findRolloutFileByThreadId(threadId);
    if (!rolloutPath) {
      if (!silentMissing) {
        console.log(`[agent-runner] rollout file not found yet for ${threadId} (resume picker metadata unchanged)`);
      }
      return false;
    }

    const raw = fs.readFileSync(rolloutPath, "utf8");
    if (!raw.trim()) return false;

    const newlineIndex = raw.indexOf("\n");
    const firstLine = newlineIndex >= 0 ? raw.slice(0, newlineIndex) : raw;
    const rest = newlineIndex >= 0 ? raw.slice(newlineIndex) : "";
    if (!firstLine.trim()) return false;

    let meta = null;
    try {
      meta = JSON.parse(firstLine);
    } catch {
      console.error(`[agent-runner] unable to parse rollout metadata line for ${threadId}`);
      return false;
    }

    if (!meta || typeof meta !== "object") {
      return false;
    }

    const topLevelThreadId = typeof meta.thread_id === "string" ? meta.thread_id : "";
    const payloadThreadId =
      meta.payload && typeof meta.payload === "object" && typeof meta.payload.id === "string"
        ? meta.payload.id
        : "";
    const discoveredThreadId = topLevelThreadId || payloadThreadId;
    if (discoveredThreadId && discoveredThreadId !== threadId) {
      return false;
    }

    let changed = false;

    const candidates = [meta];
    if (meta.payload && typeof meta.payload === "object") {
      candidates.push(meta.payload);
    }

    for (const candidate of candidates) {
      if (!candidate || typeof candidate !== "object") continue;
      const source = typeof candidate.source === "string" ? candidate.source.trim().toLowerCase() : "";
      if (
        (source === "exec" || source === "cli") &&
        (candidate.originator === "codex_exec" || candidate.originator === "Codex Desktop")
      ) {
        candidate.originator = "codex_cli_rs";
        changed = true;
      }
      if (source === "exec") {
        candidate.source = "cli";
        changed = true;
      }
    }

    if (!changed) {
      return true;
    }

    const patchedLine = JSON.stringify(meta);
    atomicWriteText(rolloutPath, `${patchedLine}${rest}`);
    console.log(`[agent-runner] promoted session metadata for resume picker: ${threadId}`);
    return true;
  } catch (error) {
    console.error(`[agent-runner] unable to promote rollout metadata: ${String(error)}`);
    return false;
  }
}

function findRolloutFileByThreadId(threadId) {
  const candidates = candidateSessionDayDirs(8);
  const suffix = `${threadId}.jsonl`;

  for (const dayDir of candidates) {
    let files = [];
    try {
      files = fs.readdirSync(dayDir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const file of files) {
      if (!file.isFile()) continue;
      if (!file.name.startsWith("rollout-")) continue;
      if (!file.name.endsWith(suffix)) continue;
      return path.join(dayDir, file.name);
    }
  }

  return "";
}

function candidateSessionDayDirs(daysBack) {
  const dirs = [];
  const seen = new Set();
  const now = new Date();

  for (let offset = 0; offset <= daysBack; offset += 1) {
    const date = new Date(now.getTime() - offset * 24 * 60 * 60 * 1000);
    const year = String(date.getFullYear());
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    const dir = path.join(CODEX_SESSIONS_ROOT, year, month, day);
    if (seen.has(dir)) continue;
    seen.add(dir);
    dirs.push(dir);
  }

  return dirs;
}

function atomicWriteText(filePath, content) {
  const dir = path.dirname(filePath);
  const base = path.basename(filePath);
  const tempPath = path.join(dir, `.${base}.tmp-${process.pid}-${Date.now()}`);
  let mode = undefined;

  try {
    mode = fs.statSync(filePath).mode;
  } catch {
    mode = undefined;
  }

  if (typeof mode === "number") {
    fs.writeFileSync(tempPath, content, { mode });
  } else {
    fs.writeFileSync(tempPath, content);
  }

  fs.renameSync(tempPath, filePath);
}

function parseBooleanEnv(value, fallback) {
  if (value == null) return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (!normalized) return fallback;
  if (normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on") {
    return true;
  }
  if (normalized === "0" || normalized === "false" || normalized === "no" || normalized === "off") {
    return false;
  }
  return fallback;
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
