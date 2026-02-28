export type AgentType = "CODEX" | "CLAUDE";
export type BridgeMode = "LOCAL" | "REMOTE";

export type SessionState =
  | "RUNNING"
  | "WAITING_INPUT"
  | "COMPLETED"
  | "FAILED"
  | "CANCELLED";

export type ActionType = "APPROVE" | "REJECT" | "TEXT_REPLY";

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  costUsd: number;
}

export interface AgentSession {
  id: string;
  agentType: AgentType;
  title: string;
  repo: string;
  branch: string;
  state: SessionState;
  lastUpdated: number;
  progress: number;
  tokenUsage: TokenUsage;
}

export interface SessionEvent {
  id: string;
  sessionId: string;
  summary: string;
  timestamp: number;
  category: "INFO" | "ACTION" | "INPUT" | "ERROR";
}

export type ChatTurnRole = "USER" | "ASSISTANT";
export type ChatTurnKind = "MESSAGE" | "FINAL_OUTPUT" | "APPROVAL_ACTION";

export interface ChatTurn {
  id: string;
  sessionId: string;
  role: ChatTurnRole;
  kind: ChatTurnKind;
  text: string;
  createdAt: number;
  runId?: string | null;
  approvalId?: string | null;
  source?: string;
}

export interface SessionThreadSummary {
  id: string;
  turnCount: number;
  pendingApprovals: number;
  lastTurn?: ChatTurn | null;
  latestRun?: LauncherRun | null;
  thread?: {
    id: string;
    key: string;
    lookupKey: string;
    agentType: AgentType;
    workspacePath: string;
    repo: string;
    branch: string;
    title: string;
    normalizedTitle: string;
    createdAt: number;
    updatedAt: number;
    lastRunId: string | null;
    runCount: number;
    lastMessageAt: number;
  } | null;
  session?: AgentSession | null;
}

export interface PendingInput {
  id: string;
  sessionId: string;
  prompt: string;
  requestedAt: number;
  priority: "HIGH" | "MEDIUM" | "LOW";
  actionable?: boolean;
  source?: "BRIDGE" | "DIRECT" | string;
  meta?: PendingInputMeta | null;
}

export interface QuestionRequestOption {
  label: string;
  description?: string;
  value?: string;
}

export interface PendingInputMeta {
  kind?: string;
  planMode?: boolean;
  agentType?: AgentType;
  runId?: string | null;
  toolCall?: string | null;
  toolName?: string | null;
  questionRequest?: boolean;
  questionHeader?: string | null;
  questionOptions?: Array<QuestionRequestOption | string> | null;
  multiSelect?: boolean;
  [key: string]: unknown;
}

export interface UserAction {
  pendingInputId: string;
  sessionId: string;
  type: ActionType;
  text?: string;
}

export interface SettingsPrefs {
  criticalRealtime: boolean;
  digest: boolean;
  pairingHealthy: boolean;
  metadataOnly: boolean;
  darkLocked: boolean;
  networkOnline: boolean;
  workspaceRoot: string;
}

export interface Workspace {
  path: string;
  name: string;
  hasGit: boolean;
  score: number;
  lastModified: number;
}

export interface PreviewTunnel {
  id: string;
  deviceId: string;
  laptopId: string;
  label: string | null;
  target: string;
  createdAt: number;
  updatedAt: number;
  lastAccessedAt: number | null;
  expiresAt: number;
  connected: boolean;
  publicUrl: string;
}

export interface CreatePreviewInput {
  port?: number;
  targetUrl?: string;
  label?: string;
  expiresInSec?: number;
}

export interface SessionsSnapshot {
  sessions: AgentSession[];
  pendingInputs: PendingInput[];
  events: SessionEvent[];
  chatTurns?: ChatTurn[];
  runs?: LauncherRun[];
  sessionSummaries?: SessionThreadSummary[];
  settings?: SettingsPrefs;
  source?: string;
  snapshotVersion?: number;
}

export interface PairingConfig {
  mode: BridgeMode;
  relayBaseUrl: string;
  phoneToken: string;
  deviceId: string | null;
  phoneLabel: string | null;
  pairedAt: number;
}

export interface RemoteDeviceStatus {
  online: boolean;
  deviceId: string | null;
  deviceLabel: string | null;
  lastSeenAt: number | null;
}

export type LauncherRunStatus = "STARTING" | "RUNNING" | "COMPLETED" | "FAILED" | "STOPPED";

export interface LauncherRun {
  id: string;
  sessionId: string;
  agentType: AgentType;
  title: string;
  prompt: string;
  workspacePath: string;
  repo: string;
  branch: string;
  command?: string[];
  status: LauncherRunStatus;
  createdAt: number;
  startedAt: number | null;
  endedAt: number | null;
  pid: number | null;
  exitCode: number | null;
  signal?: string | null;
  error: string | null;
  codexThreadId?: string | null;
  claudeSessionId?: string | null;
  resumeCommand?: string | null;
  assistantFinalOutput?: string | null;
  stopRequested: boolean;
  fullWorkspaceAccess?: boolean;
  skipPermissions?: boolean;
  planMode?: boolean;
  outputTail: string[];
}

export interface LaunchTaskInput {
  agentType: AgentType;
  workspacePath: string;
  prompt: string;
  command?: string[];
  title?: string;
  sessionId?: string;
  newThread?: boolean;
  fullWorkspaceAccess?: boolean;
  skipPermissions?: boolean;
  planMode?: boolean;
}
