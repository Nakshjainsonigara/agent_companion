import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const MAX_FILES_PER_PROVIDER = 24;
const MAX_SESSION_AGE_MS = 3 * 24 * 60 * 60 * 1000;
const PENDING_FRESH_WINDOW_MS = 7_500;
const PENDING_PATTERN =
  /input required|needs input|waiting for input|approval[_\s-]*required|awaiting approval|please approve|approve (?:this|the) plan|should i (?:proceed|implement|execute)|would you like me to (?:proceed|implement|execute)|ready to (?:implement|execute)|want me to (?:implement|execute)/i;

export function collectDirectSnapshot(nowMs = Date.now()) {
  const codexSessions = collectCodexSessions(nowMs);
  const claudeSessions = collectClaudeSessions(nowMs);

  const sessionsById = new Map();
  for (const item of [...codexSessions.sessions, ...claudeSessions.sessions]) {
    if (!item?.id) continue;
    if (nowMs - item.lastUpdated > MAX_SESSION_AGE_MS) continue;
    const prev = sessionsById.get(item.id);
    if (!prev || prev.lastUpdated < item.lastUpdated) {
      sessionsById.set(item.id, item);
    }
  }
  const sessions = [...sessionsById.values()]
    .sort((a, b) => b.lastUpdated - a.lastUpdated)
    .slice(0, 12);

  const pendingById = new Map();
  for (const pending of [...codexSessions.pendingInputs, ...claudeSessions.pendingInputs]) {
    if (!pending?.id) continue;
    if (nowMs - pending.requestedAt > MAX_SESSION_AGE_MS) continue;
    pendingById.set(pending.id, pending);
  }
  const pendingInputs = [...pendingById.values()]
    .sort((a, b) => b.requestedAt - a.requestedAt)
    .slice(0, 12);

  const eventById = new Map();
  for (const event of [...codexSessions.events, ...claudeSessions.events]) {
    if (!event?.id) continue;
    if (nowMs - event.timestamp > MAX_SESSION_AGE_MS) continue;
    eventById.set(event.id, event);
  }
  const events = [...eventById.values()]
    .sort((a, b) => b.timestamp - a.timestamp)
    .slice(0, 30);

  return {
    sessions,
    pendingInputs,
    events,
    settings: {
      pairingHealthy: true,
      metadataOnly: true,
      networkOnline: true
    }
  };
}

function collectCodexSessions(nowMs) {
  const root = path.join(os.homedir(), ".codex", "sessions");
  const files = getRecentJsonlFiles(root, MAX_FILES_PER_PROVIDER);

  const sessions = [];
  const pendingInputs = [];
  const events = [];

  for (const file of files) {
    const summary = parseCodexFile(file, nowMs);
    if (!summary) continue;

    sessions.push(summary.session);
    if (summary.pendingInput) pendingInputs.push(summary.pendingInput);
    if (summary.event) events.push(summary.event);
  }

  return { sessions, pendingInputs, events };
}

function collectClaudeSessions(nowMs) {
  const root = path.join(os.homedir(), ".claude", "projects");
  const files = getRecentJsonlFiles(root, MAX_FILES_PER_PROVIDER);

  const sessions = [];
  const pendingInputs = [];
  const events = [];

  for (const file of files) {
    const summary = parseClaudeFile(file, nowMs);
    if (!summary) continue;

    sessions.push(summary.session);
    if (summary.pendingInput) pendingInputs.push(summary.pendingInput);
    if (summary.event) events.push(summary.event);
  }

  return { sessions, pendingInputs, events };
}

function parseCodexFile(file, nowMs) {
  let raw = "";
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }

  if (!raw.trim()) return null;

  const lines = raw.split(/\r?\n/).filter(Boolean);
  let sourceSessionId = "";
  let cwd = "";
  let latestTs = 0;
  let firstPrompt = "";
  let latestAgentMessage = "";
  let pendingHint = "";
  let pendingHintTs = 0;
  let sawFinalAnswer = false;
  let sawError = false;
  let usage = {
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0
  };

  for (const line of lines) {
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }

    const ts = safeDateMs(record.timestamp);
    if (ts > latestTs) latestTs = ts;

    if (record.type === "session_meta") {
      sourceSessionId = record.payload?.id || sourceSessionId;
      cwd = record.payload?.cwd || cwd;
      continue;
    }

    if (record.type === "event_msg" && record.payload?.type === "user_message") {
      const message = String(record.payload?.message || "").trim();
      if (message && !isNoisePrompt(message) && !firstPrompt) firstPrompt = message;
      if (PENDING_PATTERN.test(message)) {
        pendingHint = message;
        pendingHintTs = ts || pendingHintTs;
      }
      continue;
    }

    if (record.type === "event_msg" && record.payload?.type === "agent_message") {
      const message = String(record.payload?.message || "").trim();
      if (message) latestAgentMessage = message;
      if (PENDING_PATTERN.test(message)) {
        pendingHint = message;
        pendingHintTs = ts || pendingHintTs;
      }
      if (/error|failed|exception/i.test(message)) sawError = true;
      continue;
    }

    if (record.type === "event_msg" && record.payload?.type === "token_count") {
      const info = record.payload?.info?.total_token_usage || record.payload?.info?.last_token_usage;
      if (info) {
        usage = {
          promptTokens: safeNumber(info.input_tokens) + safeNumber(info.cached_input_tokens),
          completionTokens: safeNumber(info.output_tokens),
          totalTokens: safeNumber(info.total_tokens)
        };
        if (!usage.totalTokens) {
          usage.totalTokens = usage.promptTokens + usage.completionTokens;
        }
      }
      continue;
    }

    if (record.type === "response_item" && record.payload?.phase === "final_answer") {
      sawFinalAnswer = true;
      continue;
    }

    if (record.type === "response_item" && record.payload?.type === "message") {
      const role = record.payload?.role;
      if (role === "user") {
        const text = extractCodexText(record.payload?.content);
        if (text && !isNoisePrompt(text) && !firstPrompt) firstPrompt = text;
        if (text && PENDING_PATTERN.test(text)) {
          pendingHint = text;
          pendingHintTs = ts || pendingHintTs;
        }
      } else if (role === "assistant") {
        const text = extractCodexText(record.payload?.content);
        if (text) {
          latestAgentMessage = text;
          if (PENDING_PATTERN.test(text)) {
            pendingHint = text;
            pendingHintTs = ts || pendingHintTs;
          }
        }
      }
      continue;
    }
  }

  const fallbackId = path.basename(file).replace(/\.jsonl$/i, "");
  const sessionId = `codex:${sourceSessionId || fallbackId}`;
  const effectiveLastUpdated = latestTs || readFileMtimeMs(file, nowMs);
  const ageSec = Math.max(0, Math.floor((nowMs - effectiveLastUpdated) / 1000));
  const pendingStillActive =
    Boolean(pendingHint) &&
    pendingHintTs > 0 &&
    pendingHintTs >= effectiveLastUpdated - PENDING_FRESH_WINDOW_MS;

  const state = deriveState({
    ageSec,
    sawFinalAnswer,
    sawError,
    hasPendingHint: pendingStillActive
  });

  const title = truncate(firstPrompt || latestAgentMessage || "Codex session", 88);
  const repo = cwd ? path.basename(cwd) : "unknown-repo";

  const progress =
    state === "COMPLETED"
      ? 100
      : state === "FAILED"
        ? 100
        : state === "WAITING_INPUT"
          ? 82
          : Math.max(14, Math.min(94, 95 - Math.floor(ageSec / 3)));

  const costUsd = Number((usage.totalTokens * 0.00001).toFixed(2));

  const session = {
    id: sessionId,
    agentType: "CODEX",
    title,
    repo,
    branch: "main",
    state,
    lastUpdated: effectiveLastUpdated,
    progress,
    tokenUsage: {
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
      totalTokens: usage.totalTokens,
      costUsd
    }
  };

  const pendingInput =
    state === "WAITING_INPUT"
      ? {
          id: `pending:${sessionId}`,
          sessionId,
          prompt: truncate(pendingHint || "Input requested by Codex", 180),
          requestedAt: pendingHintTs || effectiveLastUpdated,
          priority: "HIGH",
          actionable: false,
          source: "DIRECT"
        }
      : null;

  const event = {
    id: `event:${sessionId}`,
    sessionId,
    summary:
      state === "WAITING_INPUT"
        ? "Direct Codex session is waiting for input."
        : state === "RUNNING"
          ? "Direct Codex session is running."
          : state === "FAILED"
            ? "Direct Codex session ended with an error."
            : "Direct Codex session completed.",
    timestamp: effectiveLastUpdated,
    category: state === "FAILED" ? "ERROR" : state === "WAITING_INPUT" ? "INPUT" : "INFO"
  };

  return { session, pendingInput, event };
}

function parseClaudeFile(file, nowMs) {
  let raw = "";
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }

  if (!raw.trim()) return null;

  const lines = raw.split(/\r?\n/).filter(Boolean);
  let sourceSessionId = "";
  let cwd = "";
  let branch = "main";
  let latestTs = 0;
  let firstPrompt = "";
  let latestAssistantText = "";
  let pendingHint = "";
  let pendingHintTs = 0;
  let sawError = false;
  let usage = {
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0
  };

  for (const line of lines) {
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }

    const ts = safeDateMs(record.timestamp);
    if (ts > latestTs) latestTs = ts;

    sourceSessionId = record.sessionId || sourceSessionId;
    cwd = record.cwd || cwd;
    branch = record.gitBranch && record.gitBranch !== "HEAD" ? record.gitBranch : branch;

    if (record.type === "user") {
      const userText = extractClaudeUserText(record.message);
      if (userText && !firstPrompt) firstPrompt = userText;
      if (PENDING_PATTERN.test(userText)) {
        pendingHint = userText;
        pendingHintTs = ts || pendingHintTs;
      }
      continue;
    }

    if (record.type === "assistant") {
      const assistantText = extractClaudeAssistantText(record.message);
      if (assistantText) latestAssistantText = assistantText;
      if (PENDING_PATTERN.test(assistantText)) {
        pendingHint = assistantText;
        pendingHintTs = ts || pendingHintTs;
      }
      if (/error|failed|exception/i.test(assistantText)) sawError = true;

      const u = record.message?.usage;
      if (u) {
        usage.promptTokens =
          safeNumber(u.input_tokens) +
          safeNumber(u.cache_read_input_tokens) +
          safeNumber(u.cache_creation_input_tokens);
        usage.completionTokens = safeNumber(u.output_tokens);
        usage.totalTokens = usage.promptTokens + usage.completionTokens;
      }
    }
  }

  const fallbackId = path.basename(file).replace(/\.jsonl$/i, "");
  const sessionId = `claude:${sourceSessionId || fallbackId}`;
  const effectiveLastUpdated = latestTs || readFileMtimeMs(file, nowMs);
  const ageSec = Math.max(0, Math.floor((nowMs - effectiveLastUpdated) / 1000));
  const pendingStillActive =
    Boolean(pendingHint) &&
    pendingHintTs > 0 &&
    pendingHintTs >= effectiveLastUpdated - PENDING_FRESH_WINDOW_MS;

  const state = deriveState({
    ageSec,
    sawFinalAnswer: ageSec > 25,
    sawError,
    hasPendingHint: pendingStillActive
  });

  const title = truncate(firstPrompt || latestAssistantText || "Claude Code session", 88);
  const repo = cwd ? path.basename(cwd) : "unknown-repo";

  const progress =
    state === "COMPLETED"
      ? 100
      : state === "FAILED"
        ? 100
        : state === "WAITING_INPUT"
          ? 80
          : Math.max(12, Math.min(93, 94 - Math.floor(ageSec / 3)));

  const costUsd = Number((usage.totalTokens * 0.00001).toFixed(2));

  const session = {
    id: sessionId,
    agentType: "CLAUDE",
    title,
    repo,
    branch,
    state,
    lastUpdated: effectiveLastUpdated,
    progress,
    tokenUsage: {
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
      totalTokens: usage.totalTokens,
      costUsd
    }
  };

  const pendingInput =
    state === "WAITING_INPUT"
      ? {
          id: `pending:${sessionId}`,
          sessionId,
          prompt: truncate(pendingHint || "Input requested by Claude Code", 180),
          requestedAt: pendingHintTs || effectiveLastUpdated,
          priority: "HIGH",
          actionable: false,
          source: "DIRECT"
        }
      : null;

  const event = {
    id: `event:${sessionId}`,
    sessionId,
    summary:
      state === "WAITING_INPUT"
        ? "Direct Claude Code session is waiting for input."
        : state === "RUNNING"
          ? "Direct Claude Code session is running."
          : state === "FAILED"
            ? "Direct Claude Code session ended with an error."
            : "Direct Claude Code session completed.",
    timestamp: effectiveLastUpdated,
    category: state === "FAILED" ? "ERROR" : state === "WAITING_INPUT" ? "INPUT" : "INFO"
  };

  return { session, pendingInput, event };
}

function deriveState({ ageSec, sawFinalAnswer, sawError, hasPendingHint }) {
  if (hasPendingHint) return "WAITING_INPUT";
  if (sawError && ageSec > 20) return "FAILED";
  if (ageSec < 20) return "RUNNING";
  if (sawFinalAnswer) return "COMPLETED";
  return "COMPLETED";
}

function extractCodexText(content) {
  if (!Array.isArray(content)) return "";
  for (const item of content) {
    if (typeof item?.text === "string" && item.text.trim()) {
      return item.text.trim();
    }
  }
  return "";
}

function extractClaudeUserText(message) {
  if (!message) return "";
  if (typeof message.content === "string") return message.content.trim();
  if (!Array.isArray(message.content)) return "";

  for (const part of message.content) {
    if (typeof part === "string" && part.trim()) return part.trim();
    if (typeof part?.text === "string" && part.text.trim()) return part.text.trim();
    if (typeof part?.content === "string" && part.content.trim()) return part.content.trim();
  }

  return "";
}

function extractClaudeAssistantText(message) {
  if (!message) return "";
  if (!Array.isArray(message.content)) return "";

  for (const part of message.content) {
    if (typeof part?.text === "string" && part.text.trim()) {
      return part.text.trim();
    }
  }

  return "";
}

function safeDateMs(value) {
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function safeNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function readFileMtimeMs(file, fallback = Date.now()) {
  try {
    return safeNumber(fs.statSync(file).mtimeMs, fallback);
  } catch {
    return fallback;
  }
}

function truncate(value, max) {
  const text = String(value || "").trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max - 3)}...`;
}

function isNoisePrompt(text) {
  const raw = String(text || "");
  if (!raw.trim()) return true;
  if (raw.includes("# AGENTS.md instructions")) return true;
  if (raw.includes("<environment_context>")) return true;
  if (raw.includes("Filesystem sandboxing defines")) return true;
  return false;
}

function getRecentJsonlFiles(rootDir, limit) {
  const records = [];

  if (!fs.existsSync(rootDir)) return records;

  const stack = [rootDir];
  while (stack.length) {
    const current = stack.pop();
    if (!current) continue;

    let entries = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }

      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;

      try {
        const stat = fs.statSync(fullPath);
        records.push({ file: fullPath, mtimeMs: stat.mtimeMs });
      } catch {
        continue;
      }
    }
  }

  records.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return records.slice(0, limit).map((item) => item.file);
}
