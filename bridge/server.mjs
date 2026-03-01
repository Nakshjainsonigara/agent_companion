import cors from "cors";
import express from "express";
import { execSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildDefaultState, sanitizeState } from "./defaultState.mjs";
import { collectDirectSnapshot } from "./directIngest.mjs";

const PORT = Number(process.env.AGENT_BRIDGE_PORT || 8787);
const STATE_FILE = path.resolve(process.cwd(), "bridge", "state.json");
const BRIDGE_URL = `http://localhost:${PORT}`;
const BRIDGE_TOKEN = String(process.env.AGENT_BRIDGE_TOKEN || "").trim();
const ALLOW_ANY_WORKSPACE =
  String(process.env.AGENT_BRIDGE_ALLOW_ANY_WORKSPACE || "true").trim().toLowerCase() !== "false";
const WORKSPACE_ROOTS = resolveWorkspaceRoots();
const DEFAULT_WORKSPACE_ROOT = resolveDefaultWorkspaceRoot();
const WORKSPACE_MARKER_FILES = [".git", ".vscode", "package.json", "pyproject.toml", "go.mod", "Cargo.toml"];
const MAX_LAUNCHER_RUN_OUTPUT_LINES = 80;
const MAX_LAUNCHER_RUNS = 150;
const MAX_CHAT_TURNS = 4000;
const MAX_TRANSCRIPT_SEGMENTS_PER_RUN = 220;
const RUN_OUTPUT_TOUCH_INTERVAL_MS = 1200;
const DIRECT_PENDING_STALE_MS = 90_000;
const DIRECT_EVENT_STALE_MS = 2 * 60 * 60 * 1000;
const DIRECT_SNAPSHOT_POLL_INTERVAL_MS = 2_500;
const MAX_MANAGED_SERVICES = 120;
const MAX_MANAGED_SERVICE_OUTPUT_LINES = 180;

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

let state = loadState();
const launcherRuns = new Map();
const managedServices = new Map();

function loadState() {
  try {
    if (!fs.existsSync(STATE_FILE)) {
      const initial = buildDefaultState();
      persistState(initial);
      return initial;
    }

    const raw = fs.readFileSync(STATE_FILE, "utf8");
    return sanitizeState(JSON.parse(raw));
  } catch {
    const fallback = buildDefaultState();
    persistState(fallback);
    return fallback;
  }
}

function persistState(nextState) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(nextState, null, 2));
}

function withPersist(mutator) {
  mutator();
  state = {
    ...state,
    updatedAt: Date.now(),
    sessions: state.sessions
      .slice()
      .sort((a, b) => b.lastUpdated - a.lastUpdated),
    sessionThreads: (Array.isArray(state.sessionThreads) ? state.sessionThreads : [])
      .slice()
      .sort((a, b) => safeNumber(b.updatedAt, 0) - safeNumber(a.updatedAt, 0)),
    chatTurns: (Array.isArray(state.chatTurns) ? state.chatTurns : [])
      .slice()
      .sort((a, b) => safeNumber(a.createdAt, 0) - safeNumber(b.createdAt, 0))
      .slice(-MAX_CHAT_TURNS),
    events: state.events
      .slice()
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, 500)
  };
  persistState(state);
}

function safeNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function findSession(sessionId) {
  return state.sessions.find((item) => item.id === sessionId) || null;
}

function upsertSession(input) {
  const now = Date.now();
  const existing = state.sessions.find((item) => item.id === input.id);

  const previousTokens = existing?.tokenUsage ?? {
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    costUsd: 0
  };

  const incomingTokens = {
    promptTokens: safeNumber(input?.tokenUsage?.promptTokens, previousTokens.promptTokens),
    completionTokens: safeNumber(input?.tokenUsage?.completionTokens, previousTokens.completionTokens),
    totalTokens: safeNumber(input?.tokenUsage?.totalTokens, previousTokens.totalTokens),
    costUsd: safeNumber(input?.tokenUsage?.costUsd, previousTokens.costUsd)
  };

  if (!input?.tokenUsage?.totalTokens) {
    incomingTokens.totalTokens = incomingTokens.promptTokens + incomingTokens.completionTokens;
  }

  const next = {
    id: input.id,
    agentType: input.agentType === "CLAUDE" ? "CLAUDE" : "CODEX",
    title: input.title || existing?.title || "Untitled session",
    repo: input.repo || existing?.repo || "unknown-repo",
    branch: input.branch || existing?.branch || "main",
    state: normalizeState(input.state || existing?.state || "RUNNING"),
    lastUpdated: safeNumber(input.lastUpdated, now),
    progress: Math.max(0, Math.min(100, safeNumber(input.progress, existing?.progress ?? 0))),
    tokenUsage: incomingTokens
  };

  if (!existing) {
    state.sessions.push(next);
    syncSessionThreadFromSession(next, {
      workspacePath: input?.workspacePath,
      threadLookupKey: input?.threadLookupKey,
      updatedAt: next.lastUpdated
    });
    return next;
  }

  Object.assign(existing, next);
  syncSessionThreadFromSession(existing, {
    workspacePath: input?.workspacePath,
    threadLookupKey: input?.threadLookupKey,
    updatedAt: existing.lastUpdated
  });
  return existing;
}

function normalizeState(value) {
  const allowed = ["RUNNING", "WAITING_INPUT", "COMPLETED", "FAILED", "CANCELLED"];
  return allowed.includes(value) ? value : "RUNNING";
}

function normalizeCategory(value) {
  const allowed = ["INFO", "ACTION", "INPUT", "ERROR"];
  return allowed.includes(value) ? value : "INFO";
}

function addEvent(input) {
  if (!input?.sessionId) return null;

  const event = {
    id: input.id || `e_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
    sessionId: input.sessionId,
    summary: input.summary || "Event",
    timestamp: safeNumber(input.timestamp, Date.now()),
    category: normalizeCategory(input.category)
  };

  state.events.unshift(event);
  return event;
}

function addPendingInput(input) {
  if (!input?.sessionId || !input?.prompt) return null;

  const sessionId = String(input.sessionId).trim();
  const defaultActionable = !sessionId.startsWith("codex:") && !sessionId.startsWith("claude:");
  const pending = {
    id: input.id || `p_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
    sessionId,
    prompt: input.prompt,
    requestedAt: safeNumber(input.requestedAt, Date.now()),
    priority: normalizePriority(input.priority),
    actionable: safeBoolean(input.actionable, defaultActionable),
    source: safeTrimmedText(input.source, 32) || (defaultActionable ? "BRIDGE" : "DIRECT"),
    meta: input.meta && typeof input.meta === "object" ? input.meta : null
  };

  const existing = state.pendingInputs.find((item) => item.id === pending.id);
  if (!existing) {
    state.pendingInputs.unshift(pending);
    appendChatTurn({
      sessionId,
      role: "ASSISTANT",
      kind: "MESSAGE",
      text: pending.prompt,
      createdAt: pending.requestedAt,
      approvalId: pending.id,
      source: "PENDING"
    });
    if (state.pendingHandledAt && typeof state.pendingHandledAt === "object") {
      delete state.pendingHandledAt[pending.id];
    }
  }

  const session = findSession(input.sessionId);
  if (session) {
    session.state = "WAITING_INPUT";
    session.lastUpdated = Date.now();
    syncSessionThreadFromSession(session, {
      updatedAt: session.lastUpdated,
      lastMessageAt: pending.requestedAt
    });
  } else {
    upsertSessionThread({
      id: sessionId,
      agentType: "CODEX",
      title: "Untitled session",
      repo: "unknown-repo",
      branch: "main",
      updatedAt: pending.requestedAt,
      lastMessageAt: pending.requestedAt
    });
  }

  return pending;
}

function normalizePriority(value) {
  if (value === "HIGH" || value === "MEDIUM" || value === "LOW") {
    return value;
  }
  return "MEDIUM";
}

function requireBridgeToken(req, res, next) {
  if (!BRIDGE_TOKEN) return next();

  const candidate =
    req.header("x-bridge-token") ||
    req.query?.token ||
    req.body?.token ||
    "";

  if (String(candidate).trim() === BRIDGE_TOKEN) {
    return next();
  }

  return res.status(401).json({
    ok: false,
    error: "bridge token required",
    hint: "Provide x-bridge-token header"
  });
}

function resolveWorkspaceRoots() {
  const configured = String(process.env.AGENT_BRIDGE_WORKSPACE_ROOTS || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

  const fallbackRoots = [
    process.cwd(),
    path.join(os.homedir(), "Desktop"),
    path.join(os.homedir(), "Documents"),
    path.join(os.homedir(), "Projects")
  ];

  const roots = configured.length > 0 ? configured : fallbackRoots;
  const deduped = new Set();
  const resolved = [];

  for (const candidate of roots) {
    try {
      const absolute = path.resolve(candidate);
      const real = fs.realpathSync(absolute);
      const stat = fs.statSync(real);
      if (!stat.isDirectory()) continue;
      if (deduped.has(real)) continue;
      deduped.add(real);
      resolved.push(real);
    } catch {
      continue;
    }
  }

  return resolved;
}

function resolveDefaultWorkspaceRoot() {
  const preferred = [
    path.join(os.homedir(), "Documents"),
    path.join(os.homedir(), "Desktop"),
    WORKSPACE_ROOTS[0] || "",
    process.cwd()
  ].filter(Boolean);

  for (const candidate of preferred) {
    const normalized = normalizeExistingDirectoryPath(candidate);
    if (normalized) return normalized;
  }

  return process.cwd();
}

function normalizeExistingDirectoryPath(inputPath) {
  if (typeof inputPath !== "string" || !inputPath.trim()) return "";
  try {
    const absolute = path.resolve(inputPath.trim());
    const real = fs.realpathSync(absolute);
    const stat = fs.statSync(real);
    if (!stat.isDirectory()) return "";
    return real;
  } catch {
    return "";
  }
}

function getWorkspaceRootSetting() {
  const fromSettings = normalizeExistingDirectoryPath(safeTrimmedText(state?.settings?.workspaceRoot, 1000));
  return fromSettings || DEFAULT_WORKSPACE_ROOT;
}

function isPathInside(root, target) {
  if (root === target) return true;
  return target.startsWith(`${root}${path.sep}`);
}

function normalizeWorkspacePath(inputPath) {
  const normalized = normalizeExistingDirectoryPath(inputPath);
  return normalized || null;
}

function isWorkspaceAllowed(workspacePath) {
  if (ALLOW_ANY_WORKSPACE) return true;
  return WORKSPACE_ROOTS.some((root) => isPathInside(root, workspacePath));
}

function safeInt(value, fallback = 0) {
  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function safeBoolean(value, fallback = false) {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string" && typeof value !== "number") return fallback;
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

function safeTrimmedText(value, maxLength) {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  if (!trimmed) return "";
  return trimmed.slice(0, maxLength);
}

function normalizeLookupText(value) {
  if (typeof value !== "string") return "";
  return value
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function normalizeThreadTitle(value) {
  const normalized = normalizeLookupText(value)
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return normalized || "untitled";
}

function normalizeWorkspaceLookup(workspacePath, repo) {
  const normalizedPath = safeTrimmedText(workspacePath, 500);
  if (normalizedPath) {
    return normalizedPath.toLowerCase();
  }
  const normalizedRepo = normalizeLookupText(repo);
  return normalizedRepo ? `repo:${normalizedRepo}` : "repo:unknown";
}

function buildSessionThreadLookupKey(input) {
  const agentType = normalizeAgentType(input?.agentType);
  const workspaceKey = normalizeWorkspaceLookup(input?.workspacePath, input?.repo);
  const titleKey = normalizeThreadTitle(input?.title);
  return `${agentType}|${workspaceKey}|${titleKey}`;
}

function findSessionThread(sessionId) {
  const id = safeTrimmedText(sessionId, 160);
  if (!id) return null;
  return (Array.isArray(state.sessionThreads) ? state.sessionThreads : []).find((item) => item.id === id) || null;
}

function findLatestSessionThreadByLookupKey(lookupKey) {
  const target = safeTrimmedText(lookupKey, 640);
  if (!target) return null;

  return (Array.isArray(state.sessionThreads) ? state.sessionThreads : [])
    .slice()
    .sort((a, b) => safeNumber(b.updatedAt, 0) - safeNumber(a.updatedAt, 0))
    .find((thread) => safeTrimmedText(thread.lookupKey || thread.key, 640) === target) || null;
}

function upsertSessionThread(input) {
  const now = Date.now();
  const id = safeTrimmedText(input?.id, 160);
  if (!id) return null;

  if (!Array.isArray(state.sessionThreads)) {
    state.sessionThreads = [];
  }

  const existing = findSessionThread(id);
  const agentType = normalizeAgentType(input?.agentType || existing?.agentType);
  const title = safeTrimmedText(input?.title, 140) || safeTrimmedText(existing?.title, 140) || "Untitled session";
  const repo = safeTrimmedText(input?.repo, 120) || safeTrimmedText(existing?.repo, 120) || "unknown-repo";
  const branch = safeTrimmedText(input?.branch, 120) || safeTrimmedText(existing?.branch, 120) || "main";
  const workspacePath =
    safeTrimmedText(input?.workspacePath, 500) || safeTrimmedText(existing?.workspacePath, 500) || "";
  const normalizedTitle = normalizeThreadTitle(input?.normalizedTitle || title);
  const lookupKey =
    safeTrimmedText(input?.lookupKey || input?.key, 640) ||
    safeTrimmedText(existing?.lookupKey || existing?.key, 640) ||
    buildSessionThreadLookupKey({
      agentType,
      workspacePath,
      repo,
      title: normalizedTitle
    });
  const runCount = Math.max(
    0,
    safeInt(input?.runCount, safeInt(existing?.runCount, 0))
  );

  const next = {
    id,
    key: lookupKey,
    lookupKey,
    agentType,
    workspacePath,
    repo,
    branch,
    title,
    normalizedTitle,
    createdAt: safeNumber(input?.createdAt, safeNumber(existing?.createdAt, now)),
    updatedAt: safeNumber(input?.updatedAt, now),
    lastRunId: safeTrimmedText(input?.lastRunId, 160) || safeTrimmedText(existing?.lastRunId, 160) || null,
    runCount,
    lastMessageAt: safeNumber(input?.lastMessageAt, safeNumber(existing?.lastMessageAt, 0))
  };

  if (!existing) {
    state.sessionThreads.push(next);
    return next;
  }

  Object.assign(existing, next);
  return existing;
}

function syncSessionThreadFromSession(session, input = {}) {
  if (!session?.id) return null;
  const existingThread = findSessionThread(session.id);
  const fallbackLookupKey = buildSessionThreadLookupKey({
    agentType: session.agentType,
    workspacePath: input.workspacePath || existingThread?.workspacePath || "",
    repo: session.repo,
    title: session.title
  });

  return upsertSessionThread({
    id: session.id,
    agentType: session.agentType,
    workspacePath: safeTrimmedText(input.workspacePath, 500) || existingThread?.workspacePath || "",
    repo: session.repo,
    branch: session.branch,
    title: session.title,
    normalizedTitle: normalizeThreadTitle(session.title),
    key: safeTrimmedText(input.threadLookupKey, 640) || existingThread?.key || fallbackLookupKey,
    lookupKey: safeTrimmedText(input.threadLookupKey, 640) || existingThread?.lookupKey || fallbackLookupKey,
    createdAt: safeNumber(input.createdAt, safeNumber(existingThread?.createdAt, session.lastUpdated)),
    updatedAt: safeNumber(input.updatedAt, safeNumber(session.lastUpdated, Date.now())),
    lastRunId: safeTrimmedText(input.lastRunId, 160) || existingThread?.lastRunId || null,
    runCount: safeInt(input.runCount, safeInt(existingThread?.runCount, 0)),
    lastMessageAt: safeNumber(
      input.lastMessageAt,
      safeNumber(existingThread?.lastMessageAt, safeNumber(session.lastUpdated, 0))
    )
  });
}

function sanitizeTurnText(value, maxLength = 12000) {
  const text = String(value ?? "")
    .replace(/\u0000/g, "")
    .replace(/\r\n/g, "\n")
    .trim();
  if (!text) return "";
  return text.slice(0, maxLength);
}

function appendChatTurn(input) {
  const sessionId = safeTrimmedText(input?.sessionId, 160);
  const text = sanitizeTurnText(input?.text);
  if (!sessionId || !text) return null;

  if (!Array.isArray(state.chatTurns)) {
    state.chatTurns = [];
  }

  const role = input?.role === "ASSISTANT" ? "ASSISTANT" : "USER";
  const allowedKinds = new Set(["MESSAGE", "FINAL_OUTPUT", "APPROVAL_ACTION"]);
  const kind = allowedKinds.has(input?.kind) ? input.kind : "MESSAGE";
  const turn = {
    id: safeTrimmedText(input?.id, 180) || `turn_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
    sessionId,
    role,
    kind,
    text,
    createdAt: safeNumber(input?.createdAt, Date.now()),
    runId: safeTrimmedText(input?.runId, 160) || null,
    approvalId: safeTrimmedText(input?.approvalId, 160) || null,
    source: safeTrimmedText(input?.source, 48) || "BRIDGE"
  };

  const duplicate = state.chatTurns.find((item) => item.id === turn.id);
  if (duplicate) {
    return duplicate;
  }

  state.chatTurns.push(turn);
  return turn;
}

function listChatTurnsForSession(sessionId) {
  const id = safeTrimmedText(sessionId, 160);
  if (!id) return [];

  return (Array.isArray(state.chatTurns) ? state.chatTurns : [])
    .filter((turn) => turn.sessionId === id)
    .slice()
    .sort((a, b) => safeNumber(a.createdAt, 0) - safeNumber(b.createdAt, 0));
}

function findLastTurnForSession(sessionId) {
  const turns = listChatTurnsForSession(sessionId);
  return turns.length > 0 ? turns[turns.length - 1] : null;
}

function findMatchingSessionId(agentType, workspacePath, repo, title) {
  const lookupKey = buildSessionThreadLookupKey({ agentType, workspacePath, repo, title });
  const matchedThread = findLatestSessionThreadByLookupKey(lookupKey);
  if (
    matchedThread?.id &&
    !String(matchedThread.id).startsWith("codex:") &&
    !String(matchedThread.id).startsWith("claude:")
  ) {
    return matchedThread.id;
  }

  const normalizedRepo = normalizeLookupText(repo);
  const normalizedTitle = normalizeLookupText(title);
  if (!normalizedRepo || !normalizedTitle) return "";

  const sorted = state.sessions
    .slice()
    .sort((a, b) => safeInt(b.lastUpdated, 0) - safeInt(a.lastUpdated, 0));

  for (const session of sorted) {
    if (!session || session.agentType !== agentType) continue;
    if (String(session.id).startsWith("codex:") || String(session.id).startsWith("claude:")) continue;
    if (normalizeLookupText(session.repo) !== normalizedRepo) continue;
    if (normalizeLookupText(session.title) !== normalizedTitle) continue;
    return String(session.id || "");
  }

  return "";
}

function findActiveRunForSession(sessionId) {
  return [...launcherRuns.values()]
    .sort((a, b) => b.createdAt - a.createdAt)
    .find((run) => run.sessionId === sessionId && (run.status === "RUNNING" || run.status === "STARTING")) || null;
}

function findLatestRunForSession(sessionId) {
  return [...launcherRuns.values()]
    .sort((a, b) => b.createdAt - a.createdAt)
    .find((run) => run.sessionId === sessionId) || null;
}

function extractCodexThreadIdFromRun(run) {
  const direct = safeTrimmedText(run?.codexThreadId, 120);
  if (direct) return direct.toLowerCase();

  const resume = safeTrimmedText(run?.resumeCommand, 400);
  if (resume) {
    const match = resume.match(/codex(?:\s+exec)?\s+resume\s+([0-9a-f-]+)/i);
    if (match?.[1]) return match[1].toLowerCase();
  }

  return "";
}

function extractClaudeSessionIdFromRun(run) {
  const direct = safeTrimmedText(run?.claudeSessionId, 120).toLowerCase();
  if (direct) return direct;

  const resume = safeTrimmedText(run?.resumeCommand, 400);
  if (resume) {
    const match =
      resume.match(/claude(?:\s+code)?\s+--resume\s+([0-9a-f-]{36})/i) ||
      resume.match(/claude(?:\s+code)?\s+-r\s+([0-9a-f-]{36})/i);
    if (match?.[1]) return match[1].toLowerCase();
  }

  return "";
}

function buildContinueCommandFromRun(run, prompt) {
  const safePrompt = safeTrimmedText(prompt, 1500);
  if (!safePrompt || !run) return null;

  if (run.agentType === "CODEX") {
    const threadId = extractCodexThreadIdFromRun(run);
    if (threadId) {
      return ["codex", "exec", "resume", threadId, safePrompt];
    }
    return ["codex", "exec", safePrompt];
  }

  const claudeSessionId = extractClaudeSessionIdFromRun(run);
  if (claudeSessionId) {
    return ["claude", "--resume", claudeSessionId, "-p", safePrompt, "--output-format", "stream-json"];
  }
  return ["claude", "-p", safePrompt, "--output-format", "stream-json"];
}

function writeToRunStdin(run, message) {
  const target = run;
  if (!target || target.agentType !== "CODEX") {
    return false;
  }
  if (
    !target?.child ||
    !target.child.stdin ||
    target.child.stdin.destroyed ||
    !target.child.stdin.writable
  ) {
    return false;
  }

  try {
    target.child.stdin.write(message);
    return true;
  } catch {
    return false;
  }
}

function buildEphemeralSessionThread(session) {
  if (!session?.id) return null;
  const lookupKey = buildSessionThreadLookupKey({
    agentType: session.agentType,
    workspacePath: "",
    repo: session.repo,
    title: session.title
  });
  return {
    id: session.id,
    key: lookupKey,
    lookupKey,
    agentType: session.agentType,
    workspacePath: "",
    repo: session.repo,
    branch: session.branch,
    title: session.title,
    normalizedTitle: normalizeThreadTitle(session.title),
    createdAt: safeNumber(session.lastUpdated, Date.now()),
    updatedAt: safeNumber(session.lastUpdated, Date.now()),
    lastRunId: null,
    runCount: 0,
    lastMessageAt: safeNumber(session.lastUpdated, 0)
  };
}

function getSessionThreadSummary(sessionId) {
  const id = safeTrimmedText(sessionId, 160);
  if (!id) return null;

  const session = findSession(id);
  const thread = findSessionThread(id);
  if (!session && !thread) return null;
  const turns = listChatTurnsForSession(id);
  const lastTurn = turns.length > 0 ? turns[turns.length - 1] : null;
  const pendingApprovals = state.pendingInputs.filter((item) => item.sessionId === id);
  const latestRun = [...launcherRuns.values()]
    .filter((run) => run.sessionId === id)
    .sort((a, b) => b.createdAt - a.createdAt)[0];

  return {
    id,
    thread: thread || buildEphemeralSessionThread(session),
    session: session || null,
    turnCount: turns.length,
    lastTurn,
    pendingApprovals,
    latestRun: latestRun ? serializeRun(latestRun) : null
  };
}

function listSessionThreadSummaries() {
  const threadIds = new Set((Array.isArray(state.sessionThreads) ? state.sessionThreads : []).map((item) => item.id));
  for (const session of state.sessions) {
    threadIds.add(session.id);
  }

  return [...threadIds]
    .map((id) => getSessionThreadSummary(id))
    .filter(Boolean)
    .sort(
      (a, b) =>
        safeNumber(b.thread?.updatedAt, safeNumber(b.session?.lastUpdated, 0)) -
        safeNumber(a.thread?.updatedAt, safeNumber(a.session?.lastUpdated, 0))
    );
}

function listWorkspaceCandidates(limit = 100) {
  const candidates = new Map();
  const preferredRoot = getWorkspaceRootSetting();
  const scanRoots = [...WORKSPACE_ROOTS];
  if (preferredRoot && !scanRoots.includes(preferredRoot)) {
    scanRoots.unshift(preferredRoot);
  }

  for (const root of scanRoots) {
    const forceChildren = root === preferredRoot;
    collectWorkspaceCandidate(root, forceChildren);

    let entries = [];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith(".") && entry.name !== ".vscode") continue;
      collectWorkspaceCandidate(path.join(root, entry.name), forceChildren);
      if (candidates.size >= limit) break;
    }
  }

  for (const run of launcherRuns.values()) {
    if (run.workspacePath) {
      collectWorkspaceCandidate(run.workspacePath, true);
    }
  }

  return [...candidates.values()]
    .sort((a, b) => b.lastModified - a.lastModified)
    .slice(0, limit);

  function collectWorkspaceCandidate(dirPath, force = false) {
    if (candidates.has(dirPath)) return;
    const workspace = describeWorkspaceCandidate(dirPath);
    if (!workspace) return;
    if (!force && workspace.score === 0) return;
    candidates.set(dirPath, workspace);
  }
}

function describeWorkspaceCandidate(dirPath) {
  const normalized = normalizeExistingDirectoryPath(dirPath);
  if (!normalized) return null;

  let stat;
  try {
    stat = fs.statSync(normalized);
  } catch {
    return null;
  }
  if (!stat.isDirectory()) return null;

  let score = 0;
  let hasGit = false;

  for (const marker of WORKSPACE_MARKER_FILES) {
    if (fs.existsSync(path.join(normalized, marker))) {
      score += marker === ".git" ? 3 : 1;
      if (marker === ".git") hasGit = true;
    }
  }

  return {
    path: normalized,
    name: path.basename(normalized),
    hasGit,
    score,
    lastModified: stat.mtimeMs
  };
}

function sanitizeWorkspaceName(value) {
  const raw = safeTrimmedText(value, 120);
  if (!raw) return "";

  const normalized = raw
    .replace(/[\\/]+/g, " ")
    .replace(/[<>:"|?*\u0000-\u001F]/g, "")
    .replace(/\s+/g, " ")
    .trim();

  if (!normalized || normalized === "." || normalized === "..") return "";
  return normalized;
}

function createWorkspaceFolder(input) {
  const name = sanitizeWorkspaceName(input?.name || input?.workspaceName || input?.folderName);
  if (!name) {
    return { statusCode: 400, error: "workspace name is required" };
  }

  const explicitParent = safeTrimmedText(input?.parentPath || input?.workspaceRoot, 1000);
  const parentPath = normalizeExistingDirectoryPath(explicitParent) || getWorkspaceRootSetting();
  if (!parentPath) {
    return { statusCode: 400, error: "workspace root is not configured" };
  }

  if (!ALLOW_ANY_WORKSPACE && !WORKSPACE_ROOTS.some((root) => isPathInside(root, parentPath))) {
    return {
      statusCode: 403,
      error: "workspace root is outside allowed roots",
      workspaceRoots: WORKSPACE_ROOTS
    };
  }

  const targetPath = path.resolve(parentPath, name);
  if (!isPathInside(parentPath, targetPath)) {
    return { statusCode: 400, error: "invalid workspace name" };
  }

  if (!ALLOW_ANY_WORKSPACE && !WORKSPACE_ROOTS.some((root) => isPathInside(root, targetPath))) {
    return {
      statusCode: 403,
      error: "workspacePath is outside allowed roots",
      workspaceRoots: WORKSPACE_ROOTS
    };
  }

  let created = false;
  try {
    if (fs.existsSync(targetPath)) {
      const stat = fs.statSync(targetPath);
      if (!stat.isDirectory()) {
        return { statusCode: 409, error: "path exists and is not a directory" };
      }
    } else {
      fs.mkdirSync(targetPath, { recursive: false });
      created = true;
    }
  } catch (error) {
    return { statusCode: 500, error: String(error?.message || error) };
  }

  const normalizedPath = normalizeExistingDirectoryPath(targetPath);
  if (!normalizedPath) {
    return { statusCode: 500, error: "workspace path could not be resolved" };
  }

  const workspace = describeWorkspaceCandidate(normalizedPath);
  if (!workspace) {
    return { statusCode: 500, error: "workspace could not be indexed" };
  }

  return {
    statusCode: created ? 201 : 200,
    workspace,
    created,
    parentPath
  };
}

function detectWorkspaceMeta(workspacePath) {
  const repo = path.basename(workspacePath);
  const branch = detectGitBranch(workspacePath);
  return { repo, branch };
}

function detectGitBranch(workspacePath) {
  try {
    return execSync("git rev-parse --abbrev-ref HEAD", {
      cwd: workspacePath,
      stdio: ["ignore", "pipe", "ignore"]
    })
      .toString()
      .trim();
  } catch {
    return "main";
  }
}

function normalizeAgentType(value) {
  return value === "CLAUDE" ? "CLAUDE" : "CODEX";
}

function normalizeCommandList(input, agentType, prompt) {
  if (Array.isArray(input)) {
    const parts = input
      .map((item) => (typeof item === "string" ? item.trim() : ""))
      .filter(Boolean);
    while (parts[0] === "--") {
      parts.shift();
    }
    return parts.length > 0 ? parts : null;
  }

  if (typeof input === "string" && input.trim()) {
    const parts = input
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    while (parts[0] === "--") {
      parts.shift();
    }
    return parts.length > 0 ? parts : null;
  }

  const trimmedPrompt = safeTrimmedText(prompt, 1500);
  if (!trimmedPrompt) return null;

  if (agentType === "CLAUDE") {
    return ["claude", "-p", trimmedPrompt];
  }
  return ["codex", "exec", trimmedPrompt];
}

function buildPlanPrompt(prompt) {
  const base = safeTrimmedText(prompt, 1500);
  if (!base) return "";
  const suffix =
    "\n\nYou are in PLAN MODE. Do not implement changes yet. Return only a concrete plan, then end with a single explicit approval question asking whether to proceed with implementation.";
  return safeTrimmedText(`${base}${suffix}`, 1900);
}

function createLauncherRun(input) {
  const forceNewThread = safeBoolean(input?.newThread, false);
  const requestedSessionId = forceNewThread ? "" : safeTrimmedText(input?.sessionId, 120);
  const runId = `run_${Date.now()}_${Math.floor(Math.random() * 10000)}`;
  const agentType = normalizeAgentType(input?.agentType);
  const workspacePath = normalizeWorkspacePath(input?.workspacePath);

  if (!workspacePath) {
    return { error: "workspacePath must point to an existing local directory" };
  }
  if (!isWorkspaceAllowed(workspacePath)) {
    return {
      error: "workspacePath is outside allowed roots",
      allowedRoots: WORKSPACE_ROOTS
    };
  }

  const fullWorkspaceAccess = safeBoolean(input?.fullWorkspaceAccess, false);
  const skipPermissions = safeBoolean(input?.skipPermissions, false);
  const planMode = safeBoolean(input?.planMode, false);
  if (planMode && (fullWorkspaceAccess || skipPermissions)) {
    return {
      error: "planMode cannot be combined with fullWorkspaceAccess or skipPermissions"
    };
  }
  const displayPrompt = safeTrimmedText(input?.prompt, 1500);
  const effectivePrompt = planMode ? buildPlanPrompt(displayPrompt) : displayPrompt;
  const command = normalizeCommandList(input?.command, agentType, effectivePrompt);
  if (!command || command.length === 0) {
    return { error: "prompt is required when command is not provided" };
  }

  const workspaceMeta = detectWorkspaceMeta(workspacePath);
  const title =
    safeTrimmedText(input?.title, 140) ||
    safeTrimmedText(displayPrompt, 140) ||
    `${agentType} local task`;
  const threadLookupKey = buildSessionThreadLookupKey({
    agentType,
    workspacePath,
    repo: workspaceMeta.repo,
    title
  });
  const matchedSessionId =
    requestedSessionId ||
    (forceNewThread ? "" : findMatchingSessionId(agentType, workspacePath, workspaceMeta.repo, title));
  const sessionId =
    matchedSessionId || `${agentType.toLowerCase()}_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
  const reusedExistingSession = Boolean(
    matchedSessionId &&
      (findSession(matchedSessionId) || findSessionThread(matchedSessionId))
  );
  const existingThread = findSessionThread(sessionId);

  const run = {
    id: runId,
    sessionId,
    threadLookupKey,
    agentType,
    title,
    prompt: displayPrompt,
    executionPrompt: effectivePrompt,
    workspacePath,
    repo: workspaceMeta.repo,
    branch: workspaceMeta.branch,
    command,
    launchOptions: {
      fullWorkspaceAccess,
      skipPermissions,
      planMode,
      newThread: forceNewThread
    },
    status: "STARTING",
    createdAt: Date.now(),
    startedAt: null,
    endedAt: null,
    pid: null,
    exitCode: null,
    signal: null,
    error: null,
    codexThreadId: null,
    claudeSessionId: null,
    resumeCommand: null,
    stopRequested: false,
    assistantOutputSegments: [],
    outputTail: []
  };

  launcherRuns.set(runId, run);
  trimLauncherRuns();

  withPersist(() => {
    const launchMode = [];
    if (run.launchOptions.fullWorkspaceAccess) launchMode.push("full-workspace-access");
    if (run.launchOptions.skipPermissions) launchMode.push("skip-permissions");
    if (run.launchOptions.planMode) launchMode.push("plan-mode");
    if (run.launchOptions.newThread) launchMode.push("new-thread");
    const launchSuffix = launchMode.length > 0 ? ` (${launchMode.join(", ")})` : "";
    const reuseSuffix = reusedExistingSession ? " [reused existing session]" : "";
    const promptTokens = run.executionPrompt ? safeInt(run.executionPrompt.length / 4, 0) : 0;
    const now = Date.now();

    upsertSession({
      id: run.sessionId,
      agentType: run.agentType,
      title: run.title,
      repo: run.repo,
      branch: run.branch,
      state: "RUNNING",
      progress: 2,
      lastUpdated: now,
      workspacePath: run.workspacePath,
      threadLookupKey: run.threadLookupKey,
      tokenUsage: {
        promptTokens,
        completionTokens: 0,
        totalTokens: promptTokens,
        costUsd: 0
      }
    });
    upsertSessionThread({
      id: run.sessionId,
      agentType: run.agentType,
      key: run.threadLookupKey,
      lookupKey: run.threadLookupKey,
      workspacePath: run.workspacePath,
      repo: run.repo,
      branch: run.branch,
      title: run.title,
      normalizedTitle: normalizeThreadTitle(run.title),
      createdAt: safeNumber(existingThread?.createdAt, now),
      updatedAt: now,
      lastRunId: run.id,
      runCount: safeInt(existingThread?.runCount, 0) + 1,
      lastMessageAt: now
    });

    if (run.prompt) {
      appendChatTurn({
        sessionId: run.sessionId,
        role: "USER",
        kind: "MESSAGE",
        text: run.prompt,
        runId: run.id,
        createdAt: now,
        source: "LAUNCH"
      });
    }

    addEvent({
      sessionId: run.sessionId,
      summary: `Launch requested from phone for ${run.repo}${launchSuffix}${reuseSuffix}.`,
      category: "ACTION",
      timestamp: now
    });
  });

  const runnerScript = path.resolve(process.cwd(), "scripts", "agent-runner.mjs");
  const runnerArgs = [
    runnerScript,
    "--agent",
    run.agentType,
    "--session",
    run.sessionId,
    "--run",
    run.id,
    "--title",
    run.title,
    "--repo",
    run.repo,
    "--branch",
    run.branch,
    "--bridge",
    BRIDGE_URL,
    ...(run.launchOptions.fullWorkspaceAccess ? ["--fullWorkspaceAccess"] : []),
    ...(run.launchOptions.skipPermissions ? ["--skipPermissions"] : []),
    ...(run.launchOptions.planMode ? ["--planMode"] : []),
    "--",
    ...run.command
  ];

  try {
    const child = spawn(process.execPath, runnerArgs, {
      cwd: run.workspacePath,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"]
    });

    run.child = child;

    child.on("spawn", () => {
      run.status = "RUNNING";
      run.startedAt = Date.now();
      run.pid = child.pid ?? null;
    });

    child.stdout.on("data", (chunk) => {
      appendRunOutput(run, chunk.toString());
    });

    child.stderr.on("data", (chunk) => {
      appendRunOutput(run, chunk.toString());
    });

    child.on("error", (error) => {
      run.status = "FAILED";
      run.error = String(error);
      run.endedAt = Date.now();
      run.child = null;

      withPersist(() => {
        upsertSession({
          id: run.sessionId,
          agentType: run.agentType,
          title: run.title,
          repo: run.repo,
          branch: run.branch,
          state: "FAILED",
          progress: 100,
          lastUpdated: Date.now(),
          workspacePath: run.workspacePath,
          threadLookupKey: run.threadLookupKey
        });
        addEvent({
          sessionId: run.sessionId,
          summary: `Unable to launch local command: ${run.error}`,
          category: "ERROR",
          timestamp: Date.now()
        });
      });
    });

    child.on("close", (code, signal) => {
      run.exitCode = Number.isInteger(code) ? code : null;
      run.signal = signal ?? null;
      run.endedAt = Date.now();
      run.child = null;
      const finalOutputText = deriveAssistantFinalOutput(run);

      if (run.stopRequested) {
        run.status = "STOPPED";

        withPersist(() => {
          upsertSession({
            id: run.sessionId,
            agentType: run.agentType,
            title: run.title,
            repo: run.repo,
            branch: run.branch,
            state: "CANCELLED",
            progress: 100,
            lastUpdated: Date.now(),
            workspacePath: run.workspacePath,
            threadLookupKey: run.threadLookupKey
          });
          if (finalOutputText) {
            appendChatTurn({
              sessionId: run.sessionId,
              role: "ASSISTANT",
              kind: "FINAL_OUTPUT",
              text: finalOutputText,
              runId: run.id,
              createdAt: Date.now(),
              source: "RUN_OUTPUT"
            });
          }
          addEvent({
            sessionId: run.sessionId,
            summary: "Session stopped from phone.",
            category: "ACTION",
            timestamp: Date.now()
          });
        });
      } else {
        run.status = run.exitCode === 0 ? "COMPLETED" : "FAILED";
        withPersist(() => {
          upsertSession({
            id: run.sessionId,
            agentType: run.agentType,
            title: run.title,
            repo: run.repo,
            branch: run.branch,
            state: run.status,
            progress: 100,
            lastUpdated: Date.now(),
            workspacePath: run.workspacePath,
            threadLookupKey: run.threadLookupKey
          });

          if (finalOutputText) {
            appendChatTurn({
              sessionId: run.sessionId,
              role: "ASSISTANT",
              kind: "FINAL_OUTPUT",
              text: finalOutputText,
              runId: run.id,
              createdAt: Date.now(),
              source: "RUN_OUTPUT"
            });
          }
        });
      }
    });
  } catch (error) {
    run.status = "FAILED";
    run.error = String(error);
    run.endedAt = Date.now();

    withPersist(() => {
      upsertSession({
        id: run.sessionId,
        agentType: run.agentType,
        title: run.title,
        repo: run.repo,
        branch: run.branch,
        state: "FAILED",
        progress: 100,
        lastUpdated: Date.now(),
        workspacePath: run.workspacePath,
        threadLookupKey: run.threadLookupKey
      });
      addEvent({
        sessionId: run.sessionId,
        summary: `Failed to start task: ${run.error}`,
        category: "ERROR",
        timestamp: Date.now()
      });
    });
  }

  return { run };
}

function stripAnsi(text) {
  return String(text || "").replace(/\u001b\[[0-9;]*m/g, "");
}

function tryParseJsonLine(line) {
  const trimmed = line.trim();
  if (!trimmed || trimmed[0] !== "{") return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function extractTextFromContent(content) {
  if (typeof content === "string") {
    return [content];
  }

  if (!Array.isArray(content)) {
    if (content && typeof content === "object") {
      const candidate =
        safeTrimmedText(content.text, 40_000) ||
        safeTrimmedText(content.value, 40_000) ||
        safeTrimmedText(content.message, 40_000);
      return candidate ? [candidate] : [];
    }
    return [];
  }

  const extracted = [];
  for (const item of content) {
    if (!item || typeof item !== "object") continue;
    const candidate =
      safeTrimmedText(item.text, 40_000) ||
      safeTrimmedText(item.value, 40_000) ||
      safeTrimmedText(item.message, 40_000);
    if (candidate) {
      extracted.push(candidate);
    }
  }
  return extracted;
}

function extractAssistantSegmentsFromJson(payload) {
  if (!payload || typeof payload !== "object") return [];

  if (payload.type === "assistant") {
    const message = payload.message && typeof payload.message === "object" ? payload.message : null;
    if (message && message.role === "assistant") {
      return extractTextFromContent(message.content || message.text);
    }
    return [];
  }

  if (payload.type === "result" && typeof payload.result === "string") {
    return extractTextFromContent(payload.result);
  }

  if (payload.type === "item.completed" && payload.item && typeof payload.item === "object") {
    const itemType = safeTrimmedText(payload.item.type, 80).toLowerCase();
    if (itemType === "agent_message" || itemType === "message") {
      return extractTextFromContent(payload.item.text || payload.item.content);
    }
    if (itemType.includes("tool") || itemType.includes("function") || itemType.includes("call")) {
      const toolName =
        safeTrimmedText(payload.item.name, 120) ||
        safeTrimmedText(payload.item.tool_name, 120) ||
        safeTrimmedText(payload.item.toolName, 120) ||
        safeTrimmedText(payload.item.function?.name, 120);
      const toolStatus = safeTrimmedText(payload.item.status, 40);
      const header = `[tool] ${toolName || "call"}${toolStatus ? ` (${toolStatus})` : ""}`;
      const details = extractTextFromContent(payload.item.text || payload.item.content || payload.item.output);
      return details.length > 0 ? [header, ...details] : [header];
    }
  }

  if (payload.type === "event_msg" && payload.payload && typeof payload.payload === "object") {
    const payloadType = safeTrimmedText(payload.payload.type, 80).toLowerCase();
    if (payloadType === "agent_message" || payloadType === "message") {
      return extractTextFromContent(payload.payload.message || payload.payload.content);
    }
    if (payloadType.includes("tool") || payloadType.includes("function") || payloadType.includes("call")) {
      const toolName =
        safeTrimmedText(payload.payload.name, 120) ||
        safeTrimmedText(payload.payload.tool_name, 120) ||
        safeTrimmedText(payload.payload.toolName, 120) ||
        safeTrimmedText(payload.payload.function?.name, 120);
      const header = `[tool] ${toolName || "call"}`;
      const details = extractTextFromContent(payload.payload.message || payload.payload.content || payload.payload.output);
      return details.length > 0 ? [header, ...details] : [header];
    }
  }

  if (payload.type === "response_item" && payload.payload && typeof payload.payload === "object") {
    const payloadType = safeTrimmedText(payload.payload.type, 80).toLowerCase();
    if (payloadType === "message" && payload.payload.role === "assistant") {
      return extractTextFromContent(payload.payload.content || payload.payload.message || payload.payload.text);
    }
    if (payloadType.includes("tool") || payloadType.includes("function") || payloadType.includes("call")) {
      const toolName =
        safeTrimmedText(payload.payload.name, 120) ||
        safeTrimmedText(payload.payload.tool_name, 120) ||
        safeTrimmedText(payload.payload.toolName, 120) ||
        safeTrimmedText(payload.payload.function?.name, 120);
      const header = `[tool] ${toolName || "call"}`;
      const details = extractTextFromContent(payload.payload.output || payload.payload.content || payload.payload.message);
      return details.length > 0 ? [header, ...details] : [header];
    }
  }

  if (payload.type === "message" && payload.role === "assistant") {
    return extractTextFromContent(payload.content || payload.text);
  }

  return [];
}

function isTranscriptNoiseLine(line) {
  if (!line) return true;
  if (/^\[agent-runner\]/i.test(line)) return true;
  if (/^(session started|session completed|session failed|resume later:|codex thread ready:)/i.test(line)) {
    return true;
  }
  if (/^(prompt|completion|total)[_\s-]*tokens?\s*[:=]/i.test(line)) return true;
  if (/^cost(?:[_\s-]*usd)?\s*[:=]/i.test(line)) return true;
  if (/^\d{4}-\d{2}-\d{2}t/i.test(line) && /\b(error|warn|info|debug)\b/i.test(line)) return true;
  if (/codex_core::|codex_exec|rollout::list|mcp/i.test(line)) return true;
  return false;
}

function collectAssistantSegmentsFromLine(rawLine) {
  const line = stripAnsi(rawLine).trim();
  if (!line) return [];

  const parsed = tryParseJsonLine(line);
  if (parsed) {
    return extractAssistantSegmentsFromJson(parsed)
      .map((item) => sanitizeTurnText(item))
      .filter(Boolean);
  }

  if (isTranscriptNoiseLine(line)) {
    return [];
  }

  return [sanitizeTurnText(line)].filter(Boolean);
}

function deriveAssistantFinalOutput(run) {
  const segments = Array.isArray(run?.assistantOutputSegments) ? run.assistantOutputSegments : [];
  if (segments.length === 0) return "";

  const merged = [];
  for (const segment of segments) {
    const cleaned = sanitizeTurnText(segment, 6000);
    if (!cleaned) continue;
    if (merged[merged.length - 1] === cleaned) continue;
    merged.push(cleaned);
  }

  return sanitizeTurnText(merged.join("\n\n"), 12000);
}

function appendRunOutput(run, text) {
  if (!text) return;
  const rawLines = String(text).split(/\r?\n/);
  const lines = [];

  for (const rawLine of rawLines) {
    const line = stripAnsi(rawLine).trim();
    if (!line) continue;
    lines.push(line);

    const threadMatch = line.match(/\[agent-runner\]\s+codex_thread=([0-9a-f-]+)/i);
    if (threadMatch && threadMatch[1]) {
      run.codexThreadId = threadMatch[1];
      run.resumeCommand = `codex exec resume ${threadMatch[1]}`;
    }

    const parsedLine = tryParseJsonLine(line);
    if (parsedLine && typeof parsedLine === "object") {
      const claudeSessionId = safeTrimmedText(parsedLine.session_id, 120);
      if (claudeSessionId) {
        run.claudeSessionId = claudeSessionId;
        run.resumeCommand = `claude --resume ${claudeSessionId}`;
      }
    }

    const segments = collectAssistantSegmentsFromLine(rawLine);
    if (segments.length > 0) {
      if (!Array.isArray(run.assistantOutputSegments)) {
        run.assistantOutputSegments = [];
      }
      run.assistantOutputSegments.push(...segments);
      if (run.assistantOutputSegments.length > MAX_TRANSCRIPT_SEGMENTS_PER_RUN) {
        run.assistantOutputSegments = run.assistantOutputSegments.slice(-MAX_TRANSCRIPT_SEGMENTS_PER_RUN);
      }
    }
  }

  if (lines.length === 0) return;

  run.outputTail.push(...lines);
  if (run.outputTail.length > MAX_LAUNCHER_RUN_OUTPUT_LINES) {
    run.outputTail = run.outputTail.slice(-MAX_LAUNCHER_RUN_OUTPUT_LINES);
  }

  const now = Date.now();
  const previousTouchAt = safeNumber(run.lastSessionTouchAt, 0);
  if (now - previousTouchAt >= RUN_OUTPUT_TOUCH_INTERVAL_MS) {
    run.lastSessionTouchAt = now;
    const session = findSession(run.sessionId);
    if (session && (session.state === "RUNNING" || session.state === "WAITING_INPUT")) {
      session.lastUpdated = now;
      session.progress = Math.max(4, Math.min(99, safeNumber(session.progress, 4)));
      syncSessionThreadFromSession(session, {
        updatedAt: now,
        lastMessageAt: now,
        lastRunId: run.id
      });
    }
  }
}

function trimLauncherRuns() {
  if (launcherRuns.size <= MAX_LAUNCHER_RUNS) return;
  const entries = [...launcherRuns.entries()].sort((a, b) => b[1].createdAt - a[1].createdAt);
  const keep = new Set(entries.slice(0, MAX_LAUNCHER_RUNS).map(([id]) => id));
  for (const [id] of launcherRuns.entries()) {
    if (!keep.has(id)) launcherRuns.delete(id);
  }
}

function serializeRun(run) {
  return {
    id: run.id,
    sessionId: run.sessionId,
    threadLookupKey: run.threadLookupKey ?? null,
    agentType: run.agentType,
    title: run.title,
    prompt: run.prompt,
    workspacePath: run.workspacePath,
    repo: run.repo,
    branch: run.branch,
    command: run.command,
    fullWorkspaceAccess: Boolean(run.launchOptions?.fullWorkspaceAccess),
    skipPermissions: Boolean(run.launchOptions?.skipPermissions),
    planMode: Boolean(run.launchOptions?.planMode),
    newThread: Boolean(run.launchOptions?.newThread),
    status: run.status,
    createdAt: run.createdAt,
    startedAt: run.startedAt,
    endedAt: run.endedAt,
    pid: run.pid,
    exitCode: run.exitCode,
    signal: run.signal,
    error: run.error,
    codexThreadId: run.codexThreadId ?? null,
    claudeSessionId: run.claudeSessionId ?? null,
    resumeCommand: run.resumeCommand ?? null,
    assistantFinalOutput: deriveAssistantFinalOutput(run) || null,
    stopRequested: run.stopRequested,
    outputTail: run.outputTail
  };
}

function trimManagedServices() {
  if (managedServices.size <= MAX_MANAGED_SERVICES) return;
  const entries = [...managedServices.entries()].sort((a, b) => safeNumber(b[1]?.createdAt, 0) - safeNumber(a[1]?.createdAt, 0));
  const keep = new Set(entries.slice(0, MAX_MANAGED_SERVICES).map(([id]) => id));
  for (const [id, service] of managedServices.entries()) {
    if (keep.has(id)) continue;
    if (service?.status === "RUNNING" || service?.status === "STARTING") {
      continue;
    }
    managedServices.delete(id);
  }
}

function parseCommandInput(input) {
  if (Array.isArray(input)) {
    const parts = input
      .map((item) => (typeof item === "string" ? item.trim() : ""))
      .filter(Boolean);
    return parts.length > 0 ? parts : null;
  }

  const value = safeTrimmedText(input, 5000);
  if (!value) return null;
  return ["/bin/zsh", "-lc", value];
}

function appendManagedServiceOutput(service, text) {
  if (!service || !text) return;
  const lines = String(text)
    .split(/\r?\n/)
    .map((line) => stripAnsi(line).trim())
    .filter(Boolean);
  if (lines.length === 0) return;
  service.outputTail.push(...lines);
  if (service.outputTail.length > MAX_MANAGED_SERVICE_OUTPUT_LINES) {
    service.outputTail = service.outputTail.slice(-MAX_MANAGED_SERVICE_OUTPUT_LINES);
  }
  service.lastOutputAt = Date.now();
}

function isPidRunning(pid) {
  const numericPid = safeInt(pid, 0);
  if (numericPid <= 0) return false;
  try {
    process.kill(numericPid, 0);
    return true;
  } catch {
    return false;
  }
}

function refreshManagedServiceRuntime(service) {
  if (!service) return;
  if (service.status !== "RUNNING" && service.status !== "STARTING") return;
  if (!isPidRunning(service.pid)) {
    service.status = service.stopRequested ? "STOPPED" : "FAILED";
    service.endedAt = service.endedAt || Date.now();
    service.error = service.error || "process is no longer running";
  }
}

function serializeManagedService(service) {
  refreshManagedServiceRuntime(service);
  return {
    id: service.id,
    sessionId: service.sessionId || null,
    workspacePath: service.workspacePath,
    label: service.label,
    command: service.command,
    status: service.status,
    createdAt: service.createdAt,
    startedAt: service.startedAt,
    endedAt: service.endedAt,
    pid: service.pid,
    exitCode: service.exitCode,
    signal: service.signal,
    error: service.error,
    port: service.port,
    localhostUrl: service.localhostUrl,
    stopRequested: Boolean(service.stopRequested),
    lastOutputAt: service.lastOutputAt || null,
    outputTail: Array.isArray(service.outputTail) ? service.outputTail.slice(-MAX_MANAGED_SERVICE_OUTPUT_LINES) : []
  };
}

function startManagedService(input) {
  const workspacePath = normalizeWorkspacePath(input?.workspacePath);
  if (!workspacePath) {
    return { statusCode: 400, error: "workspacePath must point to an existing local directory" };
  }
  if (!isWorkspaceAllowed(workspacePath)) {
    return {
      statusCode: 403,
      error: "workspacePath is outside allowed roots",
      allowedRoots: WORKSPACE_ROOTS
    };
  }

  const command = parseCommandInput(input?.command);
  if (!command || command.length === 0) {
    return { statusCode: 400, error: "command is required" };
  }

  const sessionId = safeTrimmedText(input?.sessionId, 180) || null;
  const serviceId = `svc_${Date.now()}_${Math.floor(Math.random() * 10_000)}`;
  const label =
    safeTrimmedText(input?.label, 140) ||
    safeTrimmedText(command.join(" "), 140) ||
    "Background service";
  const portRaw = safeInt(input?.port, 0);
  const port = portRaw > 0 && portRaw <= 65535 ? portRaw : null;
  const localhostUrl = port ? `http://localhost:${port}` : null;

  const envInput = input?.env && typeof input.env === "object" ? input.env : {};
  const env = { ...process.env };
  for (const [key, value] of Object.entries(envInput)) {
    const envKey = safeTrimmedText(key, 120);
    if (!envKey || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(envKey)) continue;
    if (typeof value !== "string") continue;
    env[envKey] = value;
  }

  const service = {
    id: serviceId,
    sessionId,
    workspacePath,
    label,
    command,
    status: "STARTING",
    createdAt: Date.now(),
    startedAt: null,
    endedAt: null,
    pid: null,
    exitCode: null,
    signal: null,
    error: null,
    stopRequested: false,
    port,
    localhostUrl,
    outputTail: [],
    lastOutputAt: null,
    child: null
  };

  managedServices.set(serviceId, service);
  trimManagedServices();

  try {
    const child = spawn(command[0], command.slice(1), {
      cwd: workspacePath,
      env,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    child.unref();
    service.child = child;

    child.on("spawn", () => {
      service.status = "RUNNING";
      service.startedAt = Date.now();
      service.pid = child.pid ?? null;
      if (sessionId) {
        withPersist(() => {
          addEvent({
            sessionId,
            summary: `Background service started: ${label}${localhostUrl ? ` (${localhostUrl})` : ""}`,
            category: "ACTION",
            timestamp: Date.now()
          });
        });
      }
    });

    child.stdout.on("data", (chunk) => {
      appendManagedServiceOutput(service, chunk.toString());
    });
    child.stderr.on("data", (chunk) => {
      appendManagedServiceOutput(service, chunk.toString());
    });

    child.on("error", (error) => {
      service.status = "FAILED";
      service.error = String(error?.message || error);
      service.endedAt = Date.now();
      if (sessionId) {
        withPersist(() => {
          addEvent({
            sessionId,
            summary: `Background service failed to start: ${service.error}`,
            category: "ERROR",
            timestamp: Date.now()
          });
        });
      }
    });

    child.on("close", (code, signal) => {
      service.exitCode = Number.isInteger(code) ? code : null;
      service.signal = signal ?? null;
      service.endedAt = Date.now();
      service.child = null;
      if (service.stopRequested) {
        service.status = "STOPPED";
      } else {
        service.status = service.exitCode === 0 ? "COMPLETED" : "FAILED";
      }
      if (sessionId) {
        withPersist(() => {
          addEvent({
            sessionId,
            summary:
              service.status === "COMPLETED"
                ? `Background service completed: ${label}`
                : service.status === "STOPPED"
                  ? `Background service stopped: ${label}`
                  : `Background service exited: ${label}${service.exitCode != null ? ` (code ${service.exitCode})` : ""}`,
            category: service.status === "FAILED" ? "ERROR" : "INFO",
            timestamp: Date.now()
          });
        });
      }
    });
  } catch (error) {
    service.status = "FAILED";
    service.error = String(error?.message || error);
    service.endedAt = Date.now();
    return { statusCode: 500, error: service.error, service };
  }

  return { statusCode: 201, service };
}

function stopManagedService(service, signalInput) {
  if (!service) {
    return { statusCode: 404, error: "service not found" };
  }

  const signal = safeTrimmedText(signalInput, 24) || "SIGTERM";
  service.stopRequested = true;

  const pid = safeInt(service.pid, 0);
  let stopped = false;
  try {
    if (pid > 0) {
      process.kill(pid, signal);
      stopped = true;
    }
  } catch {
    stopped = false;
  }

  if (!stopped && service.child) {
    try {
      service.child.kill(signal);
      stopped = true;
    } catch {
      stopped = false;
    }
  }

  if (!stopped) {
    refreshManagedServiceRuntime(service);
    if (service.status === "RUNNING" || service.status === "STARTING") {
      return { statusCode: 409, error: "unable to stop process" };
    }
  }

  service.status = "STOPPED";
  service.endedAt = Date.now();

  if (service.sessionId) {
    withPersist(() => {
      addEvent({
        sessionId: service.sessionId,
        summary: `Background service stop requested (${signal}): ${service.label}`,
        category: "ACTION",
        timestamp: Date.now()
      });
    });
  }

  return { statusCode: 200, service };
}

function mergeDirectSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== "object") return;

  const incomingDirectSessionIds = new Set(
    (Array.isArray(snapshot.sessions) ? snapshot.sessions : [])
      .map((item) => item?.id)
      .filter((id) => typeof id === "string")
  );

  if (incomingDirectSessionIds.size > 0) {
    state.sessions = state.sessions.filter((item) => {
      const id = String(item?.id || "");
      if (!id.startsWith("codex:") && !id.startsWith("claude:")) return true;
      return incomingDirectSessionIds.has(id);
    });
    state.sessionThreads = (Array.isArray(state.sessionThreads) ? state.sessionThreads : []).filter((item) => {
      const id = String(item?.id || "");
      if (!id.startsWith("codex:") && !id.startsWith("claude:")) return true;
      return incomingDirectSessionIds.has(id);
    });
  }

  const existingSessions = new Map(state.sessions.map((item) => [item.id, item]));
  for (const incoming of Array.isArray(snapshot.sessions) ? snapshot.sessions : []) {
    if (!incoming?.id) continue;
    const previous = existingSessions.get(incoming.id);
    if (previous) {
      Object.assign(previous, incoming);
      syncSessionThreadFromSession(previous, {
        updatedAt: safeNumber(previous.lastUpdated, Date.now())
      });
    } else {
      state.sessions.push(incoming);
      syncSessionThreadFromSession(incoming, {
        updatedAt: safeNumber(incoming.lastUpdated, Date.now())
      });
    }
  }

  const incomingPendingIds = new Set();
  for (const pending of Array.isArray(snapshot.pendingInputs) ? snapshot.pendingInputs : []) {
    if (!pending?.id) continue;
    const handledAt = safeNumber(state.pendingHandledAt?.[pending.id], 0);
    const requestedAt = safeNumber(pending.requestedAt, 0);
    if (handledAt > 0 && requestedAt > 0 && requestedAt <= handledAt) {
      continue;
    }
    incomingPendingIds.add(pending.id);
    const normalizedPending = {
      ...pending,
      actionable: safeBoolean(pending.actionable, false),
      source: safeTrimmedText(pending.source, 32) || "DIRECT"
    };
    const index = state.pendingInputs.findIndex((item) => item.id === pending.id);
    if (index >= 0) {
      state.pendingInputs[index] = { ...state.pendingInputs[index], ...normalizedPending };
    } else {
      state.pendingInputs.unshift(normalizedPending);
    }
  }

  const now = Date.now();
  state.pendingInputs = state.pendingInputs.filter((item) => {
    if (!String(item.id || "").startsWith("pending:")) return true;
    if (incomingPendingIds.has(item.id)) return true;
    return now - safeNumber(item.requestedAt, 0) <= DIRECT_PENDING_STALE_MS;
  });

  const incomingDirectEventIds = new Set(
    (Array.isArray(snapshot.events) ? snapshot.events : [])
      .map((item) => item?.id)
      .filter((id) => typeof id === "string")
  );
  state.events = state.events.filter((item) => {
    const id = String(item?.id || "");
    if (!id.startsWith("event:codex:") && !id.startsWith("event:claude:")) return true;
    if (incomingDirectEventIds.has(id)) return true;
    return now - safeNumber(item.timestamp, 0) <= DIRECT_EVENT_STALE_MS;
  });

  const existingEvents = new Map(state.events.map((item) => [item.id, item]));
  for (const incoming of Array.isArray(snapshot.events) ? snapshot.events : []) {
    if (!incoming?.id) continue;
    const previous = existingEvents.get(incoming.id);
    if (previous) {
      Object.assign(previous, incoming);
    } else {
      state.events.unshift(incoming);
    }
  }

  const incomingDirectTurnIds = new Set(
    (Array.isArray(snapshot.chatTurns) ? snapshot.chatTurns : [])
      .map((item) => item?.id)
      .filter((id) => typeof id === "string")
  );
  state.chatTurns = (Array.isArray(state.chatTurns) ? state.chatTurns : []).filter((item) => {
    const sessionId = String(item?.sessionId || "");
    const isDirectSession = sessionId.startsWith("codex:") || sessionId.startsWith("claude:");
    const isDirectTurn = safeTrimmedText(item?.source, 48).toUpperCase() === "DIRECT" || String(item?.id || "").startsWith("direct:");
    if (!isDirectSession || !isDirectTurn) return true;
    if (!incomingDirectSessionIds.has(sessionId)) return false;
    return incomingDirectTurnIds.has(item.id);
  });

  const existingTurns = new Map((Array.isArray(state.chatTurns) ? state.chatTurns : []).map((item) => [item.id, item]));
  for (const incoming of Array.isArray(snapshot.chatTurns) ? snapshot.chatTurns : []) {
    if (!incoming?.id || !incoming?.sessionId) continue;
    const previous = existingTurns.get(incoming.id);
    if (previous) {
      Object.assign(previous, incoming);
    } else {
      state.chatTurns.push(incoming);
    }
  }

  if (snapshot.settings && typeof snapshot.settings === "object") {
    state.settings = {
      ...state.settings,
      ...snapshot.settings,
      darkLocked: true
    };
  }
}

function buildBootstrapPayload() {
  const sessionSummaries = listSessionThreadSummaries().map((item) => ({
    id: item.id,
    thread: item.thread,
    session: item.session,
    turnCount: item.turnCount,
    lastTurn: item.lastTurn,
    pendingApprovals: item.pendingApprovals,
    latestRun: item.latestRun
  }));

  return {
    ...state,
    source: "bridge",
    snapshotVersion: safeNumber(state.updatedAt, Date.now()),
    runs: [...launcherRuns.values()]
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, 80)
      .map((run) => serializeRun(run)),
    sessionSummaries
  };
}

function normalizeActionType(value) {
  const normalized = String(value || "")
    .trim()
    .toUpperCase();
  if (normalized === "APPROVE" || normalized === "REJECT" || normalized === "TEXT_REPLY") {
    return normalized;
  }
  if (normalized === "TEXT" || normalized === "REPLY" || normalized === "MESSAGE") {
    return "TEXT_REPLY";
  }
  return "";
}

function resolvePendingKind(pending, latestRun) {
  const fromMeta = safeTrimmedText(pending?.meta?.kind, 64).toUpperCase();
  if (fromMeta) return fromMeta;
  if (safeBoolean(pending?.meta?.questionRequest, false)) return "QUESTION_REQUEST";
  if (safeBoolean(pending?.meta?.planMode, false)) return "PLAN_CONFIRM";
  if (safeBoolean(latestRun?.launchOptions?.planMode, false)) return "PLAN_CONFIRM";
  return "RUNTIME_APPROVAL";
}

function launchFollowUpRun(latestRun, sessionId, promptText, options = {}) {
  if (!latestRun?.workspacePath) {
    return { ok: false, error: "missing workspace context for follow-up run" };
  }

  const followUpPrompt = sanitizeTurnText(promptText || "", 1500);
  if (!followUpPrompt) {
    return { ok: false, error: "follow-up prompt is required" };
  }

  const nextPlanMode = safeBoolean(options?.planMode, safeBoolean(latestRun?.launchOptions?.planMode, false));
  const nextFullWorkspaceAccess = safeBoolean(
    options?.fullWorkspaceAccess,
    safeBoolean(latestRun?.launchOptions?.fullWorkspaceAccess, false)
  );
  const nextSkipPermissions = safeBoolean(
    options?.skipPermissions,
    safeBoolean(latestRun?.launchOptions?.skipPermissions, false)
  );

  const command = buildContinueCommandFromRun(latestRun, followUpPrompt);
  const started = createLauncherRun({
    agentType: latestRun.agentType,
    workspacePath: latestRun.workspacePath,
    prompt: followUpPrompt,
    title: latestRun.title,
    sessionId,
    newThread: false,
    planMode: nextPlanMode,
    fullWorkspaceAccess: nextFullWorkspaceAccess,
    skipPermissions: nextSkipPermissions,
    command: command || undefined
  });

  if (!started?.run) {
    return { ok: false, error: started?.error || "unable to start follow-up run" };
  }

  return { ok: true, run: started.run };
}

function applyPendingAction(input) {
  const pendingInputId = safeTrimmedText(input?.pendingInputId, 180);
  const sessionId = safeTrimmedText(input?.sessionId, 160);
  const type = normalizeActionType(input?.type);
  const text = sanitizeTurnText(input?.text || "", 3000);

  if (!pendingInputId || !sessionId || !type) {
    return {
      statusCode: 400,
      body: { ok: false, error: "pendingInputId, sessionId, and valid type are required" }
    };
  }

  const pending = state.pendingInputs.find((item) => item.id === pendingInputId && item.sessionId === sessionId);
  if (!pending) {
    return { statusCode: 404, body: { ok: false, error: "pending input not found" } };
  }

  const defaultActionable = !String(sessionId).startsWith("codex:") && !String(sessionId).startsWith("claude:");
  if (!safeBoolean(pending.actionable, defaultActionable)) {
    return {
      statusCode: 409,
      body: {
        ok: false,
        error: "pending input is not remotely actionable",
        hint: "Handle this approval directly in the local CLI session."
      }
    };
  }

  const latestRun = findLatestRunForSession(sessionId);
  const pendingKind = resolvePendingKind(pending, latestRun);
  const isPlanConfirm = pendingKind === "PLAN_CONFIRM";
  const isQuestionRequest = pendingKind === "QUESTION_REQUEST";

  const questionReplyText =
    type === "TEXT_REPLY"
      ? text
      : type === "APPROVE"
        ? "Yes, continue."
        : type === "REJECT"
          ? "No, do not proceed with that approach."
          : "";
  if (isQuestionRequest && !sanitizeTurnText(questionReplyText, 3000)) {
    return {
      statusCode: 400,
      body: {
        ok: false,
        error: "text reply is required for question requests",
        pendingInputId,
        sessionId
      }
    };
  }
  const actionText = isQuestionRequest
    ? `${sanitizeTurnText(questionReplyText, 3000)}\n`
    : type === "APPROVE"
      ? "approve\n"
      : type === "REJECT"
        ? "reject\n"
        : `${text}\n`;
  const targetRun = findActiveRunForSession(sessionId);
  let actionDelivered = writeToRunStdin(targetRun, actionText);
  let actionMode = actionDelivered ? "STDIN" : "NONE";
  let launchedFollowUpRun = null;

  if (!actionDelivered && isQuestionRequest) {
    const launched = launchFollowUpRun(latestRun, sessionId, sanitizeTurnText(questionReplyText, 1500), {
      planMode: safeBoolean(latestRun?.launchOptions?.planMode, false),
      fullWorkspaceAccess: safeBoolean(latestRun?.launchOptions?.fullWorkspaceAccess, false),
      skipPermissions: safeBoolean(latestRun?.launchOptions?.skipPermissions, false)
    });
    if (launched.ok) {
      launchedFollowUpRun = launched.run;
      actionDelivered = true;
      actionMode = "QUESTION_FOLLOW_UP";
    }
  }

  if (!actionDelivered && isPlanConfirm && type === "REJECT") {
    actionDelivered = true;
    actionMode = "PLAN_REJECT";
  }

  if (!actionDelivered && isPlanConfirm && (type === "APPROVE" || (type === "TEXT_REPLY" && text))) {
    const launched = launchFollowUpRun(
      latestRun,
      sessionId,
      type === "TEXT_REPLY" ? text : "Proceed with implementation based on the approved plan.",
      {
        planMode: false
      }
    );
    if (!launched.ok) {
      return {
        statusCode: 409,
        body: {
          ok: false,
          error: launched.error || "unable to start follow-up run",
          delivered: false,
          pendingInputId,
          sessionId
        }
      };
    }
    launchedFollowUpRun = launched.run;
    actionDelivered = true;
    actionMode = "PLAN_LAUNCH";
  }

  if (!actionDelivered && latestRun?.agentType === "CLAUDE") {
    const fallbackPrompt =
      type === "APPROVE"
        ? "Approved. Continue with the task."
        : type === "REJECT"
          ? "Rejected. Revise and propose a safer alternative."
          : text;
    const launched = launchFollowUpRun(latestRun, sessionId, fallbackPrompt);
    if (launched.ok) {
      launchedFollowUpRun = launched.run;
      actionDelivered = true;
      actionMode = "CLAUDE_FOLLOW_UP";
    }
  }

  if (!actionDelivered) {
    return {
      statusCode: 409,
      body: {
        ok: false,
        error: "no active writable agent run for this approval",
        delivered: false,
        pendingInputId,
        sessionId
      }
    };
  }

  const now = Date.now();

  withPersist(() => {
    state.pendingInputs = state.pendingInputs.filter((item) => item.id !== pendingInputId);
    state.pendingHandledAt = {
      ...(state.pendingHandledAt && typeof state.pendingHandledAt === "object" ? state.pendingHandledAt : {}),
      [pendingInputId]: now
    };

    const session = findSession(sessionId);
    if (session) {
      session.lastUpdated = now;

      if (type === "REJECT") {
        if (actionMode === "CLAUDE_FOLLOW_UP" || actionMode === "QUESTION_FOLLOW_UP") {
          session.state = "RUNNING";
        } else {
          session.state = isPlanConfirm ? "COMPLETED" : "CANCELLED";
        }
      } else {
        session.state = "RUNNING";
        session.progress = Math.min(100, Math.max(0, safeNumber(session.progress, 0) + 3));
      }

      syncSessionThreadFromSession(session, {
        updatedAt: now,
        lastMessageAt: now,
        lastRunId: launchedFollowUpRun?.id || targetRun?.id || latestRun?.id || null
      });
    }

    const isTextualReply = isQuestionRequest || type === "TEXT_REPLY";
    const turnText = isQuestionRequest
      ? questionReplyText
      : type === "APPROVE"
        ? "Approved"
        : type === "REJECT"
          ? "Rejected"
          : text;
    appendChatTurn({
      sessionId,
      role: "USER",
      kind: isTextualReply ? "MESSAGE" : "APPROVAL_ACTION",
      text: turnText,
      createdAt: now,
      runId: launchedFollowUpRun?.id || targetRun?.id || null,
      approvalId: pendingInputId,
      source: "APPROVAL"
    });

    const summary =
      type === "APPROVE"
        ? actionMode === "PLAN_LAUNCH"
          ? "Plan approved from phone. Implementation run started."
          : actionMode === "QUESTION_FOLLOW_UP"
            ? "Question answered from phone. Follow-up run started."
          : actionMode === "CLAUDE_FOLLOW_UP"
            ? "Approval sent from phone. Claude follow-up run started."
          : "Input approved from phone. Sent to running agent."
        : type === "REJECT"
          ? isPlanConfirm
            ? "Plan declined from phone."
            : actionMode === "QUESTION_FOLLOW_UP"
              ? "Question response sent from phone. Follow-up run started."
            : actionMode === "CLAUDE_FOLLOW_UP"
              ? "Rejection sent from phone. Claude follow-up run started."
            : "Input rejected from phone. Session cancelled."
        : actionMode === "PLAN_LAUNCH"
            ? `Plan follow-up started from phone: ${text || "(empty)"}`
            : actionMode === "QUESTION_FOLLOW_UP"
              ? `Question reply sent from phone: ${questionReplyText || "(empty)"}`
            : actionMode === "CLAUDE_FOLLOW_UP"
              ? `Reply sent from phone. Claude follow-up run started: ${text || "(empty)"}`
            : `Text reply from phone sent to agent: ${text || "(empty)"}`;

    addEvent({ sessionId, summary, category: "ACTION", timestamp: now });
  });

  return {
    statusCode: 200,
    body: {
      ok: true,
      delivered: actionMode === "STDIN",
      resolvedVia: actionMode,
      launchedRunId: launchedFollowUpRun?.id || null,
      pendingInputId,
      sessionId,
      type
    }
  };
}

app.get("/health", (_req, res) => {
  const activeRuns = [...launcherRuns.values()].filter((run) => run.status === "RUNNING").length;
  const activeServices = [...managedServices.values()].filter((service) => {
    refreshManagedServiceRuntime(service);
    return service.status === "RUNNING" || service.status === "STARTING";
  }).length;
  res.json({ ok: true, service: "agent-bridge", activeRuns, activeServices });
});

app.get("/api/bootstrap", (_req, res) => {
  res.json(buildBootstrapPayload());
});

app.get("/api/sessions", (_req, res) => {
  const sessions = listSessionThreadSummaries();
  return res.json({ ok: true, sessions });
});

app.get("/api/sessions/:id", (req, res) => {
  const sessionId = safeTrimmedText(req.params.id, 160);
  const summary = getSessionThreadSummary(sessionId);
  if (!summary) {
    return res.status(404).json({ ok: false, error: "session not found" });
  }
  return res.json({ ok: true, session: summary });
});

app.get("/api/sessions/:id/turns", (req, res) => {
  const sessionId = safeTrimmedText(req.params.id, 160);
  const summary = getSessionThreadSummary(sessionId);
  if (!summary) {
    return res.status(404).json({ ok: false, error: "session not found" });
  }
  const turns = listChatTurnsForSession(sessionId);
  return res.json({ ok: true, sessionId, turns });
});

app.post("/api/sessions/:id/messages", (req, res) => {
  const sessionId = safeTrimmedText(req.params.id, 160);
  const text = sanitizeTurnText(req.body?.text || req.body?.message || "", 3000);
  if (!sessionId) {
    return res.status(400).json({ ok: false, error: "session id is required" });
  }
  if (!text) {
    return res.status(400).json({ ok: false, error: "text is required" });
  }

  const existingSession = findSession(sessionId);
  const existingThread = findSessionThread(sessionId);
  if (!existingSession && !existingThread) {
    return res.status(404).json({ ok: false, error: "session not found" });
  }

  const targetRun = findActiveRunForSession(sessionId);
  const delivered = writeToRunStdin(targetRun, `${text}\n`);
  let turn = null;

  withPersist(() => {
    const now = Date.now();
    let session = findSession(sessionId);
    const thread = findSessionThread(sessionId);

    if (!session && thread) {
      session = upsertSession({
        id: thread.id,
        agentType: thread.agentType,
        title: thread.title,
        repo: thread.repo,
        branch: thread.branch,
        state: delivered ? "RUNNING" : "WAITING_INPUT",
        progress: 0,
        lastUpdated: now,
        workspacePath: thread.workspacePath,
        threadLookupKey: thread.lookupKey || thread.key
      });
    }

    if (session) {
      session.lastUpdated = now;
      if (delivered) {
        session.state = "RUNNING";
      } else if (session.state === "RUNNING") {
        session.state = "WAITING_INPUT";
      }
      syncSessionThreadFromSession(session, {
        updatedAt: now,
        lastMessageAt: now,
        lastRunId: targetRun?.id || null
      });
    } else if (thread) {
      upsertSessionThread({
        id: thread.id,
        updatedAt: now,
        lastMessageAt: now,
        lastRunId: targetRun?.id || null
      });
    }

    const questionPending = state.pendingInputs.find((item) => {
      if (item.sessionId !== sessionId) return false;
      const kind = safeTrimmedText(item?.meta?.kind, 64).toUpperCase();
      return kind === "QUESTION_REQUEST";
    });
    if (questionPending) {
      state.pendingInputs = state.pendingInputs.filter((item) => item.id !== questionPending.id);
      state.pendingHandledAt = {
        ...(state.pendingHandledAt && typeof state.pendingHandledAt === "object" ? state.pendingHandledAt : {}),
        [questionPending.id]: now
      };
      addEvent({
        sessionId,
        summary: "Question answered from phone message.",
        category: "ACTION",
        timestamp: now
      });
    }

    turn = appendChatTurn({
      sessionId,
      role: "USER",
      kind: "MESSAGE",
      text,
      createdAt: now,
      runId: targetRun?.id || null,
      source: "MESSAGE_API"
    });
    addEvent({
      sessionId,
      summary: delivered
        ? `User message sent to running agent: ${text.slice(0, 180)}`
        : `User message queued for session: ${text.slice(0, 180)}`,
      category: "ACTION",
      timestamp: now
    });
  });

  return res.status(201).json({ ok: true, delivered, turn });
});

app.post("/api/sessions/:id/approvals/:approvalId/action", (req, res) => {
  let actionType = req.body?.type ?? req.body?.action;
  if (!actionType && typeof req.body?.approved === "boolean") {
    actionType = req.body.approved ? "APPROVE" : "REJECT";
  }

  const result = applyPendingAction({
    pendingInputId: req.params.approvalId,
    sessionId: req.params.id,
    type: actionType,
    text: req.body?.text
  });

  return res.status(result.statusCode).json(result.body);
});

app.post("/api/sessions/upsert", (req, res) => {
  if (!req.body?.id) {
    return res.status(400).json({ ok: false, error: "id is required" });
  }

  withPersist(() => {
    upsertSession(req.body);
  });

  return res.json({ ok: true, session: findSession(req.body.id) });
});

app.post("/api/events/add", (req, res) => {
  withPersist(() => {
    addEvent(req.body);
  });

  return res.json({ ok: true });
});

app.post("/api/pending/add", (req, res) => {
  let pending = null;

  withPersist(() => {
    pending = addPendingInput(req.body);

    if (pending) {
      addEvent({
        sessionId: pending.sessionId,
        summary: `Input requested: ${pending.prompt}`,
        category: "INPUT",
        timestamp: pending.requestedAt
      });
    }
  });

  if (!pending) {
    return res.status(400).json({ ok: false, error: "sessionId and prompt are required" });
  }

  return res.json({ ok: true, pending });
});

app.post("/api/actions", (req, res) => {
  const result = applyPendingAction(req.body || {});
  return res.status(result.statusCode).json(result.body);
});

app.use("/api/launcher", requireBridgeToken);

app.get("/api/launcher/config", (_req, res) => {
  return res.json({
    ok: true,
    bridgeUrl: BRIDGE_URL,
    tokenRequired: Boolean(BRIDGE_TOKEN),
    allowAnyWorkspace: ALLOW_ANY_WORKSPACE,
    workspaceRoots: WORKSPACE_ROOTS,
    defaultWorkspaceRoot: getWorkspaceRootSetting()
  });
});

app.get("/api/launcher/workspaces", (req, res) => {
  const limit = Math.max(1, Math.min(200, safeInt(req.query?.limit, 80)));
  const workspaces = listWorkspaceCandidates(limit);
  return res.json({
    ok: true,
    allowAnyWorkspace: ALLOW_ANY_WORKSPACE,
    workspaceRoots: WORKSPACE_ROOTS,
    defaultWorkspaceRoot: getWorkspaceRootSetting(),
    workspaces
  });
});

app.post("/api/launcher/workspaces/create", (req, res) => {
  const result = createWorkspaceFolder(req.body || {});
  if (!result.workspace) {
    return res.status(result.statusCode || 400).json({
      ok: false,
      error: result.error || "unable to create workspace",
      workspaceRoots: result.workspaceRoots || WORKSPACE_ROOTS
    });
  }

  return res.status(result.statusCode || 201).json({
    ok: true,
    created: result.created,
    workspace: result.workspace,
    parentPath: result.parentPath
  });
});

app.get("/api/launcher/runs", (_req, res) => {
  const runs = [...launcherRuns.values()]
    .sort((a, b) => b.createdAt - a.createdAt)
    .map((run) => serializeRun(run));

  return res.json({ ok: true, runs });
});

app.get("/api/launcher/services", (_req, res) => {
  const services = [...managedServices.values()]
    .map((service) => serializeManagedService(service))
    .sort((a, b) => safeNumber(b.createdAt, 0) - safeNumber(a.createdAt, 0));

  return res.json({ ok: true, services });
});

app.post("/api/launcher/services/start", (req, res) => {
  const started = startManagedService(req.body || {});
  if (!started.service) {
    return res.status(started.statusCode || 400).json({
      ok: false,
      error: started.error || "unable to start background service",
      details: started
    });
  }

  return res.status(started.statusCode || 201).json({
    ok: true,
    service: serializeManagedService(started.service),
    hint: started.service.localhostUrl
      ? `Service started. Open ${started.service.localhostUrl} (or use relay preview from phone).`
      : "Service started."
  });
});

app.get("/api/launcher/runs/:runId", (req, res) => {
  const run = launcherRuns.get(req.params.runId);
  if (!run) {
    return res.status(404).json({ ok: false, error: "run not found" });
  }
  return res.json({ ok: true, run: serializeRun(run) });
});

app.post("/api/launcher/start", (req, res) => {
  const started = createLauncherRun(req.body || {});
  if (!started.run) {
    return res.status(400).json({ ok: false, error: started.error || "unable to start task", details: started });
  }

  return res.status(201).json({
    ok: true,
    run: serializeRun(started.run),
    launchHint:
      "Session started on laptop. Poll /api/launcher/runs/{id} or /api/bootstrap for status updates."
  });
});

app.post("/api/launcher/runs/:runId/stop", (req, res) => {
  const run = launcherRuns.get(req.params.runId);
  if (!run) {
    return res.status(404).json({ ok: false, error: "run not found" });
  }

  if (!run.child || run.status !== "RUNNING") {
    return res.status(409).json({ ok: false, error: "run is not currently active", run: serializeRun(run) });
  }

  run.stopRequested = true;
  const signal = String(req.body?.signal || "SIGTERM");
  run.child.kill(signal);

  setTimeout(() => {
    if (run.child) {
      run.child.kill("SIGKILL");
    }
  }, 1200);

  withPersist(() => {
    addEvent({
      sessionId: run.sessionId,
      summary: `Stop requested from phone (${signal}).`,
      category: "ACTION",
      timestamp: Date.now()
    });
  });

  return res.json({ ok: true, run: serializeRun(run) });
});

app.post("/api/launcher/services/:serviceId/stop", (req, res) => {
  const service = managedServices.get(req.params.serviceId);
  const stopped = stopManagedService(service, req.body?.signal);
  if (!stopped.service) {
    return res.status(stopped.statusCode || 400).json({
      ok: false,
      error: stopped.error || "unable to stop service"
    });
  }

  return res.status(stopped.statusCode || 200).json({
    ok: true,
    service: serializeManagedService(stopped.service)
  });
});

app.post("/api/settings/update", (req, res) => {
  const payload = req.body && typeof req.body === "object" ? req.body : {};
  const wantsWorkspaceRoot = Object.prototype.hasOwnProperty.call(payload, "workspaceRoot");
  const workspaceRootRaw = safeTrimmedText(payload.workspaceRoot, 1000);
  let nextWorkspaceRoot = getWorkspaceRootSetting();

  if (wantsWorkspaceRoot) {
    if (!workspaceRootRaw) {
      nextWorkspaceRoot = DEFAULT_WORKSPACE_ROOT;
    } else {
      const normalizedRoot = normalizeExistingDirectoryPath(workspaceRootRaw);
      if (!normalizedRoot) {
        return res.status(400).json({ ok: false, error: "workspaceRoot must be an existing local directory" });
      }
      if (!ALLOW_ANY_WORKSPACE && !WORKSPACE_ROOTS.some((root) => isPathInside(root, normalizedRoot))) {
        return res.status(403).json({
          ok: false,
          error: "workspaceRoot is outside allowed roots",
          workspaceRoots: WORKSPACE_ROOTS
        });
      }
      nextWorkspaceRoot = normalizedRoot;
    }
  }

  withPersist(() => {
    state.settings = {
      ...state.settings,
      ...payload,
      workspaceRoot: nextWorkspaceRoot,
      darkLocked: true
    };
  });

  return res.json({ ok: true, settings: state.settings });
});

app.post("/api/reset", (_req, res) => {
  for (const run of launcherRuns.values()) {
    if (run.child) {
      run.stopRequested = true;
      run.child.kill("SIGTERM");
    }
  }
  launcherRuns.clear();

  for (const service of managedServices.values()) {
    service.stopRequested = true;
    const pid = safeInt(service.pid, 0);
    try {
      if (pid > 0) {
        process.kill(pid, "SIGTERM");
      } else if (service.child) {
        service.child.kill("SIGTERM");
      }
    } catch {
      // ignore stop errors during reset
    }
  }
  managedServices.clear();

  withPersist(() => {
    state = buildDefaultState();
  });

  return res.json({ ok: true });
});

app.post("/api/import/snapshot", (req, res) => {
  withPersist(() => {
    mergeDirectSnapshot(req.body);
  });

  return res.json({ ok: true });
});

app.listen(PORT, () => {
  setInterval(() => {
    withPersist(() => {
      const snapshot = collectDirectSnapshot();
      mergeDirectSnapshot(snapshot);
    });
  }, DIRECT_SNAPSHOT_POLL_INTERVAL_MS);
});
