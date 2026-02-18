import {
  ActionType,
  AgentSession,
  AgentType,
  LauncherRun,
  PairingConfig,
  PendingInput,
  RemoteDeviceStatus,
  SessionEvent,
  SettingsPrefs,
  Workspace
} from "./types";

export interface BridgeSnapshot {
  sessions: AgentSession[];
  pendingInputs: PendingInput[];
  events: SessionEvent[];
  settings: SettingsPrefs;
  source?: string;
}

export interface ClientConfig {
  mode: "LOCAL" | "REMOTE";
  bridgeBaseUrl: string;
  bridgeToken: string;
  relayBaseUrl: string;
  phoneToken: string;
  deviceId: string;
}

const DEFAULT_BRIDGE_URL = "http://localhost:8787";
const DEFAULT_RELAY_URL = defaultRelayUrlFromEnv();
const PAIRING_STORAGE_KEY = "agent_companion_pairing_v1";

let bridgeToken: string | null = null;

export const DEFAULT_CLIENT_CONFIG: ClientConfig = {
  mode: "LOCAL",
  bridgeBaseUrl: DEFAULT_BRIDGE_URL,
  bridgeToken: "",
  relayBaseUrl: "",
  phoneToken: "",
  deviceId: ""
};

export class TokenExpiredError extends Error {
  constructor(message = "pairing token expired") {
    super(message);
    this.name = "TokenExpiredError";
  }
}

interface RequestOptions {
  method: "GET" | "POST";
  pathLocal: string;
  pathRemote: string;
  timeoutMs: number;
  bridgeAuth?: boolean;
  body?: unknown;
}

type ActionInput = {
  pendingInputId: string;
  sessionId: string;
  type: ActionType;
  text?: string;
};

type LaunchInput = {
  agentType: AgentType;
  workspacePath: string;
  prompt: string;
  title?: string;
  fullWorkspaceAccess?: boolean;
  skipPermissions?: boolean;
  planMode?: boolean;
};

type PairingFailure = "INVALID_CODE" | "EXPIRED" | "NETWORK_ERROR" | "UNKNOWN";

export function setBridgeToken(token: string | null) {
  bridgeToken = token;
}

export function loadPairingConfig(): PairingConfig | null {
  try {
    const raw = window.localStorage.getItem(PAIRING_STORAGE_KEY);
    if (!raw) return null;

    const parsed = JSON.parse(raw) as Partial<PairingConfig>;
    if (!parsed || typeof parsed !== "object") return null;

    const mode = parsed.mode === "REMOTE" ? "REMOTE" : parsed.mode === "LOCAL" ? "LOCAL" : null;
    if (!mode) return null;

    return {
      mode,
      relayBaseUrl: safeTrim(parsed.relayBaseUrl),
      phoneToken: safeTrim(parsed.phoneToken),
      deviceId: safeTrim(parsed.deviceId) || null,
      phoneLabel: safeTrim(parsed.phoneLabel) || null,
      pairedAt: safeNumber(parsed.pairedAt, Date.now())
    };
  } catch {
    return null;
  }
}

export function savePairingConfig(config: PairingConfig) {
  try {
    window.localStorage.setItem(PAIRING_STORAGE_KEY, JSON.stringify(config));
  } catch {
    // ignore storage failures (private mode / quota)
  }
}

export function clearPairingConfig() {
  try {
    window.localStorage.removeItem(PAIRING_STORAGE_KEY);
  } catch {
    // ignore storage failures
  }
}

export async function fetchBridgeSnapshot(config?: ClientConfig): Promise<BridgeSnapshot | null> {
  const resolved = resolveClientConfig(config);
  return requestJson<BridgeSnapshot>(resolved, {
    method: "GET",
    pathLocal: "/api/bootstrap",
    pathRemote: devicePath(resolved, "/bootstrap"),
    timeoutMs: 2200
  });
}

export async function fetchDeviceStatus(config?: ClientConfig): Promise<RemoteDeviceStatus | null> {
  const resolved = resolveClientConfig(config);

  if (!isRemote(resolved)) {
    const online = await pingBridge(resolved);
    return {
      online,
      deviceId: null,
      deviceLabel: null,
      lastSeenAt: online ? Date.now() : null
    };
  }

  const status = await requestJson<{
    deviceId?: string | null;
    connected?: boolean;
    latestSnapshotAt?: number | null;
    lastDisconnectedAt?: number | null;
    lastConnectedAt?: number | null;
  }>(resolved, {
    method: "GET",
    pathLocal: "/health",
    pathRemote: devicePath(resolved, "/status"),
    timeoutMs: 2400
  });

  if (!status) return null;

  const online = Boolean(status.connected);
  const lastSeenAt = safeNullableNumber(
    online ? status.latestSnapshotAt ?? status.lastConnectedAt : status.lastDisconnectedAt ?? status.latestSnapshotAt,
    null
  );

  return {
    online,
    deviceId: safeTrim(status.deviceId) || resolved.deviceId || null,
    deviceLabel: null,
    lastSeenAt
  };
}

export async function submitBridgeAction(
  configOrInput: ClientConfig | ActionInput,
  maybeInput?: ActionInput
): Promise<boolean> {
  const { config, input } = normalizeActionArgs(configOrInput, maybeInput);
  const resolved = resolveClientConfig(config);

  const result = await requestJson<{ ok: boolean }>(resolved, {
    method: "POST",
    pathLocal: "/api/actions",
    pathRemote: devicePath(resolved, "/actions"),
    timeoutMs: 2200,
    body: input
  });

  return result?.ok === true;
}

export async function pingBridge(config?: ClientConfig): Promise<boolean> {
  const resolved = resolveClientConfig(config);

  if (isRemote(resolved)) {
    const data = await requestJson<Record<string, unknown>>(resolved, {
      method: "GET",
      pathLocal: "/health",
      pathRemote: devicePath(resolved, "/status"),
      timeoutMs: 1500
    });
    return data !== null;
  }

  const health = await requestJson<{ ok: boolean }>(resolved, {
    method: "GET",
    pathLocal: "/health",
    pathRemote: "/health",
    timeoutMs: 1000
  });

  return health?.ok === true;
}

export async function fetchWorkspaces(config?: ClientConfig): Promise<Workspace[]> {
  const resolved = resolveClientConfig(config);
  const data = await requestJson<{ ok: boolean; workspaces: Workspace[] }>(resolved, {
    method: "GET",
    pathLocal: "/api/launcher/workspaces?limit=50",
    pathRemote: devicePath(resolved, "/launcher/workspaces?limit=50"),
    timeoutMs: 3000,
    bridgeAuth: true
  });
  return data?.workspaces ?? [];
}

export async function fetchLauncherRuns(config?: ClientConfig): Promise<LauncherRun[]> {
  const resolved = resolveClientConfig(config);
  const data = await requestJson<{ ok: boolean; runs: LauncherRun[] }>(resolved, {
    method: "GET",
    pathLocal: "/api/launcher/runs",
    pathRemote: devicePath(resolved, "/launcher/runs"),
    timeoutMs: 2200,
    bridgeAuth: true
  });
  return data?.runs ?? [];
}

export async function launchTask(
  configOrInput: ClientConfig | LaunchInput,
  maybeInput?: LaunchInput
): Promise<LauncherRun | null> {
  const { config, input } = normalizeLaunchArgs(configOrInput, maybeInput);
  const resolved = resolveClientConfig(config);

  const data = await requestJson<{ ok: boolean; run: LauncherRun }>(resolved, {
    method: "POST",
    pathLocal: "/api/launcher/start",
    pathRemote: devicePath(resolved, "/launcher/start"),
    timeoutMs: 5500,
    bridgeAuth: true,
    body: input
  });

  return data?.run ?? null;
}

export async function stopRun(configOrRunId: ClientConfig | string, maybeRunId?: string): Promise<boolean> {
  const config = maybeRunId ? resolveClientConfig(configOrRunId as ClientConfig) : resolveClientConfig(undefined);
  const runId = safeTrim(maybeRunId ?? (configOrRunId as string));
  if (!runId) return false;

  const resolved = resolveClientConfig(config);
  const data = await requestJson<{ ok: boolean }>(resolved, {
    method: "POST",
    pathLocal: `/api/launcher/runs/${encodeURIComponent(runId)}/stop`,
    pathRemote: devicePath(resolved, `/launcher/runs/${encodeURIComponent(runId)}/stop`),
    timeoutMs: 3200,
    bridgeAuth: true,
    body: {}
  });

  return data?.ok === true;
}

export async function claimPairingCode(
  relayBaseUrl: string,
  code: string
): Promise<
  | { ok: true; phoneToken: string; deviceId: string }
  | { ok: false; error: PairingFailure }
> {
  const relay = normalizeBaseUrl(relayBaseUrl, DEFAULT_RELAY_URL);
  const normalizedCode = safeTrim(code).toUpperCase();
  if (!normalizedCode) {
    return { ok: false, error: "INVALID_CODE" };
  }

  try {
    const response = await fetch(`${relay}/api/pairings/claim`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json"
      },
      body: JSON.stringify({ code: normalizedCode })
    });

    const body = await safeJson(response);
    if (response.ok && typeof body?.phoneToken === "string" && typeof body?.deviceId === "string") {
      return {
        ok: true,
        phoneToken: body.phoneToken,
        deviceId: body.deviceId
      };
    }

    if (response.status === 404) return { ok: false, error: "INVALID_CODE" };
    if (response.status === 410) return { ok: false, error: "EXPIRED" };

    const message = safeTrim(body?.error);
    if (message.includes("expired")) return { ok: false, error: "EXPIRED" };
    if (message.includes("not found")) return { ok: false, error: "INVALID_CODE" };

    return { ok: false, error: "UNKNOWN" };
  } catch {
    return { ok: false, error: "NETWORK_ERROR" };
  }
}

// Kept for backward compatibility with older callers.
export async function fetchBridgeSnapshotLegacy(): Promise<BridgeSnapshot | null> {
  return fetchBridgeSnapshot(DEFAULT_CLIENT_CONFIG);
}

// Kept for backward compatibility with older callers.
export async function submitBridgeActionLegacy(input: ActionInput) {
  return submitBridgeAction(DEFAULT_CLIENT_CONFIG, input);
}

async function requestJson<T>(configInput: ClientConfig | undefined, options: RequestOptions): Promise<T | null> {
  const config = resolveClientConfig(configInput);
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), options.timeoutMs);

  const remote = isRemote(config);
  const base = remote ? config.relayBaseUrl : config.bridgeBaseUrl;
  const path = remote ? options.pathRemote : options.pathLocal;

  try {
    const response = await fetch(`${base}${path}`, {
      method: options.method,
      headers: {
        ...(options.method === "POST" ? { "Content-Type": "application/json" } : {}),
        Accept: "application/json",
        ...authHeaders(config, options.bridgeAuth)
      },
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
      signal: controller.signal
    });

    if (remote && response.status === 401) {
      throw new TokenExpiredError();
    }

    if (!response.ok) {
      return null;
    }

    return (await response.json()) as T;
  } catch (error) {
    if (error instanceof TokenExpiredError) {
      throw error;
    }
    return null;
  } finally {
    window.clearTimeout(timeout);
  }
}

function resolveClientConfig(config?: ClientConfig): ClientConfig {
  if (!config) {
    return {
      ...DEFAULT_CLIENT_CONFIG,
      bridgeBaseUrl: bridgeBaseUrlFromEnv()
    };
  }

  const requestedBridge = normalizeBaseUrl(config.bridgeBaseUrl, "");
  const resolvedBridge = normalizeBaseUrl(requestedBridge || bridgeBaseUrlFromEnv(), DEFAULT_BRIDGE_URL);

  return {
    ...DEFAULT_CLIENT_CONFIG,
    ...config,
    bridgeBaseUrl: adaptLocalBridgeForPhone(resolvedBridge),
    relayBaseUrl: normalizeBaseUrl(config.relayBaseUrl, DEFAULT_RELAY_URL),
    bridgeToken: safeTrim(config.bridgeToken),
    phoneToken: safeTrim(config.phoneToken),
    deviceId: safeTrim(config.deviceId)
  };
}

function normalizeActionArgs(configOrInput: ClientConfig | ActionInput, maybeInput?: ActionInput) {
  if (maybeInput) {
    return {
      config: configOrInput as ClientConfig,
      input: maybeInput
    };
  }

  return {
    config: DEFAULT_CLIENT_CONFIG,
    input: configOrInput as ActionInput
  };
}

function normalizeLaunchArgs(configOrInput: ClientConfig | LaunchInput, maybeInput?: LaunchInput) {
  if (maybeInput) {
    return {
      config: configOrInput as ClientConfig,
      input: maybeInput
    };
  }

  return {
    config: DEFAULT_CLIENT_CONFIG,
    input: configOrInput as LaunchInput
  };
}

function bridgeBaseUrlFromEnv() {
  const fromEnv = import.meta.env.VITE_BRIDGE_URL as string | undefined;
  const normalizedEnv = normalizeBaseUrl(fromEnv, "");
  if (normalizedEnv) return normalizedEnv;

  const inferred = inferBridgeUrlFromWindow();
  if (inferred) return inferred;

  return DEFAULT_BRIDGE_URL;
}

function defaultRelayUrlFromEnv() {
  const fromEnv = import.meta.env.VITE_RELAY_URL as string | undefined;
  const normalizedEnv = normalizeBaseUrl(fromEnv, "");
  if (normalizedEnv) return normalizedEnv;
  return "https://agent-companion-relay.onrender.com";
}

function normalizeBaseUrl(value: string | undefined | null, fallback: string) {
  const raw = safeTrim(value);
  if (!raw) return fallback;
  return raw.replace(/\/+$/, "");
}

function inferBridgeUrlFromWindow() {
  if (typeof window === "undefined") return "";
  const host = safeTrim(window.location.hostname);
  if (!host) return "";
  if (host === "localhost" || host === "127.0.0.1" || host === "::1") return "";
  return `http://${host}:8787`;
}

function adaptLocalBridgeForPhone(baseUrl: string) {
  if (typeof window === "undefined") return baseUrl;

  const windowHost = safeTrim(window.location.hostname);
  if (!windowHost) return baseUrl;
  if (windowHost === "localhost" || windowHost === "127.0.0.1" || windowHost === "::1") return baseUrl;

  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    return baseUrl;
  }

  const bridgeHost = parsed.hostname;
  if (bridgeHost !== "localhost" && bridgeHost !== "127.0.0.1" && bridgeHost !== "::1") {
    return baseUrl;
  }

  const port = parsed.port || "8787";
  return `${parsed.protocol}//${windowHost}:${port}`;
}

function isRemote(config: ClientConfig) {
  return config.mode === "REMOTE" && Boolean(config.relayBaseUrl && config.phoneToken && config.deviceId);
}

function authHeaders(config: ClientConfig, bridgeAuth = false): Record<string, string> {
  const headers: Record<string, string> = {};

  if (isRemote(config)) {
    headers.Authorization = `Bearer ${config.phoneToken}`;
    return headers;
  }

  if (bridgeAuth) {
    const token = safeTrim(config.bridgeToken) || safeTrim(bridgeToken);
    if (token) {
      headers["x-bridge-token"] = token;
    }
  }

  return headers;
}

function devicePath(config: ClientConfig, suffix: string) {
  return `/api/devices/${encodeURIComponent(config.deviceId)}${suffix}`;
}

function safeTrim(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function safeNumber(value: unknown, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function safeNullableNumber(value: unknown, fallback: number | null) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

async function safeJson(response: Response): Promise<Record<string, unknown> | null> {
  try {
    const parsed = (await response.json()) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}
