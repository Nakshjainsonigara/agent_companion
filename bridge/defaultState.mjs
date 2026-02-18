function createSession(id, agentType, title, repo, branch, state, lastUpdatedOffsetMs, progress, tokenUsage) {
  return {
    id,
    agentType,
    title,
    repo,
    branch,
    state,
    lastUpdated: Date.now() - lastUpdatedOffsetMs,
    progress,
    tokenUsage
  };
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
    {
      id: "p_live_01",
      sessionId: "s_claude_live_01",
      prompt: "Can I cap backoff at 45s and ship this patch?",
      requestedAt: now - 75_000,
      priority: "HIGH"
    }
  ];

  const events = [
    {
      id: "e_live_101",
      sessionId: "s_codex_live_01",
      summary: "Running integration tests on queue replay logic.",
      timestamp: now - 16_000,
      category: "INFO"
    },
    {
      id: "e_live_201",
      sessionId: "s_claude_live_01",
      summary: "Input requested: confirm retry cap before patch.",
      timestamp: now - 75_000,
      category: "INPUT"
    },
    {
      id: "e_live_301",
      sessionId: "s_codex_live_02",
      summary: "Session completed: endpoint + tests merged.",
      timestamp: now - 4_300_000,
      category: "ACTION"
    }
  ];

  const settings = {
    criticalRealtime: true,
    digest: true,
    pairingHealthy: true,
    metadataOnly: true,
    darkLocked: true,
    networkOnline: true
  };

  return {
    source: "bridge",
    sessions,
    pendingInputs,
    events,
    pendingHandledAt: {},
    settings
  };
}

export function sanitizeState(raw) {
  const fallback = buildDefaultState();

  if (!raw || typeof raw !== "object") {
    return fallback;
  }

  const candidate = raw;

  return {
    source: "bridge",
    sessions: Array.isArray(candidate.sessions) ? candidate.sessions : fallback.sessions,
    pendingInputs: Array.isArray(candidate.pendingInputs)
      ? candidate.pendingInputs
      : fallback.pendingInputs,
    events: Array.isArray(candidate.events) ? candidate.events : fallback.events,
    pendingHandledAt:
      candidate.pendingHandledAt && typeof candidate.pendingHandledAt === "object"
        ? candidate.pendingHandledAt
        : {},
    settings:
      candidate.settings && typeof candidate.settings === "object"
        ? { ...fallback.settings, ...candidate.settings }
        : fallback.settings
  };
}
