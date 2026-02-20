const SESSION_STATES = new Set(["RUNNING", "WAITING_INPUT", "COMPLETED", "FAILED", "CANCELLED"]);
const EVENT_CATEGORIES = new Set(["INFO", "ACTION", "INPUT", "ERROR"]);
const TURN_ROLES = new Set(["USER", "ASSISTANT"]);
const TURN_KINDS = new Set(["MESSAGE", "FINAL_OUTPUT", "APPROVAL_ACTION"]);

function safeNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function safeTrimmedText(value, maxLength = 200) {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  if (!trimmed) return "";
  return trimmed.slice(0, maxLength);
}

function normalizeAgentType(value) {
  return value === "CLAUDE" ? "CLAUDE" : "CODEX";
}

function normalizeLookupText(value) {
  if (typeof value !== "string") return "";
  return value
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function normalizeTitleText(value) {
  return normalizeLookupText(value)
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeSessionState(value) {
  return SESSION_STATES.has(value) ? value : "RUNNING";
}

function normalizePriority(value) {
  return value === "HIGH" || value === "LOW" ? value : "MEDIUM";
}

function normalizeEventCategory(value) {
  return EVENT_CATEGORIES.has(value) ? value : "INFO";
}

function normalizeTurnRole(value) {
  return TURN_ROLES.has(value) ? value : "USER";
}

function normalizeTurnKind(value) {
  return TURN_KINDS.has(value) ? value : "MESSAGE";
}

function sanitizeTokenUsage(input, fallback = null) {
  const baseline = fallback && typeof fallback === "object" ? fallback : {};
  const promptTokens = safeNumber(input?.promptTokens, safeNumber(baseline.promptTokens, 0));
  const completionTokens = safeNumber(input?.completionTokens, safeNumber(baseline.completionTokens, 0));
  const totalTokens =
    safeNumber(input?.totalTokens, safeNumber(baseline.totalTokens, promptTokens + completionTokens)) ||
    promptTokens + completionTokens;
  const costUsd = safeNumber(input?.costUsd, safeNumber(baseline.costUsd, 0));

  return {
    promptTokens,
    completionTokens,
    totalTokens,
    costUsd
  };
}

function sanitizeSession(input, fallback = null) {
  const now = Date.now();
  const baseline = fallback && typeof fallback === "object" ? fallback : {};
  const title = safeTrimmedText(input?.title, 140) || safeTrimmedText(baseline.title, 140) || "Untitled session";
  const repo = safeTrimmedText(input?.repo, 120) || safeTrimmedText(baseline.repo, 120) || "unknown-repo";
  const branch = safeTrimmedText(input?.branch, 120) || safeTrimmedText(baseline.branch, 120) || "main";
  const progress = Math.max(0, Math.min(100, safeNumber(input?.progress, safeNumber(baseline.progress, 0))));

  return {
    id:
      safeTrimmedText(input?.id, 160) ||
      safeTrimmedText(baseline.id, 160) ||
      `session_${now}_${Math.floor(Math.random() * 1000)}`,
    agentType: normalizeAgentType(input?.agentType || baseline.agentType),
    title,
    repo,
    branch,
    state: normalizeSessionState(input?.state || baseline.state),
    lastUpdated: safeNumber(input?.lastUpdated, safeNumber(baseline.lastUpdated, now)),
    progress,
    tokenUsage: sanitizeTokenUsage(input?.tokenUsage, baseline.tokenUsage)
  };
}

function sanitizePendingInput(input) {
  const now = Date.now();
  const sessionId = safeTrimmedText(input?.sessionId, 160);
  if (!sessionId) return null;

  return {
    id:
      safeTrimmedText(input?.id, 160) ||
      `p_${now}_${Math.floor(Math.random() * 1000)}`,
    sessionId,
    prompt: safeTrimmedText(input?.prompt, 1000) || "Input requested",
    requestedAt: safeNumber(input?.requestedAt, now),
    priority: normalizePriority(input?.priority),
    actionable: typeof input?.actionable === "boolean" ? input.actionable : undefined,
    source: safeTrimmedText(input?.source, 32) || undefined,
    meta: input?.meta && typeof input.meta === "object" ? input.meta : null
  };
}

function sanitizeEvent(input) {
  const now = Date.now();
  const sessionId = safeTrimmedText(input?.sessionId, 160);
  if (!sessionId) return null;

  return {
    id:
      safeTrimmedText(input?.id, 160) ||
      `e_${now}_${Math.floor(Math.random() * 1000)}`,
    sessionId,
    summary: safeTrimmedText(input?.summary, 300) || "Event",
    timestamp: safeNumber(input?.timestamp, now),
    category: normalizeEventCategory(input?.category)
  };
}

function buildSessionThreadLookupKey(input) {
  const agentType = normalizeAgentType(input?.agentType);
  const normalizedTitle = normalizeTitleText(input?.title) || "untitled";
  const workspacePath = safeTrimmedText(input?.workspacePath, 500);
  const normalizedWorkspace = workspacePath
    ? workspacePath.toLowerCase()
    : `repo:${normalizeLookupText(input?.repo) || "unknown"}`;
  return `${agentType}|${normalizedWorkspace}|${normalizedTitle}`;
}

function sanitizeSessionThread(input, fallback = null) {
  const now = Date.now();
  const baseline = fallback && typeof fallback === "object" ? fallback : {};
  const title = safeTrimmedText(input?.title, 140) || safeTrimmedText(baseline.title, 140) || "Untitled session";
  const repo = safeTrimmedText(input?.repo, 120) || safeTrimmedText(baseline.repo, 120) || "unknown-repo";
  const branch = safeTrimmedText(input?.branch, 120) || safeTrimmedText(baseline.branch, 120) || "main";
  const workspacePath = safeTrimmedText(input?.workspacePath, 500) || safeTrimmedText(baseline.workspacePath, 500);
  const normalizedTitle = normalizeTitleText(input?.normalizedTitle || title) || "untitled";
  const lookupKey =
    safeTrimmedText(input?.lookupKey, 640) ||
    safeTrimmedText(input?.key, 640) ||
    safeTrimmedText(baseline.lookupKey, 640) ||
    safeTrimmedText(baseline.key, 640) ||
    buildSessionThreadLookupKey({
      agentType: input?.agentType || baseline.agentType,
      workspacePath,
      repo,
      title: normalizedTitle
    });

  return {
    id:
      safeTrimmedText(input?.id, 160) ||
      safeTrimmedText(baseline.id, 160) ||
      `session_${now}_${Math.floor(Math.random() * 1000)}`,
    key: safeTrimmedText(input?.key, 640) || safeTrimmedText(baseline.key, 640) || lookupKey,
    lookupKey,
    agentType: normalizeAgentType(input?.agentType || baseline.agentType),
    workspacePath,
    repo,
    branch,
    title,
    normalizedTitle,
    createdAt: safeNumber(input?.createdAt, safeNumber(baseline.createdAt, now)),
    updatedAt: safeNumber(input?.updatedAt, safeNumber(baseline.updatedAt, now)),
    lastRunId: safeTrimmedText(input?.lastRunId, 160) || safeTrimmedText(baseline.lastRunId, 160) || null,
    runCount: Math.max(0, Math.floor(safeNumber(input?.runCount, safeNumber(baseline.runCount, 0)))),
    lastMessageAt: safeNumber(input?.lastMessageAt, safeNumber(baseline.lastMessageAt, 0))
  };
}

function sanitizeChatTurn(input) {
  const now = Date.now();
  const sessionId = safeTrimmedText(input?.sessionId, 160);
  if (!sessionId) return null;

  const text = String(input?.text ?? "")
    .replace(/\u0000/g, "")
    .trim()
    .slice(0, 12_000);
  if (!text) return null;

  return {
    id:
      safeTrimmedText(input?.id, 180) ||
      `turn_${now}_${Math.floor(Math.random() * 1000)}`,
    sessionId,
    role: normalizeTurnRole(input?.role),
    kind: normalizeTurnKind(input?.kind),
    text,
    createdAt: safeNumber(input?.createdAt, now),
    runId: safeTrimmedText(input?.runId, 160) || null,
    approvalId: safeTrimmedText(input?.approvalId, 160) || null,
    source: safeTrimmedText(input?.source, 48) || "LEGACY"
  };
}

function createSession(id, agentType, title, repo, branch, state, lastUpdatedOffsetMs, progress, tokenUsage) {
  return sanitizeSession({
    id,
    agentType,
    title,
    repo,
    branch,
    state,
    lastUpdated: Date.now() - lastUpdatedOffsetMs,
    progress,
    tokenUsage
  });
}

function buildDefaultThreads(sessions) {
  return sessions.map((session) =>
    sanitizeSessionThread({
      id: session.id,
      key: buildSessionThreadLookupKey({
        agentType: session.agentType,
        workspacePath: "",
        repo: session.repo,
        title: session.title
      }),
      lookupKey: buildSessionThreadLookupKey({
        agentType: session.agentType,
        workspacePath: "",
        repo: session.repo,
        title: session.title
      }),
      agentType: session.agentType,
      workspacePath: "",
      repo: session.repo,
      branch: session.branch,
      title: session.title,
      normalizedTitle: normalizeTitleText(session.title),
      createdAt: session.lastUpdated,
      updatedAt: session.lastUpdated,
      runCount: 1,
      lastMessageAt: session.lastUpdated
    })
  );
}

export function buildDefaultState() {
  const now = Date.now();

  const sessions = [
    createSession(
      "s_codex_live_01",
      "CODEX",
      "Refactor notification pipeline",
      "agent-control-plane",
      "feature/queue-replay",
      "RUNNING",
      16_000,
      64,
      {
        promptTokens: 27120,
        completionTokens: 18340,
        totalTokens: 45460,
        costUsd: 0.62
      }
    ),
    createSession(
      "s_claude_live_01",
      "CLAUDE",
      "Fix websocket reconnect",
      "agent-bridge",
      "bugfix/retry-loop",
      "WAITING_INPUT",
      75_000,
      79,
      {
        promptTokens: 18110,
        completionTokens: 11040,
        totalTokens: 29150,
        costUsd: 0.43
      }
    ),
    createSession(
      "s_codex_live_02",
      "CODEX",
      "Token analytics API",
      "agent-api",
      "feat/token-metrics",
      "COMPLETED",
      4_300_000,
      100,
      {
        promptTokens: 32002,
        completionTokens: 22994,
        totalTokens: 54996,
        costUsd: 0.78
      }
    )
  ];

  const pendingInputs = [
    sanitizePendingInput({
      id: "p_live_01",
      sessionId: "s_claude_live_01",
      prompt: "Can I cap backoff at 45s and ship this patch?",
      requestedAt: now - 75_000,
      priority: "HIGH"
    })
  ].filter(Boolean);

  const events = [
    sanitizeEvent({
      id: "e_live_101",
      sessionId: "s_codex_live_01",
      summary: "Running integration tests on queue replay logic.",
      timestamp: now - 16_000,
      category: "INFO"
    }),
    sanitizeEvent({
      id: "e_live_201",
      sessionId: "s_claude_live_01",
      summary: "Input requested: confirm retry cap before patch.",
      timestamp: now - 75_000,
      category: "INPUT"
    }),
    sanitizeEvent({
      id: "e_live_301",
      sessionId: "s_codex_live_02",
      summary: "Session completed: endpoint + tests merged.",
      timestamp: now - 4_300_000,
      category: "ACTION"
    })
  ].filter(Boolean);

  const settings = {
    criticalRealtime: true,
    digest: true,
    pairingHealthy: true,
    metadataOnly: true,
    darkLocked: true,
    networkOnline: true
  };

  const sessionThreads = buildDefaultThreads(sessions);
  const chatTurns = [
    sanitizeChatTurn({
      id: "turn_live_01",
      sessionId: "s_claude_live_01",
      role: "ASSISTANT",
      kind: "FINAL_OUTPUT",
      text: "Can I cap backoff at 45s and ship this patch?",
      createdAt: now - 75_000,
      source: "LEGACY"
    })
  ].filter(Boolean);

  return {
    source: "bridge",
    sessions,
    sessionThreads,
    chatTurns,
    pendingInputs,
    events,
    pendingHandledAt: {},
    settings
  };
}

function sanitizePendingHandledAt(input) {
  if (!input || typeof input !== "object") return {};
  const out = {};
  for (const [key, value] of Object.entries(input)) {
    const id = safeTrimmedText(key, 180);
    if (!id) continue;
    const ts = safeNumber(value, 0);
    if (ts <= 0) continue;
    out[id] = ts;
  }
  return out;
}

export function sanitizeState(raw) {
  const fallback = buildDefaultState();

  if (!raw || typeof raw !== "object") {
    return fallback;
  }

  const candidate = raw;

  const sessions = (
    Array.isArray(candidate.sessions) ? candidate.sessions : fallback.sessions
  )
    .map((session) => sanitizeSession(session))
    .filter(Boolean);

  const pendingInputs = (
    Array.isArray(candidate.pendingInputs) ? candidate.pendingInputs : fallback.pendingInputs
  )
    .map((item) => sanitizePendingInput(item))
    .filter(Boolean);

  const events = (Array.isArray(candidate.events) ? candidate.events : fallback.events)
    .map((event) => sanitizeEvent(event))
    .filter(Boolean);

  const sessionThreadMap = new Map();
  const rawThreads = Array.isArray(candidate.sessionThreads) ? candidate.sessionThreads : [];
  for (const item of rawThreads) {
    const sanitized = sanitizeSessionThread(item);
    if (!sanitized) continue;
    sessionThreadMap.set(sanitized.id, sanitized);
  }

  for (const session of sessions) {
    if (sessionThreadMap.has(session.id)) continue;
    const derived = sanitizeSessionThread({
      id: session.id,
      agentType: session.agentType,
      workspacePath: "",
      repo: session.repo,
      branch: session.branch,
      title: session.title,
      normalizedTitle: normalizeTitleText(session.title),
      createdAt: session.lastUpdated,
      updatedAt: session.lastUpdated,
      runCount: 0,
      lastMessageAt: session.lastUpdated
    });
    sessionThreadMap.set(derived.id, derived);
  }

  const sessionThreads = [...sessionThreadMap.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  const knownSessionIds = new Set(sessionThreads.map((thread) => thread.id));

  const chatTurns = (Array.isArray(candidate.chatTurns) ? candidate.chatTurns : fallback.chatTurns)
    .map((turn) => sanitizeChatTurn(turn))
    .filter((turn) => Boolean(turn && knownSessionIds.has(turn.sessionId)))
    .sort((a, b) => a.createdAt - b.createdAt);

  return {
    source: "bridge",
    sessions,
    sessionThreads,
    chatTurns,
    pendingInputs,
    events,
    pendingHandledAt: sanitizePendingHandledAt(candidate.pendingHandledAt),
    settings:
      candidate.settings && typeof candidate.settings === "object"
        ? { ...fallback.settings, ...candidate.settings }
        : fallback.settings
  };
}
