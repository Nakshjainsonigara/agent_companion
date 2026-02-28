import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Clock3,
  Folder,
  FolderPlus,
  FolderGit2,
  LayoutDashboard,
  Link,
  ListChecks,
  Loader2,
  MessageSquare,
  Play,
  RefreshCw,
  Rocket,
  Send,
  Settings2,
  ShieldAlert,
  Square,
  TriangleAlert,
  Unlink,
  XCircle,
} from "lucide-react";
import {
  claimPairingCode,
  clearPairingConfig,
  createPreview,
  createWorkspace,
  DEFAULT_CLIENT_CONFIG,
  fetchDeviceStatus,
  fetchSessionRun,
  fetchSessionRuns,
  fetchSessionsSnapshot,
  fetchWorkspaces,
  launchTask,
  loadPairingConfig,
  savePairingConfig,
  sendSessionMessage,
  stopRun,
  submitBridgeAction,
  updateSettings,
  type ClientConfig,
  TokenExpiredError,
} from "./bridgeClient";
import { initialEvents, initialPendingInputs, initialSessions, initialSettings } from "./mockData";
import {
  type ActionType,
  type AgentSession,
  type AgentType,
  type ChatTurn,
  type ChatTurnKind,
  type LauncherRun,
  type LauncherRunStatus,
  type PairingConfig,
  type PendingInput,
  type QuestionRequestOption,
  type RemoteDeviceStatus,
  type SessionEvent,
  type SessionState,
  type SettingsPrefs,
  type Workspace,
} from "./types";
import { formatRelativeTime } from "./utils";
import { Badge } from "./components/ui/badge";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
import { Switch } from "./components/ui/switch";
import { cn } from "./lib/utils";

type Tab = "HOME" | "ACTIONS" | "RUN" | "SESSIONS" | "SETTINGS";
type AgentFilter = "ALL" | AgentType;
type StatusFilter = "ALL" | SessionState;
type RunThreadMode = "REUSE" | "NEW_CHAT";

type ContentBlock =
  | { type: "text"; text: string }
  | { type: "code"; lang: string; code: string }
  | { type: "step"; text: string }
  | { type: "list"; items: string[] };

type ConversationRow = {
  id: string;
  kind: "user" | "assistant" | "status";
  text: string;
  timestamp: number;
  agentType?: AgentType;
  turnKind?: ChatTurnKind;
};

const STATUS_LABEL: Record<SessionState, string> = {
  RUNNING: "Running",
  WAITING_INPUT: "Waiting",
  COMPLETED: "Completed",
  FAILED: "Failed",
  CANCELLED: "Cancelled",
};

const STATUS_BADGE = {
  RUNNING: "success",
  WAITING_INPUT: "warning",
  COMPLETED: "muted",
  FAILED: "danger",
  CANCELLED: "muted",
} as const;

const STATUS_ICON = {
  RUNNING: Activity,
  WAITING_INPUT: Clock3,
  COMPLETED: CheckCircle2,
  FAILED: TriangleAlert,
  CANCELLED: XCircle,
} as const;

const RUN_STATUS_LABEL: Record<LauncherRunStatus, string> = {
  STARTING: "Starting",
  RUNNING: "Running",
  COMPLETED: "Completed",
  FAILED: "Failed",
  STOPPED: "Stopped",
};

const RUN_STATUS_COLOR: Record<LauncherRunStatus, string> = {
  STARTING: "text-amber-400",
  RUNNING: "text-emerald-400",
  COMPLETED: "text-muted-foreground",
  FAILED: "text-rose-400",
  STOPPED: "text-muted-foreground",
};

const TAB_ITEMS: Array<{
  id: Tab;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
}> = [
  { id: "HOME", label: "Home", icon: LayoutDashboard },
  { id: "ACTIONS", label: "Actions", icon: ListChecks },
  { id: "RUN", label: "Run", icon: Rocket },
  { id: "SESSIONS", label: "Sessions", icon: MessageSquare },
  { id: "SETTINGS", label: "Settings", icon: Settings2 },
];

const FILTER_STATUS_ITEMS: StatusFilter[] = ["ALL", "RUNNING", "WAITING_INPUT", "COMPLETED", "FAILED", "CANCELLED"];
const AGENT_OPTIONS: Array<{ value: AgentType; label: string; color: string; bg: string }> = [
  { value: "CLAUDE", label: "Claude", color: "text-brand-claude", bg: "bg-brand-claude/15" },
  { value: "CODEX", label: "Codex", color: "text-brand-openai", bg: "bg-brand-openai/15" },
];

const FIXED_RELAY_URL = ((import.meta.env.VITE_RELAY_URL as string | undefined) || "https://agent-companion-relay.onrender.com").trim();

function App() {
  const [activeTab, setActiveTab] = useState<Tab>("HOME");
  const [sessions, setSessions] = useState<AgentSession[]>(initialSessions);
  const [pendingInputs, setPendingInputs] = useState<PendingInput[]>(initialPendingInputs);
  const [events, setEvents] = useState<SessionEvent[]>(initialEvents);
  const [chatTurns, setChatTurns] = useState<ChatTurn[]>([]);
  const [launcherRuns, setLauncherRuns] = useState<LauncherRun[]>([]);

  const [selectedSessionId, setSelectedSessionId] = useState<string>(initialSessions[0]?.id ?? "");
  const [showSessionDetail, setShowSessionDetail] = useState(false);

  const [sessionSearch, setSessionSearch] = useState("");
  const [sessionAgentFilter, setSessionAgentFilter] = useState<AgentFilter>("ALL");
  const [sessionStatusFilter, setSessionStatusFilter] = useState<StatusFilter>("ALL");
  const [showArchivedSessions, setShowArchivedSessions] = useState(false);

  const [busyActionIds, setBusyActionIds] = useState<string[]>([]);
  const [pendingReplyDrafts, setPendingReplyDrafts] = useState<Record<string, string>>({});
  const [pendingCustomOpen, setPendingCustomOpen] = useState<Set<string>>(new Set());
  const [toast, setToast] = useState<string | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [networkOnline, setNetworkOnline] = useState(navigator.onLine);
  const [settingsPrefs, setSettingsPrefs] = useState<SettingsPrefs>(initialSettings);
  const [workspaceRootDraft, setWorkspaceRootDraft] = useState(initialSettings.workspaceRoot);
  const [isSavingWorkspaceRoot, setIsSavingWorkspaceRoot] = useState(false);

  // Pairing state
  const [pairingConfig, setPairingConfig] = useState<PairingConfig | null>(() => {
    const stored = loadPairingConfig();
    if (stored?.mode !== "REMOTE") return null;
    if (isLocalRelayUrl(stored.relayBaseUrl)) return null;
    return stored;
  });
  const [deviceStatus, setDeviceStatus] = useState<RemoteDeviceStatus | null>(null);
  const [isPairing, setIsPairing] = useState(false);
  const [pairCode, setPairCode] = useState("");
  const [pairError, setPairError] = useState<string | null>(null);

  const [bridgeConnected, setBridgeConnected] = useState(false);

  // Run panel state
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [workspacesLoading, setWorkspacesLoading] = useState(false);
  const [workspacePickerOpen, setWorkspacePickerOpen] = useState(false);
  const [createWorkspaceOpen, setCreateWorkspaceOpen] = useState(false);
  const [newWorkspaceName, setNewWorkspaceName] = useState("");
  const [isCreatingWorkspace, setIsCreatingWorkspace] = useState(false);
  const [agentPickerOpen, setAgentPickerOpen] = useState(false);
  const [runSessionPickerOpen, setRunSessionPickerOpen] = useState(false);

  const [runAgentType, setRunAgentType] = useState<AgentType>("CLAUDE");
  const [runWorkspace, setRunWorkspace] = useState<Workspace | null>(null);
  const [runPrompt, setRunPrompt] = useState("");
  const [runTitle, setRunTitle] = useState("");
  const [runFullAccess, setRunFullAccess] = useState(false);
  const [runPlanMode, setRunPlanMode] = useState(false);
  const [showLaunchConfirm, setShowLaunchConfirm] = useState(false);
  const [isLaunching, setIsLaunching] = useState(false);
  const [runThreadMode, setRunThreadMode] = useState<RunThreadMode>("REUSE");
  const [runSessionTargetId, setRunSessionTargetId] = useState("");

  // Session detail composer
  const [sessionComposerDraft, setSessionComposerDraft] = useState("");
  const [isSendingFollowUp, setIsSendingFollowUp] = useState(false);

  const conversationEndRef = useRef<HTMLDivElement>(null);
  const liveRefreshInFlightRef = useRef(false);
  const liveRefreshSeqRef = useRef(0);

  const pairRelayUrl = FIXED_RELAY_URL;

  const clientConfig = useMemo<ClientConfig>(() => {
    if (pairingConfig?.mode === "REMOTE") {
      return {
        mode: "REMOTE",
        bridgeBaseUrl: "",
        bridgeToken: "",
        relayBaseUrl: pairingConfig.relayBaseUrl,
        phoneToken: pairingConfig.phoneToken,
        deviceId: pairingConfig.deviceId ?? "",
      };
    }
    return DEFAULT_CLIENT_CONFIG;
  }, [pairingConfig]);

  const isRemote = pairingConfig?.mode === "REMOTE";

  const hasActiveRuns = useMemo(
    () => launcherRuns.some((run) => run.status === "STARTING" || run.status === "RUNNING"),
    [launcherRuns]
  );

  const handleTokenExpired = useCallback(() => {
    setBridgeConnected(false);
    setDeviceStatus((previous) =>
      previous
        ? {
            ...previous,
            online: false
          }
        : previous
    );
    setToast("Relay auth failed. Keeping pairing and retrying.");
  }, []);

  const refreshLiveData = useCallback(
    async (options?: { force?: boolean }) => {
      if (!pairingConfig) return false;
      if (liveRefreshInFlightRef.current && !options?.force) {
        return false;
      }

      liveRefreshInFlightRef.current = true;
      const requestSeq = liveRefreshSeqRef.current + 1;
      liveRefreshSeqRef.current = requestSeq;
      const shouldForceLiveRuns = showSessionDetail || hasActiveRuns;
      const liveRunsPromise = shouldForceLiveRuns ? fetchSessionRuns(clientConfig) : null;

      try {
        const snapshot = await fetchSessionsSnapshot(clientConfig);
        if (requestSeq !== liveRefreshSeqRef.current) {
          return false;
        }
        if (!snapshot) {
          setBridgeConnected(false);
          return false;
        }

        setBridgeConnected(true);
        setSessions((previous) => (areSessionsEquivalent(previous, snapshot.sessions) ? previous : snapshot.sessions));
        setPendingInputs((previous) =>
          arePendingInputsEquivalent(previous, snapshot.pendingInputs) ? previous : snapshot.pendingInputs
        );
        setEvents((previous) => (areEventsEquivalent(previous, snapshot.events) ? previous : snapshot.events));
        setChatTurns((previous) => {
          const merged = mergeChatTurnsFromSnapshot(snapshot.chatTurns ?? [], previous, Date.now());
          return areChatTurnsEquivalent(previous, merged) ? previous : merged;
        });

        if (Array.isArray(snapshot.runs) && !shouldForceLiveRuns) {
          setLauncherRuns((previous) => (areRunsEquivalent(previous, snapshot.runs ?? []) ? previous : snapshot.runs ?? []));
        } else {
          try {
            const runs = liveRunsPromise ? await liveRunsPromise : await fetchSessionRuns(clientConfig);
            if (requestSeq !== liveRefreshSeqRef.current) return false;
            setLauncherRuns((previous) => (areRunsEquivalent(previous, runs) ? previous : runs));
          } catch (runsError) {
            if (runsError instanceof TokenExpiredError) {
              handleTokenExpired();
              return false;
            }
          }
        }

        if (snapshot.settings) {
          setSettingsPrefs((previous) => {
            const merged = { ...previous, ...snapshot.settings };
            return areSettingsEquivalent(previous, merged) ? previous : merged;
          });
          if (snapshot.settings.workspaceRoot) {
            setWorkspaceRootDraft((previous) => previous || snapshot.settings.workspaceRoot);
          }
        }
        return true;
      } catch (error) {
        if (error instanceof TokenExpiredError) {
          handleTokenExpired();
        }
        return false;
      } finally {
        if (requestSeq === liveRefreshSeqRef.current) {
          liveRefreshInFlightRef.current = false;
        }
      }
    },
    [pairingConfig, clientConfig, handleTokenExpired, showSessionDetail, hasActiveRuns]
  );

  useEffect(() => {
    const onOnline = () => setNetworkOnline(true);
    const onOffline = () => setNetworkOnline(false);
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    return () => {
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
    };
  }, []);

  useEffect(() => {
    if (!pairingConfig) return;

    let cancelled = false;
    let timer: number | null = null;

    const loop = async () => {
      if (cancelled) return;
      const ok = await refreshLiveData();
      if (!cancelled && !ok) {
        setBridgeConnected(false);
      }
      if (cancelled) return;

      const delay = showSessionDetail || hasActiveRuns ? 700 : 1800;
      timer = window.setTimeout(() => {
        void loop();
      }, delay);
    };

    void loop();
    return () => {
      cancelled = true;
      if (timer !== null) {
        window.clearTimeout(timer);
      }
    };
  }, [pairingConfig, refreshLiveData, showSessionDetail, hasActiveRuns]);

  useEffect(() => {
    if (pairingConfig?.mode !== "REMOTE") {
      setDeviceStatus(null);
      return;
    }

    let cancelled = false;
    const pollDevice = async () => {
      try {
        const status = await fetchDeviceStatus(clientConfig);
        if (!cancelled) {
          setDeviceStatus(status);
        }
      } catch (error) {
        if (error instanceof TokenExpiredError) {
          handleTokenExpired();
        }
      }
    };

    void pollDevice();
    const interval = window.setInterval(() => {
      void pollDevice();
    }, 10000);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [pairingConfig, clientConfig, handleTokenExpired]);

  useEffect(() => {
    if (activeTab !== "RUN" || !pairingConfig) return;

    let cancelled = false;
    setWorkspacesLoading(true);

    void (async () => {
      try {
        const nextWorkspaces = await fetchWorkspaces(clientConfig);
        if (cancelled) return;
        setWorkspaces(nextWorkspaces);
        setWorkspacesLoading(false);
        setRunWorkspace((prev) => prev ?? nextWorkspaces[0] ?? null);
      } catch (error) {
        setWorkspacesLoading(false);
        if (error instanceof TokenExpiredError) {
          handleTokenExpired();
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [activeTab, pairingConfig, clientConfig, handleTokenExpired]);

  useEffect(() => {
    const visible = dedupeSessionList(sessions, launcherRuns);
    setSelectedSessionId((prev) => {
      if (prev && visible.some((session) => session.id === prev)) {
        return prev;
      }
      if (prev && showSessionDetail) {
        return prev;
      }
      return visible[0]?.id ?? "";
    });
  }, [sessions, launcherRuns, showSessionDetail]);

  // Auto-scroll conversation to bottom on new messages
  useEffect(() => {
    if (showSessionDetail && conversationEndRef.current) {
      conversationEndRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [showSessionDetail, chatTurns.length, launcherRuns.length]);

  const visibleSessions = useMemo(() => dedupeSessionList(sessions, launcherRuns), [sessions, launcherRuns]);
  const reusableSessions = useMemo(
    () => visibleSessions.filter((session) => !isDirectSessionId(session.id)),
    [visibleSessions]
  );

  useEffect(() => {
    setRunSessionTargetId((prev) => {
      if (prev && reusableSessions.some((session) => session.id === prev)) {
        return prev;
      }
      if (selectedSessionId && reusableSessions.some((session) => session.id === selectedSessionId)) {
        return selectedSessionId;
      }
      return reusableSessions[0]?.id ?? "";
    });
  }, [reusableSessions, selectedSessionId]);

  useEffect(() => {
    if (!toast) return;
    const timeout = window.setTimeout(() => setToast(null), 2000);
    return () => window.clearTimeout(timeout);
  }, [toast]);

  useEffect(() => {
    if (workspacePickerOpen) return;
    setCreateWorkspaceOpen(false);
    setNewWorkspaceName("");
  }, [workspacePickerOpen]);

  const sessionById = useMemo(() => {
    const map = new Map<string, AgentSession>();
    for (const session of visibleSessions) {
      map.set(session.id, session);
    }
    return map;
  }, [visibleSessions]);

  const runsBySession = useMemo(() => {
    const map = new Map<string, LauncherRun[]>();
    for (const run of launcherRuns) {
      const current = map.get(run.sessionId) ?? [];
      current.push(run);
      map.set(run.sessionId, current);
    }
    for (const list of map.values()) {
      list.sort((a, b) => a.createdAt - b.createdAt);
    }
    return map;
  }, [launcherRuns]);

  const sessionRecencyById = useMemo(() => {
    const map = new Map<string, number>();
    for (const session of visibleSessions) {
      map.set(session.id, session.lastUpdated);
    }
    for (const run of launcherRuns) {
      const current = map.get(run.sessionId) ?? 0;
      map.set(run.sessionId, Math.max(current, getRunUpdatedAt(run)));
    }
    return map;
  }, [visibleSessions, launcherRuns]);

  const eventsBySession = useMemo(() => {
    const map = new Map<string, SessionEvent[]>();
    for (const event of events) {
      const current = map.get(event.sessionId) ?? [];
      current.push(event);
      map.set(event.sessionId, current);
    }
    for (const list of map.values()) {
      list.sort((a, b) => a.timestamp - b.timestamp);
    }
    return map;
  }, [events]);

  const turnsBySession = useMemo(() => {
    const map = new Map<string, ChatTurn[]>();
    for (const turn of chatTurns) {
      const current = map.get(turn.sessionId) ?? [];
      current.push(turn);
      map.set(turn.sessionId, current);
    }
    for (const list of map.values()) {
      list.sort((a, b) => a.createdAt - b.createdAt);
    }
    return map;
  }, [chatTurns]);

  const pendingBySession = useMemo(() => {
    const sorted = [...pendingInputs].sort((a, b) => {
      const weightDiff = priorityWeight(a.priority) - priorityWeight(b.priority);
      if (weightDiff !== 0) return weightDiff;
      return b.requestedAt - a.requestedAt;
    });

    const map = new Map<string, PendingInput>();
    for (const pending of sorted) {
      if (!map.has(pending.sessionId)) {
        map.set(pending.sessionId, pending);
      }
    }
    return map;
  }, [pendingInputs]);

  const selectedSession = selectedSessionId
    ? sessionById.get(selectedSessionId) ?? null
    : visibleSessions[0] ?? null;
  const selectedSessionRuns = selectedSession ? runsBySession.get(selectedSession.id) ?? [] : [];
  const selectedSessionTurns = selectedSession ? turnsBySession.get(selectedSession.id) ?? [] : [];
  const selectedSessionEvents = selectedSession ? eventsBySession.get(selectedSession.id) ?? [] : [];
  const selectedSessionPending = selectedSession ? pendingBySession.get(selectedSession.id) ?? null : null;
  const selectedSessionActiveRunId = useMemo(() => {
    if (!selectedSession || selectedSessionRuns.length === 0) return "";
    const active = [...selectedSessionRuns]
      .slice()
      .reverse()
      .find((run) => run.status === "STARTING" || run.status === "RUNNING");
    return active?.id || "";
  }, [selectedSession, selectedSessionRuns]);

  useEffect(() => {
    if (!pairingConfig) return;
    if (!showSessionDetail) return;
    if (!selectedSessionActiveRunId) return;

    let cancelled = false;
    let timer: number | null = null;

    const streamPoll = async () => {
      if (cancelled) return;
      try {
        const liveRun = await fetchSessionRun(clientConfig, selectedSessionActiveRunId);
        if (cancelled || !liveRun) return;
        setBridgeConnected(true);
        setLauncherRuns((previous) => {
          const currentIndex = previous.findIndex((item) => item.id === liveRun.id);
          if (currentIndex >= 0 && areRunsEquivalent([previous[currentIndex]], [liveRun])) {
            return previous;
          }

          const next = [...previous];
          if (currentIndex >= 0) {
            next[currentIndex] = liveRun;
          } else {
            next.push(liveRun);
          }
          next.sort((a, b) => getRunUpdatedAt(b) - getRunUpdatedAt(a));
          return next;
        });
      } catch (error) {
        if (error instanceof TokenExpiredError) {
          handleTokenExpired();
          return;
        }
      } finally {
        if (!cancelled) {
          timer = window.setTimeout(() => {
            void streamPoll();
          }, isRemote ? 420 : 220);
        }
      }
    };

    void streamPoll();
    return () => {
      cancelled = true;
      if (timer !== null) {
        window.clearTimeout(timer);
      }
    };
  }, [pairingConfig, showSessionDetail, selectedSessionActiveRunId, clientConfig, handleTokenExpired, isRemote]);

  const buildSessionContinueCommand = useCallback(
    (sessionId: string, prompt: string) => {
      const session = sessionById.get(sessionId);
      if (!session) return undefined;

      const runs = runsBySession.get(sessionId) ?? [];
      const latestRun = runs.length > 0 ? runs[runs.length - 1] : null;

      if (session.agentType === "CODEX") {
        const fromRun = latestRun ? getCodexThreadId(latestRun) : "";
        const fromSessionId = session.id.startsWith("codex:")
          ? session.id.slice("codex:".length).trim().toLowerCase()
          : "";
        const threadId = fromRun || fromSessionId;
        if (!threadId) return undefined;

        return ["codex", "exec", "resume", threadId, prompt];
      }

      const fromRun = latestRun ? getClaudeSessionId(latestRun) : "";
      const fromSessionId = session.id.startsWith("claude:")
        ? normalizeClaudeSessionId(session.id.slice("claude:".length))
        : "";
      const claudeSessionId = fromRun || fromSessionId;
      if (claudeSessionId) {
        return ["claude", "--resume", claudeSessionId, "-p", prompt, "--output-format", "stream-json"];
      }

      return ["claude", "--continue", "-p", prompt, "--output-format", "stream-json"];
    },
    [sessionById, runsBySession]
  );

  const sessionsSearchNormalized = sessionSearch.trim().toLowerCase();
  const filteredSessions = useMemo(() => {
    const list = visibleSessions.filter((session) => {
      if (sessionAgentFilter !== "ALL" && session.agentType !== sessionAgentFilter) return false;
      if (sessionStatusFilter !== "ALL" && session.state !== sessionStatusFilter) return false;
      if (!sessionsSearchNormalized) return true;

      const haystack = [session.title, session.repo, session.branch, session.id].join(" ").toLowerCase();
      return haystack.includes(sessionsSearchNormalized);
    });

    return list.sort(
      (a, b) =>
        (sessionRecencyById.get(b.id) ?? b.lastUpdated) - (sessionRecencyById.get(a.id) ?? a.lastUpdated)
    );
  }, [visibleSessions, sessionAgentFilter, sessionStatusFilter, sessionsSearchNormalized, sessionRecencyById]);

  const sectionActive = filteredSessions.filter((session) => session.state === "RUNNING");
  const sectionWaiting = filteredSessions.filter((session) => session.state === "WAITING_INPUT");
  const sectionArchived = filteredSessions.filter(
    (session) => session.state === "COMPLETED" || session.state === "FAILED" || session.state === "CANCELLED"
  );

  const counts = useMemo(
    () => ({
      running: visibleSessions.filter((session) => session.state === "RUNNING").length,
      waiting: visibleSessions.filter((session) => session.state === "WAITING_INPUT").length,
      completed: visibleSessions.filter((session) => session.state === "COMPLETED").length,
      failed: visibleSessions.filter((session) => session.state === "FAILED").length,
    }),
    [visibleSessions]
  );

  const recentRuns = useMemo(
    () => [...launcherRuns].sort((a, b) => getRunUpdatedAt(b) - getRunUpdatedAt(a)),
    [launcherRuns]
  );
  const primaryRuns = useMemo(() => collapseRunsBySession(recentRuns), [recentRuns]);

  const conversationRows = useMemo(
    () => buildConversationRows(selectedSessionRuns, selectedSessionTurns, selectedSessionEvents),
    [selectedSessionRuns, selectedSessionTurns, selectedSessionEvents]
  );

  const lastRunForSelectedSession = selectedSessionRuns.length > 0 ? selectedSessionRuns[selectedSessionRuns.length - 1] : null;
  const followUpContext = selectedSession
    ? resolveFollowUpContext(selectedSession, lastRunForSelectedSession, runWorkspace, workspaces)
    : null;

  const openSession = (sessionId: string) => {
    setSelectedSessionId(sessionId);
    setActiveTab("SESSIONS");
    setShowSessionDetail(true);
  };

  const handleConversationLinkOpen = useCallback(
    (href: string) => {
      const fallbackOpen = () => {
        window.open(href, "_blank", "noopener,noreferrer");
      };

      let parsed: URL;
      try {
        parsed = new URL(href);
      } catch {
        fallbackOpen();
        return;
      }

      const hostname = String(parsed.hostname || "").toLowerCase();
      const isLoopback = hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "0.0.0.0";
      if (!isLoopback) {
        fallbackOpen();
        return;
      }

      if (pairingConfig?.mode === "REMOTE") {
        setToast("Opening preview...");
        void (async () => {
          try {
            const preview = await createPreview(clientConfig, {
              targetUrl: parsed.toString(),
              label: selectedSession?.title || "Live Preview",
              expiresInSec: 2 * 60 * 60,
            });
            if (!preview?.publicUrl) {
              setToast("Unable to create preview link");
              return;
            }
            window.location.assign(preview.publicUrl);
          } catch (error) {
            if (error instanceof TokenExpiredError) {
              handleTokenExpired();
              return;
            }
            setToast("Unable to open localhost preview");
          }
        })();
        return;
      }

      const currentHost = String(window.location.hostname || "").toLowerCase();
      const currentIsLoopback =
        currentHost === "localhost" || currentHost === "127.0.0.1" || currentHost === "::1" || currentHost === "";
      if (!currentIsLoopback) {
        const remapped = new URL(parsed.toString());
        remapped.hostname = currentHost;
        if (!remapped.port) {
          remapped.port = window.location.port || remapped.port;
        }
        window.open(remapped.toString(), "_blank", "noopener,noreferrer");
        return;
      }

      setToast("localhost on phone points to phone. Pair remotely to open via relay preview.");
    },
    [clientConfig, handleTokenExpired, pairingConfig?.mode, selectedSession?.title]
  );

  const handleConversationFeedClickCapture = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      const target = event.target as HTMLElement | null;
      const anchor = target?.closest("a[href]") as HTMLAnchorElement | null;
      if (!anchor) return;
      const href = String(anchor.getAttribute("href") || "").trim();
      if (!href) return;
      event.preventDefault();
      handleConversationLinkOpen(href);
    },
    [handleConversationLinkOpen]
  );

  const triggerRefresh = () => {
    setIsRefreshing(true);
    void (async () => {
      await refreshLiveData({ force: true });
      setIsRefreshing(false);
      setToast("Updated");
    })();
  };

  const applyLocalActionState = (pending: PendingInput, type: ActionType, text?: string, resolvedVia?: string) => {
    setPendingInputs((prev) => prev.filter((item) => item.id !== pending.id));

    setSessions((prev) =>
      prev.map((session) => {
        if (session.id !== pending.sessionId) return session;
        if (type === "REJECT") {
          const nextState: SessionState =
            resolvedVia === "PLAN_REJECT"
              ? "COMPLETED"
              : resolvedVia === "CLAUDE_FOLLOW_UP"
                ? "RUNNING"
                : "CANCELLED";
          return {
            ...session,
            state: nextState,
            lastUpdated: Date.now(),
          };
        }

        return {
          ...session,
          state: "RUNNING",
          lastUpdated: Date.now(),
          progress: Math.min(100, session.progress + 3),
        };
      })
    );

    const summary = type === "APPROVE"
      ? resolvedVia === "PLAN_LAUNCH"
        ? "Plan approved from phone. Implementation run started."
        : "Approval sent from phone."
      : type === "REJECT"
        ? resolvedVia === "PLAN_REJECT"
          ? "Plan declined from phone."
          : "Rejected from phone."
        : `Reply sent from phone: ${text?.trim() || "(empty)"}`;

    setEvents((prev) => [
      ...prev,
      {
        id: `evt_${Date.now()}`,
        sessionId: pending.sessionId,
        summary,
        timestamp: Date.now(),
        category: "ACTION",
      },
    ]);
  };

  const handleAction = (pending: PendingInput, type: ActionType, text?: string) => {
    if (busyActionIds.includes(pending.id)) return;

    const actionable = pending.actionable !== false;
    if (!actionable) {
      setToast("This approval is read-only from phone.");
      return;
    }

    if (!networkOnline || !bridgeConnected) {
      setToast("Device offline. Try again when connected.");
      return;
    }

    setBusyActionIds((prev) => [...prev, pending.id]);

    void (async () => {
      try {
        const result = await submitBridgeAction(clientConfig, {
          pendingInputId: pending.id,
          sessionId: pending.sessionId,
          type,
          text,
        });

        setBusyActionIds((prev) => prev.filter((id) => id !== pending.id));

        if (!result?.ok) {
          setToast("Action failed");
          return;
        }

        applyLocalActionState(pending, type, text, result.resolvedVia);

        if (result.resolvedVia === "PLAN_LAUNCH") {
          setToast("Plan approved. Implementation started");
        } else if (result.resolvedVia === "PLAN_REJECT") {
          setToast("Plan declined");
        } else if (result.resolvedVia === "CLAUDE_FOLLOW_UP") {
          setToast(type === "APPROVE" ? "Approval sent. Claude resumed" : "Reply sent. Claude resumed");
        } else {
          setToast(type === "REJECT" ? "Rejected" : type === "APPROVE" ? "Approved" : "Reply sent");
        }
        void refreshLiveData({ force: true });
      } catch (error) {
        setBusyActionIds((prev) => prev.filter((id) => id !== pending.id));
        if (error instanceof TokenExpiredError) {
          handleTokenExpired();
          return;
        }
        setToast("Action failed");
      }
    })();
  };

  const updatePendingReplyDraft = (pendingId: string, value: string) => {
    setPendingReplyDrafts((previous) => ({ ...previous, [pendingId]: value }));
  };

  const selectQuestionOption = (pending: PendingInput, option: QuestionRequestOption) => {
    const value = String(option.value || option.label || "").trim();
    if (!value) {
      setToast("Invalid option");
      return;
    }
    handleAction(pending, "TEXT_REPLY", value);
    setPendingCustomOpen((prev) => {
      const next = new Set(prev);
      next.delete(pending.id);
      return next;
    });
  };

  const toggleCustomReply = (pendingId: string) => {
    setPendingCustomOpen((prev) => {
      const next = new Set(prev);
      if (next.has(pendingId)) {
        next.delete(pendingId);
      } else {
        next.add(pendingId);
      }
      return next;
    });
  };

  const submitPendingReply = (pending: PendingInput) => {
    const draft = String(pendingReplyDrafts[pending.id] || "").trim();
    if (!draft) {
      setToast("Type a reply first");
      return;
    }
    handleAction(pending, "TEXT_REPLY", draft);
    setPendingReplyDrafts((previous) => {
      const next = { ...previous };
      delete next[pending.id];
      return next;
    });
    setPendingCustomOpen((prev) => {
      const next = new Set(prev);
      next.delete(pending.id);
      return next;
    });
  };

  const handleSaveWorkspaceRoot = () => {
    if (isSavingWorkspaceRoot) return;
    const nextRoot = workspaceRootDraft.trim();
    if (!nextRoot) {
      setToast("Enter a folder path");
      return;
    }

    setIsSavingWorkspaceRoot(true);

    void (async () => {
      try {
        const updated = await updateSettings(clientConfig, {
          workspaceRoot: nextRoot,
        });
        setIsSavingWorkspaceRoot(false);

        if (!updated) {
          setToast("Unable to save location");
          return;
        }

        setSettingsPrefs((previous) => ({ ...previous, ...updated }));
        setWorkspaceRootDraft(updated.workspaceRoot || nextRoot);
        setToast("Default location saved");
      } catch (error) {
        setIsSavingWorkspaceRoot(false);
        if (error instanceof TokenExpiredError) {
          handleTokenExpired();
          return;
        }
        setToast("Unable to save location");
      }
    })();
  };

  const handleCreateWorkspace = () => {
    const name = newWorkspaceName.trim();
    if (!name || isCreatingWorkspace) return;
    if (!pairingConfig) return;

    const parentPath = workspaceRootDraft.trim() || settingsPrefs.workspaceRoot || "";

    setIsCreatingWorkspace(true);

    void (async () => {
      try {
        const workspace = await createWorkspace(clientConfig, {
          name,
          parentPath: parentPath || undefined,
        });
        setIsCreatingWorkspace(false);

        if (!workspace) {
          setToast("Workspace create failed");
          return;
        }

        setWorkspaces((previous) => {
          const next = [workspace, ...previous.filter((item) => item.path !== workspace.path)];
          next.sort((a, b) => b.lastModified - a.lastModified);
          return next;
        });
        setRunWorkspace(workspace);
        setNewWorkspaceName("");
        setCreateWorkspaceOpen(false);
        setToast("Workspace ready");
      } catch (error) {
        setIsCreatingWorkspace(false);
        if (error instanceof TokenExpiredError) {
          handleTokenExpired();
          return;
        }
        setToast("Workspace create failed");
      }
    })();
  };

  const handleLaunchTask = () => {
    if (!runWorkspace || !runPrompt.trim() || isLaunching) return;

    if (runPlanMode && runFullAccess) {
      setToast("Plan mode and full access cannot be combined.");
      return;
    }

    if (runFullAccess && !showLaunchConfirm) {
      setShowLaunchConfirm(true);
      return;
    }

    setShowLaunchConfirm(false);
    setIsLaunching(true);

    const shouldReuse = runThreadMode === "REUSE";
    const targetSessionId = shouldReuse ? runSessionTargetId || selectedSessionId : "";
    const launchPrompt = runPrompt.trim();

    if (shouldReuse && !targetSessionId) {
      setToast("Pick a session target or choose New Chat.");
      setIsLaunching(false);
      return;
    }

    if (shouldReuse && isDirectSessionId(targetSessionId)) {
      setToast("Direct local sessions cannot be reused from Run. Use New Chat.");
      setIsLaunching(false);
      return;
    }

    const launchNow = Date.now();
    const optimisticRunId = `optimistic_run_${launchNow}_${Math.floor(Math.random() * 1000)}`;
    const optimisticSessionId = shouldReuse
      ? targetSessionId
      : `optimistic_session_${launchNow}_${Math.floor(Math.random() * 1000)}`;
    const optimisticTitle = runTitle.trim() || launchPrompt.slice(0, 120) || `${runAgentType} local task`;
    const optimisticRun: LauncherRun = {
      id: optimisticRunId,
      sessionId: optimisticSessionId,
      agentType: runAgentType,
      title: optimisticTitle,
      prompt: launchPrompt,
      workspacePath: runWorkspace.path,
      repo: runWorkspace.name || "workspace",
      branch: "main",
      command: shouldReuse && targetSessionId ? buildSessionContinueCommand(targetSessionId, launchPrompt) : undefined,
      status: "STARTING",
      createdAt: launchNow,
      startedAt: null,
      endedAt: null,
      pid: null,
      exitCode: null,
      signal: null,
      error: null,
      stopRequested: false,
      outputTail: [],
      fullWorkspaceAccess: runFullAccess || undefined,
      planMode: runPlanMode || undefined,
    };

    setLauncherRuns((previous) => {
      const next = [...previous.filter((item) => item.id !== optimisticRunId), optimisticRun];
      next.sort((a, b) => getRunUpdatedAt(b) - getRunUpdatedAt(a));
      return next;
    });
    if (!shouldReuse) {
      setSessions((previous) => {
        if (previous.some((session) => session.id === optimisticSessionId)) {
          return previous;
        }
        return [
          {
            id: optimisticSessionId,
            agentType: runAgentType,
            title: optimisticTitle,
            repo: runWorkspace.name || "workspace",
            branch: "main",
            state: "RUNNING",
            lastUpdated: launchNow,
            progress: 2,
            tokenUsage: {
              promptTokens: 0,
              completionTokens: 0,
              totalTokens: 0,
              costUsd: 0,
            },
          },
          ...previous,
        ];
      });
    }

    void (async () => {
      try {
        const run = await launchTask(clientConfig, {
          agentType: runAgentType,
          workspacePath: runWorkspace.path,
          prompt: launchPrompt,
          command: shouldReuse && targetSessionId ? buildSessionContinueCommand(targetSessionId, launchPrompt) : undefined,
          title: runTitle.trim() || undefined,
          sessionId: shouldReuse ? targetSessionId : undefined,
          newThread: !shouldReuse || undefined,
          fullWorkspaceAccess: runFullAccess || undefined,
          planMode: runPlanMode || undefined,
        });

        setIsLaunching(false);

        if (!run) {
          setLauncherRuns((previous) => previous.filter((item) => item.id !== optimisticRunId));
          if (!shouldReuse) {
            setSessions((previous) => previous.filter((session) => session.id !== optimisticSessionId));
          }
          setToast("Launch failed");
          return;
        }

        setRunPrompt("");
        setRunTitle("");
        setRunPlanMode(false);

        setSelectedSessionId(run.sessionId);
        setRunSessionTargetId(run.sessionId);

        setLauncherRuns((previous) => {
          const next = [...previous.filter((item) => item.id !== run.id && item.id !== optimisticRunId), run];
          next.sort((a, b) => getRunUpdatedAt(b) - getRunUpdatedAt(a));
          return next;
        });
        setSessions((previous) => {
          const sanitized = previous.filter((session) => session.id !== optimisticSessionId);
          const now = Date.now();
          const existing = sanitized.find((session) => session.id === run.sessionId);
          const nextSession: AgentSession = existing
            ? {
                ...existing,
                agentType: run.agentType,
                title: run.title || existing.title,
                repo: run.repo || existing.repo,
                branch: run.branch || existing.branch,
                state: "RUNNING",
                progress: Math.max(existing.progress, 4),
                lastUpdated: Math.max(existing.lastUpdated, getRunUpdatedAt(run), now),
              }
            : {
                id: run.sessionId,
                agentType: run.agentType,
                title: run.title || run.prompt || "Untitled session",
                repo: run.repo || "unknown-repo",
                branch: run.branch || "main",
                state: "RUNNING",
                progress: 4,
                lastUpdated: Math.max(getRunUpdatedAt(run), now),
                tokenUsage: {
                  promptTokens: 0,
                  completionTokens: 0,
                  totalTokens: 0,
                  costUsd: 0,
                },
              };

          if (!existing) {
            return [nextSession, ...sanitized];
          }

          return sanitized.map((session) => (session.id === run.sessionId ? nextSession : session));
        });

        void refreshLiveData({ force: true });
        setToast(shouldReuse ? "Continued session" : "New chat started");
      } catch (error) {
        setIsLaunching(false);
        setLauncherRuns((previous) => previous.filter((item) => item.id !== optimisticRunId));
        if (!shouldReuse) {
          setSessions((previous) => previous.filter((session) => session.id !== optimisticSessionId));
        }
        if (error instanceof TokenExpiredError) {
          handleTokenExpired();
          return;
        }
        setToast("Launch failed");
      }
    })();
  };

  const handleStopRun = (runId: string) => {
    void (async () => {
      try {
        const ok = await stopRun(clientConfig, runId);
        if (!ok) {
          setToast("Unable to stop run");
          return;
        }
        setToast("Stop requested");
        await refreshLiveData({ force: true });
      } catch (error) {
        if (error instanceof TokenExpiredError) {
          handleTokenExpired();
          return;
        }
        setToast("Unable to stop run");
      }
    })();
  };

  const handleSendSessionFollowUp = () => {
    if (!selectedSession || !followUpContext) return;
    if (!sessionComposerDraft.trim() || isSendingFollowUp) return;

    const draft = sessionComposerDraft.trim();
    const now = Date.now();
    const optimisticTurnId = `optimistic:${selectedSession.id}:${now}:${Math.floor(Math.random() * 1000)}`;

    setSessionComposerDraft("");
    setChatTurns((prev) => [
      ...prev,
      {
        id: optimisticTurnId,
        sessionId: selectedSession.id,
        role: "USER",
        kind: "MESSAGE",
        text: draft,
        createdAt: now,
        runId: null,
        approvalId: null,
        source: "UI_OPTIMISTIC",
      },
    ]);
    setSessions((prev) =>
      prev.map((session) =>
        session.id === selectedSession.id
          ? {
              ...session,
              state: "RUNNING",
              lastUpdated: now,
              progress: Math.max(8, session.progress),
            }
          : session
      )
    );

    setIsSendingFollowUp(true);

    void (async () => {
      try {
        const activeRun = [...selectedSessionRuns]
          .slice()
          .reverse()
          .find((run) => run.status === "STARTING" || run.status === "RUNNING");
        const canSendToActiveRun = Boolean(activeRun && selectedSession.agentType === "CODEX");
        let fallbackReason: "NONE" | "NOT_DELIVERED" | "SEND_FAILED" = "NONE";

        if (canSendToActiveRun) {
          try {
            const sent = await sendSessionMessage(clientConfig, {
              sessionId: selectedSession.id,
              text: draft,
            });

            if (sent?.ok && sent.delivered) {
              setIsSendingFollowUp(false);
              void refreshLiveData({ force: true });
              setToast("Follow-up sent");
              return;
            }
            fallbackReason = "NOT_DELIVERED";
          } catch {
            fallbackReason = "SEND_FAILED";
          }
        }

        const run = await launchTask(clientConfig, {
          agentType: followUpContext.agentType,
          workspacePath: followUpContext.workspacePath,
          sessionId: selectedSession.id,
          title: selectedSession.title,
          prompt: draft,
          command: buildSessionContinueCommand(selectedSession.id, draft),
          fullWorkspaceAccess: followUpContext.fullWorkspaceAccess,
          planMode: false,
        });

        setIsSendingFollowUp(false);

        if (!run) {
          setChatTurns((prev) => prev.filter((turn) => turn.id !== optimisticTurnId));
          setSessionComposerDraft(draft);
          setToast("Unable to send follow-up");
          return;
        }

        setSelectedSessionId(run.sessionId);
        setRunSessionTargetId(run.sessionId);

        setLauncherRuns((prev) => {
          const next = [...prev.filter((item) => item.id !== run.id), run];
          next.sort((a, b) => getRunUpdatedAt(b) - getRunUpdatedAt(a));
          return next;
        });
        setSessions((prev) =>
          prev.map((session) =>
            session.id === run.sessionId
              ? {
                  ...session,
                  state: "RUNNING",
                  lastUpdated: Math.max(session.lastUpdated, getRunUpdatedAt(run)),
                  progress: Math.max(session.progress, 10),
                }
              : session
          )
        );

        void refreshLiveData({ force: true });
        if (!canSendToActiveRun) {
          setToast("Follow-up sent");
        } else if (fallbackReason === "SEND_FAILED") {
          setToast("Follow-up resumed in new run");
        } else if (fallbackReason === "NOT_DELIVERED") {
          setToast("Follow-up resumed in new run");
        } else {
          setToast("Follow-up sent");
        }
      } catch (error) {
        setIsSendingFollowUp(false);
        setChatTurns((prev) => prev.filter((turn) => turn.id !== optimisticTurnId));
        setSessionComposerDraft(draft);
        if (error instanceof TokenExpiredError) {
          handleTokenExpired();
          return;
        }
        setToast("Unable to send follow-up");
      }
    })();
  };

  const handlePair = () => {
    const code = pairCode.trim().toUpperCase();
    if (code.length < 6 || isPairing) return;

    setIsPairing(true);
    setPairError(null);

    void (async () => {
      const result = await claimPairingCode(pairRelayUrl, code);
      setIsPairing(false);

      if (!result.ok) {
        const messages: Record<string, string> = {
          INVALID_CODE: "Invalid pairing code.",
          EXPIRED: "Code expired. Generate a new one on laptop.",
          NETWORK_ERROR: "Cannot reach relay server.",
          UNKNOWN: "Pairing failed.",
        };
        setPairError(messages[result.error] ?? "Pairing failed.");
        return;
      }

      const config: PairingConfig = {
        mode: "REMOTE",
        relayBaseUrl: pairRelayUrl,
        phoneToken: result.phoneToken,
        deviceId: result.deviceId,
        phoneLabel: null,
        pairedAt: Date.now(),
      };

      savePairingConfig(config);
      setPairingConfig(config);
      setPairCode("");
      setPairError(null);
      setToast("Paired");
    })();
  };

  const handleUnpair = () => {
    clearPairingConfig();
    setPairingConfig(null);
    setDeviceStatus(null);
  };

  if (!pairingConfig) {
    return (
      <PairingScreen
        relayUrl={pairRelayUrl}
        code={pairCode}
        onCodeChange={setPairCode}
        error={pairError}
        isPairing={isPairing}
        onPair={handlePair}
      />
    );
  }

  const laptopOnline = isRemote ? Boolean(deviceStatus?.online) : bridgeConnected;
  const showBottomNav = !(activeTab === "SESSIONS" && showSessionDetail);
  const lastSeenText =
    isRemote && deviceStatus?.lastSeenAt
      ? Date.now() - deviceStatus.lastSeenAt < 60_000
        ? "Last seen <1m ago"
        : `Last seen ${Math.round((Date.now() - deviceStatus.lastSeenAt) / 60_000)}m ago`
      : null;

  return (
    <div className="relative min-h-screen bg-background text-foreground">
      <div
        className={cn(
          "mx-auto w-full max-w-lg px-5 pt-[max(env(safe-area-inset-top),16px)]",
          showBottomNav ? "pb-28" : "pb-4"
        )}
      >
        <header className="flex items-center justify-between pb-4">
          <div className="flex items-baseline gap-0">
            <span className="font-space text-base font-bold tracking-tight text-brand-claude">agent</span>
            <span className="font-space text-base font-bold tracking-tight text-muted-foreground/30">.</span>
            <span className="font-space text-base font-bold tracking-tight text-foreground/60">companion</span>
            <span
              className={cn(
                "ml-2 inline-block h-1.5 w-1.5 rounded-full",
                laptopOnline && networkOnline ? "bg-emerald-400 animate-pulse-soft" : "bg-rose-400"
              )}
            />
          </div>

          <button
            onClick={triggerRefresh}
            disabled={isRefreshing}
            className="flex h-7 w-7 items-center justify-center rounded-full text-muted-foreground/50 transition hover:bg-white/[0.05] hover:text-foreground active:scale-95 disabled:opacity-40"
          >
            {isRefreshing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
          </button>
        </header>

        {isRemote && deviceStatus && !deviceStatus.online && (
          <div className="mb-4 rounded-xl bg-amber-500/[0.06] px-3 py-2 text-[11px] text-amber-400/80">
            Laptop offline{lastSeenText ? ` (${lastSeenText.toLowerCase()})` : ""}
          </div>
        )}

        {!networkOnline && (
          <div className="mb-4 rounded-xl bg-rose-500/[0.06] px-3 py-2 text-[11px] text-rose-400/80">
            Phone offline
          </div>
        )}

        {activeTab === "HOME" && (
          <div className="animate-fade-in">
            <div className="grid grid-cols-4 gap-2">
              <StatTile value={counts.running} label="Active" icon={Activity} accent="openai" />
              <StatTile value={counts.waiting} label="Waiting" icon={Clock3} accent="warning" />
              <StatTile value={counts.completed} label="Done" icon={CheckCircle2} />
              <StatTile value={counts.failed} label="Failed" icon={TriangleAlert} accent="danger" />
            </div>

            <div className="my-5 border-b border-white/[0.04]" />

            <SectionHeader title="Recent Sessions" />
            <div className="mt-3 space-y-1">
              {visibleSessions.length === 0 ? (
                <EmptyState message="No sessions yet." />
              ) : (
                visibleSessions
                  .slice()
                  .sort(
                    (a, b) =>
                      (sessionRecencyById.get(b.id) ?? b.lastUpdated) - (sessionRecencyById.get(a.id) ?? a.lastUpdated)
                  )
                  .slice(0, 5)
                  .map((session) => (
                    <SessionRow
                      key={session.id}
                      session={session}
                      pending={pendingBySession.get(session.id) ?? null}
                      preview={extractSessionPreview(
                        turnsBySession.get(session.id) ?? [],
                        runsBySession.get(session.id) ?? [],
                        eventsBySession.get(session.id) ?? []
                      )}
                      onOpen={() => openSession(session.id)}
                    />
                  ))
              )}
            </div>

            <div className="my-5 border-b border-white/[0.04]" />

            <SectionHeader title="Latest Runs" />
            <div className="mt-3 space-y-2">
              {primaryRuns.length === 0 ? (
                <EmptyState message="No runs yet." />
              ) : (
                primaryRuns.slice(0, 3).map((run) => (
                  <RunCard key={run.id} run={run} onOpenSession={openSession} onStop={handleStopRun} />
                ))
              )}
            </div>
          </div>
        )}

        {activeTab === "ACTIONS" && (
          <div className="animate-fade-in">
            <div className="flex items-center justify-between">
              <SectionHeader title="Actions" />
              {pendingInputs.length > 0 && (
                <span className="flex h-5 w-5 items-center justify-center rounded-full bg-amber-400/15 text-[10px] font-bold text-amber-400">
                  {pendingInputs.length}
                </span>
              )}
            </div>

            <div className="mt-3">
              {pendingInputs.length === 0 ? (
                <EmptyState message="No pending approvals." />
              ) : (
                <div className="space-y-2">
                  {[...pendingInputs]
                    .sort((a, b) => {
                      const weight = priorityWeight(a.priority) - priorityWeight(b.priority);
                      if (weight !== 0) return weight;
                      return b.requestedAt - a.requestedAt;
                    })
                    .map((pending) => {
                      const session = sessionById.get(pending.sessionId) ?? null;
                      const busy = busyActionIds.includes(pending.id);
                      const actionable = pending.actionable !== false;
                      const pendingKind = getPendingKind(pending);
                      const isQuestionRequest = pendingKind === "QUESTION_REQUEST";
                      const toolLabel = getPendingToolLabel(pending);
                      const questionHeader = getPendingQuestionHeader(pending);
                      const questionOptions = getPendingQuestionOptions(pending);
                      const replyDraft = String(pendingReplyDrafts[pending.id] || "");

                      return (
                        <article key={pending.id} className="rounded-2xl border border-white/[0.06] bg-white/[0.02] px-3 py-3">
                          <div className="flex items-start justify-between gap-3">
                            <div>
                              <p className="text-[12px] font-semibold text-foreground/90">{session?.title ?? pending.sessionId}</p>
                              <div className="mt-1 flex flex-wrap items-center gap-1.5">
                                {pendingKind === "TOOL_PERMISSION" && (
                                  <span className="rounded-full bg-brand-openai/15 px-2 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-brand-openai">
                                    Tool Call
                                  </span>
                                )}
                                {pendingKind === "PLAN_CONFIRM" && (
                                  <span className="rounded-full bg-brand-claude/15 px-2 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-brand-claude">
                                    Plan Confirm
                                  </span>
                                )}
                                {pendingKind === "QUESTION_REQUEST" && (
                                  <span className="rounded-full bg-amber-400/15 px-2 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-amber-400">
                                    Question
                                  </span>
                                )}
                                {toolLabel && (
                                  <span className="rounded-full bg-white/[0.08] px-2 py-0.5 text-[9px] font-medium text-foreground/70">
                                    {toolLabel}
                                  </span>
                                )}
                              </div>
                              {questionHeader ? (
                                <p className="mt-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground/45">
                                  {questionHeader}
                                </p>
                              ) : null}
                              <p className="mt-1 text-[12px] leading-snug text-foreground/70">{pending.prompt}</p>
                            </div>
                            <span
                              className={cn(
                                "rounded-full px-2 py-0.5 text-[9px] font-semibold uppercase tracking-wider",
                                pending.priority === "HIGH"
                                  ? "bg-amber-400/15 text-amber-400"
                                  : pending.priority === "MEDIUM"
                                    ? "bg-brand-claude/15 text-brand-claude"
                                    : "bg-white/[0.08] text-muted-foreground"
                              )}
                            >
                              {pending.priority}
                            </span>
                          </div>

                          {isQuestionRequest ? (
                            <div className="mt-3 space-y-1.5">
                                  {questionOptions.map((option, idx) => (
                                    <button
                                      key={`${pending.id}:opt:${idx}`}
                                      type="button"
                                      onClick={() => selectQuestionOption(pending, option)}
                                  disabled={busy || !actionable}
                                  className="flex w-full items-start gap-2 rounded-lg border border-white/[0.06] bg-white/[0.02] px-3 py-2 text-left transition hover:border-amber-400/25 hover:bg-amber-400/[0.04] active:bg-amber-400/[0.08] disabled:opacity-35"
                                    >
                                      <span className="shrink-0 rounded bg-white/[0.08] px-1.5 py-0.5 text-[10px] font-bold text-muted-foreground/60">
                                        {idx + 1}
                                      </span>
                                      <span className="min-w-0">
                                        <span className="block text-[12px] leading-snug text-foreground/84">{option.label}</span>
                                        {option.description ? (
                                          <span className="mt-0.5 block text-[10px] leading-snug text-muted-foreground/45">
                                            {option.description}
                                          </span>
                                        ) : null}
                                      </span>
                                    </button>
                                  ))}

                              {/* "Type your own" toggle */}
                              {!pendingCustomOpen.has(pending.id) ? (
                                <button
                                  type="button"
                                  onClick={() => toggleCustomReply(pending.id)}
                                  disabled={busy || !actionable}
                                  className="flex w-full items-center gap-2 rounded-lg border border-dashed border-white/[0.08] px-3 py-2 text-left transition hover:border-white/[0.15] hover:bg-white/[0.02] disabled:opacity-35"
                                >
                                  <span className="shrink-0 rounded bg-white/[0.08] px-1.5 py-0.5 text-[10px] font-bold text-muted-foreground/60">
                                    ✎
                                  </span>
                                  <span className="text-[12px] text-muted-foreground/60">Type your own…</span>
                                </button>
                              ) : (
                                <div className="rounded-lg border border-white/[0.08] bg-white/[0.02] p-2.5">
                                  <textarea
                                    rows={2}
                                    value={replyDraft}
                                    onChange={(event) => updatePendingReplyDraft(pending.id, event.target.value)}
                                    onKeyDown={(event) => {
                                      if (event.key === "Enter" && !event.shiftKey) {
                                        event.preventDefault();
                                        submitPendingReply(pending);
                                      }
                                    }}
                                    placeholder="Type your reply…"
                                    className="w-full resize-none bg-transparent text-[12px] text-foreground placeholder:text-muted-foreground/30 focus:outline-none"
                                    disabled={busy || !actionable}
                                    autoFocus
                                  />
                                  <div className="mt-2 flex items-center gap-2">
                                    <Button
                                      size="sm"
                                      className="flex-1"
                                      onClick={() => submitPendingReply(pending)}
                                      disabled={busy || !actionable || !replyDraft.trim()}
                                    >
                                      Send
                                    </Button>
                                    <Button size="sm" variant="ghost" onClick={() => toggleCustomReply(pending.id)}>
                                      Cancel
                                    </Button>
                                  </div>
                                </div>
                              )}

                              <div className="pt-1">
                                <Button size="sm" variant="ghost" onClick={() => openSession(pending.sessionId)}>
                                  Open Session
                                </Button>
                              </div>
                            </div>
                          ) : (
                            <div className="mt-3 flex items-center gap-2">
                              <Button
                                size="sm"
                                className="flex-1"
                                onClick={() => handleAction(pending, "APPROVE")}
                                disabled={busy || !actionable}
                              >
                                Approve
                              </Button>
                              <Button
                                size="sm"
                                variant="outline"
                                className="flex-1"
                                onClick={() => handleAction(pending, "REJECT")}
                                disabled={busy || !actionable}
                              >
                                Reject
                              </Button>
                              <Button size="sm" variant="ghost" onClick={() => openSession(pending.sessionId)}>
                                Open
                              </Button>
                            </div>
                          )}

                          {!actionable && (
                            <p className="mt-2 text-[11px] text-amber-400/80">This approval is view-only from phone.</p>
                          )}
                        </article>
                      );
                    })}
                </div>
              )}
            </div>
          </div>
        )}

        {activeTab === "RUN" && (
          <div className="animate-fade-in">
            {!laptopOnline ? (
              <EmptyState message="Laptop offline. Connect laptop to launch runs." />
            ) : (
              <>
                <SectionHeader title="Run" />

                <div className="relative mt-3">
                  {(() => {
                    const selected = AGENT_OPTIONS.find((option) => option.value === runAgentType) ?? AGENT_OPTIONS[0];
                    return (
                      <button
                        onClick={() => setAgentPickerOpen((prev) => !prev)}
                        className="flex w-full items-center justify-between rounded-xl bg-white/[0.04] px-3 py-2.5 text-left transition hover:bg-white/[0.06]"
                      >
                        <div className="flex items-center gap-2">
                          <span className={cn("h-2 w-2 rounded-full", selected.bg)} />
                          <span className={cn("text-[12px] font-semibold", selected.color)}>{selected.label}</span>
                        </div>
                        <ChevronDown className={cn("h-3.5 w-3.5 text-muted-foreground/40 transition", agentPickerOpen && "rotate-180")} />
                      </button>
                    );
                  })()}

                  {agentPickerOpen && (
                    <div className="absolute left-0 right-0 top-full z-10 mt-1 overflow-hidden rounded-xl border border-white/[0.06] bg-surface backdrop-blur-xl">
                      {AGENT_OPTIONS.map((option) => (
                        <button
                          key={option.value}
                          onClick={() => {
                            setRunAgentType(option.value);
                            setAgentPickerOpen(false);
                          }}
                          className={cn(
                            "flex w-full items-center gap-2.5 px-3 py-2.5 text-left transition hover:bg-white/[0.04]",
                            runAgentType === option.value && "bg-white/[0.04]"
                          )}
                        >
                          <span className={cn("h-2 w-2 rounded-full", option.bg)} />
                          <span className={cn("text-[12px] font-medium", option.color)}>{option.label}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>

                <div className="relative mt-3">
                  <button
                    onClick={() => setWorkspacePickerOpen((prev) => !prev)}
                    className="flex w-full items-center justify-between rounded-xl bg-white/[0.04] px-3 py-2.5 text-left transition hover:bg-white/[0.06]"
                  >
                    <div className="min-w-0 flex-1">
                      {runWorkspace ? (
                        <>
                          <p className="truncate text-[12px] font-medium">{runWorkspace.name}</p>
                          <p className="truncate font-mono text-[10px] text-muted-foreground/50">{runWorkspace.path}</p>
                        </>
                      ) : (
                        <p className="text-[12px] text-muted-foreground/50">Select workspace...</p>
                      )}
                    </div>
                    <ChevronDown
                      className={cn("ml-2 h-3.5 w-3.5 shrink-0 text-muted-foreground/40 transition", workspacePickerOpen && "rotate-180")}
                    />
                  </button>

                  {workspacePickerOpen && (
                    <div className="absolute left-0 right-0 top-full z-10 mt-1 max-h-48 overflow-y-auto rounded-xl border border-white/[0.06] bg-surface backdrop-blur-xl">
                      <div className="border-b border-white/[0.05] px-2 py-2">
                        <button
                          onClick={() => setCreateWorkspaceOpen((previous) => !previous)}
                          className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[12px] font-medium text-foreground/80 transition hover:bg-white/[0.04]"
                        >
                          <FolderPlus className="h-3.5 w-3.5 text-brand-openai" />
                          New workspace
                        </button>

                        {createWorkspaceOpen && (
                          <div className="mt-2 rounded-lg border border-white/[0.06] bg-white/[0.02] p-2">
                            <Input
                              value={newWorkspaceName}
                              onChange={(event) => setNewWorkspaceName(event.target.value)}
                              onKeyDown={(event) => {
                                if (event.key === "Enter") {
                                  event.preventDefault();
                                  handleCreateWorkspace();
                                }
                              }}
                              placeholder="Folder name"
                              className="h-8"
                            />
                            <p className="mt-1.5 truncate font-mono text-[10px] text-muted-foreground/45">
                              {workspaceRootDraft.trim() || settingsPrefs.workspaceRoot || "Using laptop default root"}
                            </p>
                            <Button
                              size="sm"
                              className="mt-2 w-full"
                              onClick={handleCreateWorkspace}
                              disabled={!newWorkspaceName.trim() || isCreatingWorkspace}
                            >
                              {isCreatingWorkspace ? <Loader2 className="mr-1.5 h-3 w-3 animate-spin" /> : null}
                              Create
                            </Button>
                          </div>
                        )}
                      </div>

                      {workspacesLoading ? (
                        <div className="flex items-center justify-center py-4">
                          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                        </div>
                      ) : workspaces.length === 0 ? (
                        <p className="px-3 py-4 text-center text-[11px] text-muted-foreground/50">No workspaces found</p>
                      ) : (
                        workspaces.map((workspace) => (
                          <button
                            key={workspace.path}
                            onClick={() => {
                              setRunWorkspace(workspace);
                              setWorkspacePickerOpen(false);
                            }}
                            className={cn(
                              "flex w-full items-center gap-2.5 px-3 py-2.5 text-left transition hover:bg-white/[0.04]",
                              runWorkspace?.path === workspace.path && "bg-white/[0.04]"
                            )}
                          >
                            {workspace.hasGit ? (
                              <FolderGit2 className="h-3.5 w-3.5 shrink-0 text-muted-foreground/50" />
                            ) : (
                              <Folder className="h-3.5 w-3.5 shrink-0 text-muted-foreground/50" />
                            )}
                            <div className="min-w-0 flex-1">
                              <p className="truncate text-[12px] font-medium">{workspace.name}</p>
                              <p className="truncate font-mono text-[10px] text-muted-foreground/40">{workspace.path}</p>
                            </div>
                          </button>
                        ))
                      )}
                    </div>
                  )}
                </div>

                <div className="mt-3 rounded-2xl border border-white/[0.06] bg-white/[0.02] p-3">
                  <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/60">Thread</p>
                  <div className="mt-2 grid grid-cols-2 gap-2">
                    <button
                      onClick={() => setRunThreadMode("REUSE")}
                      className={cn(
                        "rounded-lg px-3 py-2 text-[11px] font-medium transition",
                        runThreadMode === "REUSE" ? "bg-white/[0.1] text-foreground" : "text-muted-foreground/50 hover:text-foreground"
                      )}
                    >
                      Reuse
                    </button>
                    <button
                      onClick={() => setRunThreadMode("NEW_CHAT")}
                      className={cn(
                        "rounded-lg px-3 py-2 text-[11px] font-medium transition",
                        runThreadMode === "NEW_CHAT" ? "bg-brand-openai/20 text-brand-openai" : "text-muted-foreground/50 hover:text-foreground"
                      )}
                    >
                      New Chat
                    </button>
                  </div>

                  {runThreadMode === "REUSE" && (
                    <div className="relative mt-2">
                      <button
                        onClick={() => setRunSessionPickerOpen((prev) => !prev)}
                        className="flex w-full items-center justify-between rounded-lg border border-white/[0.06] bg-white/[0.02] px-3 py-2 text-left"
                      >
                        <span className="truncate text-[12px]">
                          {sessionById.get(runSessionTargetId)?.title ?? "Select session"}
                        </span>
                        <ChevronDown
                          className={cn("h-3.5 w-3.5 text-muted-foreground/50 transition", runSessionPickerOpen && "rotate-180")}
                        />
                      </button>

                      {runSessionPickerOpen && (
                        <div className="absolute left-0 right-0 top-full z-10 mt-1 max-h-44 overflow-y-auto rounded-xl border border-white/[0.06] bg-surface">
                          {reusableSessions.length === 0 ? (
                            <p className="px-3 py-3 text-[11px] text-muted-foreground/60">
                              No reusable app sessions yet. Start a New Chat first.
                            </p>
                          ) : (
                            reusableSessions
                              .slice()
                              .sort(
                                (a, b) =>
                                  (sessionRecencyById.get(b.id) ?? b.lastUpdated) -
                                  (sessionRecencyById.get(a.id) ?? a.lastUpdated)
                              )
                              .map((session) => (
                                <button
                                  key={session.id}
                                  onClick={() => {
                                    setRunSessionTargetId(session.id);
                                    setRunSessionPickerOpen(false);
                                  }}
                                  className={cn(
                                    "w-full truncate px-3 py-2 text-left text-[12px] transition hover:bg-white/[0.04]",
                                    runSessionTargetId === session.id && "bg-white/[0.04]"
                                  )}
                                >
                                  {session.title}
                                </button>
                              ))
                          )}
                        </div>
                      )}
                    </div>
                  )}
                </div>

                <textarea
                  rows={4}
                  value={runPrompt}
                  onChange={(event) => setRunPrompt(event.target.value)}
                  placeholder="What should the agent do?"
                  className="mt-3 w-full resize-none rounded-xl border border-white/[0.06] bg-white/[0.03] px-3 py-2.5 text-[13px] text-foreground placeholder:text-muted-foreground/30 transition focus:border-brand-claude/30 focus:outline-none"
                />

                <Input
                  value={runTitle}
                  onChange={(event) => setRunTitle(event.target.value)}
                  placeholder="Title (optional)"
                  className="mt-2"
                />

                <div className="mt-3 rounded-xl border border-white/[0.06] bg-white/[0.02]">
                  <div className="flex items-center justify-between px-3 py-2.5">
                    <div>
                      <p className="text-[12px] font-medium text-foreground/80">Full workspace access</p>
                      <p className="text-[10px] text-muted-foreground/40">Reduced safety checks</p>
                    </div>
                    <Switch
                      checked={runFullAccess}
                      onCheckedChange={(checked) => {
                        setRunFullAccess(checked);
                        if (checked) setRunPlanMode(false);
                      }}
                    />
                  </div>

                  <div className="border-t border-white/[0.05] px-3 py-2.5">
                    <div className="flex items-center justify-between">
                      <div>
                        <p className="text-[12px] font-medium text-foreground/80">Plan mode</p>
                        <p className="text-[10px] text-muted-foreground/40">Read-only planning</p>
                      </div>
                      <Switch
                        checked={runPlanMode}
                        onCheckedChange={(checked) => {
                          setRunPlanMode(checked);
                          if (checked) {
                            setRunFullAccess(false);
                            setShowLaunchConfirm(false);
                          }
                        }}
                      />
                    </div>
                  </div>
                </div>

                {showLaunchConfirm && (
                  <div className="mt-3 rounded-xl border border-amber-400/20 bg-amber-500/[0.06] px-3 py-3">
                    <div className="flex items-start gap-2">
                      <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" />
                      <p className="text-[11px] leading-snug text-foreground/70">
                        This run can execute commands with reduced safety checks.
                      </p>
                    </div>
                    <div className="mt-3 flex gap-2">
                      <Button className="flex-1" onClick={handleLaunchTask} disabled={isLaunching}>
                        {isLaunching ? <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> : <Play className="mr-2 h-3.5 w-3.5" />}
                        Confirm Launch
                      </Button>
                      <Button variant="outline" onClick={() => setShowLaunchConfirm(false)}>
                        Cancel
                      </Button>
                    </div>
                  </div>
                )}

                {!showLaunchConfirm && (
                  <Button className="mt-3 w-full" onClick={handleLaunchTask} disabled={!runWorkspace || !runPrompt.trim() || isLaunching}>
                    {isLaunching ? <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> : <Play className="mr-2 h-3.5 w-3.5" />}
                    {runThreadMode === "REUSE" ? "Continue Session" : "Start New Chat"}
                  </Button>
                )}

                <div className="my-5 border-b border-white/[0.04]" />

                <div className="flex items-center justify-between">
                  <SectionHeader title="Runs" />
                  {hasActiveRuns && (
                    <span className="flex h-5 items-center gap-1 rounded-full bg-emerald-400/10 px-2 text-[10px] font-bold text-emerald-400">
                      {launcherRuns.filter((run) => run.status === "STARTING" || run.status === "RUNNING").length} active
                    </span>
                  )}
                </div>

                <div className="mt-3 space-y-2">
                  {primaryRuns.length === 0 ? (
                    <EmptyState message="No runs yet." />
                  ) : (
                    primaryRuns.map((run) => (
                      <RunCard key={run.id} run={run} onOpenSession={openSession} onStop={handleStopRun} />
                    ))
                  )}
                </div>
              </>
            )}
          </div>
        )}

        {activeTab === "SESSIONS" && (
          <div className="animate-fade-in">
            {!showSessionDetail ? (
              <>
                <SectionHeader title="Sessions" />

                <div className="mt-3">
                  <Input
                    value={sessionSearch}
                    onChange={(event) => setSessionSearch(event.target.value)}
                    placeholder="Search title, repo, or id"
                  />
                </div>

                <div className="mt-3 flex items-center rounded-xl border border-white/[0.06] bg-white/[0.02] p-0.5">
                  {(["ALL", "CLAUDE", "CODEX"] as const).map((agent) => (
                    <button
                      key={agent}
                      onClick={() => setSessionAgentFilter(agent)}
                      className={cn(
                        "flex-1 rounded-lg px-3 py-1.5 text-[11px] font-medium transition",
                        sessionAgentFilter === agent
                          ? agent === "CLAUDE"
                            ? "bg-brand-claude/15 text-brand-claude"
                            : agent === "CODEX"
                              ? "bg-brand-openai/15 text-brand-openai"
                              : "bg-white/[0.08] text-foreground"
                          : "text-muted-foreground/50 hover:text-foreground"
                      )}
                    >
                      {agent === "ALL" ? "All Agents" : agent === "CLAUDE" ? "Claude" : "Codex"}
                    </button>
                  ))}
                </div>

                <div className="mt-3 flex gap-2 overflow-x-auto pb-1">
                  {FILTER_STATUS_ITEMS.map((status) => (
                    <button
                      key={status}
                      onClick={() => setSessionStatusFilter(status)}
                      className={cn(
                        "shrink-0 rounded-full px-3 py-1 text-[11px] font-medium transition",
                        sessionStatusFilter === status
                          ? "bg-white/[0.1] text-foreground"
                          : "text-muted-foreground/50 hover:text-foreground"
                      )}
                    >
                      {status === "ALL" ? "All Status" : STATUS_LABEL[status]}
                    </button>
                  ))}
                </div>

                <div className="my-5 border-b border-white/[0.04]" />

                {sessionStatusFilter === "ALL" ? (
                  <>
                    <SessionSection
                      title="Active"
                      sessions={sectionActive}
                      pendingBySession={pendingBySession}
                      turnsBySession={turnsBySession}
                      runsBySession={runsBySession}
                      eventsBySession={eventsBySession}
                      onOpen={openSession}
                      emptyMessage="No active sessions"
                    />

                    <div className="mt-5">
                      <SessionSection
                        title="Waiting"
                        sessions={sectionWaiting}
                        pendingBySession={pendingBySession}
                        turnsBySession={turnsBySession}
                        runsBySession={runsBySession}
                        eventsBySession={eventsBySession}
                        onOpen={openSession}
                        emptyMessage="No waiting sessions"
                      />
                    </div>

                    <div className="mt-5">
                      <button
                        onClick={() => setShowArchivedSessions((prev) => !prev)}
                        className="flex w-full items-center justify-between"
                      >
                        <div className="flex items-center gap-2">
                          <SectionHeader title="Completed / Failed" />
                          <span className="rounded-full bg-white/[0.08] px-2 py-0.5 text-[10px] text-muted-foreground">
                            {sectionArchived.length}
                          </span>
                        </div>
                        <ChevronDown
                          className={cn(
                            "h-3.5 w-3.5 text-muted-foreground/50 transition",
                            showArchivedSessions && "rotate-180"
                          )}
                        />
                      </button>

                      {showArchivedSessions && (
                        <div className="mt-3">
                          <SessionSection
                            title=""
                            sessions={sectionArchived}
                            pendingBySession={pendingBySession}
                            turnsBySession={turnsBySession}
                            runsBySession={runsBySession}
                            eventsBySession={eventsBySession}
                            onOpen={openSession}
                            emptyMessage="No completed or failed sessions"
                            hideTitle
                          />
                        </div>
                      )}
                    </div>
                  </>
                ) : (
                  <SessionSection
                    title={STATUS_LABEL[sessionStatusFilter]}
                    sessions={filteredSessions}
                    pendingBySession={pendingBySession}
                    turnsBySession={turnsBySession}
                    runsBySession={runsBySession}
                    eventsBySession={eventsBySession}
                    onOpen={openSession}
                    emptyMessage={`No ${STATUS_LABEL[sessionStatusFilter].toLowerCase()} sessions`}
                  />
                )}
              </>
            ) : !selectedSession ? (
              <EmptyState message="Session not found." />
            ) : (
              <div className="font-mono flex flex-col" style={{ minHeight: "calc(100dvh - 80px)" }}>
                {/* TUI header bar — fixed */}
                <div className="-mx-5 shrink-0 border-b border-white/[0.06] bg-background px-5 pb-2">
                  <button
                    onClick={() => setShowSessionDetail(false)}
                    className="text-[11px] text-muted-foreground/60 transition hover:text-foreground"
                  >
                    ← back
                  </button>

                  <div className="mt-1.5 flex items-center gap-2">
                    <span
                      className={cn(
                        "text-[11px] font-bold",
                        selectedSession.agentType === "CODEX" ? "text-brand-openai" : "text-brand-claude"
                      )}
                    >
                      {selectedSession.agentType === "CODEX" ? "codex" : "claude"}
                    </span>
                    <span className="text-[11px] text-white/[0.12]">│</span>
                    <span className="min-w-0 flex-1 truncate text-[12px] text-foreground/80">{selectedSession.title}</span>
                    <span
                      className={cn(
                        "text-[10px]",
                        selectedSession.state === "RUNNING"
                          ? "text-emerald-400"
                          : selectedSession.state === "WAITING_INPUT"
                            ? "text-amber-400"
                            : selectedSession.state === "FAILED"
                              ? "text-rose-400"
                              : "text-muted-foreground/50"
                      )}
                    >
                      [{STATUS_LABEL[selectedSession.state].toLowerCase()}]
                    </span>
                  </div>
                </div>

                {/* TUI conversation feed — scrollable */}
                <div className="-mx-5 flex-1 overflow-y-auto px-5 pt-3">
                  <div className="space-y-0" onClickCapture={handleConversationFeedClickCapture}>
                    {conversationRows.length === 0 ? (
                      <div className="py-12 text-center">
                        <p className="text-[12px] text-muted-foreground/30">~ no output ~</p>
                        <p className="mt-1 text-[11px] text-muted-foreground/20">send a message to begin</p>
                      </div>
                    ) : (
                      conversationRows.map((row, index) => {
                        const prev = index > 0 ? conversationRows[index - 1] : null;
                        const kindChanged = !prev || prev.kind !== row.kind;
                        return (
                          <ConversationRowView
                            key={row.id}
                            row={row}
                            agentType={selectedSession.agentType}
                            showRole={kindChanged}
                            onOpenLink={handleConversationLinkOpen}
                          />
                        );
                      })
                    )}

                    {/* Stable thinking indicator when agent is running */}
                    {selectedSession.state === "RUNNING" && (
                      <div className="mt-2 flex items-center gap-2 py-1">
                        <span
                          className={cn(
                            "text-[11px]",
                            selectedSession.agentType === "CODEX" ? "text-brand-openai/50" : "text-brand-claude/50"
                          )}
                        >
                          ●
                        </span>
                        <span className="text-[11px] text-muted-foreground/40">Thinking…</span>
                      </div>
                    )}

                    {/* Approval block — TUI style */}
                    {selectedSessionPending && (
                      <div className="mt-3 border-l-2 border-amber-400/40 pl-3 py-2">
                        {(() => {
                          const pendingKind = getPendingKind(selectedSessionPending);
                          const isQuestionRequest = pendingKind === "QUESTION_REQUEST";
                          const toolLabel = getPendingToolLabel(selectedSessionPending);
                          const questionHeader = getPendingQuestionHeader(selectedSessionPending);
                          const questionOptions = getPendingQuestionOptions(selectedSessionPending);
                          const replyDraft = String(pendingReplyDrafts[selectedSessionPending.id] || "");
                          const busy = busyActionIds.includes(selectedSessionPending.id);
                          const actionable = selectedSessionPending.actionable !== false;
                          return (
                            <>
                              <div className="mb-1 flex flex-wrap items-center gap-1.5">
                                {pendingKind === "TOOL_PERMISSION" && (
                                  <span className="rounded-full bg-brand-openai/15 px-2 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-brand-openai">
                                    Tool Call
                                  </span>
                                )}
                                {pendingKind === "PLAN_CONFIRM" && (
                                  <span className="rounded-full bg-brand-claude/15 px-2 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-brand-claude">
                                    Plan Confirm
                                  </span>
                                )}
                                {pendingKind === "QUESTION_REQUEST" && (
                                  <span className="rounded-full bg-amber-400/15 px-2 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-amber-400">
                                    Question
                                  </span>
                                )}
                                {toolLabel && (
                                  <span className="rounded-full bg-white/[0.08] px-2 py-0.5 text-[9px] font-medium text-foreground/70">
                                    {toolLabel}
                                  </span>
                                )}
                              </div>
                              <p className="text-[10px] text-amber-400/70">
                                {isQuestionRequest ? "✎ response needed" : "⚠ approval required"} ·{" "}
                                {formatRelativeTime(selectedSessionPending.requestedAt)}
                              </p>
                              {questionHeader ? (
                                <p className="mt-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground/45">
                                  {questionHeader}
                                </p>
                              ) : null}
                              <p className="mt-1 text-[12px] leading-snug text-foreground/80">{selectedSessionPending.prompt}</p>

                              {isQuestionRequest ? (
                                <div className="mt-2 space-y-1">
                                  {questionOptions.map((option, idx) => (
                                    <button
                                      key={`${selectedSessionPending.id}:opt:${idx}`}
                                      type="button"
                                      onClick={() => selectQuestionOption(selectedSessionPending, option)}
                                      disabled={busy || !actionable}
                                      className="flex w-full items-start gap-2 py-1 text-left transition hover:text-foreground disabled:opacity-35"
                                    >
                                      <span className="shrink-0 text-[11px] text-muted-foreground/40">[{idx + 1}]</span>
                                      <span className="min-w-0">
                                        <span className="block text-[12px] leading-snug text-foreground/72">{option.label}</span>
                                        {option.description ? (
                                          <span className="mt-0.5 block text-[10px] leading-snug text-muted-foreground/35">
                                            {option.description}
                                          </span>
                                        ) : null}
                                      </span>
                                    </button>
                                  ))}

                                  {!pendingCustomOpen.has(selectedSessionPending.id) ? (
                                    <button
                                      type="button"
                                      onClick={() => toggleCustomReply(selectedSessionPending.id)}
                                      disabled={busy || !actionable}
                                      className="flex w-full items-center gap-2 py-1 text-left transition hover:text-foreground disabled:opacity-35"
                                    >
                                      <span className="shrink-0 text-[11px] text-muted-foreground/40">[✎]</span>
                                      <span className="text-[12px] text-muted-foreground/40">type your own…</span>
                                    </button>
                                  ) : (
                                    <div className="mt-1 border-l border-white/[0.08] pl-3">
                                      <textarea
                                        rows={2}
                                        value={replyDraft}
                                        onChange={(event) => updatePendingReplyDraft(selectedSessionPending.id, event.target.value)}
                                        onKeyDown={(event) => {
                                          if (event.key === "Enter" && !event.shiftKey) {
                                            event.preventDefault();
                                            submitPendingReply(selectedSessionPending);
                                          }
                                        }}
                                        placeholder="type your reply…"
                                        disabled={busy || !actionable}
                                        className="w-full resize-none bg-transparent text-[12px] text-foreground placeholder:text-muted-foreground/25 focus:outline-none disabled:opacity-40"
                                        autoFocus
                                      />
                                      <div className="mt-1 flex gap-2">
                                        <button
                                          disabled={busy || !actionable || !replyDraft.trim()}
                                          onClick={() => submitPendingReply(selectedSessionPending)}
                                          className="rounded border border-amber-400/25 bg-amber-400/[0.06] px-2.5 py-0.5 text-[10px] text-amber-400 transition hover:bg-amber-400/[0.12] disabled:opacity-30"
                                        >
                                          [↵] send
                                        </button>
                                        <button
                                          onClick={() => toggleCustomReply(selectedSessionPending.id)}
                                          className="text-[10px] text-muted-foreground/40 transition hover:text-foreground"
                                        >
                                          cancel
                                        </button>
                                      </div>
                                    </div>
                                  )}
                                </div>
                              ) : (
                                <div className="mt-2 flex gap-2">
                                  <button
                                    disabled={busy || !actionable}
                                    onClick={() => handleAction(selectedSessionPending, "APPROVE")}
                                    className="rounded border border-emerald-400/30 bg-emerald-400/[0.06] px-3 py-1 text-[11px] text-emerald-400 transition hover:bg-emerald-400/[0.12] disabled:opacity-30"
                                  >
                                    [y] approve
                                  </button>
                                  <button
                                    disabled={busy || !actionable}
                                    onClick={() => handleAction(selectedSessionPending, "REJECT")}
                                    className="rounded border border-rose-400/30 bg-rose-400/[0.06] px-3 py-1 text-[11px] text-rose-400 transition hover:bg-rose-400/[0.12] disabled:opacity-30"
                                  >
                                    [n] reject
                                  </button>
                                </div>
                              )}

                              {selectedSessionPending.actionable === false && (
                                <p className="mt-1.5 text-[10px] text-amber-400/50">read-only from phone</p>
                              )}
                            </>
                          );
                        })()}
                      </div>
                    )}

                    <div ref={conversationEndRef} className="h-4" />
                  </div>
                </div>

                {/* TUI prompt-line composer — pinned to bottom */}
                <div className="-mx-5 shrink-0 border-t border-white/[0.06] bg-background px-5 pb-2 pt-2">
                  <div className="flex items-end gap-0">
                    <span
                      className={cn(
                        "shrink-0 pb-1.5 pr-2 text-[13px] font-bold",
                        followUpContext
                          ? selectedSession.agentType === "CODEX" ? "text-brand-openai" : "text-brand-claude"
                          : "text-muted-foreground/20"
                      )}
                    >
                      ❯
                    </span>
                    <textarea
                      rows={1}
                      value={sessionComposerDraft}
                      onChange={(event) => {
                        setSessionComposerDraft(event.target.value);
                        const el = event.target;
                        el.style.height = "auto";
                        el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
                      }}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" && !event.shiftKey) {
                          event.preventDefault();
                          handleSendSessionFollowUp();
                        }
                      }}
                      placeholder={
                        followUpContext
                          ? "type a follow-up…"
                          : "no workspace context"
                      }
                      disabled={!followUpContext || isSendingFollowUp}
                      className="min-h-[36px] flex-1 resize-none bg-transparent py-1.5 text-[13px] text-foreground placeholder:text-muted-foreground/20 focus:outline-none disabled:opacity-30"
                    />
                    {isSendingFollowUp && (
                      <Loader2 className="mb-2 ml-2 h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground/40" />
                    )}
                  </div>
                  {followUpContext && (
                    <p className="text-[10px] text-muted-foreground/25">
                      {followUpContext.workspacePath.split("/").pop()} · enter to send · shift+enter for newline
                    </p>
                  )}
                </div>
              </div>
            )}
          </div>
        )}

        {activeTab === "SETTINGS" && (
          <div className="animate-fade-in">
            <SectionHeader title="Settings" />

            <div className="mt-4 space-y-0 rounded-2xl border border-white/[0.06] bg-white/[0.02] px-3">
              <div className="flex items-center justify-between py-3">
                <div className="flex items-center gap-2.5">
                  <span className={cn("h-2 w-2 rounded-full", laptopOnline ? "bg-emerald-400" : "bg-rose-400")} />
                  <span className="text-[13px]">Laptop status</span>
                </div>
                <Badge variant={laptopOnline ? "success" : "danger"}>{laptopOnline ? "Online" : "Offline"}</Badge>
              </div>

              <div className="divider" />

              <div className="py-3">
                <p className="text-[11px] text-muted-foreground/65">Relay URL (read-only)</p>
                <Input value={pairingConfig.relayBaseUrl || pairRelayUrl} readOnly className="mt-1 h-8 font-mono text-[11px]" />
              </div>

              <div className="divider" />

              <div className="py-3">
                <p className="text-[11px] text-muted-foreground/65">Default workspace location</p>
                <Input
                  value={workspaceRootDraft}
                  onChange={(event) => setWorkspaceRootDraft(event.target.value)}
                  placeholder={settingsPrefs.workspaceRoot || "/Users/you/Documents"}
                  className="mt-1 h-8 font-mono text-[11px]"
                />
                <p className="mt-1 text-[10px] text-muted-foreground/45">New workspace from phone will be created in this folder.</p>
                <Button
                  size="sm"
                  className="mt-2 w-full"
                  onClick={handleSaveWorkspaceRoot}
                  disabled={!workspaceRootDraft.trim() || isSavingWorkspaceRoot}
                >
                  {isSavingWorkspaceRoot ? <Loader2 className="mr-1.5 h-3 w-3 animate-spin" /> : null}
                  Save location
                </Button>
              </div>

              <div className="divider" />

              <div className="py-3">
                <Button variant="destructive" className="w-full gap-1.5" onClick={handleUnpair}>
                  <Unlink className="h-3.5 w-3.5" />
                  Unpair
                </Button>
              </div>
            </div>
          </div>
        )}
      </div>

      {showBottomNav && (
        <nav className="fixed inset-x-0 bottom-0 z-20 pb-[max(env(safe-area-inset-bottom),6px)]">
          <div className="mx-auto flex w-[calc(100%-32px)] max-w-md items-center justify-around rounded-2xl border border-white/[0.06] bg-background/80 py-1.5 backdrop-blur-xl">
            {TAB_ITEMS.map((item) => {
              const Icon = item.icon;
              const active = activeTab === item.id;
              const hasPending = item.id === "ACTIONS" && pendingInputs.length > 0;
              const hasRunning = item.id === "RUN" && hasActiveRuns;

              return (
                <button
                  key={item.id}
                  onClick={() => {
                    setActiveTab(item.id);
                    if (item.id === "SESSIONS") {
                      setShowSessionDetail(false);
                    }
                  }}
                  className={cn(
                    "relative flex flex-col items-center gap-0.5 px-2 py-1.5 transition",
                    active ? "text-foreground" : "text-muted-foreground/40"
                  )}
                >
                  <div className="relative">
                    <Icon className={cn("h-[17px] w-[17px]", active && "text-brand-claude")} />
                    {hasPending && <span className="absolute -right-1.5 -top-0.5 h-1.5 w-1.5 rounded-full bg-amber-400" />}
                    {hasRunning && <span className="absolute -right-1.5 -top-0.5 h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-400" />}
                  </div>
                  <span className={cn("text-[9px]", active ? "text-foreground/70" : "text-muted-foreground/30")}>{item.label}</span>
                </button>
              );
            })}
          </div>
        </nav>
      )}

      {toast && (
        <div
          className={cn(
            "fixed left-1/2 z-30 -translate-x-1/2 animate-fade-in rounded-full border border-white/[0.06] bg-surface px-4 py-2 text-xs text-foreground backdrop-blur-lg",
            showBottomNav ? "bottom-20" : "bottom-6"
          )}
        >
          {toast}
        </div>
      )}
    </div>
  );
}

function SessionSection({
  title,
  sessions,
  pendingBySession,
  turnsBySession,
  runsBySession,
  eventsBySession,
  onOpen,
  emptyMessage,
  hideTitle,
}: {
  title: string;
  sessions: AgentSession[];
  pendingBySession: Map<string, PendingInput>;
  turnsBySession: Map<string, ChatTurn[]>;
  runsBySession: Map<string, LauncherRun[]>;
  eventsBySession: Map<string, SessionEvent[]>;
  onOpen: (sessionId: string) => void;
  emptyMessage: string;
  hideTitle?: boolean;
}) {
  return (
    <div>
      {!hideTitle && <SectionHeader title={title} />}
      <div className={cn(!hideTitle && "mt-3", "space-y-1")}> 
        {sessions.length === 0 ? (
          <EmptyState message={emptyMessage} />
        ) : (
          sessions.map((session) => (
            <SessionRow
              key={session.id}
              session={session}
              pending={pendingBySession.get(session.id) ?? null}
              preview={extractSessionPreview(
                turnsBySession.get(session.id) ?? [],
                runsBySession.get(session.id) ?? [],
                eventsBySession.get(session.id) ?? []
              )}
              onOpen={() => onOpen(session.id)}
            />
          ))
        )}
      </div>
    </div>
  );
}

function SessionRow({
  session,
  pending,
  preview,
  onOpen,
}: {
  session: AgentSession;
  pending: PendingInput | null;
  preview: string;
  onOpen: () => void;
}) {
  const StatusIcon = STATUS_ICON[session.state];

  return (
    <button
      onClick={onOpen}
      className="group flex w-full items-center gap-3 rounded-xl px-2 py-3 text-left transition-colors hover:bg-white/[0.03] active:bg-white/[0.05]"
    >
      <div
        className={cn(
          "flex h-9 w-9 shrink-0 items-center justify-center rounded-full",
          session.agentType === "CODEX" ? "bg-brand-openai/10" : "bg-brand-claude/10"
        )}
      >
        <StatusIcon
          className={cn(
            "h-4 w-4",
            session.state === "RUNNING"
              ? "text-emerald-400"
              : session.state === "WAITING_INPUT"
                ? "text-amber-400"
                : session.state === "FAILED"
                  ? "text-rose-400"
                  : "text-muted-foreground"
          )}
        />
      </div>

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <h3 className="truncate text-[13px] font-semibold">{session.title}</h3>
          <span
            className={cn(
              "shrink-0 rounded px-1 py-0.5 text-[8px] font-bold uppercase tracking-wider",
              session.agentType === "CODEX" ? "bg-brand-openai/10 text-brand-openai" : "bg-brand-claude/10 text-brand-claude"
            )}
          >
            {session.agentType === "CODEX" ? "Codex" : "Claude"}
          </span>
          {pending && <span className="h-1.5 w-1.5 rounded-full bg-amber-400" />}
        </div>

        <p className="mt-0.5 truncate text-[11px] leading-snug text-foreground/45">{preview || "No output yet."}</p>

        <div className="mt-1 flex items-center gap-2">
          <span
            className={cn(
              "text-[10px] font-medium",
              session.state === "RUNNING"
                ? "text-emerald-400"
                : session.state === "WAITING_INPUT"
                  ? "text-amber-400"
                  : session.state === "FAILED"
                    ? "text-rose-400"
                    : "text-muted-foreground/60"
            )}
          >
            {STATUS_LABEL[session.state]}
          </span>
          <span className="text-[9px] text-muted-foreground/40">{formatRelativeTime(session.lastUpdated)}</span>
        </div>
      </div>

      <ChevronRight className="h-3.5 w-3.5 shrink-0 text-white/[0.1]" />
    </button>
  );
}

function InlineCode({
  text,
  onOpenLink,
}: {
  text: string;
  onOpenLink?: (href: string) => void;
}) {
  // Split text on `backtick` segments and render inline code highlighted
  const parts = text.split(/(`[^`]+`)/g);
  return (
    <>
      {parts.map((part, i) => {
        if (part.startsWith("`") && part.endsWith("`")) {
          const codeText = part.slice(1, -1);
          const href = getHrefIfLinkLike(codeText);
          if (href) {
            return (
              <a
                key={i}
                href={href}
                target="_blank"
                rel="noreferrer noopener"
                onClick={(event) => {
                  if (!onOpenLink) return;
                  event.preventDefault();
                  onOpenLink(href);
                }}
                className="inline-block cursor-pointer rounded bg-white/[0.06] px-1 py-0.5 text-[11px] text-brand-openai/90 underline decoration-dotted underline-offset-2 transition hover:text-brand-openai pointer-events-auto"
              >
                {codeText}
              </a>
            );
          }
          return (
            <span key={i} className="rounded bg-white/[0.06] px-1 py-0.5 text-[11px] text-brand-claude/80">
              {codeText}
            </span>
          );
        }

        return <span key={i}>{renderInlineLinks(part, `txt-${i}`, onOpenLink)}</span>;
      })}
    </>
  );
}

function renderInlineLinks(text: string, keyPrefix: string, onOpenLink?: (href: string) => void) {
  if (!text) return null;
  const nodes: ReactNode[] = [];
  const markdownLinkPattern =
    /\[([^\]\n]+)\]\(((?:https?:\/\/|www\.|localhost:|127\.0\.0\.1:)[^\s<>"'`]+)\)/gi;

  let lastIndex = 0;
  let markdownMatch: RegExpExecArray | null = markdownLinkPattern.exec(text);
  let index = 0;

  while (markdownMatch) {
    const start = markdownMatch.index;
    const end = start + markdownMatch[0].length;
    const label = markdownMatch[1];
    const rawHref = markdownMatch[2];

    if (start > lastIndex) {
      nodes.push(...renderPlainUrlSegment(text.slice(lastIndex, start), `${keyPrefix}-mdtxt-${index}`, onOpenLink));
    }

    const cleanedHref = trimUrlPunctuation(rawHref);
    if (cleanedHref) {
      const href = toLinkHref(cleanedHref);
      nodes.push(
        <a
          key={`${keyPrefix}-mdlink-${index}`}
          href={href}
          target="_blank"
          rel="noreferrer noopener"
          onClick={(event) => {
            if (!onOpenLink) return;
            event.preventDefault();
            onOpenLink(href);
          }}
          className="underline decoration-dotted underline-offset-2 transition hover:text-brand-openai"
        >
          {label}
        </a>
      );
    } else {
      nodes.push(markdownMatch[0]);
    }

    index += 1;
    lastIndex = end;
    markdownMatch = markdownLinkPattern.exec(text);
  }

  if (lastIndex < text.length) {
    nodes.push(...renderPlainUrlSegment(text.slice(lastIndex), `${keyPrefix}-tail`, onOpenLink));
  }

  return nodes;
}

function trimUrlPunctuation(value: string) {
  return String(value || "")
    .trim()
    .replace(/^[(*_~`<\[]+/, "")
    .replace(/[)>*_,.;!?~`\]]+$/g, "");
}

function renderPlainUrlSegment(text: string, keyPrefix: string, onOpenLink?: (href: string) => void): ReactNode[] {
  if (!text) return [];

  const urlPattern = /\b(?:https?:\/\/|www\.|localhost:|127\.0\.0\.1:)[^\s<>"'`]+/gi;
  const nodes: ReactNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null = urlPattern.exec(text);
  let index = 0;

  while (match) {
    const rawMatch = match[0];
    const start = match.index;
    const end = start + rawMatch.length;

    if (start > lastIndex) {
      nodes.push(text.slice(lastIndex, start));
    }

    const cleaned = trimUrlPunctuation(rawMatch);
    const trailing = rawMatch.slice(cleaned.length);
    if (cleaned) {
      const href = toLinkHref(cleaned);
      nodes.push(
        <a
          key={`${keyPrefix}-link-${index}`}
          href={href}
          target="_blank"
          rel="noreferrer noopener"
          onClick={(event) => {
            if (!onOpenLink) return;
            event.preventDefault();
            onOpenLink(href);
          }}
          className="underline decoration-dotted underline-offset-2 transition hover:text-brand-openai"
        >
          {cleaned}
        </a>
      );
      index += 1;
    } else {
      nodes.push(rawMatch);
    }

    if (trailing) {
      nodes.push(trailing);
    }

    lastIndex = end;
    match = urlPattern.exec(text);
  }

  if (lastIndex < text.length) {
    nodes.push(text.slice(lastIndex));
  }

  return nodes;
}

function toLinkHref(value: string) {
  const raw = value.trim();
  if (raw.startsWith("http://") || raw.startsWith("https://")) return raw;
  if (raw.startsWith("www.")) return `https://${raw}`;
  if (raw.startsWith("localhost:") || raw.startsWith("127.0.0.1:")) return `http://${raw}`;
  return raw;
}

function getHrefIfLinkLike(value: string) {
  const cleaned = trimUrlPunctuation(value);
  if (!cleaned) return "";
  if (/^(https?:\/\/|www\.|localhost:|127\.0\.0\.1:)/i.test(cleaned)) {
    return toLinkHref(cleaned);
  }
  return "";
}

function AssistantContentBlocks({
  blocks,
  isFinal,
  onOpenLink,
}: {
  blocks: ContentBlock[];
  isFinal: boolean;
  onOpenLink?: (href: string) => void;
}) {
  return (
    <div className="space-y-2 border-l border-white/[0.06] pl-4">
      {blocks.map((block, i) => {
        if (block.type === "code") {
          return (
            <div key={i} className="rounded border border-white/[0.06] bg-white/[0.02]">
              {block.lang && (
                <div className="border-b border-white/[0.04] px-3 py-1">
                  <span className="text-[9px] text-muted-foreground/40">{block.lang}</span>
                </div>
              )}
              <pre className="overflow-x-auto px-3 py-2 text-[11px] leading-relaxed text-foreground/70">
                {block.code}
              </pre>
            </div>
          );
        }

        if (block.type === "list") {
          return (
            <div key={i} className="space-y-0.5">
              {block.items.map((item, j) => (
                <div key={j} className="flex gap-2 text-[12px] leading-relaxed text-foreground/75">
                  <span className="shrink-0 text-muted-foreground/30">─</span>
                  <span><InlineCode text={item} onOpenLink={onOpenLink} /></span>
                </div>
              ))}
            </div>
          );
        }

        if (block.type === "step") {
          return (
            <p key={i} className="text-[11px] leading-relaxed text-muted-foreground/45 italic">
              <InlineCode text={block.text} onOpenLink={onOpenLink} />
            </p>
          );
        }

        // type === "text"
        return (
          <p
            key={i}
            className={cn(
              "whitespace-pre-wrap text-[12px] leading-relaxed",
              isFinal ? "text-foreground/85" : "text-foreground/60"
            )}
          >
            <InlineCode text={block.text} onOpenLink={onOpenLink} />
          </p>
        );
      })}
    </div>
  );
}

function ConversationRowView({
  row,
  agentType,
  showRole,
  onOpenLink,
}: {
  row: ConversationRow;
  agentType: AgentType;
  showRole: boolean;
  onOpenLink?: (href: string) => void;
}) {
  const timeStr = new Date(row.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

  if (row.kind === "status") {
    return (
      <div className="py-1">
        <span className="text-[11px] text-muted-foreground/30">  --- {row.text} ---</span>
      </div>
    );
  }

  const isUser = row.kind === "user";
  const resolvedAgent = row.agentType ?? agentType;
  const agentLabel = resolvedAgent === "CODEX" ? "codex" : "claude";
  const agentColor = resolvedAgent === "CODEX" ? "text-brand-openai" : "text-brand-claude";

  if (isUser) {
    return (
      <div className={cn(showRole && "mt-3")}>
        {showRole && (
          <div className="flex items-center gap-2 pb-0.5">
            <span className="text-[11px] font-bold text-emerald-400/80">❯ you</span>
            <span className="text-[10px] text-muted-foreground/25">{timeStr}</span>
          </div>
        )}
        <p className="whitespace-pre-wrap pl-4 text-[12px] leading-relaxed text-foreground/90">
          <InlineCode text={row.text} onOpenLink={onOpenLink} />
        </p>
      </div>
    );
  }

  // Assistant message — parse into structured blocks
  const isFinal = row.turnKind === "FINAL_OUTPUT";
  const blocks = parseContentBlocks(row.text);

  return (
    <div className={cn(showRole && "mt-3")}>
      {showRole && (
        <div className="flex items-center gap-2 pb-0.5">
          <span className={cn("text-[11px] font-bold", agentColor)}>● {agentLabel}</span>
          <span className="text-[10px] text-muted-foreground/25">{timeStr}</span>
          {isFinal && <span className="text-[9px] text-muted-foreground/25">final</span>}
        </div>
      )}
      <AssistantContentBlocks blocks={blocks} isFinal={isFinal} onOpenLink={onOpenLink} />
    </div>
  );
}

function RunCard({
  run,
  onOpenSession,
  onStop,
}: {
  run: LauncherRun;
  onOpenSession: (sessionId: string) => void;
  onStop: (runId: string) => void;
}) {
  const isActive = run.status === "STARTING" || run.status === "RUNNING";
  const statusIcon =
    run.status === "RUNNING" || run.status === "STARTING"
      ? Activity
      : run.status === "COMPLETED"
        ? CheckCircle2
        : run.status === "FAILED"
          ? TriangleAlert
          : XCircle;
  const StatusIcon = statusIcon;

  const title = run.title || run.prompt.slice(0, 80);
  const updatedAt = getRunUpdatedAt(run);
  const runTranscript = getRunAssistantOutput(run);
  const preview = truncateText(runTranscript, 180);

  return (
    <article className="rounded-2xl border border-white/[0.06] bg-white/[0.02] px-3 py-3">
      <div className="flex items-start gap-2.5">
        <div
          className={cn(
            "flex h-8 w-8 shrink-0 items-center justify-center rounded-full",
            run.agentType === "CODEX" ? "bg-brand-openai/10" : "bg-brand-claude/10"
          )}
        >
          <StatusIcon className={cn("h-3.5 w-3.5", RUN_STATUS_COLOR[run.status])} />
        </div>

        <div className="min-w-0 flex-1">
          <p className="truncate text-[12px] font-semibold">{title}</p>
          <div className="mt-0.5 flex items-center gap-2">
            <span className={cn("text-[10px] font-medium", RUN_STATUS_COLOR[run.status])}>{RUN_STATUS_LABEL[run.status]}</span>
            <span className="text-[9px] text-muted-foreground/45">updated {formatRelativeTime(updatedAt)}</span>
          </div>

          <p className="mt-2 whitespace-pre-wrap text-[11px] leading-snug text-foreground/70">
            {preview || (isActive ? "Model is running..." : "No output captured.")}
          </p>

          {run.error && <p className="mt-1 text-[10px] text-rose-400/80">{truncateText(run.error, 140)}</p>}

          <div className="mt-3 flex items-center gap-2">
            <Button size="sm" className="flex-1" onClick={() => onOpenSession(run.sessionId)}>
              {isActive ? "Continue" : "Open Session"}
            </Button>
            {isActive && (
              <Button size="sm" variant="outline" onClick={() => onStop(run.id)}>
                <Square className="mr-1 h-2.5 w-2.5" />
                Stop
              </Button>
            )}
          </div>
        </div>
      </div>
    </article>
  );
}

function StatTile({
  value,
  label,
  icon: Icon,
  accent,
}: {
  value: number;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  accent?: "openai" | "warning" | "danger";
}) {
  const color =
    accent === "openai"
      ? "text-brand-openai"
      : accent === "warning"
        ? "text-amber-400"
        : accent === "danger"
          ? "text-rose-400"
          : "text-muted-foreground";

  const bg =
    accent === "openai"
      ? "bg-brand-openai/[0.06]"
      : accent === "warning"
        ? "bg-amber-400/[0.06]"
        : accent === "danger"
          ? "bg-rose-400/[0.06]"
          : "bg-white/[0.03]";

  return (
    <div className={cn("flex flex-col items-center gap-0.5 rounded-xl py-2.5", bg)}>
      <Icon className={cn("h-3.5 w-3.5", color)} />
      <span className={cn("font-space text-lg font-bold leading-none", color)}>{value}</span>
      <span className="text-[8px] uppercase tracking-wider text-muted-foreground/50">{label}</span>
    </div>
  );
}

function SectionHeader({ title }: { title: string }) {
  return <h2 className="text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">{title}</h2>;
}

function EmptyState({ message }: { message: string }) {
  return (
    <div className="py-8 text-center">
      <p className="text-sm text-muted-foreground/60">{message}</p>
    </div>
  );
}

function PairingScreen({
  relayUrl,
  code,
  onCodeChange,
  error,
  isPairing,
  onPair,
}: {
  relayUrl: string;
  code: string;
  onCodeChange: (value: string) => void;
  error: string | null;
  isPairing: boolean;
  onPair: () => void;
}) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-6">
      <div className="w-full max-w-sm">
        <div className="text-center">
          <div className="flex items-baseline justify-center gap-0">
            <span className="font-space text-2xl font-bold tracking-tight text-brand-claude">agent</span>
            <span className="font-space text-2xl font-bold tracking-tight text-muted-foreground/30">.</span>
            <span className="font-space text-2xl font-bold tracking-tight text-foreground/60">companion</span>
          </div>
          <p className="mt-2 text-[13px] text-muted-foreground/60">Pair with your laptop to get started.</p>
        </div>

        <div className="mt-8 space-y-4">
          <p className="rounded-xl border border-white/[0.06] bg-white/[0.02] px-3 py-2 text-center text-[11px] text-muted-foreground/70">
            Relay: <span className="font-mono text-[10px] text-foreground/80">{relayUrl}</span>
          </p>

          <div>
            <label className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground/50">Pairing Code</label>
            <Input
              value={code}
              onChange={(event) => {
                const filtered = event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6);
                onCodeChange(filtered);
              }}
              className="mt-1.5 text-center font-mono text-lg tracking-[0.3em]"
              placeholder="XXXXXX"
              maxLength={6}
              onKeyDown={(event) => event.key === "Enter" && onPair()}
            />
          </div>

          {error && <p className="text-center text-[12px] text-rose-400">{error}</p>}

          <Button className="w-full gap-1.5" onClick={onPair} disabled={code.length < 6 || isPairing}>
            {isPairing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Link className="h-3.5 w-3.5" />}
            Pair
          </Button>
        </div>
      </div>
    </div>
  );
}

function buildConversationRows(runs: LauncherRun[], turns: ChatTurn[], events: SessionEvent[]): ConversationRow[] {
  const rows: ConversationRow[] = [];

  if (turns.length > 0) {
    for (const turn of turns) {
      const rawText = cleanOutputText(turn.text);
      if (!rawText) continue;

      if (turn.role === "ASSISTANT") {
        // Strip transient thinking fragments line-by-line
        const stableLines = rawText
          .split("\n")
          .filter((l) => !shouldHideRawOutput(l))
          .join("\n")
          .trim();
        if (!stableLines) continue;

        rows.push({
          id: turn.id,
          kind: "assistant",
          text: stableLines,
          timestamp: turn.createdAt,
          turnKind: turn.kind,
        });
        continue;
      }

      const text = rawText;

      if (turn.kind === "APPROVAL_ACTION") {
        rows.push({
          id: turn.id,
          kind: "status",
          text,
          timestamp: turn.createdAt,
        });
        continue;
      }

      rows.push({
        id: turn.id,
        kind: "user",
        text,
        timestamp: turn.createdAt,
        turnKind: turn.kind,
      });
    }

    const activeRun = [...runs]
      .slice()
      .reverse()
      .find((run) => run.status === "STARTING" || run.status === "RUNNING");
    if (activeRun) {
      const rawLiveTranscript = getRunAssistantOutput(activeRun);
      // Strip transient thinking fragments from live transcript too
      const liveTranscript = rawLiveTranscript
        ? rawLiveTranscript
            .split("\n")
            .filter((l) => !shouldHideRawOutput(l))
            .join("\n")
            .trim()
        : "";
      const previousAssistant = [...rows]
        .slice()
        .reverse()
        .find((row) => row.kind === "assistant");
      if (liveTranscript) {
        const liveNorm = normalizeMessageComparable(liveTranscript);
        const prevNorm = previousAssistant ? normalizeMessageComparable(previousAssistant.text) : "";
        // Skip if live text matches or is a subset of latest turn (avoids flicker/swap)
        if (prevNorm && (liveNorm === prevNorm || prevNorm.includes(liveNorm))) {
          return dedupeConversationRows(rows.sort((a, b) => a.timestamp - b.timestamp));
        }
        rows.push({
          id: `${activeRun.id}:live`,
          kind: "assistant",
          text: liveTranscript,
          timestamp: getRunUpdatedAt(activeRun),
          turnKind: "MESSAGE",
        });
      }
    }

    return dedupeConversationRows(rows.sort((a, b) => a.timestamp - b.timestamp));
  }

  for (const run of runs) {
    const userPrompt = cleanOutputText(run.prompt);
    if (userPrompt) {
      rows.push({
        id: `${run.id}:user`,
        kind: "user",
        text: userPrompt,
        timestamp: run.createdAt,
      });
    }

    const assistantOutput = getRunAssistantOutput(run);
    if (assistantOutput) {
      rows.push({
        id: `${run.id}:assistant`,
        kind: "assistant",
        text: assistantOutput,
        timestamp: getRunUpdatedAt(run),
        turnKind: "FINAL_OUTPUT",
      });
    } else if (run.status === "FAILED" && run.error) {
      rows.push({
        id: `${run.id}:error`,
        kind: "status",
        text: `Run failed: ${truncateText(run.error, 120)}`,
        timestamp: getRunUpdatedAt(run),
      });
    }
  }

  if (rows.length === 0) {
    for (const event of events) {
      const text = cleanOutputText(event.summary);
      if (!text) continue;
      rows.push({
        id: `event:${event.id}`,
        kind: "status",
        text,
        timestamp: event.timestamp,
      });
    }
  }

  return dedupeConversationRows(rows.sort((a, b) => a.timestamp - b.timestamp));
}

function extractSessionPreview(turns: ChatTurn[], runs: LauncherRun[], events: SessionEvent[]) {
  if (turns.length > 0) {
    const assistantTurns = turns.filter((turn) => turn.role === "ASSISTANT");
    const latestAssistantTurn = assistantTurns.length > 0 ? assistantTurns[assistantTurns.length - 1] : null;
    if (latestAssistantTurn?.text) {
      return truncateText(cleanOutputText(latestAssistantTurn.text), 120);
    }

    const latestTurn = turns[turns.length - 1];
    if (latestTurn?.text) {
      return truncateText(cleanOutputText(latestTurn.text), 120);
    }
  }

  if (runs.length > 0) {
    const latestRun = runs[runs.length - 1];
    const output = getRunAssistantOutput(latestRun);
    if (output) return truncateText(output, 120);
    if (latestRun.prompt) return truncateText(cleanOutputText(latestRun.prompt), 120);
  }

  const latestEvent = [...events].sort((a, b) => b.timestamp - a.timestamp)[0];
  return latestEvent ? truncateText(cleanOutputText(latestEvent.summary), 120) : "";
}

function getRunUpdatedAt(run: LauncherRun) {
  return run.endedAt ?? run.startedAt ?? run.createdAt;
}

function runStatusPriority(status: LauncherRunStatus) {
  if (status === "RUNNING" || status === "STARTING") return 3;
  if (status === "FAILED") return 2;
  if (status === "STOPPED") return 1;
  return 0;
}

function collapseRunsBySession(sortedRuns: LauncherRun[]) {
  const bySession = new Map<string, LauncherRun[]>();
  for (const run of sortedRuns) {
    const current = bySession.get(run.sessionId) ?? [];
    current.push(run);
    bySession.set(run.sessionId, current);
  }

  const collapsed: LauncherRun[] = [];
  for (const list of bySession.values()) {
    const chosen = [...list].sort((a, b) => {
      const statusDiff = runStatusPriority(b.status) - runStatusPriority(a.status);
      if (statusDiff !== 0) return statusDiff;
      return getRunUpdatedAt(b) - getRunUpdatedAt(a);
    })[0];
    if (chosen) {
      collapsed.push(chosen);
    }
  }

  return collapsed.sort((a, b) => getRunUpdatedAt(b) - getRunUpdatedAt(a));
}

function getRunAssistantOutput(run: LauncherRun) {
  const stable = cleanOutputText(String(run.assistantFinalOutput || ""));
  if (stable) return stable;
  return extractRunTranscript(run.outputTail);
}

function resolveFollowUpContext(
  session: AgentSession,
  latestRun: LauncherRun | null,
  selectedWorkspace: Workspace | null,
  workspaces: Workspace[]
): {
  agentType: AgentType;
  workspacePath: string;
  fullWorkspaceAccess?: boolean;
} | null {
  if (latestRun?.workspacePath) {
    return {
      agentType: latestRun.agentType,
      workspacePath: latestRun.workspacePath,
      fullWorkspaceAccess: latestRun.fullWorkspaceAccess || undefined,
    };
  }

  const repoName = normalizeLookup(session.repo);
  if (repoName) {
    const matched = workspaces.find((workspace) => normalizeLookup(workspace.name) === repoName);
    if (matched) {
      return {
        agentType: session.agentType,
        workspacePath: matched.path,
      };
    }
  }

  if (selectedWorkspace) {
    return {
      agentType: session.agentType,
      workspacePath: selectedWorkspace.path,
    };
  }

  return null;
}

function dedupeConversationRows(rows: ConversationRow[]) {
  const deduped: ConversationRow[] = [];
  for (const row of rows) {
    const last = deduped[deduped.length - 1];
    if (
      last &&
      last.kind === row.kind &&
      cleanOutputText(last.text) === cleanOutputText(row.text) &&
      Math.abs(last.timestamp - row.timestamp) <= 2_000
    ) {
      continue;
    }
    deduped.push(row);
  }
  return deduped;
}

function mergeChatTurnsFromSnapshot(serverTurns: ChatTurn[], currentTurns: ChatTurn[], nowMs: number) {
  const incoming = Array.isArray(serverTurns) ? [...serverTurns] : [];
  const previous = Array.isArray(currentTurns) ? currentTurns : [];
  const optimistic = previous.filter(
    (turn) => turn.source === "UI_OPTIMISTIC" && nowMs - turn.createdAt <= 45_000
  );

  const normalizedServer = incoming.sort((a, b) => a.createdAt - b.createdAt);

  const pendingOptimistic = optimistic.filter((candidate) => {
    const candidateText = normalizeMessageComparable(candidate.text);
    if (!candidateText) return false;

    const acknowledged = normalizedServer.some((serverTurn) => {
      if (serverTurn.sessionId !== candidate.sessionId) return false;
      if (serverTurn.role !== "USER") return false;
      if (serverTurn.kind !== "MESSAGE") return false;

      const serverText = normalizeMessageComparable(serverTurn.text);
      if (!serverText || serverText !== candidateText) return false;

      return Math.abs(serverTurn.createdAt - candidate.createdAt) <= 120_000;
    });

    return !acknowledged;
  });

  const mergedById = new Map<string, ChatTurn>();
  for (const turn of [...normalizedServer, ...pendingOptimistic]) {
    mergedById.set(turn.id, turn);
  }

  return [...mergedById.values()].sort((a, b) => a.createdAt - b.createdAt);
}

function extractRunTranscript(outputTail: string[]) {
  if (!Array.isArray(outputTail) || outputTail.length === 0) return "";

  const collected: string[] = [];

  const pushUnique = (value: string) => {
    const cleaned = cleanOutputText(value);
    if (!cleaned) return;
    if (collected[collected.length - 1] === cleaned) return;
    collected.push(cleaned);
  };

  for (const rawLine of outputTail) {
    const line = cleanOutputText(rawLine);
    if (!line || line.startsWith("[agent-runner]")) continue;

    const parsed = tryParseJsonLine(line);
    if (parsed) {
      const parts = extractTranscriptSegmentsFromJson(parsed);
      for (const part of parts) {
        if (shouldHideRawOutput(part)) continue;
        pushUnique(part);
      }
      continue;
    }

    if (shouldHideRawOutput(line)) continue;
    pushUnique(line);
  }

  return collected.slice(-32).join("\n");
}

function extractFinalModelOutput(outputTail: string[]) {
  return extractRunTranscript(outputTail);
}

function tryParseJsonLine(line: string): unknown | null {
  if (!line.startsWith("{")) return null;
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function extractTranscriptSegmentsFromJson(payload: unknown): string[] {
  if (!payload || typeof payload !== "object") return [];
  const event = payload as Record<string, unknown>;
  const type = typeof event.type === "string" ? event.type : "";
  const result: string[] = [];

  if (type === "assistant") {
    const message = asRecord(event.message);
    if (!message) return [];
    if (safeInlineText(message.role) !== "assistant") return [];
    return extractTextFragments(message.content ?? message.text, 0);
  }

  if (type === "result") {
    return extractTextFragments(event.result, 0);
  }

  if (type === "item.completed") {
    const item = asRecord(event.item);
    if (!item) return [];

    const itemType = safeInlineText(item.type);
    const textParts = extractTextFragments(item.text ?? item.content ?? item.message, 0);
    if (itemType === "agent_message" || itemType === "message") {
      return textParts;
    }

    if (itemType.includes("reason")) {
      if (textParts.length > 0) {
        return [`[thinking] ${textParts.join("\n")}`];
      }
      return ["[thinking]"];
    }

    if (itemType.includes("tool") || itemType.includes("function") || itemType.includes("call")) {
      const toolName =
        safeInlineText(item.name) ||
        safeInlineText(item.tool_name) ||
        safeInlineText(item.toolName) ||
        safeInlineText(asRecord(item.call)?.name) ||
        safeInlineText(asRecord(item.function)?.name);
      const header = toolName ? `[tool] ${toolName}` : "[tool]";
      if (textParts.length > 0) {
        return [header, ...textParts];
      }
      return [header];
    }

    return textParts;
  }

  if (type === "event_msg") {
    const payloadRecord = asRecord(event.payload);
    if (!payloadRecord) return [];
    const payloadType = safeInlineText(payloadRecord.type);
    if (payloadType === "agent_message" || payloadType === "message") {
      return extractTextFragments(payloadRecord.message ?? payloadRecord.content, 0);
    }
    return [];
  }

  if (type === "response_item") {
    const payloadRecord = asRecord(event.payload);
    if (!payloadRecord) return [];
    const payloadType = safeInlineText(payloadRecord.type);
    const role = safeInlineText(payloadRecord.role);
    const textParts = extractTextFragments(payloadRecord.content ?? payloadRecord.message ?? payloadRecord.text, 0);

    if (payloadType === "message" && role === "assistant") {
      return textParts;
    }

    if (payloadType.includes("reason")) {
      if (textParts.length > 0) {
        return [`[thinking] ${textParts.join("\n")}`];
      }
      return ["[thinking]"];
    }

    if (payloadType.includes("tool") || payloadType.includes("function") || payloadType.includes("call")) {
      const toolName =
        safeInlineText(payloadRecord.name) ||
        safeInlineText(payloadRecord.tool_name) ||
        safeInlineText(payloadRecord.toolName) ||
        safeInlineText(asRecord(payloadRecord.function)?.name);
      const header = toolName ? `[tool] ${toolName}` : "[tool]";
      if (textParts.length > 0) {
        return [header, ...textParts];
      }
      return [header];
    }

    return [];
  }

  return result;
}

function shouldHideRawOutput(line: string) {
  if (!line) return true;

  if (line.startsWith("[agent-runner]")) return true;
  // Hide transient thinking fragments
  if (/^\[thinking\]/i.test(line)) return true;
  if (/^\d{4}-\d{2}-\d{2}T/.test(line) && /\b(INFO|WARN|ERROR)\b/.test(line)) return true;
  if (/^(tip:|usage:|for more information, try|warning: term is set)/i.test(line)) return true;
  if (/^prompt[_\s-]*tokens?/i.test(line)) return true;
  if (/^completion[_\s-]*tokens?/i.test(line)) return true;
  if (/^total[_\s-]*tokens?/i.test(line)) return true;
  if (/^cost(?:[_\s-]*usd)?/i.test(line)) return true;
  if (/\b\d[\d,]*(?:\.\d+)?\s*tok(?:en)?s?\b/i.test(line)) return true;
  if (/^\$[\d,.]+/.test(line)) return true;
  if (/^error:\s*$/i.test(line)) return true;
  if (line === "y" || line === "n") return true;

  return false;
}

function extractTextFragments(value: unknown, depth: number): string[] {
  if (depth > 3 || value == null) return [];

  if (typeof value === "string") {
    const text = cleanOutputText(value);
    return text ? [text] : [];
  }

  if (Array.isArray(value)) {
    return value.flatMap((item) => extractTextFragments(item, depth + 1));
  }

  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const candidates = [
      record.text,
      record.message,
      record.content,
      record.summary,
      record.value,
      record.output
    ];

    const extracted: string[] = [];
    for (const candidate of candidates) {
      extracted.push(...extractTextFragments(candidate, depth + 1));
    }
    return extracted;
  }

  return [];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function safeInlineText(value: unknown) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function parseContentBlocks(raw: string): ContentBlock[] {
  const blocks: ContentBlock[] = [];
  // Split on fenced code blocks, preserving them
  const parts = raw.split(/(```[\s\S]*?```)/g);

  for (const part of parts) {
    // Fenced code block
    if (part.startsWith("```")) {
      const firstNl = part.indexOf("\n");
      const lang = firstNl > 3 ? part.slice(3, firstNl).trim() : "";
      const code = part.slice(Math.max(3, firstNl + 1), part.lastIndexOf("```")).trimEnd();
      if (code) blocks.push({ type: "code", lang, code });
      continue;
    }

    // Split remaining text into paragraphs
    const paragraphs = part.split(/\n{2,}/);
    for (const para of paragraphs) {
      const trimmed = para.trim();
      if (!trimmed) continue;

      // Detect bullet lists (lines starting with - or *)
      const lines = trimmed.split("\n");
      const allBullets = lines.length > 1 && lines.every((l) => /^\s*[-*•]\s/.test(l));
      if (allBullets) {
        blocks.push({ type: "list", items: lines.map((l) => l.replace(/^\s*[-*•]\s+/, "")) });
        continue;
      }

      // Detect "step" paragraphs: short action descriptions
      // (starts with "I'm", "I'll", "I found", "Checking", "Looking", etc. and < 200 chars)
      const isStep =
        trimmed.length < 200 &&
        /^(I('m|'ll|'ve| am| will| found| confirmed| also| need| want)|Checking|Looking|Reading|Searching|Let me|Now I|Validation|The two|So I)/i.test(trimmed);
      if (isStep) {
        blocks.push({ type: "step", text: trimmed });
        continue;
      }

      blocks.push({ type: "text", text: trimmed });
    }
  }

  return blocks;
}

function cleanOutputText(text: string) {
  return String(text || "")
    .replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "")
    .replace(/\r/g, "")
    .trim();
}

function truncateText(value: string, maxLength: number) {
  const clean = cleanOutputText(value);
  if (clean.length <= maxLength) return clean;
  return `${clean.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function normalizeLookup(value: string) {
  return String(value || "")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ");
}

function normalizeMessageComparable(value: string) {
  return cleanOutputText(value)
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function areSessionsEquivalent(previous: AgentSession[], next: AgentSession[]) {
  if (previous === next) return true;
  if (!Array.isArray(previous) || !Array.isArray(next)) return false;
  if (previous.length !== next.length) return false;

  for (let index = 0; index < previous.length; index += 1) {
    const a = previous[index];
    const b = next[index];
    if (!a || !b) return false;
    if (
      a.id !== b.id ||
      a.state !== b.state ||
      a.lastUpdated !== b.lastUpdated ||
      a.progress !== b.progress ||
      a.title !== b.title ||
      a.repo !== b.repo ||
      a.branch !== b.branch
    ) {
      return false;
    }
    if (
      a.tokenUsage?.totalTokens !== b.tokenUsage?.totalTokens ||
      a.tokenUsage?.promptTokens !== b.tokenUsage?.promptTokens ||
      a.tokenUsage?.completionTokens !== b.tokenUsage?.completionTokens ||
      a.tokenUsage?.costUsd !== b.tokenUsage?.costUsd
    ) {
      return false;
    }
  }

  return true;
}

function arePendingInputsEquivalent(previous: PendingInput[], next: PendingInput[]) {
  if (previous === next) return true;
  if (!Array.isArray(previous) || !Array.isArray(next)) return false;
  if (previous.length !== next.length) return false;

  for (let index = 0; index < previous.length; index += 1) {
    const a = previous[index];
    const b = next[index];
    if (!a || !b) return false;
    if (
      a.id !== b.id ||
      a.sessionId !== b.sessionId ||
      a.prompt !== b.prompt ||
      a.requestedAt !== b.requestedAt ||
      a.priority !== b.priority ||
      a.actionable !== b.actionable
    ) {
      return false;
    }
  }

  return true;
}

function areEventsEquivalent(previous: SessionEvent[], next: SessionEvent[]) {
  if (previous === next) return true;
  if (!Array.isArray(previous) || !Array.isArray(next)) return false;
  if (previous.length !== next.length) return false;

  for (let index = 0; index < previous.length; index += 1) {
    const a = previous[index];
    const b = next[index];
    if (!a || !b) return false;
    if (a.id !== b.id || a.sessionId !== b.sessionId || a.timestamp !== b.timestamp || a.category !== b.category || a.summary !== b.summary) {
      return false;
    }
  }

  return true;
}

function areChatTurnsEquivalent(previous: ChatTurn[], next: ChatTurn[]) {
  if (previous === next) return true;
  if (!Array.isArray(previous) || !Array.isArray(next)) return false;
  if (previous.length !== next.length) return false;

  for (let index = 0; index < previous.length; index += 1) {
    const a = previous[index];
    const b = next[index];
    if (!a || !b) return false;
    if (
      a.id !== b.id ||
      a.sessionId !== b.sessionId ||
      a.role !== b.role ||
      a.kind !== b.kind ||
      a.createdAt !== b.createdAt ||
      a.text !== b.text
    ) {
      return false;
    }
  }

  return true;
}

function areRunsEquivalent(previous: LauncherRun[], next: LauncherRun[]) {
  if (previous === next) return true;
  if (!Array.isArray(previous) || !Array.isArray(next)) return false;
  if (previous.length !== next.length) return false;

  for (let index = 0; index < previous.length; index += 1) {
    const a = previous[index];
    const b = next[index];
    if (!a || !b) return false;
    if (
      a.id !== b.id ||
      a.sessionId !== b.sessionId ||
      a.status !== b.status ||
      a.startedAt !== b.startedAt ||
      a.endedAt !== b.endedAt ||
      a.exitCode !== b.exitCode ||
      a.error !== b.error ||
      a.resumeCommand !== b.resumeCommand ||
      a.codexThreadId !== b.codexThreadId ||
      a.claudeSessionId !== b.claudeSessionId ||
      a.assistantFinalOutput !== b.assistantFinalOutput
    ) {
      return false;
    }

    const aTail = Array.isArray(a.outputTail) ? a.outputTail : [];
    const bTail = Array.isArray(b.outputTail) ? b.outputTail : [];
    if (aTail.length !== bTail.length) return false;
    if (aTail.length > 0 && aTail[aTail.length - 1] !== bTail[bTail.length - 1]) return false;
  }

  return true;
}

function areSettingsEquivalent(previous: SettingsPrefs, next: SettingsPrefs) {
  return (
    previous.criticalRealtime === next.criticalRealtime &&
    previous.digest === next.digest &&
    previous.pairingHealthy === next.pairingHealthy &&
    previous.metadataOnly === next.metadataOnly &&
    previous.darkLocked === next.darkLocked &&
    previous.networkOnline === next.networkOnline &&
    previous.workspaceRoot === next.workspaceRoot
  );
}

function dedupeSessionList(sessions: AgentSession[], runs: LauncherRun[]) {
  if (!Array.isArray(sessions) || sessions.length === 0) return [];

  const runBoundSessionIds = new Set(
    (Array.isArray(runs) ? runs : [])
      .map((run) => run?.sessionId)
      .filter((id): id is string => Boolean(id))
  );

  const threadToSession = new Map<string, { sessionId: string; updatedAt: number }>();
  for (const run of runs) {
    if (run.agentType !== "CODEX") continue;
    const threadId = getCodexThreadId(run);
    if (!threadId) continue;
    const updatedAt = getRunUpdatedAt(run);
    const existing = threadToSession.get(threadId);
    if (!existing || updatedAt >= existing.updatedAt) {
      threadToSession.set(threadId, { sessionId: run.sessionId, updatedAt });
    }
  }

  return sessions.filter((session) => {
    // Never hide a session that is explicitly referenced by a launcher run.
    if (runBoundSessionIds.has(session.id)) return true;

    if (session.id.startsWith("codex:")) {
      const threadId = session.id.slice("codex:".length).trim().toLowerCase();
      if (threadId) {
        const mapped = threadToSession.get(threadId);
        if (mapped && mapped.sessionId !== session.id) {
          return false;
        }
      }
    }

    return true;
  });
}

function getCodexThreadId(run: LauncherRun) {
  const direct = String(run.codexThreadId || "").trim().toLowerCase();
  if (direct) return direct;

  const resume = String(run.resumeCommand || "").trim();
  const resumeMatch = resume.match(/codex(?:\s+exec)?\s+resume\s+([0-9a-f-]+)/i);
  if (resumeMatch?.[1]) {
    return resumeMatch[1].toLowerCase();
  }

  const outputTail = Array.isArray(run.outputTail) ? run.outputTail : [];
  for (let index = outputTail.length - 1; index >= 0; index -= 1) {
    const line = cleanOutputText(outputTail[index]);
    const match = line.match(/\bcodex_thread=([0-9a-f-]+)/i);
    if (match?.[1]) return match[1].toLowerCase();
    const parsed = tryParseJsonLine(line) as { type?: string; thread_id?: string } | null;
    if (parsed?.type === "thread.started" && typeof parsed.thread_id === "string") {
      return parsed.thread_id.trim().toLowerCase();
    }
  }

  return "";
}

function getClaudeSessionId(run: LauncherRun) {
  const direct = normalizeClaudeSessionId(run.claudeSessionId || "");
  if (direct) return direct;

  const resume = String(run.resumeCommand || "").trim();
  const resumeMatch =
    resume.match(/claude(?:\s+code)?\s+--resume\s+([0-9a-f-]{36})/i) ||
    resume.match(/claude(?:\s+code)?\s+-r\s+([0-9a-f-]{36})/i);
  if (resumeMatch?.[1]) {
    return resumeMatch[1].toLowerCase();
  }

  const outputTail = Array.isArray(run.outputTail) ? run.outputTail : [];
  for (let index = outputTail.length - 1; index >= 0; index -= 1) {
    const parsed = tryParseJsonLine(cleanOutputText(outputTail[index])) as { session_id?: string } | null;
    if (!parsed?.session_id) continue;
    const parsedId = normalizeClaudeSessionId(parsed.session_id);
    if (parsedId) return parsedId;
  }

  return "";
}

function normalizeClaudeSessionId(value: string | null | undefined) {
  const candidate = String(value || "").trim().toLowerCase();
  if (!candidate) return "";
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(candidate)) {
    return candidate;
  }
  return "";
}

function priorityWeight(priority: PendingInput["priority"]) {
  if (priority === "HIGH") return 0;
  if (priority === "MEDIUM") return 1;
  return 2;
}

function getPendingKind(pending: PendingInput) {
  const meta = pending?.meta && typeof pending.meta === "object" ? pending.meta : null;
  const raw = String(meta?.kind || "").trim().toUpperCase();
  if (raw === "TOOL_PERMISSION") return "TOOL_PERMISSION";
  if (raw === "PLAN_CONFIRM") return "PLAN_CONFIRM";
  if (raw === "QUESTION_REQUEST") return "QUESTION_REQUEST";
  if (meta?.questionRequest === true) return "QUESTION_REQUEST";
  return "RUNTIME_APPROVAL";
}

function getPendingToolLabel(pending: PendingInput) {
  const meta = pending?.meta && typeof pending.meta === "object" ? pending.meta : null;
  const candidates = [
    meta?.toolName,
    meta?.tool,
    meta?.name,
    meta?.toolCall,
  ];
  for (const item of candidates) {
    const value = String(item || "").trim();
    if (!value) continue;
    return value.slice(0, 40);
  }

  const prompt = String(pending?.prompt || "").replace(/\\n/g, "\n");
  const match = prompt.match(/\[tool\]\s*([^\n(]+?)(?:\s*\(|$)/i);
  if (match?.[1]) {
    return match[1].trim().slice(0, 40);
  }

  return "";
}

function getPendingQuestionHeader(pending: PendingInput) {
  const meta = pending?.meta && typeof pending.meta === "object" ? pending.meta : null;
  return String(meta?.questionHeader || "").trim().slice(0, 120);
}

function getPendingQuestionOptions(pending: PendingInput): QuestionRequestOption[] {
  const meta = pending?.meta && typeof pending.meta === "object" ? pending.meta : null;
  const direct = Array.isArray(meta?.questionOptions)
    ? meta.questionOptions
        .map(normalizeQuestionOption)
        .filter((option): option is QuestionRequestOption => Boolean(option))
    : [];
  if (direct.length > 0) return direct;

  const prompt = String(pending?.prompt || "");
  const options = prompt
    .split("\n")
    .map((line) => line.trim())
    .map((line) => {
      const bulletMatch = line.match(/^[-*•]\s+(.{2,180})$/);
      if (bulletMatch?.[1]) return normalizeQuestionOption(bulletMatch[1].trim());
      const numberedMatch = line.match(/^(?:\d{1,2}[.)]|[A-Da-d][.)])\s+(.{2,180})$/);
      if (numberedMatch?.[1]) return normalizeQuestionOption(numberedMatch[1].trim());
      return null;
    })
    .filter(Boolean) as QuestionRequestOption[];

  const deduped: string[] = [];
  const seen = new Set<string>();
  for (const option of options) {
    const normalized = option.label.toLowerCase();
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    deduped.push(option.label.slice(0, 140));
    if (deduped.length >= 6) break;
  }

  return deduped.map((label) => ({ label }));
}

function normalizeQuestionOption(option: unknown): QuestionRequestOption | null {
  if (typeof option === "string") {
    const label = option.trim().slice(0, 140);
    return label ? { label } : null;
  }
  if (!option || typeof option !== "object") return null;
  const label = String((option as { label?: unknown; value?: unknown }).label || (option as { value?: unknown }).value || "")
    .trim()
    .slice(0, 140);
  const description = String((option as { description?: unknown }).description || "").trim().slice(0, 220);
  const value = String((option as { value?: unknown }).value || label).trim().slice(0, 140);
  if (!label) return null;
  return {
    label,
    description: description || undefined,
    value: value || undefined,
  };
}

function isDirectSessionId(sessionId: string) {
  const id = String(sessionId || "");
  return id.startsWith("codex:") || id.startsWith("claude:");
}

function isLocalRelayUrl(value: string | null | undefined) {
  const raw = String(value || "").trim();
  if (!raw) return false;
  try {
    const parsed = new URL(raw);
    const host = parsed.hostname.toLowerCase();
    return host === "localhost" || host === "127.0.0.1" || host === "::1";
  } catch {
    return false;
  }
}

export default App;
