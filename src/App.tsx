import { useEffect, useMemo, useState } from "react";
import {
  Activity,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Clock3,
  Folder,
  FolderGit2,
  LayoutDashboard,
  Link,
  ListChecks,
  Loader2,
  Play,
  RefreshCw,
  Rocket,
  Send,
  Settings2,
  ShieldAlert,
  Smartphone,
  Square,
  TerminalSquare,
  TriangleAlert,
  Unlink,
  XCircle,
  Zap
} from "lucide-react";
import {
  claimPairingCode,
  clearPairingConfig,
  type ClientConfig,
  DEFAULT_CLIENT_CONFIG,
  fetchBridgeSnapshot,
  fetchDeviceStatus,
  fetchLauncherRuns,
  fetchWorkspaces,
  launchTask,
  loadPairingConfig,
  savePairingConfig,
  stopRun,
  submitBridgeAction,
  TokenExpiredError,
} from "./bridgeClient";
import { initialEvents, initialPendingInputs, initialSessions, initialSettings } from "./mockData";
import { ActionType, AgentSession, AgentType, LauncherRun, LauncherRunStatus, PairingConfig, PendingInput, RemoteDeviceStatus, SessionEvent, SessionState, Workspace } from "./types";
import { clamp, formatNumber, formatRelativeTime, formatUsd } from "./utils";
import { Badge } from "./components/ui/badge";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
import { Switch } from "./components/ui/switch";
import { cn } from "./lib/utils";

type Tab = "DASHBOARD" | "SESSION" | "PENDING" | "SETTINGS" | "RUN";
type Filter = "ALL" | SessionState;

const STATUS_LABEL: Record<SessionState, string> = {
  RUNNING: "Running",
  WAITING_INPUT: "Waiting",
  COMPLETED: "Done",
  FAILED: "Failed",
  CANCELLED: "Cancelled"
};

const STATUS_BADGE = {
  RUNNING: "success",
  WAITING_INPUT: "warning",
  COMPLETED: "muted",
  FAILED: "danger",
  CANCELLED: "muted"
} as const;

const STATUS_ICON = {
  RUNNING: Activity,
  WAITING_INPUT: Clock3,
  COMPLETED: CheckCircle2,
  FAILED: TriangleAlert,
  CANCELLED: XCircle
} as const;

const AGENT_OPTIONS: Array<{ value: AgentType; label: string; color: string; bg: string }> = [
  { value: "CLAUDE", label: "Claude", color: "text-brand-claude", bg: "bg-brand-claude/10" },
  { value: "CODEX", label: "Codex", color: "text-brand-openai", bg: "bg-brand-openai/10" }
];

const RUN_STATUS_LABEL: Record<LauncherRunStatus, string> = {
  STARTING: "Starting",
  RUNNING: "Running",
  COMPLETED: "Done",
  FAILED: "Failed",
  STOPPED: "Stopped"
};

const RUN_STATUS_COLOR: Record<LauncherRunStatus, string> = {
  STARTING: "text-amber-400",
  RUNNING: "text-emerald-400",
  COMPLETED: "text-muted-foreground",
  FAILED: "text-rose-400",
  STOPPED: "text-muted-foreground"
};

const TAB_ITEMS: Array<{
  id: Tab;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
}> = [
  { id: "DASHBOARD", label: "Home", icon: LayoutDashboard },
  { id: "PENDING", label: "Actions", icon: ListChecks },
  { id: "RUN", label: "Run", icon: Rocket },
  { id: "SETTINGS", label: "Settings", icon: Settings2 }
];

const FILTER_ITEMS: Filter[] = ["ALL", "WAITING_INPUT", "RUNNING", "FAILED", "COMPLETED"];
const FIXED_RELAY_URL = ((import.meta.env.VITE_RELAY_URL as string | undefined) || "https://agent-companion-relay.onrender.com").trim();

function App() {
  const [activeTab, setActiveTab] = useState<Tab>("DASHBOARD");
  const [filter, setFilter] = useState<Filter>("ALL");
  const [agentFilter, setAgentFilter] = useState<"ALL" | AgentType>("ALL");
  const [sessions, setSessions] = useState<AgentSession[]>(initialSessions);
  const [pendingInputs, setPendingInputs] = useState<PendingInput[]>(initialPendingInputs);
  const [events, setEvents] = useState<SessionEvent[]>(initialEvents);
  const [settings, setSettings] = useState(initialSettings);
  const [selectedSessionId, setSelectedSessionId] = useState(initialSessions[0]?.id ?? "");
  const [replyDraft, setReplyDraft] = useState("");
  const [pendingDrafts, setPendingDrafts] = useState<Record<string, string>>({});
  const [expandedReplyId, setExpandedReplyId] = useState<string | null>(null);
  const [busyActionIds, setBusyActionIds] = useState<string[]>([]);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [loadingView, setLoadingView] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [installPromptEvent, setInstallPromptEvent] = useState<BeforeInstallPromptEvent | null>(null);
  const [bridgeEnabled, setBridgeEnabled] = useState(true);
  const [bridgeConnected, setBridgeConnected] = useState(false);

  // ── Pairing state ──
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
  const pairRelayUrl = FIXED_RELAY_URL;

  // ── Derived client config ──
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

  // ── Run tab state ──
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [workspacesLoading, setWorkspacesLoading] = useState(false);
  const [launcherRuns, setLauncherRuns] = useState<LauncherRun[]>([]);
  const [runAgentType, setRunAgentType] = useState<AgentType>("CLAUDE");
  const [runWorkspace, setRunWorkspace] = useState<Workspace | null>(null);
  const [runPrompt, setRunPrompt] = useState("");
  const [runTitle, setRunTitle] = useState("");
  const [isLaunching, setIsLaunching] = useState(false);
  const [workspacePickerOpen, setWorkspacePickerOpen] = useState(false);
  const [agentPickerOpen, setAgentPickerOpen] = useState(false);
  const [runFullAccess, setRunFullAccess] = useState(false);
  const [runPlanMode, setRunPlanMode] = useState(false);
  const [showLaunchConfirm, setShowLaunchConfirm] = useState(false);

  // ── Mock simulation (when bridge disabled) ──
  useEffect(() => {
    if (bridgeEnabled) return;
    const interval = window.setInterval(() => {
      if (!settings.networkOnline) return;
      setSessions((prev) =>
        prev.map((session) => {
          if (session.state !== "RUNNING") return session;
          const promptDelta = Math.floor(Math.random() * 300 + 40);
          const completionDelta = Math.floor(Math.random() * 230 + 30);
          const totalDelta = promptDelta + completionDelta;
          const progressDelta = Math.random() * 3.5;
          return {
            ...session,
            progress: clamp(session.progress + progressDelta, 0, 100),
            lastUpdated: Date.now(),
            tokenUsage: {
              promptTokens: session.tokenUsage.promptTokens + promptDelta,
              completionTokens: session.tokenUsage.completionTokens + completionDelta,
              totalTokens: session.tokenUsage.totalTokens + totalDelta,
              costUsd: Number((session.tokenUsage.costUsd + totalDelta * 0.00001).toFixed(2))
            }
          };
        })
      );
    }, 4200);
    return () => window.clearInterval(interval);
  }, [bridgeEnabled, settings.networkOnline]);

  // ── Network listeners ──
  useEffect(() => {
    const onOnline = () => setSettings((prev) => ({ ...prev, networkOnline: true }));
    const onOffline = () => setSettings((prev) => ({ ...prev, networkOnline: false }));
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    return () => {
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
    };
  }, []);

  // ── PWA install prompt ──
  useEffect(() => {
    const installer = (event: Event) => {
      event.preventDefault();
      setInstallPromptEvent(event as BeforeInstallPromptEvent);
    };
    window.addEventListener("beforeinstallprompt", installer);
    return () => window.removeEventListener("beforeinstallprompt", installer);
  }, []);

  // ── Token expiry handler ──
  const handleTokenExpired = () => {
    clearPairingConfig();
    setPairingConfig(null);
    setDeviceStatus(null);
    setToast("Session expired. Re-pair your device.");
  };

  // ── Bridge polling ──
  useEffect(() => {
    if (!pairingConfig) return;
    if (!bridgeEnabled && pairingConfig.mode === "LOCAL") {
      setBridgeConnected(false);
      return;
    }
    let cancelled = false;
    const syncFromBridge = async () => {
      try {
        const snapshot = await fetchBridgeSnapshot(clientConfig);
        if (cancelled) return;
        if (!snapshot) {
          setBridgeConnected(false);
          return;
        }
        setBridgeConnected(true);
        setSessions(snapshot.sessions);
        setPendingInputs(snapshot.pendingInputs);
        setEvents(snapshot.events);
        setSettings((prev) => ({
          ...prev,
          ...snapshot.settings,
          networkOnline: snapshot.settings.networkOnline && navigator.onLine
        }));
        setSelectedSessionId((prev) =>
          snapshot.sessions.some((session) => session.id === prev) ? prev : snapshot.sessions[0]?.id ?? ""
        );
      } catch (err) {
        if (err instanceof TokenExpiredError) handleTokenExpired();
      }
    };
    void syncFromBridge();
    const interval = window.setInterval(() => {
      void syncFromBridge();
    }, 2000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [bridgeEnabled, pairingConfig, clientConfig]);

  // ── Device status polling (REMOTE only) ──
  useEffect(() => {
    if (pairingConfig?.mode !== "REMOTE") {
      setDeviceStatus(null);
      return;
    }
    let cancelled = false;
    const poll = async () => {
      try {
        const s = await fetchDeviceStatus(clientConfig);
        if (!cancelled) setDeviceStatus(s);
      } catch (err) {
        if (err instanceof TokenExpiredError) handleTokenExpired();
      }
    };
    void poll();
    const iv = setInterval(() => { void poll(); }, 10_000);
    return () => { cancelled = true; clearInterval(iv); };
  }, [pairingConfig, clientConfig]);

  // ── Toast auto-dismiss ──
  useEffect(() => {
    if (!toast) return;
    const timeout = window.setTimeout(() => setToast(null), 2000);
    return () => window.clearTimeout(timeout);
  }, [toast]);

  // ── Workspace fetch (when Run tab opens + bridge connected) ──
  useEffect(() => {
    if (activeTab !== "RUN" || !bridgeEnabled || !bridgeConnected) return;
    let cancelled = false;
    setWorkspacesLoading(true);
    void (async () => {
      try {
        const ws = await fetchWorkspaces(clientConfig);
        if (cancelled) return;
        setWorkspaces(ws);
        setWorkspacesLoading(false);
        setRunWorkspace((prev) => prev ?? ws[0] ?? null);
      } catch (err) {
        if (err instanceof TokenExpiredError) handleTokenExpired();
      }
    })();
    return () => { cancelled = true; };
  }, [activeTab, bridgeEnabled, bridgeConnected, clientConfig]);

  // ── Derived: hasActiveRuns ──
  const hasActiveRuns = useMemo(
    () => launcherRuns.some((r) => r.status === "STARTING" || r.status === "RUNNING"),
    [launcherRuns]
  );

  // ── Launcher runs polling ──
  useEffect(() => {
    if (!bridgeEnabled || !bridgeConnected) return;
    let cancelled = false;
    const poll = async () => {
      try {
        const runs = await fetchLauncherRuns(clientConfig);
        if (!cancelled) setLauncherRuns(runs);
      } catch (err) {
        if (err instanceof TokenExpiredError) handleTokenExpired();
      }
    };
    void poll();
    const interval = window.setInterval(() => { void poll(); }, hasActiveRuns ? 3000 : 15000);
    return () => { cancelled = true; window.clearInterval(interval); };
  }, [bridgeEnabled, bridgeConnected, hasActiveRuns, clientConfig]);

  // ── Derived state ──
  const sessionById = useMemo(() => new Map(sessions.map((s) => [s.id, s])), [sessions]);
  const selectedSession = sessionById.get(selectedSessionId) ?? sessions[0] ?? null;

  const selectedSessionEvents = useMemo(() => {
    if (!selectedSession) return [];
    return events
      .filter((event) => event.sessionId === selectedSession.id)
      .sort((a, b) => b.timestamp - a.timestamp);
  }, [events, selectedSession]);

  const selectedSessionPending = selectedSession
    ? pendingInputs.find((pending) => pending.sessionId === selectedSession.id) ?? null
    : null;

  const filteredSessions = useMemo(() => {
    return sessions.filter((session) => {
      if (filter !== "ALL" && session.state !== filter) return false;
      if (agentFilter !== "ALL" && session.agentType !== agentFilter) return false;
      return true;
    });
  }, [filter, agentFilter, sessions]);

  const counts = useMemo(
    () => ({
      running: sessions.filter((s) => s.state === "RUNNING").length,
      waiting: sessions.filter((s) => s.state === "WAITING_INPUT").length,
      failed: sessions.filter((s) => s.state === "FAILED").length,
      completed: sessions.filter((s) => s.state === "COMPLETED").length
    }),
    [sessions]
  );

  const tokenStats = useMemo(() => {
    const totalTokens = sessions.reduce((sum, item) => sum + item.tokenUsage.totalTokens, 0);
    const totalCost = sessions.reduce((sum, item) => sum + item.tokenUsage.costUsd, 0);
    return { totalTokens, totalCost };
  }, [sessions]);

  const isStale = sessions.some((session) => Date.now() - session.lastUpdated > 95_000);

  // ── Handlers ──
  const triggerRefresh = () => {
    setIsRefreshing(true);
    setLoadingView(true);
    if (bridgeEnabled) {
      void (async () => {
        try {
          const snapshot = await fetchBridgeSnapshot(clientConfig);
          if (snapshot) {
            setBridgeConnected(true);
            setSessions(snapshot.sessions);
            setPendingInputs(snapshot.pendingInputs);
            setEvents(snapshot.events);
            setSettings((prev) => ({
              ...prev,
              ...snapshot.settings,
              networkOnline: snapshot.settings.networkOnline && navigator.onLine
            }));
            setSelectedSessionId((prev) =>
              snapshot.sessions.some((session) => session.id === prev) ? prev : snapshot.sessions[0]?.id ?? ""
            );
            setToast("Synced with bridge");
          } else {
            setBridgeConnected(false);
            setToast("Bridge unavailable");
          }
        } catch (err) {
          if (err instanceof TokenExpiredError) handleTokenExpired();
        }
        setIsRefreshing(false);
        setLoadingView(false);
      })();
      return;
    }
    window.setTimeout(() => {
      setSessions((prev) =>
        prev.map((session) => ({
          ...session,
          lastUpdated: Date.now() - Math.floor(Math.random() * 5000)
        }))
      );
      setIsRefreshing(false);
      setLoadingView(false);
      setToast("Feed refreshed");
    }, 850);
  };

  const installPwa = async () => {
    if (!installPromptEvent) return;
    await installPromptEvent.prompt();
    await installPromptEvent.userChoice;
    setInstallPromptEvent(null);
  };

  const handleAction = (pending: PendingInput, type: ActionType, text?: string) => {
    const actionable = pending.actionable !== false;
    if (!actionable) {
      setToast("Handle this approval on laptop CLI");
      return;
    }
    if (!settings.networkOnline) {
      setToast("Offline — action queued");
      return;
    }
    if (busyActionIds.includes(pending.id)) return;

    if (bridgeEnabled) {
      setBusyActionIds((prev) => [...prev, pending.id]);
      void (async () => {
        let ok = false;
        try {
          ok = await submitBridgeAction(clientConfig, {
            pendingInputId: pending.id,
            sessionId: pending.sessionId,
            type,
            text
          });
        } catch (err) {
          if (err instanceof TokenExpiredError) { handleTokenExpired(); return; }
        }
        setBusyActionIds((prev) => prev.filter((id) => id !== pending.id));
        if (!ok) {
          setToast("Action failed");
          return;
        }
        applyLocalActionState(pending, type, text);
        setExpandedReplyId(null);
        setReplyDraft("");
        setPendingDrafts((prev) => ({ ...prev, [pending.id]: "" }));
        setToast(type === "REJECT" ? "Rejected" : "Sent");
        if (navigator.vibrate) {
          navigator.vibrate(type === "REJECT" ? [15, 25, 15] : 18);
        }
      })();
      return;
    }

    setBusyActionIds((prev) => [...prev, pending.id]);
    window.setTimeout(() => {
      applyLocalActionState(pending, type, text);
      setBusyActionIds((prev) => prev.filter((id) => id !== pending.id));
      setExpandedReplyId(null);
      setReplyDraft("");
      setPendingDrafts((prev) => ({ ...prev, [pending.id]: "" }));
      setToast(type === "REJECT" ? "Rejected" : "Sent");
    }, 420);
  };

  const applyLocalActionState = (pending: PendingInput, type: ActionType, text?: string) => {
    setPendingInputs((prev) => prev.filter((item) => item.id !== pending.id));
    setSessions((prev) =>
      prev.map((session) => {
        if (session.id !== pending.sessionId) return session;
        return {
          ...session,
          state: type === "REJECT" ? "CANCELLED" : "RUNNING",
          progress: type === "REJECT" ? session.progress : clamp(session.progress + 3, 0, 100),
          lastUpdated: Date.now()
        };
      })
    );
    const summary =
      type === "APPROVE"
        ? "Input approved. Agent resumed."
        : type === "REJECT"
          ? "Input rejected. Session cancelled."
          : `Reply sent: ${text?.trim() || "(empty)"}`;
    setEvents((prev) => [
      {
        id: `e_${Date.now()}`,
        sessionId: pending.sessionId,
        summary,
        timestamp: Date.now(),
        category: "ACTION"
      },
      ...prev
    ]);
  };

  const onReplySubmit = (pending: PendingInput) => {
    const text = (pendingDrafts[pending.id] ?? "").trim();
    if (!text) return;
    handleAction(pending, "TEXT_REPLY", text);
  };

  const onSessionQuickReply = () => {
    if (!selectedSessionPending) return;
    const text = replyDraft.trim();
    if (!text) return;
    handleAction(selectedSessionPending, "TEXT_REPLY", text);
  };

  const handleLaunchTask = () => {
    if (!runPrompt.trim() || !runWorkspace || isLaunching) return;
    if (runPlanMode && runFullAccess) {
      setToast("Plan mode cannot be combined with full access");
      return;
    }
    if (runFullAccess && !showLaunchConfirm) {
      setShowLaunchConfirm(true);
      return;
    }
    setShowLaunchConfirm(false);
    setIsLaunching(true);
    void (async () => {
      try {
        const run = await launchTask(clientConfig, {
          agentType: runAgentType,
          workspacePath: runWorkspace.path,
          prompt: runPrompt.trim(),
          title: runTitle.trim() || undefined,
          fullWorkspaceAccess: runFullAccess || undefined,
          planMode: runPlanMode || undefined
        });
        setIsLaunching(false);
        if (!run) {
          setToast("Launch failed");
          return;
        }
        setRunPrompt("");
        setRunTitle("");
        setRunPlanMode(false);
        setToast("Task launched");
        const runs = await fetchLauncherRuns(clientConfig);
        setLauncherRuns(runs);
      } catch (err) {
        setIsLaunching(false);
        if (err instanceof TokenExpiredError) handleTokenExpired();
      }
    })();
  };

  const handleStopRun = (runId: string) => {
    void (async () => {
      try {
        const ok = await stopRun(clientConfig, runId);
        if (!ok) {
          setToast("Stop failed");
          return;
        }
        setToast("Stop requested");
        const runs = await fetchLauncherRuns(clientConfig);
        setLauncherRuns(runs);
      } catch (err) {
        if (err instanceof TokenExpiredError) handleTokenExpired();
      }
    })();
  };

  // ── Pairing handlers ──
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
          EXPIRED: "Code expired. Generate a new one on your laptop.",
          NETWORK_ERROR: "Cannot reach relay server.",
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
      setToast("Paired successfully!");
    })();
  };

  const handleUnpair = () => {
    clearPairingConfig();
    setPairingConfig(null);
    setDeviceStatus(null);
  };

  // ═══════════════════════════════════════════
  //  RENDER
  // ═══════════════════════════════════════════

  // ── Pairing screen guard ──
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

  const isRemote = pairingConfig.mode === "REMOTE";
  const laptopOnline = isRemote ? Boolean(deviceStatus?.online) : bridgeEnabled && bridgeConnected;

  // Helper for last-seen text
  const lastSeenText = (() => {
    if (!isRemote || !deviceStatus?.lastSeenAt) return null;
    const ago = Date.now() - deviceStatus.lastSeenAt;
    if (ago < 60_000) return "Last seen <1m ago";
    return `Last seen ${Math.round(ago / 60_000)}m ago`;
  })();

  return (
    <div className="relative min-h-screen bg-background text-foreground">
      <div className="mx-auto w-full max-w-lg px-5 pb-28 pt-[max(env(safe-area-inset-top),16px)]">

        {/* ── Persistent Top Bar ── */}
        <header className="flex items-center justify-between pb-4">
          <div className="flex items-baseline gap-0">
            <span className="font-space text-base font-bold tracking-tight text-brand-claude">agent</span>
            <span className="font-space text-base font-bold tracking-tight text-muted-foreground/30">.</span>
            <span className="font-space text-base font-bold tracking-tight text-foreground/60">companion</span>
            <span
              className={cn(
                "ml-2 inline-block h-1.5 w-1.5 rounded-full",
                isRemote
                  ? (deviceStatus?.online ? "bg-emerald-400 animate-pulse-soft" : "bg-rose-400")
                  : (bridgeEnabled && bridgeConnected
                    ? "bg-emerald-400 animate-pulse-soft"
                    : !settings.networkOnline
                      ? "bg-rose-400"
                      : "bg-amber-400")
              )}
            />
          </div>
          <div className="flex items-center gap-1">
            {installPromptEvent && (
              <button
                onClick={installPwa}
                className="text-[10px] text-muted-foreground/50 transition hover:text-foreground"
              >
                Install
              </button>
            )}
            <button
              onClick={triggerRefresh}
              disabled={isRefreshing}
              className="flex h-7 w-7 items-center justify-center rounded-full text-muted-foreground/50 transition hover:bg-white/[0.05] hover:text-foreground active:scale-95 disabled:opacity-40"
            >
              {isRefreshing ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <RefreshCw className="h-3.5 w-3.5" />
              )}
            </button>
          </div>
        </header>

        {/* Alert banner */}
        {isRemote && deviceStatus && !deviceStatus.online && (
          <div className="mb-4 rounded-xl bg-amber-500/[0.06] px-3 py-2 text-[11px] text-amber-400/80">
            Laptop offline{lastSeenText ? ` (${lastSeenText.toLowerCase()})` : ""}
          </div>
        )}
        {isRemote && !deviceStatus && (
          <div className="mb-4 rounded-xl bg-rose-500/[0.06] px-3 py-2 text-[11px] text-rose-400/80">
            Relay unreachable
          </div>
        )}
        {!isRemote && bridgeEnabled && !bridgeConnected && (
          <div className="mb-4 rounded-xl bg-amber-500/[0.06] px-3 py-2 text-[11px] text-amber-400/80">
            Bridge offline — run <span className="font-mono">npm run bridge</span>
          </div>
        )}

        {/* ── DASHBOARD ── */}
        {activeTab === "DASHBOARD" && (
          <div className="animate-fade-in">
            {/* Connection Card (REMOTE only) */}
            {isRemote && (
              <div className="mb-4 flex items-center gap-3 rounded-xl bg-white/[0.03] px-3 py-3">
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-brand-claude/10">
                  <Smartphone className="h-4 w-4 text-brand-claude" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-[12px] font-semibold">
                      {deviceStatus?.deviceLabel || pairingConfig?.deviceId || "Remote Device"}
                    </span>
                    <Badge variant="muted">Remote</Badge>
                  </div>
                  <div className="mt-0.5 flex items-center gap-2">
                    <span
                      className={cn(
                        "inline-block h-1.5 w-1.5 rounded-full",
                        deviceStatus?.online ? "bg-emerald-400 animate-pulse-soft" : "bg-rose-400"
                      )}
                    />
                    <span className="text-[10px] text-muted-foreground/60">
                      {deviceStatus?.online ? "Online" : (lastSeenText ?? "Offline")}
                    </span>
                  </div>
                </div>
              </div>
            )}

            {/* Stats */}
            <div className="grid grid-cols-4 gap-2">
              <StatTile value={counts.running} label="Live" icon={Activity} accent="openai" />
              <StatTile value={counts.waiting} label="Blocked" icon={Clock3} accent="warning" />
              <StatTile value={counts.failed} label="Failed" icon={TriangleAlert} accent="danger" />
              <StatTile value={counts.completed} label="Done" icon={CheckCircle2} />
            </div>

            {/* ── Section break ── */}
            <div className="my-5 border-b border-white/[0.04]" />

            {/* Sessions header + agent toggle */}
            <div className="flex items-center justify-between">
              <h2 className="text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Sessions</h2>
              <div className="flex items-center rounded-xl border border-white/[0.06] bg-white/[0.02] p-0.5">
                {(["ALL", "CLAUDE", "CODEX"] as const).map((item) => (
                  <button
                    key={item}
                    onClick={() => setAgentFilter(item)}
                    className={cn(
                      "rounded-lg px-3 py-1 text-[11px] font-medium transition",
                      agentFilter === item
                        ? item === "CLAUDE"
                          ? "bg-brand-claude/15 text-brand-claude"
                          : item === "CODEX"
                            ? "bg-brand-openai/15 text-brand-openai"
                            : "bg-white/[0.08] text-foreground"
                        : "text-muted-foreground/40 hover:text-muted-foreground"
                    )}
                  >
                    {item === "ALL" ? "All" : item === "CLAUDE" ? "Claude" : "Codex"}
                  </button>
                ))}
              </div>
            </div>

            {/* Status filter pills */}
            <div className="mt-4 flex gap-3 border-b border-white/[0.04] pb-3">
              {FILTER_ITEMS.map((item) => (
                <button
                  key={item}
                  onClick={() => setFilter(item)}
                  className={cn(
                    "shrink-0 text-[13px] font-medium transition",
                    filter === item
                      ? "rounded-full bg-white/[0.08] px-3 py-1 text-foreground"
                      : "px-0 py-1 text-muted-foreground/40 hover:text-muted-foreground"
                  )}
                >
                  {item === "ALL" ? "All" : STATUS_LABEL[item]}
                </button>
              ))}
            </div>

            {/* Session list */}
            <div className="mt-4">
              {loadingView ? (
                <div className="space-y-3">
                  {[1, 2, 3].map((i) => (
                    <div key={i} className="h-20 animate-pulse rounded-2xl bg-white/[0.03]" />
                  ))}
                </div>
              ) : filteredSessions.length === 0 ? (
                <EmptyState message="No sessions here yet." />
              ) : (
                <div className="space-y-1">
                  {filteredSessions.map((session) => {
                    const StatusIcon = STATUS_ICON[session.state];
                    const latestEvent = events
                      .filter((e) => e.sessionId === session.id)
                      .sort((a, b) => b.timestamp - a.timestamp)[0] ?? null;
                    return (
                      <button
                        key={session.id}
                        onClick={() => {
                          setSelectedSessionId(session.id);
                          setActiveTab("SESSION");
                        }}
                        className="group flex w-full items-center gap-3 rounded-xl px-2 py-3 text-left transition-colors hover:bg-white/[0.03] active:bg-white/[0.05]"
                      >
                        {/* Status icon with agent color */}
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
                                session.agentType === "CODEX"
                                  ? "bg-brand-openai/10 text-brand-openai"
                                  : "bg-brand-claude/10 text-brand-claude"
                              )}
                            >
                              {session.agentType === "CODEX" ? "Codex" : "Claude"}
                            </span>
                          </div>

                          {/* Latest thread activity */}
                          {latestEvent && (
                            <p className="mt-0.5 truncate text-[11px] leading-snug text-foreground/40">
                              {latestEvent.summary}
                            </p>
                          )}

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
                            <span className="text-[9px] text-muted-foreground/40">
                              {formatRelativeTime(session.lastUpdated)}
                            </span>
                          </div>

                          {/* Progress bar */}
                          <div className="mt-2 h-[2px] overflow-hidden rounded-full bg-white/[0.05]">
                            <div
                              className={cn(
                                "h-full rounded-full transition-all duration-700",
                                session.agentType === "CODEX" ? "bg-brand-openai/40" : "bg-brand-claude/40"
                              )}
                              style={{ width: `${session.progress}%` }}
                            />
                          </div>
                        </div>

                        <ChevronRight className="h-3.5 w-3.5 shrink-0 text-white/[0.07]" />
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        )}

        {/* ── SESSION DETAIL ── */}
        {activeTab === "SESSION" && (
          <div className="animate-fade-in">
            {!selectedSession ? (
              <div className="pt-16">
                <EmptyState message="Pick a session from the dashboard." />
              </div>
            ) : (
              <>
                {/* Back */}
                <button
                  onClick={() => setActiveTab("DASHBOARD")}
                  className="flex items-center gap-1 text-[11px] text-muted-foreground transition hover:text-foreground"
                >
                  <ChevronRight className="h-3 w-3 rotate-180" />
                  Sessions
                </button>

                {/* Session header */}
                <div className="mt-3">
                  <div className="flex items-center gap-2">
                    <span
                      className={cn(
                        "h-2 w-2 rounded-full",
                        selectedSession.agentType === "CODEX" ? "bg-brand-openai" : "bg-brand-claude"
                      )}
                    />
                    <span className={cn(
                      "text-[10px] font-medium",
                      selectedSession.agentType === "CODEX" ? "text-brand-openai" : "text-brand-claude"
                    )}>
                      {selectedSession.agentType === "CODEX" ? "Codex" : "Claude"}
                    </span>
                    <Badge variant={STATUS_BADGE[selectedSession.state]}>
                      {STATUS_LABEL[selectedSession.state]}
                    </Badge>
                  </div>

                  <h2 className="mt-2 font-space text-lg font-bold leading-tight">{selectedSession.title}</h2>
                </div>

                {/* Progress + meta */}
                <div className="mt-4">
                  <div className="h-[3px] overflow-hidden rounded-full bg-white/[0.06]">
                    <div
                      className={cn(
                        "h-full rounded-full transition-all duration-700",
                        selectedSession.agentType === "CODEX" ? "bg-brand-openai/60" : "bg-brand-claude/60"
                      )}
                      style={{ width: `${selectedSession.progress}%` }}
                    />
                  </div>
                  <div className="mt-1.5 flex items-center justify-between text-[10px] text-muted-foreground/60">
                    <span>{Math.round(selectedSession.progress)}%</span>
                    <span>{formatNumber(selectedSession.tokenUsage.totalTokens)} tok · {formatUsd(selectedSession.tokenUsage.costUsd)}</span>
                  </div>
                </div>

                {/* Pending input action area */}
                {selectedSessionPending && (
                  <div className="mt-5 rounded-2xl bg-amber-500/[0.05] px-4 py-3.5">
                    <div className="flex items-center gap-2">
                      <Zap className="h-3 w-3 text-amber-400" />
                      <span className="text-[10px] font-semibold uppercase tracking-wider text-amber-400/80">Blocked</span>
                    </div>

                    <p className="mt-2 text-[13px] leading-snug text-foreground/85">
                      {selectedSessionPending.prompt}
                    </p>
                    {selectedSessionPending.actionable === false ? (
                      <p className="mt-3 text-[11px] text-amber-400/80">
                        Approval is tracked only. Respond from the local CLI session.
                      </p>
                    ) : (
                      <>
                        {/* Primary action — full width approve */}
                        <Button
                          className="mt-3 w-full"
                          onClick={() => handleAction(selectedSessionPending, "APPROVE")}
                          disabled={busyActionIds.includes(selectedSessionPending.id)}
                        >
                          Approve
                        </Button>

                        {/* Secondary row: reply input + reject */}
                        <div className="mt-2 flex gap-2">
                          <Input
                            value={replyDraft}
                            placeholder="Or type a reply..."
                            onChange={(event) => setReplyDraft(event.target.value)}
                            onKeyDown={(e) => e.key === "Enter" && onSessionQuickReply()}
                            disabled={busyActionIds.includes(selectedSessionPending.id)}
                            className="border-amber-400/10 bg-amber-500/[0.04]"
                          />
                          {replyDraft.trim() ? (
                            <button
                              onClick={onSessionQuickReply}
                              disabled={busyActionIds.includes(selectedSessionPending.id)}
                              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-brand-claude text-white transition active:scale-95 disabled:opacity-40"
                            >
                              <Send className="h-3.5 w-3.5" />
                            </button>
                          ) : (
                            <button
                              onClick={() => handleAction(selectedSessionPending, "REJECT")}
                              disabled={busyActionIds.includes(selectedSessionPending.id)}
                              className="shrink-0 rounded-full px-3 text-[11px] text-rose-400/70 transition hover:text-rose-400 active:scale-95 disabled:opacity-40"
                            >
                              Reject
                            </button>
                          )}
                        </div>
                      </>
                    )}
                  </div>
                )}

                {/* ── Section break ── */}
                <div className="my-5 border-b border-white/[0.04]" />

                {/* Timeline */}
                <div>
                  <h3 className="text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Activity</h3>

                  {selectedSessionEvents.length === 0 ? (
                    <EmptyState message="No events yet." />
                  ) : (
                    <div className="space-y-0">
                      {selectedSessionEvents.map((event, i) => (
                        <div key={event.id} className="flex gap-3 py-2.5">
                          <div className="relative flex w-2.5 shrink-0 flex-col items-center">
                            <span
                              className={cn(
                                "mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full",
                                event.category === "ERROR"
                                  ? "bg-rose-400"
                                  : event.category === "INPUT"
                                    ? "bg-amber-400"
                                    : event.category === "ACTION"
                                      ? "bg-brand-openai"
                                      : "bg-white/20"
                              )}
                            />
                            {i < selectedSessionEvents.length - 1 && (
                              <span className="mt-1 w-px flex-1 bg-white/[0.04]" />
                            )}
                          </div>
                          <div className="min-w-0 flex-1">
                            <p className="text-[12px] leading-snug text-foreground/80">{event.summary}</p>
                            <p className="mt-0.5 font-mono text-[9px] text-muted-foreground/50">
                              {formatRelativeTime(event.timestamp)}
                            </p>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </>
            )}
          </div>
        )}

        {/* ── ACTIONS (Pending) ── */}
        {activeTab === "PENDING" && (
          <div className="animate-fade-in">
            <div className="flex items-center justify-between">
              <h2 className="text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Pending Actions</h2>
              {pendingInputs.length > 0 && (
                <span className="flex h-5 w-5 items-center justify-center rounded-full bg-amber-400/15 text-[10px] font-bold text-amber-400">{pendingInputs.length}</span>
              )}
            </div>

            <div className="mt-4">
              {pendingInputs.length === 0 ? (
                <EmptyState message="All clear." />
              ) : (
                <div className="divide-y divide-white/[0.04]">
                  {pendingInputs
                    .slice()
                    .sort((a, b) => priorityWeight(a.priority) - priorityWeight(b.priority))
                    .map((pending) => {
                      const session = sessionById.get(pending.sessionId);
                      const busy = busyActionIds.includes(pending.id);
                      const actionable = pending.actionable !== false;

                      return (
                        <article key={pending.id} className="rounded-xl px-2 py-3">
                          <div className="flex items-start gap-2.5">
                            <span
                              className={cn(
                                "mt-1.5 h-2 w-2 shrink-0 rounded-full",
                                pending.priority === "HIGH"
                                  ? "bg-amber-400"
                                  : pending.priority === "MEDIUM"
                                    ? "bg-brand-claude/60"
                                    : "bg-white/15"
                              )}
                            />
                            <div className="min-w-0 flex-1">
                              <p className="text-[12px] font-medium">{session?.title ?? "Unknown"}</p>
                              <p className="mt-1 text-[12px] leading-snug text-foreground/70">{pending.prompt}</p>

                              {actionable ? (
                                <>
                                  {/* Primary action */}
                                  <Button className="mt-2.5 w-full" size="sm" onClick={() => handleAction(pending, "APPROVE")} disabled={busy}>
                                    Approve
                                  </Button>

                                  {/* Reply + reject row */}
                                  <div className="mt-1.5 flex gap-2">
                                    <Input
                                      placeholder="Or reply..."
                                      value={pendingDrafts[pending.id] ?? ""}
                                      onChange={(event) =>
                                        setPendingDrafts((prev) => ({ ...prev, [pending.id]: event.target.value }))
                                      }
                                      onKeyDown={(e) => e.key === "Enter" && onReplySubmit(pending)}
                                      disabled={busy}
                                    />
                                    {(pendingDrafts[pending.id] ?? "").trim() ? (
                                      <button
                                        onClick={() => onReplySubmit(pending)}
                                        disabled={busy}
                                        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-brand-claude text-white transition active:scale-95 disabled:opacity-40"
                                      >
                                        <Send className="h-3.5 w-3.5" />
                                      </button>
                                    ) : (
                                      <button
                                        onClick={() => handleAction(pending, "REJECT")}
                                        disabled={busy}
                                        className="shrink-0 rounded-full px-3 text-[11px] text-rose-400/60 transition hover:text-rose-400 active:scale-95 disabled:opacity-40"
                                      >
                                        Reject
                                      </button>
                                    )}
                                  </div>
                                </>
                              ) : (
                                <p className="mt-2.5 text-[11px] text-amber-400/75">
                                  Tracked from direct CLI logs. Approve/reply on laptop terminal.
                                </p>
                              )}
                            </div>
                          </div>
                        </article>
                      );
                    })}
                </div>
              )}
            </div>
          </div>
        )}

        {/* ── RUN ── */}
        {activeTab === "RUN" && (
          <div className="animate-fade-in">
            {isRemote && !deviceStatus?.online ? (
              <EmptyState message="Laptop is offline. Connect your laptop to launch tasks." />
            ) : !bridgeEnabled || !bridgeConnected ? (
              <EmptyState message="Connect to bridge to launch tasks." />
            ) : (
              <>
                {/* Agent type picker */}
                <div className="relative">
                  {(() => {
                    const selected = AGENT_OPTIONS.find((o) => o.value === runAgentType) ?? AGENT_OPTIONS[0];
                    return (
                      <button
                        onClick={() => setAgentPickerOpen((prev) => !prev)}
                        className="flex w-full items-center justify-between rounded-xl bg-white/[0.04] px-3 py-2.5 text-left transition hover:bg-white/[0.06]"
                      >
                        <div className="flex items-center gap-2">
                          <span className={cn("h-2 w-2 rounded-full", selected.bg.replace("/10", ""))} />
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
                          <span className={cn("h-2 w-2 rounded-full", option.bg.replace("/10", ""))} />
                          <span className={cn("text-[12px] font-medium", option.color)}>{option.label}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>

                {/* Workspace picker */}
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
                        <p className="text-[12px] text-muted-foreground/50">Select workspace…</p>
                      )}
                    </div>
                    <ChevronDown className={cn("ml-2 h-3.5 w-3.5 shrink-0 text-muted-foreground/40 transition", workspacePickerOpen && "rotate-180")} />
                  </button>

                  {workspacePickerOpen && (
                    <div className="absolute left-0 right-0 top-full z-10 mt-1 max-h-48 overflow-y-auto rounded-xl border border-white/[0.06] bg-surface backdrop-blur-xl">
                      {workspacesLoading ? (
                        <div className="flex items-center justify-center py-4">
                          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                        </div>
                      ) : workspaces.length === 0 ? (
                        <p className="px-3 py-4 text-center text-[11px] text-muted-foreground/50">No workspaces found</p>
                      ) : (
                        workspaces.map((ws) => (
                          <button
                            key={ws.path}
                            onClick={() => {
                              setRunWorkspace(ws);
                              setWorkspacePickerOpen(false);
                            }}
                            className={cn(
                              "flex w-full items-center gap-2.5 px-3 py-2.5 text-left transition hover:bg-white/[0.04]",
                              runWorkspace?.path === ws.path && "bg-white/[0.04]"
                            )}
                          >
                            {ws.hasGit ? (
                              <FolderGit2 className="h-3.5 w-3.5 shrink-0 text-muted-foreground/50" />
                            ) : (
                              <Folder className="h-3.5 w-3.5 shrink-0 text-muted-foreground/50" />
                            )}
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-1.5">
                                <span className="truncate text-[12px] font-medium">{ws.name}</span>
                                {ws.hasGit && (
                                  <span className="shrink-0 rounded bg-white/[0.06] px-1 py-0.5 text-[8px] font-medium text-muted-foreground/50">git</span>
                                )}
                              </div>
                              <p className="truncate font-mono text-[10px] text-muted-foreground/40">{ws.path}</p>
                            </div>
                          </button>
                        ))
                      )}
                    </div>
                  )}
                </div>

                {/* Prompt textarea */}
                <textarea
                  rows={4}
                  value={runPrompt}
                  onChange={(e) => setRunPrompt(e.target.value)}
                  placeholder="What should the agent do?"
                  className="mt-3 w-full resize-none rounded-xl border border-white/[0.06] bg-white/[0.03] px-3 py-2.5 text-[13px] text-foreground placeholder:text-muted-foreground/30 transition focus:border-brand-claude/30 focus:outline-none"
                />

                {/* Title input */}
                <Input
                  value={runTitle}
                  onChange={(e) => setRunTitle(e.target.value)}
                  placeholder="Title (optional)"
                  className="mt-2"
                />

                {/* Safety toggles */}
                <div className="mt-3 rounded-xl border border-white/[0.06] bg-white/[0.02]">
                  <div className="flex items-center justify-between px-3 py-2.5">
                    <div className="min-w-0">
                      <p className="text-[12px] font-medium text-foreground/80">Full workspace access</p>
                      <p className="text-[10px] text-muted-foreground/40">Bypass sandbox restrictions</p>
                    </div>
                    <Switch
                      checked={runFullAccess}
                      onCheckedChange={(checked) => {
                        setRunFullAccess(checked);
                        if (checked) {
                          setRunPlanMode(false);
                        }
                      }}
                    />
                  </div>
                  <div className="border-t border-white/[0.05] px-3 py-2.5">
                    <div className="flex items-center justify-between">
                      <div className="min-w-0">
                        <p className="text-[12px] font-medium text-foreground/80">Plan mode</p>
                        <p className="text-[10px] text-muted-foreground/40">Planning only (no file writes)</p>
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

                {/* Launch confirm overlay */}
                {showLaunchConfirm && (
                  <div className="mt-3 rounded-xl border border-amber-400/20 bg-amber-500/[0.06] px-3 py-3">
                    <div className="flex items-start gap-2">
                      <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" />
                      <div>
                        <p className="text-[12px] font-semibold text-amber-400">Reduced safety checks</p>
                        <p className="mt-1 text-[11px] leading-snug text-foreground/60">
                          This run can execute commands with reduced safety checks. Are you sure?
                        </p>
                      </div>
                    </div>
                    <div className="mt-3 flex gap-2">
                      <Button
                        className="flex-1"
                        onClick={handleLaunchTask}
                        disabled={isLaunching}
                      >
                        {isLaunching ? (
                          <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <Play className="mr-2 h-3.5 w-3.5" />
                        )}
                        Confirm Launch
                      </Button>
                      <Button
                        variant="outline"
                        className="shrink-0"
                        onClick={() => setShowLaunchConfirm(false)}
                      >
                        Cancel
                      </Button>
                    </div>
                  </div>
                )}

                {/* Launch button */}
                {!showLaunchConfirm && (
                  <Button
                    className="mt-3 w-full"
                    onClick={handleLaunchTask}
                    disabled={!runPrompt.trim() || !runWorkspace || isLaunching}
                  >
                    {isLaunching ? (
                      <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Play className="mr-2 h-3.5 w-3.5" />
                    )}
                    Launch
                  </Button>
                )}

                {/* ── Runs divider ── */}
                <div className="my-5 border-b border-white/[0.04]" />

                {/* Runs section */}
                <div className="flex items-center justify-between">
                  <h2 className="text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Runs</h2>
                  {hasActiveRuns && (
                    <span className="flex h-5 items-center gap-1 rounded-full bg-emerald-400/10 px-2 text-[10px] font-bold text-emerald-400">
                      {launcherRuns.filter((r) => r.status === "STARTING" || r.status === "RUNNING").length} active
                    </span>
                  )}
                </div>

                <div className="mt-3">
                  {launcherRuns.length === 0 ? (
                    <EmptyState message="No runs yet." />
                  ) : (
                    <div className="space-y-2">
                      {launcherRuns
                        .slice()
                        .sort((a, b) => b.createdAt - a.createdAt)
                        .map((run) => (
                          <RunCard key={run.id} run={run} onStop={handleStopRun} />
                        ))}
                    </div>
                  )}
                </div>
              </>
            )}
          </div>
        )}

        {/* ── SETTINGS ── */}
        {activeTab === "SETTINGS" && (
          <div className="animate-fade-in">
            <h2 className="text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Settings</h2>

            <div className="mt-4 space-y-0">
              <div className="flex items-center justify-between py-3">
                <div className="flex items-center gap-2.5">
                  <span className={cn("h-2 w-2 rounded-full", deviceStatus?.online ? "bg-emerald-400" : "bg-rose-400")} />
                  <span className="text-[13px]">Laptop status</span>
                </div>
                <Badge variant={deviceStatus?.online ? "success" : "danger"}>
                  {deviceStatus?.online ? "Online" : "Offline"}
                </Badge>
              </div>

              <div className="divider" />
              <div className="py-3">
                <p className="text-[11px] text-muted-foreground/65">
                  Connected relay
                </p>
                <p className="mt-1 font-mono text-[11px] text-foreground/80">{pairingConfig.relayBaseUrl || pairRelayUrl}</p>
              </div>

              {/* Unpair */}
              <div className="divider" />
              <div className="py-3">
                <Button
                  variant="destructive"
                  className="w-full gap-1.5"
                  onClick={handleUnpair}
                >
                  <Unlink className="h-3.5 w-3.5" />
                  Unpair device
                </Button>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* ── Bottom Navigation ── */}
      <nav className="fixed inset-x-0 bottom-0 z-20 pb-[max(env(safe-area-inset-bottom),6px)]">
        <div className="mx-auto flex w-[calc(100%-40px)] max-w-sm items-center justify-around rounded-2xl border border-white/[0.06] bg-background/80 py-1.5 backdrop-blur-xl">
          {TAB_ITEMS.map((item) => {
            const Icon = item.icon;
            const active = activeTab === item.id;
            const hasPending = item.id === "PENDING" && pendingInputs.length > 0;
            const hasRunning = item.id === "RUN" && hasActiveRuns;

            return (
              <button
                key={item.id}
                onClick={() => setActiveTab(item.id)}
                className={cn(
                  "relative flex flex-col items-center gap-0.5 px-2 py-1.5 transition",
                  active ? "text-foreground" : "text-muted-foreground/40"
                )}
              >
                <div className="relative">
                  <Icon className={cn("h-[17px] w-[17px]", active && "text-brand-claude")} />
                  {hasPending && (
                    <span className="absolute -right-1.5 -top-0.5 h-1.5 w-1.5 rounded-full bg-amber-400" />
                  )}
                  {hasRunning && (
                    <span className="absolute -right-1.5 -top-0.5 h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-400" />
                  )}
                </div>
                <span className={cn("text-[9px]", active ? "text-foreground/70" : "text-muted-foreground/30")}>{item.label}</span>
              </button>
            );
          })}
        </div>
      </nav>

      {/* ── Toast ── */}
      {toast && (
        <div className="fixed bottom-20 left-1/2 z-30 -translate-x-1/2 animate-fade-in rounded-full border border-white/[0.06] bg-surface px-4 py-2 text-xs text-foreground backdrop-blur-lg">
          {toast}
        </div>
      )}
    </div>
  );
}

// ── Small components ──

function StatTile({
  value,
  label,
  icon: Icon,
  accent
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

function EmptyState({ message }: { message: string }) {
  return (
    <div className="py-12 text-center">
      <p className="text-sm text-muted-foreground/60">{message}</p>
    </div>
  );
}

function RunCard({ run, onStop }: { run: LauncherRun; onStop: (id: string) => void }) {
  const isActive = run.status === "STARTING" || run.status === "RUNNING";
  const StatusIcon = isActive ? Activity : run.status === "COMPLETED" ? CheckCircle2 : run.status === "FAILED" ? TriangleAlert : XCircle;
  const title = run.title || run.prompt.slice(0, 50) + (run.prompt.length > 50 ? "…" : "");
  const finalOutput = extractFinalModelOutput(run.outputTail);

  return (
    <div className="rounded-xl bg-white/[0.02] px-3 py-3">
      <div className="flex items-start gap-2.5">
        {/* Agent-colored circle with status icon */}
        <div
          className={cn(
            "flex h-8 w-8 shrink-0 items-center justify-center rounded-full",
            run.agentType === "CODEX" ? "bg-brand-openai/10" : "bg-brand-claude/10"
          )}
        >
          <StatusIcon
            className={cn(
              "h-3.5 w-3.5",
              RUN_STATUS_COLOR[run.status]
            )}
          />
        </div>

        <div className="min-w-0 flex-1">
          <p className="truncate text-[12px] font-semibold">{title}</p>
          <div className="mt-0.5 flex items-center gap-2">
            <span className={cn("text-[10px] font-medium", RUN_STATUS_COLOR[run.status])}>
              {RUN_STATUS_LABEL[run.status]}
            </span>
            <span className="text-[9px] text-muted-foreground/40">
              {run.agentType === "CODEX" ? "Codex" : "Claude"}
            </span>
            <span className="text-[9px] text-muted-foreground/40">
              {formatRelativeTime(run.createdAt)}
            </span>
          </div>
          {/* Mode badge */}
          {run.fullWorkspaceAccess && (
            <div className="mt-1">
              <span className="inline-flex items-center rounded bg-amber-500/10 px-1.5 py-0.5 text-[9px] font-medium text-amber-400/80">
                Full Access
              </span>
            </div>
          )}
          <p className="mt-0.5 truncate font-mono text-[9px] text-muted-foreground/30">{run.workspacePath}</p>

          {/* Error message */}
          {run.error && (
            <p className="mt-1.5 text-[11px] leading-snug text-rose-400/80">{run.error}</p>
          )}

          {/* Final model output only */}
          {finalOutput ? (
            <div className="mt-2 rounded-lg bg-black/30 p-2">
              <p className="mb-1 text-[9px] uppercase tracking-wider text-muted-foreground/45">final output</p>
              <pre className="max-h-32 overflow-y-auto whitespace-pre-wrap font-mono text-[10px] leading-relaxed text-foreground/70">
                {finalOutput}
              </pre>
            </div>
          ) : isActive ? (
            <p className="mt-2 text-[10px] text-muted-foreground/45">Waiting for final model response…</p>
          ) : null}

          {/* Stop button for active runs */}
          {isActive && (
            <button
              onClick={() => onStop(run.id)}
              className="mt-2 flex items-center gap-1.5 rounded-full border border-rose-400/20 px-2.5 py-1 text-[10px] font-medium text-rose-400/70 transition hover:border-rose-400/40 hover:text-rose-400 active:scale-95"
            >
              <Square className="h-2.5 w-2.5" />
              Stop
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Utilities ──

function priorityWeight(priority: PendingInput["priority"]) {
  if (priority === "HIGH") return 0;
  if (priority === "MEDIUM") return 1;
  return 2;
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

function extractFinalModelOutput(outputTail: string[]) {
  if (!Array.isArray(outputTail) || outputTail.length === 0) return "";

  let latestStructured = "";
  let latestPlain = "";

  for (const line of outputTail) {
    const trimmed = String(line || "").trim();
    if (!trimmed) continue;

    const parsed = tryParseJsonLine(trimmed);
    if (parsed) {
      const structured = extractModelMessageFromJson(parsed);
      if (structured) {
        latestStructured = structured;
      }
      continue;
    }

    const plain = sanitizePlainOutputLine(trimmed);
    if (plain) {
      latestPlain = plain;
    }
  }

  return latestStructured || latestPlain;
}

function tryParseJsonLine(line: string): unknown | null {
  if (!line.startsWith("{")) return null;
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function extractModelMessageFromJson(payload: unknown) {
  if (!payload || typeof payload !== "object") return "";
  const event = payload as {
    type?: string;
    item?: { type?: string; text?: string };
  };

  if (event.type === "item.completed" && event.item?.type === "agent_message" && typeof event.item.text === "string") {
    return cleanOutputText(event.item.text);
  }

  return "";
}

function sanitizePlainOutputLine(line: string) {
  const trimmed = cleanOutputText(line);
  if (!trimmed) return "";
  if (trimmed.startsWith("[agent-runner]")) return "";
  if (trimmed.startsWith("{\"type\":")) return "";
  if (/^\d{4}-\d{2}-\d{2}T/.test(trimmed) && /\b(ERROR|WARN|INFO)\b/.test(trimmed)) return "";
  if (/^(tip:|usage:|for more information, try|warning: term is set)/i.test(trimmed)) return "";
  if (/^error:/i.test(trimmed)) return "";
  if (trimmed === "y") return "";
  return trimmed;
}

function cleanOutputText(text: string) {
  return text
    .replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "")
    .replace(/\r/g, "")
    .trim();
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
  onCodeChange: (v: string) => void;
  error: string | null;
  isPairing: boolean;
  onPair: () => void;
}) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-6">
      <div className="w-full max-w-sm">
        {/* Wordmark */}
        <div className="text-center">
          <div className="flex items-baseline justify-center gap-0">
            <span className="font-space text-2xl font-bold tracking-tight text-brand-claude">agent</span>
            <span className="font-space text-2xl font-bold tracking-tight text-muted-foreground/30">.</span>
            <span className="font-space text-2xl font-bold tracking-tight text-foreground/60">companion</span>
          </div>
          <p className="mt-2 text-[13px] text-muted-foreground/60">
            Pair with your laptop to get started.
          </p>
        </div>

        {/* Form */}
        <div className="mt-8 space-y-4">
          <p className="rounded-xl border border-white/[0.06] bg-white/[0.02] px-3 py-2 text-center text-[11px] text-muted-foreground/70">
            Relay: <span className="font-mono text-[10px] text-foreground/80">{relayUrl}</span>
          </p>

          <div>
            <label className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground/50">Pairing Code</label>
            <Input
              value={code}
              onChange={(e) => {
                const filtered = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6);
                onCodeChange(filtered);
              }}
              className="mt-1.5 text-center font-mono text-lg tracking-[0.3em]"
              placeholder="XXXXXX"
              maxLength={6}
              onKeyDown={(e) => e.key === "Enter" && onPair()}
            />
          </div>

          {error && (
            <p className="text-center text-[12px] text-rose-400">{error}</p>
          )}

          <Button
            className="w-full gap-1.5"
            onClick={onPair}
            disabled={code.length < 6 || isPairing}
          >
            {isPairing ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Link className="h-3.5 w-3.5" />
            )}
            Pair
          </Button>
        </div>
      </div>
    </div>
  );
}

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
}

export default App;
