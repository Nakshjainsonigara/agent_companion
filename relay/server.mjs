#!/usr/bin/env node
import cors from "cors";
import express from "express";
import { randomBytes } from "node:crypto";
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

app.use(cors());
app.use(express.json({ limit: "2mb" }));

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
  const laptopToken = createToken("ltkn");
  const deviceId = createId("dev");
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

  const phoneToken = createToken("ptkn");
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

  const token = safeText(parsedUrl.searchParams.get("token"), 400);
  const laptop = findLaptopByToken(token);
  if (!laptop) {
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    socket.destroy();
    return;
  }

  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit("connection", ws, laptop);
  });
});

wss.on("connection", (ws, laptop) => {
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

async function handlePreviewProxy(req, res) {
  cleanupExpiredPreviews();

  const rawToken =
    req.params && typeof req.params === "object" ? req.params.token ?? req.params[0] : "";
  const accessToken = safeText(rawToken, 500);
  if (!accessToken) {
    return res.status(400).type("text/plain").send("preview token is required");
  }

  const preview = findPreviewByAccessToken(accessToken);
  if (!preview) {
    return res.status(404).type("text/plain").send("preview link expired or not found");
  }

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
    req.params && typeof req.params === "object" ? req.params.rest ?? req.params[1] : "";
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

    mutateState(() => {
      preview.lastAccessedAt = Date.now();
      preview.updatedAt = Date.now();
    });

    return relayRpcResponse(res, rpc);
  } catch (error) {
    return res.status(resolveRpcErrorStatus(error)).type("text/plain").send(String(error?.message || error));
  }
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

  const phone = findPhoneByToken(token);
  if (!phone) {
    return res.status(401).json({ ok: false, error: "invalid phone token" });
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

  const laptop = findLaptopByToken(token);
  if (!laptop) {
    return res.status(401).json({ ok: false, error: "invalid laptop token" });
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
  const publicUrl = token ? `${RELAY_PUBLIC_URL}/p/${encodeURIComponent(token)}` : "";
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
