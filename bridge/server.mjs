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
const MAX_LAUNCHER_RUN_OUTPUT_LINES = 80;
const MAX_LAUNCHER_RUNS = 150;

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

let state = loadState();
const launcherRuns = new Map();

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
    sessions: state.sessions
      .slice()
      .sort((a, b) => b.lastUpdated - a.lastUpdated),
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
    return next;
  }

  Object.assign(existing, next);
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
    if (state.pendingHandledAt && typeof state.pendingHandledAt === "object") {
      delete state.pendingHandledAt[pending.id];
    }
  }

  const session = findSession(input.sessionId);
  if (session) {
    session.state = "WAITING_INPUT";
    session.lastUpdated = Date.now();
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

function isPathInside(root, target) {
  if (root === target) return true;
  return target.startsWith(`${root}${path.sep}`);
}

function normalizeWorkspacePath(inputPath) {
  if (typeof inputPath !== "string" || !inputPath.trim()) return null;
  try {
    const absolute = path.resolve(inputPath.trim());
    const real = fs.realpathSync(absolute);
    const stat = fs.statSync(real);
    if (!stat.isDirectory()) return null;
    return real;
  } catch {
    return null;
  }
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

function findMatchingSessionId(agentType, repo, title) {
  const normalizedRepo = normalizeLookupText(repo);
  const normalizedTitle = normalizeLookupText(title);
  if (!normalizedRepo || !normalizedTitle) return "";

  const sorted = state.sessions
    .slice()
    .sort((a, b) => safeInt(b.lastUpdated, 0) - safeInt(a.lastUpdated, 0));

  for (const session of sorted) {
    if (!session || session.agentType !== agentType) continue;
    if (normalizeLookupText(session.repo) !== normalizedRepo) continue;
    if (normalizeLookupText(session.title) !== normalizedTitle) continue;
    return String(session.id || "");
  }

  return "";
}

function listWorkspaceCandidates(limit = 100) {
  const candidates = new Map();
  const markerFiles = [".git", ".vscode", "package.json", "pyproject.toml", "go.mod", "Cargo.toml"];

  for (const root of WORKSPACE_ROOTS) {
    collectWorkspaceCandidate(root);

    let entries = [];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith(".") && entry.name !== ".vscode") continue;
      collectWorkspaceCandidate(path.join(root, entry.name));
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

    let stat;
    try {
      stat = fs.statSync(dirPath);
    } catch {
      return;
    }
    if (!stat.isDirectory()) return;

    let score = 0;
    let hasGit = false;

    for (const marker of markerFiles) {
      if (fs.existsSync(path.join(dirPath, marker))) {
        score += marker === ".git" ? 3 : 1;
        if (marker === ".git") hasGit = true;
      }
    }

    if (!force && score === 0) return;

    candidates.set(dirPath, {
      path: dirPath,
      name: path.basename(dirPath),
      hasGit,
      score,
      lastModified: stat.mtimeMs
    });
  }
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
  const requestedSessionId = safeTrimmedText(input?.sessionId, 120);
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
  const effectivePrompt = planMode ? buildPlanPrompt(input?.prompt) : safeTrimmedText(input?.prompt, 1500);
  const command = normalizeCommandList(input?.command, agentType, effectivePrompt);
  if (!command || command.length === 0) {
    return { error: "prompt is required when command is not provided" };
  }

  const workspaceMeta = detectWorkspaceMeta(workspacePath);
  const title =
    safeTrimmedText(input?.title, 140) ||
    safeTrimmedText(effectivePrompt || input?.prompt, 140) ||
    `${agentType} local task`;
  const matchedSessionId = requestedSessionId || findMatchingSessionId(agentType, workspaceMeta.repo, title);
  const sessionId =
    matchedSessionId || `${agentType.toLowerCase()}_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
  const reusedExistingSession = Boolean(matchedSessionId && findSession(matchedSessionId));

  const run = {
    id: runId,
    sessionId,
    agentType,
    title,
    prompt: effectivePrompt || safeTrimmedText(input?.prompt, 1500),
    workspacePath,
    repo: workspaceMeta.repo,
    branch: workspaceMeta.branch,
    command,
    launchOptions: {
      fullWorkspaceAccess,
      skipPermissions,
      planMode
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
    resumeCommand: null,
    stopRequested: false,
    outputTail: []
  };

  launcherRuns.set(runId, run);
  trimLauncherRuns();

  withPersist(() => {
    const launchMode = [];
    if (run.launchOptions.fullWorkspaceAccess) launchMode.push("full-workspace-access");
    if (run.launchOptions.skipPermissions) launchMode.push("skip-permissions");
    if (run.launchOptions.planMode) launchMode.push("plan-mode");
    const launchSuffix = launchMode.length > 0 ? ` (${launchMode.join(", ")})` : "";
    const reuseSuffix = reusedExistingSession ? " [reused existing session]" : "";

    upsertSession({
      id: run.sessionId,
      agentType: run.agentType,
      title: run.title,
      repo: run.repo,
      branch: run.branch,
      state: "RUNNING",
      progress: 2,
      lastUpdated: Date.now(),
      tokenUsage: {
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        costUsd: 0
      }
    });
    addEvent({
      sessionId: run.sessionId,
      summary: `Launch requested from phone for ${run.repo}${launchSuffix}${reuseSuffix}.`,
      category: "ACTION",
      timestamp: Date.now()
    });
  });

  const runnerScript = path.resolve(process.cwd(), "scripts", "agent-runner.mjs");
  const runnerArgs = [
    runnerScript,
    "--agent",
    run.agentType,
    "--session",
    run.sessionId,
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
          lastUpdated: Date.now()
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
            lastUpdated: Date.now()
          });
          addEvent({
            sessionId: run.sessionId,
            summary: "Session stopped from phone.",
            category: "ACTION",
            timestamp: Date.now()
          });
        });
      } else {
        run.status = run.exitCode === 0 ? "COMPLETED" : "FAILED";
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
        lastUpdated: Date.now()
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

function appendRunOutput(run, text) {
  if (!text) return;
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length === 0) return;

  for (const line of lines) {
    const threadMatch = line.match(/\[agent-runner\]\s+codex_thread=([0-9a-f-]+)/i);
    if (threadMatch && threadMatch[1]) {
      run.codexThreadId = threadMatch[1];
      run.resumeCommand = `codex exec resume ${threadMatch[1]}`;
    }
  }

  run.outputTail.push(...lines);
  if (run.outputTail.length > MAX_LAUNCHER_RUN_OUTPUT_LINES) {
    run.outputTail = run.outputTail.slice(-MAX_LAUNCHER_RUN_OUTPUT_LINES);
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
    status: run.status,
    createdAt: run.createdAt,
    startedAt: run.startedAt,
    endedAt: run.endedAt,
    pid: run.pid,
    exitCode: run.exitCode,
    signal: run.signal,
    error: run.error,
    codexThreadId: run.codexThreadId ?? null,
    resumeCommand: run.resumeCommand ?? null,
    stopRequested: run.stopRequested,
    outputTail: run.outputTail
  };
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
  }

  const existingSessions = new Map(state.sessions.map((item) => [item.id, item]));
  for (const incoming of Array.isArray(snapshot.sessions) ? snapshot.sessions : []) {
    if (!incoming?.id) continue;
    const previous = existingSessions.get(incoming.id);
    if (previous) {
      Object.assign(previous, incoming);
    } else {
      state.sessions.push(incoming);
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

  if (incomingPendingIds.size > 0) {
    state.pendingInputs = state.pendingInputs.filter((item) => {
      if (!String(item.id || "").startsWith("pending:")) return true;
      return incomingPendingIds.has(item.id);
    });
  }

  const incomingDirectEventIds = new Set(
    (Array.isArray(snapshot.events) ? snapshot.events : [])
      .map((item) => item?.id)
      .filter((id) => typeof id === "string")
  );
  if (incomingDirectEventIds.size > 0) {
    state.events = state.events.filter((item) => {
      const id = String(item?.id || "");
      if (!id.startsWith("event:codex:") && !id.startsWith("event:claude:")) return true;
      return incomingDirectEventIds.has(id);
    });
  }

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

  if (snapshot.settings && typeof snapshot.settings === "object") {
    state.settings = {
      ...state.settings,
      ...snapshot.settings,
      darkLocked: true
    };
  }
}

app.get("/health", (_req, res) => {
  const activeRuns = [...launcherRuns.values()].filter((run) => run.status === "RUNNING").length;
  res.json({ ok: true, service: "agent-bridge", activeRuns });
});

app.get("/api/bootstrap", (_req, res) => {
  res.json({ ...state, source: "bridge" });
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
  const { pendingInputId, sessionId, type, text } = req.body || {};
  if (!pendingInputId || !sessionId || !type) {
    return res.status(400).json({ ok: false, error: "pendingInputId, sessionId, and type are required" });
  }

  const pending = state.pendingInputs.find((item) => item.id === pendingInputId && item.sessionId === sessionId);
  if (!pending) {
    return res.status(404).json({ ok: false, error: "pending input not found" });
  }
  const defaultActionable = !String(sessionId).startsWith("codex:") && !String(sessionId).startsWith("claude:");
  if (!safeBoolean(pending.actionable, defaultActionable)) {
    return res.status(409).json({
      ok: false,
      error: "pending input is not remotely actionable",
      hint: "Handle this approval directly in the local CLI session."
    });
  }

  const actionText =
    type === "APPROVE" ? "approve\n" : type === "REJECT" ? "reject\n" : `${String(text || "").trim()}\n`;
  const targetRun = [...launcherRuns.values()]
    .sort((a, b) => b.createdAt - a.createdAt)
    .find((run) => run.sessionId === sessionId && (run.status === "RUNNING" || run.status === "STARTING"));
  const actionDelivered = Boolean(
    targetRun?.child &&
      targetRun.child.stdin &&
      !targetRun.child.stdin.destroyed &&
      targetRun.child.stdin.writable
  );
  if (actionDelivered) {
    try {
      targetRun.child.stdin.write(actionText);
    } catch {
      // Keep state transition for UI even if transport fails.
    }
  }

  withPersist(() => {
    state.pendingInputs = state.pendingInputs.filter((item) => item.id !== pendingInputId);
    state.pendingHandledAt = {
      ...(state.pendingHandledAt && typeof state.pendingHandledAt === "object" ? state.pendingHandledAt : {}),
      [pendingInputId]: Date.now()
    };

    const session = findSession(sessionId);
    if (session) {
      session.lastUpdated = Date.now();

      if (type === "REJECT") {
        session.state = "CANCELLED";
      } else {
        session.state = "RUNNING";
        session.progress = Math.min(100, Math.max(0, safeNumber(session.progress, 0) + 3));
      }
    }

    const summary =
      type === "APPROVE"
        ? actionDelivered
          ? "Input approved from phone. Sent to running agent."
          : "Input approved from phone. Marked as resolved."
        : type === "REJECT"
          ? actionDelivered
            ? "Input rejected from phone. Sent to running agent."
            : "Input rejected from phone. Session cancelled."
          : `Text reply from phone${actionDelivered ? " sent to agent" : ""}: ${(text || "").trim() || "(empty)"}`;

    addEvent({ sessionId, summary, category: "ACTION", timestamp: Date.now() });
  });

  return res.json({ ok: true, delivered: actionDelivered });
});

app.use("/api/launcher", requireBridgeToken);

app.get("/api/launcher/config", (_req, res) => {
  return res.json({
    ok: true,
    bridgeUrl: BRIDGE_URL,
    tokenRequired: Boolean(BRIDGE_TOKEN),
    allowAnyWorkspace: ALLOW_ANY_WORKSPACE,
    workspaceRoots: WORKSPACE_ROOTS
  });
});

app.get("/api/launcher/workspaces", (req, res) => {
  const limit = Math.max(1, Math.min(200, safeInt(req.query?.limit, 80)));
  const workspaces = listWorkspaceCandidates(limit);
  return res.json({
    ok: true,
    allowAnyWorkspace: ALLOW_ANY_WORKSPACE,
    workspaceRoots: WORKSPACE_ROOTS,
    workspaces
  });
});

app.get("/api/launcher/runs", (_req, res) => {
  const runs = [...launcherRuns.values()]
    .sort((a, b) => b.createdAt - a.createdAt)
    .map((run) => serializeRun(run));

  return res.json({ ok: true, runs });
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

app.post("/api/settings/update", (req, res) => {
  withPersist(() => {
    state.settings = {
      ...state.settings,
      ...req.body,
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
  }, 3000);
});
