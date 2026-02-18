import { AgentSession, PendingInput, SessionEvent, SettingsPrefs } from "./types";

const now = Date.now();

export const initialSessions: AgentSession[] = [
  {
    id: "s_codex_01",
    agentType: "CODEX",
    title: "Refactor notification pipeline",
    repo: "agent-control-plane",
    branch: "feature/queue-replay",
    state: "RUNNING",
    lastUpdated: now - 20_000,
    progress: 62,
    tokenUsage: {
      promptTokens: 26_800,
      completionTokens: 18_250,
      totalTokens: 45_050,
      costUsd: 0.61
    }
  },
  {
    id: "s_claude_01",
    agentType: "CLAUDE",
    title: "Fix flaky websocket reconnect",
    repo: "agent-bridge",
    branch: "bugfix/retry-logic",
    state: "WAITING_INPUT",
    lastUpdated: now - 95_000,
    progress: 78,
    tokenUsage: {
      promptTokens: 18_110,
      completionTokens: 11_040,
      totalTokens: 29_150,
      costUsd: 0.43
    }
  },
  {
    id: "s_codex_02",
    agentType: "CODEX",
    title: "Add usage analytics endpoint",
    repo: "agent-api",
    branch: "feat/token-metrics",
    state: "COMPLETED",
    lastUpdated: now - 4_200_000,
    progress: 100,
    tokenUsage: {
      promptTokens: 32_002,
      completionTokens: 22_994,
      totalTokens: 54_996,
      costUsd: 0.78
    }
  },
  {
    id: "s_claude_02",
    agentType: "CLAUDE",
    title: "Tune mobile sync worker",
    repo: "agent-mobile-sync",
    branch: "perf/worker-batch",
    state: "FAILED",
    lastUpdated: now - 510_000,
    progress: 54,
    tokenUsage: {
      promptTokens: 14_912,
      completionTokens: 9_101,
      totalTokens: 24_013,
      costUsd: 0.31
    }
  },
  {
    id: "s_codex_03",
    agentType: "CODEX",
    title: "Harden auth middleware",
    repo: "agent-gateway",
    branch: "security/auth-hardening",
    state: "WAITING_INPUT",
    lastUpdated: now - 41_000,
    progress: 88,
    tokenUsage: {
      promptTokens: 21_300,
      completionTokens: 13_200,
      totalTokens: 34_500,
      costUsd: 0.47
    }
  },
  {
    id: "s_claude_03",
    agentType: "CLAUDE",
    title: "Write release changelog draft",
    repo: "agent-docs",
    branch: "chore/release-notes",
    state: "RUNNING",
    lastUpdated: now - 8_000,
    progress: 41,
    tokenUsage: {
      promptTokens: 7_920,
      completionTokens: 6_280,
      totalTokens: 14_200,
      costUsd: 0.19
    }
  }
];

export const initialPendingInputs: PendingInput[] = [
  {
    id: "p_01",
    sessionId: "s_claude_01",
    prompt: "Can I force exponential backoff max to 45s and ship?",
    requestedAt: now - 96_000,
    priority: "HIGH"
  },
  {
    id: "p_02",
    sessionId: "s_codex_03",
    prompt: "Allow JWT leeway to 30s for clock skew?",
    requestedAt: now - 39_000,
    priority: "MEDIUM"
  }
];

export const initialEvents: SessionEvent[] = [
  {
    id: "e_101",
    sessionId: "s_codex_01",
    summary: "Running integration tests on queue replay logic.",
    timestamp: now - 19_000,
    category: "INFO"
  },
  {
    id: "e_102",
    sessionId: "s_codex_01",
    summary: "Updated retry strategy for delayed mobile pushes.",
    timestamp: now - 125_000,
    category: "ACTION"
  },
  {
    id: "e_201",
    sessionId: "s_claude_01",
    summary: "Input requested: confirm retry cap before patch.",
    timestamp: now - 95_000,
    category: "INPUT"
  },
  {
    id: "e_202",
    sessionId: "s_claude_01",
    summary: "Potential duplicate reconnect observed under packet loss.",
    timestamp: now - 210_000,
    category: "ERROR"
  },
  {
    id: "e_301",
    sessionId: "s_codex_03",
    summary: "Input requested: JWT leeway policy clarification.",
    timestamp: now - 40_000,
    category: "INPUT"
  },
  {
    id: "e_401",
    sessionId: "s_claude_03",
    summary: "Drafted release note sections for API and UI.",
    timestamp: now - 7_000,
    category: "INFO"
  }
];

export const initialSettings: SettingsPrefs = {
  criticalRealtime: true,
  digest: true,
  pairingHealthy: true,
  metadataOnly: true,
  darkLocked: true,
  networkOnline: true
};
