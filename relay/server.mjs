#!/usr/bin/env node
import cors from "cors";
import express from "express";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket, WebSocketServer } from "ws";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, "..");

const RELAY_PORT = toInt(process.env.PORT || process.env.RELAY_PORT, 9797);
const RELAY_PUBLIC_URL = trimTrailingSlash(
  process.env.RELAY_PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || `http://localhost:${RELAY_PORT}`
);
const RELAY_TOKEN_SECRET = resolveRelayTokenSecret();
const RELAY_WAKE_PROXY_URL = trimTrailingSlash(process.env.RELAY_WAKE_PROXY_URL || process.env.WAKE_PROXY_URL || "");
const RELAY_WAKE_PROXY_TOKEN = safeText(process.env.RELAY_WAKE_PROXY_TOKEN || process.env.WAKE_PROXY_TOKEN || "", 500);
const RELAY_WAKE_TIMEOUT_MS = clamp(toInt(process.env.RELAY_WAKE_TIMEOUT_MS, 90_000), 5_000, 5 * 60 * 1000);
const RELAY_WAKE_POLL_INTERVAL_MS = clamp(toInt(process.env.RELAY_WAKE_POLL_INTERVAL_MS, 1200), 250, 10_000);
const RELAY_WAKE_REQUEST_TIMEOUT_MS = clamp(toInt(process.env.RELAY_WAKE_REQUEST_TIMEOUT_MS, 6000), 1000, 60_000);
const PAIRING_TTL_MS = clamp(toInt(process.env.PAIRING_TTL_MS, 10 * 60 * 1000), 30_000, 24 * 60 * 60 * 1000);
const RPC_TIMEOUT_MS = clamp(toInt(process.env.RELAY_RPC_TIMEOUT_MS, 15_000), 500, 60_000);
const PREVIEW_DEFAULT_TTL_MS = clamp(toInt(process.env.RELAY_PREVIEW_TTL_MS, 2 * 60 * 60 * 1000), 60_000, 7 * 24 * 60 * 60 * 1000);
const PREVIEW_MAX_TTL_MS = clamp(
  toInt(process.env.RELAY_PREVIEW_MAX_TTL_MS, 24 * 60 * 60 * 1000),
  PREVIEW_DEFAULT_TTL_MS,
  14 * 24 * 60 * 60 * 1000
);
const PREVIEW_RPC_TIMEOUT_MS = clamp(toInt(process.env.RELAY_PREVIEW_RPC_TIMEOUT_MS, 30_000), 2000, 120_000);
const CLEANUP_INTERVAL_MS = 30_000;
const MAX_LAPTOP_RECORDS = 500;
const MAX_PHONE_TOKENS = 2_000;
const MAX_PREVIEW_RECORDS = 4_000;
const PHONE_TOKEN_HEADER = "x-agent-companion-phone-token";
const LAPTOP_TOKEN_HEADER = "x-agent-companion-laptop-token";

const STATE_FILE = path.resolve(PROJECT_ROOT, "relay", "state.json");
const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ noServer: true });

let state = loadState();
let persistTimer = null;
let shuttingDown = false;

const laptopSockets = new Map();
const pendingRpcs = new Map();
const pendingWakeAttempts = new Map();

app.use(
  cors({
    exposedHeaders: [PHONE_TOKEN_HEADER, LAPTOP_TOKEN_HEADER]
  })
);
app.use(express.json({ limit: "2mb" }));

if (!RELAY_TOKEN_SECRET) {
  console.warn("[relay] durable token secret missing; pairing may break after relay restarts");
}

app.get("/health", (_req, res) => {
  cleanupExpiredPairings();
  cleanupExpiredPreviews();
  const onlineLaptops = [...laptopSockets.values()].filter((ws) => ws.readyState === WebSocket.OPEN).length;
  const activePairings = state.pairings.filter((item) => !item.claimedAt && item.expiresAt > Date.now()).length;
  const activePreviews = state.previews.filter((item) => item.expiresAt > Date.now()).length;

  res.json({
    ok: true,
    service: "agent-relay",
    onlineLaptops,
    totalLaptops: state.laptops.length,
    activePairings,
    activePreviews,
    issuedPhoneTokens: state.phones.length,
    wakeProxyEnabled: Boolean(RELAY_WAKE_PROXY_URL)
  });
});

app.get("/pair", (req, res) => {
  const code = normalizePairCode(req.query?.code);
  const pairing = code ? findPairingByCode(code) : null;

  const body = {
    ok: true,
    message: "Use this code in the Agent Companion app to pair your laptop.",
    code: code || null,
    valid: Boolean(pairing && pairing.expiresAt > Date.now()),
    claimed: Boolean(pairing?.claimedAt),
    expiresAt: pairing?.expiresAt ?? null
  };

  return res.json(body);
});

app.post("/api/laptops/register", (req, res) => {
  cleanupExpiredPairings();

  const now = Date.now();
  const laptopId = createId("lap");
  const deviceId = createId("dev");
  const laptopToken = issueLaptopToken(laptopId, deviceId);
  const wakeMacAddress = normalizeMacAddress(
    req.body?.wakeMac || req.body?.wake_mac || req.body?.macAddress || req.body?.wake?.macAddress
  );

  const laptop = {
    laptopId,
    deviceId,
    laptopToken,
    name: safeText(req.body?.name, 120) || safeText(req.body?.hostname, 120) || null,
    createdAt: now,
    updatedAt: now,
    pairedAt: null,
    pairCode: null,
    pairingExpiresAt: null,
    pairingUrl: null,
    pairingPayload: null,
    lastConnectedAt: null,
    lastDisconnectedAt: null,
    lastSnapshotAt: null,
    latestSnapshot: null,
    wake: {
      macAddress: wakeMacAddress || null
    },
    lastWakeRequestedAt: null,
    lastWakeResult: null
  };

  mutateState(() => {
    state.laptops.push(laptop);
    trimStateCollections();
  });

  const pairing = createPairingForLaptop(laptop);

  res.status(201).json({
    laptopId: laptop.laptopId,
    laptopToken: laptop.laptopToken,
    deviceId: laptop.deviceId,
    pairCode: pairing.code,
    pairingExpiresAt: pairing.expiresAt,
    pairingUrl: pairing.pairingUrl,
    pairingPayload: pairing.pairingPayload
  });
});

app.use("/api/laptops", requireLaptopToken);

app.get("/api/laptops/me", (req, res) => {
  const laptop = req.laptopSession;
  const activePairing =
    state.pairings
      .filter((item) => item.laptopId === laptop.laptopId && item.expiresAt > Date.now())
      .sort((a, b) => b.createdAt - a.createdAt)[0] || null;

  return res.json({
    ok: true,
    laptopId: laptop.laptopId,
    deviceId: laptop.deviceId,
    laptopToken: preferredLaptopToken(laptop),
    name: laptop.name,
    pairedAt: laptop.pairedAt,
    connected: isLaptopConnected(laptop.laptopId),
    lastConnectedAt: laptop.lastConnectedAt,
    lastDisconnectedAt: laptop.lastDisconnectedAt,
    lastSnapshotAt: laptop.lastSnapshotAt,
    wake: {
      macAddress: laptop?.wake?.macAddress || null
    },
    wakeConfigured: Boolean(laptop?.wake?.macAddress),
    lastWakeRequestedAt: laptop.lastWakeRequestedAt || null,
    lastWakeResult: laptop.lastWakeResult || null,
    activePairing: activePairing
      ? {
          code: activePairing.code,
          expiresAt: activePairing.expiresAt,
          pairingUrl: activePairing.pairingUrl
        }
      : null
  });
});

app.post("/api/laptops/pairing", (req, res) => {
  cleanupExpiredPairings();
  const laptop = req.laptopSession;
  const force = Boolean(req.body?.force);
  const wakeMacAddress = normalizeMacAddress(
    req.body?.wakeMac || req.body?.wake_mac || req.body?.macAddress || req.body?.wake?.macAddress
  );

  if (wakeMacAddress && wakeMacAddress !== laptop?.wake?.macAddress) {
    mutateState(() => {
      laptop.wake = {
        ...(isObject(laptop.wake) ? laptop.wake : {}),
        macAddress: wakeMacAddress
      };
      laptop.updatedAt = Date.now();
    });
  }

  const existingPairing =
    !force
      ? state.pairings
          .filter((item) => item.laptopId === laptop.laptopId && item.expiresAt > Date.now())
          .sort((a, b) => b.createdAt - a.createdAt)[0] || null
      : null;

  const pairing = existingPairing || createPairingForLaptop(laptop);

  return res.json({
    ok: true,
    laptopId: laptop.laptopId,
    deviceId: laptop.deviceId,
    laptopToken: preferredLaptopToken(laptop),
    pairCode: pairing.code,
    pairingExpiresAt: pairing.expiresAt,
    pairingUrl: pairing.pairingUrl,
    pairingPayload: pairing.pairingPayload
  });
});

app.get("/api/pairings/:code", (req, res) => {
  cleanupExpiredPairings();

  const code = normalizePairCode(req.params.code);
  if (!code) {
    return res.status(400).json({ ok: false, error: "pairing code is required" });
  }

  const pairing = findPairingByCode(code);
  if (!pairing) {
    return res.status(404).json({ ok: false, error: "pairing code not found" });
  }

  const laptop = findLaptopById(pairing.laptopId);
  return res.json({
    ok: true,
    code: pairing.code,
    laptopId: pairing.laptopId,
    deviceId: pairing.deviceId,
    pairingExpiresAt: pairing.expiresAt,
    claimed: Boolean(pairing.claimedAt),
    connected: laptop ? isLaptopConnected(laptop.laptopId) : false,
    hasSnapshot: Boolean(laptop?.latestSnapshot)
  });
});

app.post("/api/pairings/claim", (req, res) => {
  cleanupExpiredPairings();

  const code = normalizePairCode(req.body?.code || req.body?.pairCode);
  if (!code) {
    return res.status(400).json({ ok: false, error: "code is required" });
  }

  const pairing = findPairingByCode(code);
  if (!pairing) {
    return res.status(404).json({ ok: false, error: "pairing code not found" });
  }

  if (pairing.expiresAt < Date.now() && !pairing.claimedAt) {
    return res.status(410).json({ ok: false, error: "pairing code expired" });
  }

  if (pairing.phoneToken) {
    return res.json({
      phoneToken: pairing.phoneToken,
      deviceId: pairing.deviceId
    });
  }

  const phoneToken = issuePhoneToken(pairing.deviceId);
  const now = Date.now();

  mutateState(() => {
    pairing.claimedAt = now;
    pairing.phoneToken = phoneToken;

    state.phones.push({
      phoneToken,
      deviceId: pairing.deviceId,
      createdAt: now,
      lastUsedAt: now
    });

    const laptop = findLaptopById(pairing.laptopId);
    if (laptop) {
      laptop.pairedAt = now;
      laptop.updatedAt = now;
    }

    trimStateCollections();
  });

  return res.json({
    phoneToken,
    deviceId: pairing.deviceId
  });
});

app.use("/api/devices/:id", requirePhoneToken, requireDeviceAccess);

app.get("/api/devices/:id/status", (req, res) => {
  const laptop = req.deviceLaptop;
  const connected = isLaptopConnected(laptop.laptopId);

  return res.json({
    ok: true,
    deviceId: laptop.deviceId,
    laptopId: laptop.laptopId,
    connected,
    pairedAt: laptop.pairedAt,
    lastConnectedAt: laptop.lastConnectedAt,
    lastDisconnectedAt: laptop.lastDisconnectedAt,
    latestSnapshotAt: laptop.lastSnapshotAt,
    pairingExpiresAt: laptop.pairingExpiresAt,
    wakeConfigured: Boolean(laptop?.wake?.macAddress),
    wakeProxyEnabled: Boolean(RELAY_WAKE_PROXY_URL),
    autoWakeCapable: Boolean(!connected && RELAY_WAKE_PROXY_URL && laptop?.wake?.macAddress),
    lastWakeRequestedAt: laptop.lastWakeRequestedAt || null,
    lastWakeResult: laptop.lastWakeResult || null
  });
});

app.get("/api/devices/:id/bootstrap", async (req, res) => {
  const laptop = req.deviceLaptop;
  const freshFlag = String(req.query?.fresh || "").trim().toLowerCase();
  const requireFresh = freshFlag === "1" || freshFlag === "true";

  if (!requireFresh && isObject(laptop.latestSnapshot)) {
    return res.json(laptop.latestSnapshot);
  }

  try {
    const rpc = await sendLaptopRpc(laptop.laptopId, {
      method: "GET",
      path: "/api/bootstrap"
    });

    if (rpc.ok && isObject(rpc.body)) {
      mutateState(() => {
        laptop.latestSnapshot = rpc.body;
        laptop.lastSnapshotAt = Date.now();
        laptop.updatedAt = Date.now();
      });
    }

    return relayRpcResponse(res, rpc);
  } catch (error) {
    if (isObject(laptop.latestSnapshot)) {
      return res.json(laptop.latestSnapshot);
    }
    return res.status(resolveRpcErrorStatus(error)).json({
      ok: false,
      error: String(error?.message || error)
    });
  }
});

app.post("/api/devices/:id/actions", async (req, res) => {
  return proxyToLaptopBridge(req, res, {
    method: "POST",
    path: "/api/actions",
    body: req.body || {}
  });
});

app.get("/api/devices/:id/launcher/workspaces", async (req, res) => {
  const pathWithQuery = withQuery("/api/launcher/workspaces", req.query);
  return proxyToLaptopBridge(req, res, {
    method: "GET",
    path: pathWithQuery
  });
});

app.post("/api/devices/:id/launcher/workspaces/create", async (req, res) => {
  return proxyToLaptopBridge(req, res, {
    method: "POST",
    path: "/api/launcher/workspaces/create",
    body: req.body || {},
    autoWake: true,
    wakeIntent: "create_workspace"
  });
});

app.get("/api/devices/:id/launcher/runs", async (req, res) => {
  const pathWithQuery = withQuery("/api/launcher/runs", req.query);
  return proxyToLaptopBridge(req, res, {
    method: "GET",
    path: pathWithQuery
  });
});

app.get("/api/devices/:id/launcher/services", async (req, res) => {
  const pathWithQuery = withQuery("/api/launcher/services", req.query);
  return proxyToLaptopBridge(req, res, {
    method: "GET",
    path: pathWithQuery
  });
});

app.post("/api/devices/:id/launcher/start", async (req, res) => {
  return proxyToLaptopBridge(req, res, {
    method: "POST",
    path: "/api/launcher/start",
    body: req.body || {},
    autoWake: true,
    wakeIntent: "launch_run"
  });
});

app.post("/api/devices/:id/launcher/runs/:runId/stop", async (req, res) => {
  const runId = encodeURIComponent(String(req.params.runId || ""));
  return proxyToLaptopBridge(req, res, {
    method: "POST",
    path: `/api/launcher/runs/${runId}/stop`,
    body: req.body || {}
  });
});

app.post("/api/devices/:id/launcher/services/start", async (req, res) => {
  return proxyToLaptopBridge(req, res, {
    method: "POST",
    path: "/api/launcher/services/start",
    body: req.body || {},
    autoWake: true,
    wakeIntent: "start_background_service"
  });
});

app.post("/api/devices/:id/launcher/services/:serviceId/stop", async (req, res) => {
  const serviceId = encodeURIComponent(String(req.params.serviceId || ""));
  return proxyToLaptopBridge(req, res, {
    method: "POST",
    path: `/api/launcher/services/${serviceId}/stop`,
    body: req.body || {}
  });
});

app.post("/api/devices/:id/settings/update", async (req, res) => {
  return proxyToLaptopBridge(req, res, {
    method: "POST",
    path: "/api/settings/update",
    body: req.body || {},
    autoWake: true,
    wakeIntent: "update_settings"
  });
});

app.post("/api/devices/:id/sessions/:sessionId/messages", async (req, res) => {
  const sessionId = encodeURIComponent(safeText(req.params.sessionId, 200));
  if (!sessionId) {
    return res.status(400).json({ ok: false, error: "sessionId is required" });
  }

  return proxyToLaptopBridge(req, res, {
    method: "POST",
    path: `/api/sessions/${sessionId}/messages`,
    body: req.body || {},
    autoWake: true,
    wakeIntent: "send_message"
  });
});

app.get("/api/devices/:id/previews", (req, res) => {
  cleanupExpiredPreviews();
  const laptop = req.deviceLaptop;
  const previews = listPreviewsForDevice(laptop.deviceId).map((item) =>
    serializePreview(item, {
      connected: isLaptopConnected(item.laptopId)
    })
  );

  return res.json({
    ok: true,
    previews
  });
});

app.post("/api/devices/:id/previews", (req, res) => {
  cleanupExpiredPreviews();
  const laptop = req.deviceLaptop;
  const previewTarget = normalizePreviewTarget(req.body?.targetUrl || req.body?.url, req.body?.port);
  if (!previewTarget) {
    return res.status(400).json({
      ok: false,
      error: "invalid preview target (use localhost/127.0.0.1 URL or a valid port)"
    });
  }

  const requestedTtlSec = toInt(req.body?.expiresInSec, Math.round(PREVIEW_DEFAULT_TTL_MS / 1000));
  const expiresInSec = clamp(requestedTtlSec, 60, Math.round(PREVIEW_MAX_TTL_MS / 1000));
  const now = Date.now();

  const preview = {
    previewId: createId("preview"),
    accessToken: createToken("pvw"),
    laptopId: laptop.laptopId,
    deviceId: laptop.deviceId,
    label: safeText(req.body?.label, 120) || null,
    target: previewTarget,
    createdAt: now,
    updatedAt: now,
    lastAccessedAt: null,
    expiresAt: now + expiresInSec * 1000,
    createdByPhoneToken: safeText(req.phoneSession?.phoneToken, 500) || null
  };

  mutateState(() => {
    state.previews.push(preview);
    trimStateCollections();
  });

  return res.status(201).json({
    ok: true,
    preview: serializePreview(preview, {
      connected: isLaptopConnected(preview.laptopId)
    })
  });
});

app.delete("/api/devices/:id/previews/:previewId", (req, res) => {
  cleanupExpiredPreviews();
  const previewId = safeText(req.params.previewId, 200);
  if (!previewId) {
    return res.status(400).json({ ok: false, error: "previewId is required" });
  }

  let removed = false;
  mutateState(() => {
    const before = state.previews.length;
    state.previews = state.previews.filter((item) => !(item.previewId === previewId && item.deviceId === req.deviceLaptop.deviceId));
    removed = state.previews.length !== before;
  });

  if (!removed) {
    return res.status(404).json({ ok: false, error: "preview not found" });
  }

  return res.json({ ok: true });
});

app.post("/api/devices/:id/wake", async (req, res) => {
  const laptop = req.deviceLaptop;
  const result = await ensureLaptopOnline(laptop, {
    autoWake: true,
    wakeIntent: "manual_wake",
    timeoutMs: clamp(toInt(req.body?.timeoutMs, RELAY_WAKE_TIMEOUT_MS), 2_000, 5 * 60 * 1000)
  });

  if (!result.ok) {
    return res.status(503).json({
      ok: false,
      error: result.error || "unable to wake device",
      wakeAttempted: result.wakeAttempted
    });
  }

  return res.json({
    ok: true,
    connected: isLaptopConnected(laptop.laptopId),
    wakeAttempted: result.wakeAttempted
  });
});

app.all(/^\/(?:preview|p)\/([^/]+)(?:\/(.*))?$/, (req, res) => {
  return handlePreviewProxy(req, res);
});

// Support assets requested via absolute root paths (e.g. /styles.css) from preview pages.
// Many local dev servers emit root-absolute URLs, which would otherwise bypass /p/:token.
app.all(/^\/(?!api(?:\/|$)|ws(?:\/|$)|pair(?:\/|$)|health$|preview(?:\/|$)|p(?:\/|$)).+/, (req, res, next) => {
  const previewToken = extractPreviewTokenFromCookie(req) || extractPreviewTokenFromReferer(req);
  if (!previewToken) return next();
  return handlePreviewProxy(req, res, {
    forcedToken: previewToken,
    forcedSuffix: req.path || "/"
  });
});

server.on("upgrade", (request, socket, head) => {
  let parsedUrl;
  try {
    parsedUrl = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
  } catch {
    socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
    socket.destroy();
    return;
  }

  if (parsedUrl.pathname !== "/ws/laptop") {
    socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
    socket.destroy();
    return;
  }

  const token = safeText(parsedUrl.searchParams.get("token"), 4000);
  const resolved = resolveLaptopAuth(token);
  const laptop = resolved?.laptop || null;
  if (!laptop) {
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    socket.destroy();
    return;
  }

  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit("connection", ws, laptop, resolved);
  });
});

wss.on("connection", (ws, laptop, authInfo) => {
  const existing = laptopSockets.get(laptop.laptopId);
  if (existing && existing !== ws && existing.readyState === WebSocket.OPEN) {
    existing.close(4000, "replaced by newer connection");
  }

  laptopSockets.set(laptop.laptopId, ws);

  mutateState(() => {
    laptop.lastConnectedAt = Date.now();
    laptop.updatedAt = Date.now();
  });

  sendWsJson(ws, {
    type: "welcome",
    laptopId: laptop.laptopId,
    deviceId: laptop.deviceId,
    laptopToken: authInfo?.refreshedToken || null,
    relayTime: Date.now()
  });

  ws.on("message", (chunk, isBinary) => {
    if (isBinary) return;

    let message;
    try {
      message = JSON.parse(chunk.toString());
    } catch {
      return;
    }

    if (!isObject(message)) return;

    if (message.type === "rpc_response" && typeof message.id === "string") {
      settlePendingRpc(laptop.laptopId, message);
      return;
    }

    if (message.type === "snapshot" && isObject(message.snapshot)) {
      mutateState(() => {
        laptop.latestSnapshot = message.snapshot;
        laptop.lastSnapshotAt = Date.now();
        laptop.updatedAt = Date.now();
      });
      return;
    }

    if (message.type === "ping") {
      sendWsJson(ws, { type: "pong", ts: Date.now() });
    }
  });

  ws.on("close", () => {
    if (laptopSockets.get(laptop.laptopId) === ws) {
      laptopSockets.delete(laptop.laptopId);
    }

    rejectPendingRpcsForLaptop(laptop.laptopId, "laptop disconnected");

    mutateState(() => {
      laptop.lastDisconnectedAt = Date.now();
      laptop.updatedAt = Date.now();
    });
  });

  ws.on("error", () => {
    // errors are handled by close/retry paths
  });
});

const cleanupTicker = setInterval(() => {
  cleanupExpiredPairings();
  cleanupExpiredPreviews();
}, CLEANUP_INTERVAL_MS);
cleanupTicker.unref();

server.listen(RELAY_PORT);

process.on("SIGINT", () => gracefulShutdown("SIGINT"));
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));

async function proxyToLaptopBridge(req, res, input) {
  const laptop = req.deviceLaptop;

  const online = await ensureLaptopOnline(laptop, {
    autoWake: Boolean(input?.autoWake),
    wakeIntent: safeText(input?.wakeIntent, 80) || "proxy_request"
  });
  if (!online.ok) {
    return res.status(503).json({
      ok: false,
      error: online.error || "laptop is not connected",
      wakeAttempted: online.wakeAttempted
    });
  }

  try {
    const rpc = await sendLaptopRpc(laptop.laptopId, input);
    return relayRpcResponse(res, rpc);
  } catch (error) {
    return res.status(resolveRpcErrorStatus(error)).json({
      ok: false,
      error: String(error?.message || error)
    });
  }
}

async function handlePreviewProxy(req, res, options = {}) {
  cleanupExpiredPreviews();

  const rawToken =
    safeText(options?.forcedToken, 500) ||
    (req.params && typeof req.params === "object" ? req.params.token ?? req.params[0] : "");
  const accessToken = safeText(rawToken, 500);
  if (!accessToken) {
    return res.status(400).type("text/plain").send("preview token is required");
  }

  const hasForcedSuffix = Boolean(safeText(options?.forcedSuffix, 4000));
  if (!hasForcedSuffix && isPreviewRootPathWithoutTrailingSlash(req.path) && isSafeMethod(req.method)) {
    const query = req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : "";
    return res.redirect(307, `${req.path}/${query}`);
  }

  const preview = findPreviewByAccessToken(accessToken);
  if (!preview) {
    return res.status(404).type("text/plain").send("preview link expired or not found");
  }
  setPreviewTokenCookie(res, accessToken, preview.expiresAt);

  const laptop = findLaptopById(preview.laptopId);
  if (!laptop) {
    return res.status(404).type("text/plain").send("preview device not found");
  }

  const online = await ensureLaptopOnline(laptop, {
    autoWake: true,
    wakeIntent: "preview_request"
  });
  if (!online.ok) {
    return res.status(503).type("text/plain").send("laptop is offline");
  }

  const rawSuffix =
    safeText(options?.forcedSuffix, 4000) ||
    (req.params && typeof req.params === "object" ? req.params.rest ?? req.params[1] : "");
  const suffix = safePreviewPathSuffix(rawSuffix);
  const query = req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : "";
  const proxiedPath = `${suffix}${query}`;
  const rpcPath =
    "/__relay/preview/proxy" +
    withQuery("", {
      target: preview.target,
      path: proxiedPath
    });

  const headers = sanitizePreviewForwardHeaders(req.headers);

  try {
    const rpc = await sendLaptopRpc(
      preview.laptopId,
      {
        method: String(req.method || "GET").toUpperCase(),
        path: rpcPath,
        headers,
        body: normalizePreviewForwardBody(req)
      },
      PREVIEW_RPC_TIMEOUT_MS
    );
    const rewrittenRpc = maybeRewritePreviewTextResponse(rpc, accessToken, preview.target, proxiedPath);

    mutateState(() => {
      preview.lastAccessedAt = Date.now();
      preview.updatedAt = Date.now();
    });

    return relayRpcResponse(res, rewrittenRpc);
  } catch (error) {
    return res.status(resolveRpcErrorStatus(error)).type("text/plain").send(String(error?.message || error));
  }
}

function setPreviewTokenCookie(res, accessToken, expiresAt) {
  const token = safeText(accessToken, 500);
  if (!token) return;
  const now = Date.now();
  const maxAgeSec = Math.max(60, Math.floor((toInt(expiresAt, now + 60_000) - now) / 1000));
  const cookie = `ac_preview_token=${encodeURIComponent(token)}; Path=/; Max-Age=${maxAgeSec}; SameSite=Lax`;
  res.append("Set-Cookie", cookie);
}

function maybeRewritePreviewTextResponse(rpc, accessToken, previewTarget, requestPath) {
  if (!rpc || typeof rpc !== "object") return rpc;
  if (safeText(rpc.bodyType, 20) !== "text") return rpc;
  if (typeof rpc.body !== "string" || !rpc.body) return rpc;

  const token = safeText(accessToken, 500);
  if (!token) return rpc;
  const kind = detectPreviewTextKind(rpc.responseHeaders, rpc.body, requestPath);
  if (!kind) return rpc;

  const prefix = `/p/${encodeURIComponent(token)}`;
  let text = String(rpc.body);

  // Rewrite absolute localhost URLs to preview-prefixed paths.
  const origins = buildLocalhostOrigins(previewTarget);
  for (const origin of origins) {
    const escaped = escapeRegExp(origin);
    text = text.replace(new RegExp(`${escaped}/`, "gi"), `${prefix}/`);
  }

  if (kind === "html") {
    text = ensurePreviewBaseTag(text, `${prefix}/`);

    // Prefix root-relative resource attributes so they keep preview token context.
    text = text.replace(
      /(\b(?:href|src|action|poster)\s*=\s*["'])\/(?!\/|p\/|preview\/)/gi,
      `$1${prefix}/`
    );
  }

  if (kind === "html" || kind === "css" || kind === "js") {
    // Prefix root-relative URL literals in text assets.
    text = text.replace(/(["'`])\/(?!\/|p\/|preview\/)/g, `$1${prefix}/`);
    text = text.replace(/url\((['"]?)\/(?!\/|p\/|preview\/)/gi, `url($1${prefix}/`);
  }

  if (kind === "js") {
    text = text.replace(/\bfrom\s+(['"])\/(?!\/|p\/|preview\/)/g, `from $1${prefix}/`);
    text = text.replace(/\bimport\(\s*(['"])\/(?!\/|p\/|preview\/)/g, `import($1${prefix}/`);
  }

  const nextHeaders = {
    ...(isObject(rpc.responseHeaders) ? rpc.responseHeaders : {})
  };
  const existingContentType = getHeaderCaseInsensitive(nextHeaders, "content-type");
  if (!existingContentType) {
    if (kind === "html") nextHeaders["content-type"] = "text/html; charset=utf-8";
    if (kind === "css") nextHeaders["content-type"] = "text/css; charset=utf-8";
    if (kind === "js") nextHeaders["content-type"] = "application/javascript; charset=utf-8";
  }

  return { ...rpc, bodyType: "text", body: text, responseHeaders: nextHeaders };
}

function ensurePreviewBaseTag(htmlText, baseHref) {
  let html = String(htmlText || "");
  const base = String(baseHref || "").trim();
  if (!base) return html;

  if (/<base\b/i.test(html)) {
    return html.replace(/<base\b[^>]*href\s*=\s*["'][^"']*["'][^>]*>/i, `<base href="${base}">`);
  }

  if (/<head\b[^>]*>/i.test(html)) {
    return html.replace(/<head\b[^>]*>/i, (match) => `${match}\n<base href="${base}">`);
  }

  return `<base href="${base}">\n${html}`;
}

function isHtmlResponse(headersInput, bodyText) {
  const contentType = getHeaderCaseInsensitive(headersInput, "content-type");
  if (contentType && /text\/html|application\/xhtml\+xml/i.test(contentType)) return true;
  const sample = safeText(String(bodyText || "").slice(0, 300), 300).toLowerCase();
  if (!sample) return false;
  return sample.includes("<html") || sample.includes("<!doctype html");
}

function detectPreviewTextKind(headersInput, bodyText, requestPath) {
  const contentType = getHeaderCaseInsensitive(headersInput, "content-type").toLowerCase();
  if (contentType.includes("text/html") || contentType.includes("application/xhtml+xml")) return "html";
  if (contentType.includes("text/css")) return "css";
  if (contentType.includes("javascript") || contentType.includes("ecmascript")) return "js";

  const pathOnly = safeText(String(requestPath || "").split("?")[0], 2000).toLowerCase();
  if (pathOnly.endsWith(".html") || pathOnly.endsWith(".htm")) return "html";
  if (pathOnly.endsWith(".css")) return "css";
  if (
    pathOnly.endsWith(".js") ||
    pathOnly.endsWith(".mjs") ||
    pathOnly.endsWith(".cjs") ||
    pathOnly.endsWith(".ts") ||
    pathOnly.endsWith(".tsx")
  ) {
    return "js";
  }

  if (isHtmlResponse(headersInput, bodyText)) return "html";
  return "";
}

function buildLocalhostOrigins(previewTarget) {
  const target = safeText(previewTarget, 2000);
  if (!target) return [];
  try {
    const parsed = new URL(target);
    const protocol = parsed.protocol === "https:" ? "https" : "http";
    const port = parsed.port ? `:${parsed.port}` : "";
    const origins = new Set([
      `${protocol}://127.0.0.1${port}`,
      `${protocol}://localhost${port}`,
      `${protocol}://[::1]${port}`
    ]);
    return [...origins];
  } catch {
    return [];
  }
}

function escapeRegExp(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractPreviewTokenFromReferer(req) {
  const refererRaw = safeText(req.header("referer"), 4000);
  if (!refererRaw) return "";

  try {
    const parsed = new URL(refererRaw);
    const match = parsed.pathname.match(/^\/(?:preview|p)\/([^/]+)/i);
    if (!match || !match[1]) return "";
    return safeText(decodeURIComponent(match[1]), 500);
  } catch {
    return "";
  }
}

function isPreviewRootPathWithoutTrailingSlash(pathname) {
  const path = safeText(pathname, 2000);
  if (!path) return false;
  return /^\/(?:preview|p)\/[^/]+$/i.test(path);
}

function isSafeMethod(method) {
  const value = String(method || "").toUpperCase();
  return value === "GET" || value === "HEAD";
}

function extractPreviewTokenFromCookie(req) {
  const cookieHeader = safeText(req.header("cookie"), 8000);
  if (!cookieHeader) return "";
  const pairs = cookieHeader.split(";");
  for (const pair of pairs) {
    const [rawKey, ...rest] = pair.split("=");
    if (!rawKey || rest.length === 0) continue;
    const key = rawKey.trim();
    if (key !== "ac_preview_token") continue;
    try {
      return safeText(decodeURIComponent(rest.join("=").trim()), 500);
    } catch {
      return safeText(rest.join("=").trim(), 500);
    }
  }
  return "";
}

function getHeaderCaseInsensitive(headersInput, name) {
  if (!isObject(headersInput)) return "";
  const target = String(name || "").toLowerCase();
  for (const [key, value] of Object.entries(headersInput)) {
    if (String(key || "").toLowerCase() !== target) continue;
    if (typeof value !== "string") continue;
    return value;
  }
  return "";
}

function relayRpcResponse(res, rpc) {
  const status = clamp(toInt(rpc?.status, rpc?.ok ? 200 : 500), 100, 599);
  const bodyType = rpc?.bodyType;
  const hasExplicitContentType = hasHeaderCaseInsensitive(rpc?.responseHeaders, "content-type");
  applyRpcResponseHeaders(res, rpc?.responseHeaders);

  if (bodyType === "empty") {
    return res.status(status).end();
  }

  if (bodyType === "base64" || rpc?.bodyEncoding === "base64") {
    const payload = typeof rpc?.body === "string" ? Buffer.from(rpc.body, "base64") : Buffer.alloc(0);
    return res.status(status).send(payload);
  }

  if (bodyType === "text") {
    const response = res.status(status);
    if (!hasExplicitContentType) {
      response.type("text/plain");
    }
    return response.send(String(rpc?.body ?? ""));
  }

  if (rpc?.body !== undefined) {
    if (typeof rpc.body === "string") {
      const response = res.status(status);
      if (!hasExplicitContentType) {
        response.type("text/plain");
      }
      return response.send(rpc.body);
    }
    return res.status(status).json(rpc.body);
  }

  if (rpc?.error) {
    return res.status(status).json({ ok: false, error: rpc.error });
  }

  return res.status(status).json({ ok: Boolean(rpc?.ok) });
}

function hasHeaderCaseInsensitive(headersInput, name) {
  if (!isObject(headersInput)) return false;
  const target = String(name || "").toLowerCase();
  return Object.keys(headersInput).some((key) => String(key || "").toLowerCase() === target);
}

function applyRpcResponseHeaders(res, headersInput) {
  if (!isObject(headersInput)) return;

  for (const [rawName, rawValue] of Object.entries(headersInput)) {
    if (typeof rawValue !== "string") continue;
    const name = String(rawName || "").trim();
    if (!name || /[\r\n]/.test(name)) continue;
    if (/[^\t\x20-\x7e]/.test(name)) continue;
    const lower = name.toLowerCase();
    if (lower === "content-length" || lower === "transfer-encoding" || lower === "connection") continue;

    const value = rawValue.replace(/[\r\n]+/g, " ").trim();
    if (!value) continue;
    res.setHeader(name, value);
  }
}

function resolveRpcErrorStatus(error) {
  if (error?.code === "timeout") return 504;
  if (error?.code === "offline") return 503;
  return 502;
}

function requirePhoneToken(req, res, next) {
  const token = extractPhoneToken(req);
  if (!token) {
    return res.status(401).json({ ok: false, error: "phone token missing" });
  }

  const resolved = resolvePhoneSession(token);
  const phone = resolved?.phone || null;
  if (!phone) {
    return res.status(401).json({ ok: false, error: "invalid phone token" });
  }

  if (resolved?.refreshedToken && resolved.refreshedToken !== token) {
    res.setHeader(PHONE_TOKEN_HEADER, resolved.refreshedToken);
  }

  phone.lastUsedAt = Date.now();
  state.updatedAt = Date.now();
  schedulePersist();

  req.phoneSession = phone;
  return next();
}

function requireLaptopToken(req, res, next) {
  const token = extractLaptopToken(req);
  if (!token) {
    return res.status(401).json({ ok: false, error: "laptop token missing" });
  }

  const resolved = resolveLaptopAuth(token);
  const laptop = resolved?.laptop || null;
  if (!laptop) {
    return res.status(401).json({ ok: false, error: "invalid laptop token" });
  }

  if (resolved?.refreshedToken && resolved.refreshedToken !== token) {
    res.setHeader(LAPTOP_TOKEN_HEADER, resolved.refreshedToken);
    req.refreshedLaptopToken = resolved.refreshedToken;
  }

  laptop.updatedAt = Date.now();
  state.updatedAt = Date.now();
  schedulePersist();

  req.laptopSession = laptop;
  return next();
}

function requireDeviceAccess(req, res, next) {
  const deviceId = safeText(req.params.id, 200);
  const phone = req.phoneSession;

  if (!phone || phone.deviceId !== deviceId) {
    return res.status(403).json({ ok: false, error: "token cannot access this device" });
  }

  const laptop = findLaptopByDeviceId(deviceId);
  if (!laptop) {
    return res.status(404).json({ ok: false, error: "device not found" });
  }

  req.deviceLaptop = laptop;
  return next();
}

function extractPhoneToken(req) {
  const authHeader = String(req.header("authorization") || "");
  if (authHeader.toLowerCase().startsWith("bearer ")) {
    const bearer = authHeader.slice(7).trim();
    if (bearer) return bearer;
  }

  const fromHeader = safeText(req.header("x-phone-token"), 400);
  if (fromHeader) return fromHeader;

  const fromQuery = safeText(req.query?.phoneToken, 400);
  if (fromQuery) return fromQuery;

  return "";
}

function extractLaptopToken(req) {
  const authHeader = String(req.header("authorization") || "");
  if (authHeader.toLowerCase().startsWith("bearer ")) {
    const bearer = authHeader.slice(7).trim();
    if (bearer) return bearer;
  }

  const fromHeader = safeText(req.header("x-laptop-token"), 500);
  if (fromHeader) return fromHeader;

  const fromBody = safeText(req.body?.laptopToken, 500);
  if (fromBody) return fromBody;

  const fromQuery = safeText(req.query?.laptopToken, 500);
  if (fromQuery) return fromQuery;

  return "";
}

async function sendLaptopRpc(laptopId, request, timeoutMs = RPC_TIMEOUT_MS) {
  const socket = laptopSockets.get(laptopId);
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    const error = new Error("laptop is not connected");
    error.code = "offline";
    throw error;
  }

  const id = createId("rpc");

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingRpcs.delete(id);
      const error = new Error("rpc request timed out");
      error.code = "timeout";
      reject(error);
    }, timeoutMs);

    pendingRpcs.set(id, {
      id,
      laptopId,
      resolve,
      reject,
      timer
    });

    try {
      sendWsJson(socket, {
        type: "rpc_request",
        id,
        request: {
          method: String(request?.method || "GET").toUpperCase(),
          path: String(request?.path || "/"),
          headers: isObject(request?.headers) ? request.headers : {},
          body: request?.body
        }
      });
    } catch (error) {
      clearTimeout(timer);
      pendingRpcs.delete(id);
      reject(error);
    }
  });
}

async function ensureLaptopOnline(laptop, options = {}) {
  if (!laptop) {
    return { ok: false, error: "device not found", wakeAttempted: false };
  }

  if (isLaptopConnected(laptop.laptopId)) {
    return { ok: true, wakeAttempted: false };
  }

  if (!options.autoWake) {
    return { ok: false, error: "laptop is not connected", wakeAttempted: false };
  }

  const wakeResult = await triggerWakeAndWait(laptop, {
    wakeIntent: options.wakeIntent,
    timeoutMs: options.timeoutMs
  });
  if (wakeResult.ok) {
    return { ok: true, wakeAttempted: true };
  }

  return {
    ok: false,
    error: wakeResult.error || "laptop is not connected",
    wakeAttempted: true
  };
}

async function triggerWakeAndWait(laptop, options = {}) {
  const pending = pendingWakeAttempts.get(laptop.laptopId);
  if (pending) return pending;

  const attempt = (async () => {
    const wakeMacAddress = normalizeMacAddress(laptop?.wake?.macAddress);
    if (!RELAY_WAKE_PROXY_URL) {
      return { ok: false, error: "wake proxy is not configured" };
    }
    if (!wakeMacAddress) {
      return { ok: false, error: "wake MAC address is not configured for this laptop" };
    }

    mutateState(() => {
      laptop.lastWakeRequestedAt = Date.now();
      laptop.lastWakeResult = "requested";
    });

    const wakeProxyResponse = await callWakeProxy({
      laptopId: laptop.laptopId,
      deviceId: laptop.deviceId,
      macAddress: wakeMacAddress,
      intent: safeText(options?.wakeIntent, 80) || "auto_wake",
      laptopName: safeText(laptop.name, 120) || null
    });

    if (!wakeProxyResponse.ok) {
      mutateState(() => {
        laptop.lastWakeResult = `failed:${wakeProxyResponse.error || "unknown"}`;
      });
      return { ok: false, error: wakeProxyResponse.error || "wake proxy request failed" };
    }

    const timeoutMs = clamp(toInt(options?.timeoutMs, RELAY_WAKE_TIMEOUT_MS), 2_000, 5 * 60 * 1000);
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      if (isLaptopConnected(laptop.laptopId)) {
        mutateState(() => {
          laptop.lastWakeResult = "online";
        });
        return { ok: true };
      }
      await sleep(RELAY_WAKE_POLL_INTERVAL_MS);
    }

    mutateState(() => {
      laptop.lastWakeResult = "timeout";
    });
    return { ok: false, error: "wake timed out; laptop did not reconnect" };
  })()
    .catch((error) => ({ ok: false, error: String(error?.message || error) }))
    .finally(() => {
      pendingWakeAttempts.delete(laptop.laptopId);
    });

  pendingWakeAttempts.set(laptop.laptopId, attempt);
  return attempt;
}

async function callWakeProxy(payload) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), RELAY_WAKE_REQUEST_TIMEOUT_MS);

  try {
    const headers = {
      "Content-Type": "application/json",
      Accept: "application/json"
    };
    if (RELAY_WAKE_PROXY_TOKEN) {
      headers.Authorization = `Bearer ${RELAY_WAKE_PROXY_TOKEN}`;
    }

    const response = await fetch(`${RELAY_WAKE_PROXY_URL}/api/wake`, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: controller.signal
    });

    const body = await safeParseJsonResponse(response);
    if (!response.ok) {
      return { ok: false, error: safeText(body?.error, 240) || `wake proxy error (${response.status})` };
    }

    return { ok: true };
  } catch (error) {
    return { ok: false, error: String(error?.message || error) };
  } finally {
    clearTimeout(timeout);
  }
}

function settlePendingRpc(laptopId, message) {
  const pending = pendingRpcs.get(message.id);
  if (!pending || pending.laptopId !== laptopId) return;

  clearTimeout(pending.timer);
  pendingRpcs.delete(message.id);

  pending.resolve({
    ok: Boolean(message.ok),
    status: toInt(message.status, message.ok ? 200 : 500),
    bodyType: safeText(message.bodyType, 20) || "json",
    body: message.body,
    bodyEncoding: safeText(message.bodyEncoding, 20) || null,
    responseHeaders: isObject(message.responseHeaders) ? message.responseHeaders : null,
    error: safeText(message.error, 1000) || null
  });
}

function rejectPendingRpcsForLaptop(laptopId, reason) {
  for (const [id, pending] of pendingRpcs.entries()) {
    if (pending.laptopId !== laptopId) continue;
    clearTimeout(pending.timer);
    pendingRpcs.delete(id);
    const error = new Error(reason);
    error.code = "offline";
    pending.reject(error);
  }
}

function sendWsJson(ws, payload) {
  if (ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify(payload));
}

function isLaptopConnected(laptopId) {
  const socket = laptopSockets.get(laptopId);
  return Boolean(socket && socket.readyState === WebSocket.OPEN);
}

function createPairingForLaptop(laptop) {
  let code = "";
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const candidate = generatePairCode();
    if (!findPairingByCode(candidate)) {
      code = candidate;
      break;
    }
  }

  if (!code) {
    code = `${generatePairCode()}${Math.floor(Math.random() * 10)}`;
  }

  const now = Date.now();
  const expiresAt = now + PAIRING_TTL_MS;
  const pairingPayload = {
    relayUrl: RELAY_PUBLIC_URL,
    code,
    deviceId: laptop.deviceId,
    laptopId: laptop.laptopId
  };
  const pairingUrl = `${RELAY_PUBLIC_URL}/pair?code=${code}`;

  const pairing = {
    code,
    laptopId: laptop.laptopId,
    deviceId: laptop.deviceId,
    createdAt: now,
    expiresAt,
    claimedAt: null,
    phoneToken: null,
    pairingUrl,
    pairingPayload
  };

  mutateState(() => {
    state.pairings = state.pairings.filter((item) => item.laptopId !== laptop.laptopId || Boolean(item.claimedAt));
    state.pairings.push(pairing);
    laptop.pairCode = code;
    laptop.pairingExpiresAt = expiresAt;
    laptop.pairingUrl = pairingUrl;
    laptop.pairingPayload = pairingPayload;
    laptop.updatedAt = now;
  });

  return pairing;
}

function cleanupExpiredPairings() {
  const now = Date.now();
  let changed = false;

  const nextPairings = [];
  for (const pairing of state.pairings) {
    const isExpired = pairing.expiresAt <= now;
    const keepClaimed = pairing.claimedAt && now - pairing.claimedAt < 7 * 24 * 60 * 60 * 1000;

    if (!isExpired || keepClaimed) {
      nextPairings.push(pairing);
      continue;
    }

    if (!pairing.claimedAt) {
      const laptop = findLaptopById(pairing.laptopId);
      if (laptop && laptop.pairCode === pairing.code) {
        laptop.pairCode = null;
        laptop.pairingExpiresAt = null;
        laptop.pairingUrl = null;
        laptop.pairingPayload = null;
        laptop.updatedAt = now;
      }
    }

    changed = true;
  }

  if (!changed) return;
  state.pairings = nextPairings;
  state.updatedAt = now;
  schedulePersist();
}

function cleanupExpiredPreviews() {
  const now = Date.now();
  const next = state.previews.filter((item) => item.expiresAt > now);
  if (next.length === state.previews.length) return;

  state.previews = next;
  state.updatedAt = now;
  schedulePersist();
}

function findLaptopById(laptopId) {
  return state.laptops.find((item) => item.laptopId === laptopId) || null;
}

function findLaptopByToken(token) {
  if (!token) return null;
  return state.laptops.find((item) => item.laptopToken === token) || null;
}

function findLaptopByDeviceId(deviceId) {
  if (!deviceId) return null;
  return state.laptops.find((item) => item.deviceId === deviceId) || null;
}

function findPairingByCode(code) {
  if (!code) return null;
  return state.pairings.find((item) => item.code === code) || null;
}

function findPhoneByToken(token) {
  if (!token) return null;
  return state.phones.find((item) => item.phoneToken === token) || null;
}

function resolvePhoneSession(token) {
  const exact = findPhoneByToken(token);
  if (exact) {
    const refreshedToken = issuePhoneToken(exact.deviceId);
    return {
      phone: exact,
      refreshedToken: refreshedToken.startsWith("ptkn1_") ? refreshedToken : null
    };
  }

  const claims = parseSignedToken(token, "ptkn1");
  if (!claims || safeText(claims.kind, 40) !== "phone") return null;

  const deviceId = safeText(claims.deviceId, 200);
  if (!deviceId) return null;

  const restored = {
    phoneToken: token,
    deviceId,
    createdAt: Date.now(),
    lastUsedAt: Date.now()
  };

  mutateState(() => {
    if (!state.phones.some((item) => item.phoneToken === token)) {
      state.phones.push(restored);
      trimStateCollections();
    }
  });

  return {
    phone: findPhoneByToken(token) || restored,
    refreshedToken: null
  };
}

function resolveLaptopAuth(token) {
  const exact = findLaptopByToken(token);
  if (exact) {
    const refreshedToken = issueLaptopToken(exact.laptopId, exact.deviceId);
    return {
      laptop: exact,
      refreshedToken: refreshedToken.startsWith("ltkn1_") ? refreshedToken : null
    };
  }

  const restored = restoreLaptopFromSignedToken(token);
  if (!restored) return null;

  return {
    laptop: restored,
    refreshedToken: null
  };
}

function resolveLaptopSession(token) {
  const resolved = resolveLaptopAuth(token);
  return resolved?.laptop || null;
}

function restoreLaptopFromSignedToken(token) {
  const claims = parseSignedToken(token, "ltkn1");
  if (!claims || safeText(claims.kind, 40) !== "laptop") return null;

  const laptopId = safeText(claims.laptopId, 200);
  const deviceId = safeText(claims.deviceId, 200);
  if (!laptopId || !deviceId) return null;

  const existing = findLaptopById(laptopId) || findLaptopByDeviceId(deviceId);
  if (existing) {
    return existing;
  }

  const restored = {
    laptopId,
    deviceId,
    laptopToken: token,
    name: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    pairedAt: null,
    pairCode: null,
    pairingExpiresAt: null,
    pairingUrl: null,
    pairingPayload: null,
    lastConnectedAt: null,
    lastDisconnectedAt: null,
    lastSnapshotAt: null,
    latestSnapshot: null,
    wake: {
      macAddress: null
    },
    lastWakeRequestedAt: null,
    lastWakeResult: null
  };

  mutateState(() => {
    const alreadyThere = findLaptopById(laptopId) || findLaptopByDeviceId(deviceId);
    if (!alreadyThere) {
      state.laptops.push(restored);
      trimStateCollections();
    }
  });

  return findLaptopById(laptopId) || restored;
}

function findPreviewByAccessToken(accessToken) {
  if (!accessToken) return null;
  return state.previews.find((item) => item.accessToken === accessToken) || null;
}

function listPreviewsForDevice(deviceId) {
  if (!deviceId) return [];
  return state.previews
    .filter((item) => item.deviceId === deviceId && item.expiresAt > Date.now())
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

function serializePreview(preview, options = {}) {
  const token = safeText(preview?.accessToken, 500);
  const publicUrl = token ? `${RELAY_PUBLIC_URL}/p/${encodeURIComponent(token)}/` : "";
  return {
    id: safeText(preview?.previewId, 200),
    deviceId: safeText(preview?.deviceId, 200),
    laptopId: safeText(preview?.laptopId, 200),
    label: safeText(preview?.label, 120) || null,
    target: safeText(preview?.target, 2000),
    createdAt: toInt(preview?.createdAt, Date.now()),
    updatedAt: toInt(preview?.updatedAt, Date.now()),
    lastAccessedAt: preview?.lastAccessedAt ? toInt(preview.lastAccessedAt, null) : null,
    expiresAt: toInt(preview?.expiresAt, Date.now()),
    connected: options.connected === true,
    publicUrl
  };
}

function normalizePreviewTarget(targetUrlInput, portInput) {
  let target = safeText(targetUrlInput, 2000);
  if (!target && portInput !== undefined && portInput !== null && String(portInput).trim()) {
    const port = toInt(portInput, 0);
    if (port <= 0 || port > 65535) return "";
    target = `http://127.0.0.1:${port}`;
  }
  if (!target) return "";

  let parsed;
  try {
    parsed = new URL(target);
  } catch {
    return "";
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "";
  const host = String(parsed.hostname || "").toLowerCase();
  if (host !== "localhost" && host !== "127.0.0.1" && host !== "::1" && host !== "0.0.0.0") return "";

  const normalizedHost = host === "localhost" || host === "::1" || host === "0.0.0.0" ? "127.0.0.1" : host;
  const normalized = new URL(`${parsed.protocol}//${normalizedHost}`);
  if (parsed.port) {
    const port = toInt(parsed.port, 0);
    if (port <= 0 || port > 65535) return "";
    normalized.port = String(port);
  }

  return trimTrailingSlash(normalized.toString());
}

function safePreviewPathSuffix(value) {
  const segment = safeText(value, 4000);
  if (!segment) return "/";
  return segment.startsWith("/") ? segment : `/${segment}`;
}

function sanitizePreviewForwardHeaders(headersInput) {
  if (!isObject(headersInput)) return {};
  const out = {};

  for (const [nameRaw, valueRaw] of Object.entries(headersInput)) {
    if (Array.isArray(valueRaw)) continue;
    if (typeof valueRaw !== "string") continue;
    const name = String(nameRaw || "").trim();
    if (!name) continue;
    const lower = name.toLowerCase();
    if (
      lower === "host" ||
      lower === "content-length" ||
      lower === "connection" ||
      lower === "transfer-encoding" ||
      lower === "upgrade" ||
      lower === "authorization" ||
      lower === "x-phone-token" ||
      lower === "x-laptop-token"
    ) {
      continue;
    }

    out[name] = valueRaw;
  }

  return out;
}

function normalizePreviewForwardBody(req) {
  const method = String(req.method || "GET").toUpperCase();
  if (method === "GET" || method === "HEAD") return undefined;

  if (req.body === undefined || req.body === null) return undefined;
  if (typeof req.body === "string") return req.body;
  if (Buffer.isBuffer(req.body)) return req.body.toString("utf8");
  if (typeof req.body === "object") return req.body;
  return String(req.body);
}

function withQuery(pathname, queryInput) {
  const params = new URLSearchParams();

  for (const [key, value] of Object.entries(queryInput || {})) {
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item === undefined || item === null) continue;
        params.append(key, String(item));
      }
      continue;
    }

    if (value === undefined || value === null) continue;
    params.set(key, String(value));
  }

  const query = params.toString();
  if (!query) return pathname;
  return `${pathname}?${query}`;
}

function createId(prefix) {
  return `${prefix}_${randomBytes(8).toString("hex")}`;
}

function createToken(prefix) {
  return `${prefix}_${randomBytes(20).toString("hex")}`;
}

function issuePhoneToken(deviceId) {
  const normalizedDeviceId = safeText(deviceId, 200);
  if (!normalizedDeviceId || !RELAY_TOKEN_SECRET) {
    return createToken("ptkn");
  }

  return createSignedToken("ptkn1", {
    kind: "phone",
    deviceId: normalizedDeviceId
  });
}

function issueLaptopToken(laptopId, deviceId) {
  const normalizedLaptopId = safeText(laptopId, 200);
  const normalizedDeviceId = safeText(deviceId, 200);
  if (!normalizedLaptopId || !normalizedDeviceId || !RELAY_TOKEN_SECRET) {
    return createToken("ltkn");
  }

  return createSignedToken("ltkn1", {
    kind: "laptop",
    laptopId: normalizedLaptopId,
    deviceId: normalizedDeviceId
  });
}

function preferredLaptopToken(laptop) {
  const upgraded = issueLaptopToken(laptop?.laptopId, laptop?.deviceId);
  return upgraded.startsWith("ltkn1_") ? upgraded : safeText(laptop?.laptopToken, 1000);
}

function createSignedToken(prefix, payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = createHmac("sha256", RELAY_TOKEN_SECRET).update(`${prefix}.${body}`).digest("base64url");
  return `${prefix}_${body}.${signature}`;
}

function parseSignedToken(token, expectedPrefix) {
  if (!RELAY_TOKEN_SECRET) return null;

  const raw = safeText(token, 4000);
  if (!raw.startsWith(`${expectedPrefix}_`)) return null;

  const composite = raw.slice(expectedPrefix.length + 1);
  const separatorIndex = composite.lastIndexOf(".");
  if (separatorIndex <= 0 || separatorIndex >= composite.length - 1) return null;

  const body = composite.slice(0, separatorIndex);
  const signature = composite.slice(separatorIndex + 1);

  let actual;
  try {
    actual = Buffer.from(signature, "base64url");
  } catch {
    return null;
  }

  const expected = createHmac("sha256", RELAY_TOKEN_SECRET).update(`${expectedPrefix}.${body}`).digest();
  if (actual.length !== expected.length) return null;
  if (!timingSafeEqual(actual, expected)) return null;

  try {
    const parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    return isObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function generatePairCode() {
  const alphabet = "23456789ABCDEFGHJKMNPQRSTVWXYZ";
  let out = "";
  for (let i = 0; i < 6; i += 1) {
    out += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return out;
}

function normalizePairCode(value) {
  const normalized = String(value || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
  return normalized || "";
}

function resolveRelayTokenSecret() {
  const explicit = safeText(process.env.RELAY_TOKEN_SECRET || process.env.AGENT_RELAY_TOKEN_SECRET || "", 1000);
  if (explicit) return explicit;

  const renderServiceId = safeText(process.env.RENDER_SERVICE_ID || "", 500);
  if (renderServiceId) return `render:${renderServiceId}`;

  if (/^https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0)(?::\d+)?$/i.test(RELAY_PUBLIC_URL)) {
    return "agent-companion-local-dev-secret";
  }

  return "";
}

function mutateState(mutator) {
  mutator();
  state.updatedAt = Date.now();
  schedulePersist();
}

function schedulePersist() {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    persistStateNow();
  }, 120);
}

function persistStateNow() {
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (error) {
    console.error("[relay] failed to persist state:", error);
  }
}

function loadState() {
  const fallback = {
    laptops: [],
    pairings: [],
    phones: [],
    previews: [],
    updatedAt: Date.now()
  };

  try {
    if (!fs.existsSync(STATE_FILE)) {
      return fallback;
    }

    const parsed = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    return sanitizeState(parsed);
  } catch {
    return fallback;
  }
}

function sanitizeState(raw) {
  const fallback = {
    laptops: [],
    pairings: [],
    phones: [],
    previews: [],
    updatedAt: Date.now()
  };

  if (!isObject(raw)) return fallback;

  const laptops = Array.isArray(raw.laptops)
    ? raw.laptops
        .filter((item) => isObject(item))
        .map((item) => ({
          laptopId: safeText(item.laptopId, 200),
          deviceId: safeText(item.deviceId, 200),
          laptopToken: safeText(item.laptopToken, 500),
          name: safeText(item.name, 120) || null,
          createdAt: toInt(item.createdAt, Date.now()),
          updatedAt: toInt(item.updatedAt, Date.now()),
          pairedAt: item.pairedAt ? toInt(item.pairedAt, null) : null,
          pairCode: safeText(item.pairCode, 40) || null,
          pairingExpiresAt: item.pairingExpiresAt ? toInt(item.pairingExpiresAt, null) : null,
          pairingUrl: safeText(item.pairingUrl, 2000) || null,
          pairingPayload: isObject(item.pairingPayload) ? item.pairingPayload : null,
          lastConnectedAt: item.lastConnectedAt ? toInt(item.lastConnectedAt, null) : null,
          lastDisconnectedAt: item.lastDisconnectedAt ? toInt(item.lastDisconnectedAt, null) : null,
          lastSnapshotAt: item.lastSnapshotAt ? toInt(item.lastSnapshotAt, null) : null,
          latestSnapshot: isObject(item.latestSnapshot) ? item.latestSnapshot : null,
          wake: {
            macAddress: normalizeMacAddress(item?.wake?.macAddress || item?.wakeMac || item?.macAddress) || null
          },
          lastWakeRequestedAt: item.lastWakeRequestedAt ? toInt(item.lastWakeRequestedAt, null) : null,
          lastWakeResult: safeText(item.lastWakeResult, 120) || null
        }))
        .filter((item) => item.laptopId && item.deviceId && item.laptopToken)
    : [];

  const pairings = Array.isArray(raw.pairings)
    ? raw.pairings
        .filter((item) => isObject(item))
        .map((item) => ({
          code: normalizePairCode(item.code),
          laptopId: safeText(item.laptopId, 200),
          deviceId: safeText(item.deviceId, 200),
          createdAt: toInt(item.createdAt, Date.now()),
          expiresAt: toInt(item.expiresAt, Date.now()),
          claimedAt: item.claimedAt ? toInt(item.claimedAt, null) : null,
          phoneToken: safeText(item.phoneToken, 500) || null,
          pairingUrl: safeText(item.pairingUrl, 2000) || null,
          pairingPayload: isObject(item.pairingPayload) ? item.pairingPayload : null
        }))
        .filter((item) => item.code && item.laptopId && item.deviceId)
    : [];

  const phones = Array.isArray(raw.phones)
    ? raw.phones
        .filter((item) => isObject(item))
        .map((item) => ({
          phoneToken: safeText(item.phoneToken, 500),
          deviceId: safeText(item.deviceId, 200),
          createdAt: toInt(item.createdAt, Date.now()),
          lastUsedAt: toInt(item.lastUsedAt, Date.now())
        }))
        .filter((item) => item.phoneToken && item.deviceId)
    : [];

  const previews = Array.isArray(raw.previews)
    ? raw.previews
        .filter((item) => isObject(item))
        .map((item) => ({
          previewId: safeText(item.previewId, 200),
          accessToken: safeText(item.accessToken, 500),
          laptopId: safeText(item.laptopId, 200),
          deviceId: safeText(item.deviceId, 200),
          label: safeText(item.label, 120) || null,
          target: normalizePreviewTarget(item.target, null),
          createdAt: toInt(item.createdAt, Date.now()),
          updatedAt: toInt(item.updatedAt, Date.now()),
          lastAccessedAt: item.lastAccessedAt ? toInt(item.lastAccessedAt, null) : null,
          expiresAt: toInt(item.expiresAt, Date.now()),
          createdByPhoneToken: safeText(item.createdByPhoneToken, 500) || null
        }))
        .filter((item) => item.previewId && item.accessToken && item.laptopId && item.deviceId && item.target)
    : [];

  return {
    laptops,
    pairings,
    phones,
    previews,
    updatedAt: toInt(raw.updatedAt, Date.now())
  };
}

function trimStateCollections() {
  if (state.laptops.length > MAX_LAPTOP_RECORDS) {
    state.laptops = state.laptops
      .slice()
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, MAX_LAPTOP_RECORDS);
  }

  if (state.phones.length > MAX_PHONE_TOKENS) {
    state.phones = state.phones
      .slice()
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, MAX_PHONE_TOKENS);
  }

  if (state.previews.length > MAX_PREVIEW_RECORDS) {
    state.previews = state.previews
      .slice()
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, MAX_PREVIEW_RECORDS);
  }
}

function gracefulShutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;

  console.log(`[relay] received ${signal}, shutting down`);

  try {
    persistStateNow();
  } catch {
    // ignore
  }

  for (const ws of laptopSockets.values()) {
    try {
      ws.close(1001, "relay shutting down");
    } catch {
      // ignore
    }
  }

  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 800).unref();
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function toInt(value, fallback = 0) {
  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function safeText(value, maxLength) {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (trimmed.length <= maxLength) return trimmed;
  return trimmed.slice(0, maxLength);
}

function trimTrailingSlash(value) {
  const trimmed = String(value || "").trim();
  if (!trimmed) return "";
  return trimmed.replace(/\/+$/, "");
}

function normalizeMacAddress(value) {
  const raw = String(value || "")
    .trim()
    .toUpperCase()
    .replace(/[^0-9A-F]/g, "");
  if (raw.length !== 12) return "";
  const chunks = raw.match(/.{1,2}/g);
  return chunks ? chunks.join(":") : "";
}

async function safeParseJsonResponse(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
