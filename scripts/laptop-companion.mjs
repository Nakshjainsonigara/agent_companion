#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

const argv = process.argv.slice(2);
const args = parseArgs(argv);

const relayBaseUrl = trimTrailingSlash(args.relay || process.env.AGENT_RELAY_URL || "https://agent-companion-relay.onrender.com");
const bridgeBaseUrl = trimTrailingSlash(args.bridge || process.env.AGENT_LOCAL_BRIDGE_URL || "http://localhost:8787");
const bridgeToken = String(args.bridgeToken || process.env.AGENT_BRIDGE_TOKEN || "").trim();
const quietLogs = String(args.quiet || process.env.AGENT_COMPANION_QUIET || "1").trim() !== "0";
const snapshotIntervalMs = clamp(toInt(args["snapshot-interval"], 4000), 1000, 60_000);
const rpcTimeoutMs = clamp(toInt(args["rpc-timeout"], 12_000), 1000, 60_000);
const bridgeStartupTimeoutMs = clamp(toInt(args["bridge-startup-timeout"], 9000), 2000, 60_000);
const bridgeProbeBeforeSpawnMs = clamp(toInt(args["bridge-probe-before-spawn"], 1200), 200, 10_000);
const companionStateFile = path.resolve(
  String(args["state-file"] || process.env.AGENT_COMPANION_STATE_FILE || path.join(os.homedir(), ".agent-companion", "companion.json"))
);
const registerRetryDelayMs = 3000;
const explicitWakeMac = normalizeMacAddress(
  args["wake-mac"] || args.wakeMac || process.env.AGENT_WAKE_MAC || process.env.WAKE_MAC || ""
);
const detectedWakeMac = detectPrimaryWakeMacAddress();
const wakeMacAddress = explicitWakeMac || detectedWakeMac || "";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");
const bridgeScript = path.resolve(projectRoot, "bridge", "server.mjs");

let shuttingDown = false;
let snapshotTimer = null;
let snapshotInFlight = false;
let ensureBridgePromise = null;
let websocket = null;
let reconnectDelayMs = 1200;

let bridgeChild = null;
let bridgeStartedByCompanion = false;

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

await main();

async function main() {
  if (!relayBaseUrl.startsWith("http://") && !relayBaseUrl.startsWith("https://")) {
    throw new Error(`relay URL must start with http:// or https:// (received "${relayBaseUrl}")`);
  }

  if (!bridgeBaseUrl.startsWith("http://") && !bridgeBaseUrl.startsWith("https://")) {
    throw new Error(`bridge URL must start with http:// or https:// (received "${bridgeBaseUrl}")`);
  }

  await ensureBridgeAvailable();

  const registration = await getOrCreateLaptopRegistration();
  printPairingInfo(registration);

  while (!shuttingDown) {
    await connectWebSocketOnce(registration.laptopToken);
    if (shuttingDown) break;

    const waitMs = reconnectDelayMs;
    await sleep(waitMs);
    reconnectDelayMs = Math.min(10_000, Math.round(reconnectDelayMs * 1.7));
  }
}

async function getOrCreateLaptopRegistration() {
  const cached = loadCompanionState();
  if (cached && cached.relayBaseUrl === relayBaseUrl && cached.laptopToken) {
    const reused = await fetchExistingLaptopRegistration(cached.laptopToken);
    if (reused) {
      persistCompanionState({
        relayBaseUrl,
        laptopId: reused.laptopId,
        deviceId: reused.deviceId,
        laptopToken: reused.laptopToken,
        pairCode: reused.pairCode,
        pairingExpiresAt: reused.pairingExpiresAt,
        pairingUrl: reused.pairingUrl
      });
      return { ...reused, reused: true };
    }
  }

  const created = await registerLaptopWithRetry();
  persistCompanionState({
    relayBaseUrl,
    laptopId: created.laptopId,
    deviceId: created.deviceId,
    laptopToken: created.laptopToken,
    pairCode: created.pairCode,
    pairingExpiresAt: created.pairingExpiresAt,
    pairingUrl: created.pairingUrl
  });
  return { ...created, reused: false };
}

async function fetchExistingLaptopRegistration(laptopToken) {
  try {
    const meResponse = await fetchWithTimeout(
      `${relayBaseUrl}/api/laptops/me`,
      {
        method: "GET",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${laptopToken}`
        }
      },
      5000
    );

    if (!meResponse.ok) {
      return null;
    }

    const me = await safeParseJson(meResponse);
    if (!me?.laptopId || !me?.deviceId) {
      return null;
    }

    const pairingResponse = await fetchWithTimeout(
      `${relayBaseUrl}/api/laptops/pairing`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          Authorization: `Bearer ${laptopToken}`
        },
        body: JSON.stringify({
          force: false,
          ...(wakeMacAddress ? { wakeMac: wakeMacAddress } : {})
        })
      },
      5000
    );

    if (!pairingResponse.ok) {
      return null;
    }

    const pairing = await safeParseJson(pairingResponse);
    if (!pairing?.pairCode) {
      return null;
    }

    return {
      laptopId: me.laptopId,
      deviceId: me.deviceId,
      laptopToken,
      pairCode: pairing.pairCode,
      pairingExpiresAt: pairing.pairingExpiresAt,
      pairingUrl: pairing.pairingUrl,
      pairingPayload: pairing.pairingPayload
    };
  } catch {
    return null;
  }
}

async function registerLaptopWithRetry() {
  const payload = {
    name: safeText(args.name, 120) || os.hostname(),
    hostname: os.hostname(),
    platform: process.platform,
    ...(wakeMacAddress ? { wakeMac: wakeMacAddress } : {})
  };

  while (!shuttingDown) {
    try {
      const response = await fetchWithTimeout(
        `${relayBaseUrl}/api/laptops/register`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json"
          },
          body: JSON.stringify(payload)
        },
        6000
      );

      const body = await safeParseJson(response);
      if (!response.ok) {
        throw new Error(`register failed (${response.status}): ${JSON.stringify(body)}`);
      }

      assertRegistrationShape(body);
      return body;
    } catch (error) {
      if (shuttingDown) break;
      console.error(`[companion] register failed: ${String(error?.message || error)}`);
      await sleep(registerRetryDelayMs);
    }
  }

  throw new Error("registration aborted");
}

function printPairingInfo(registration) {
  console.log("");
  console.log("Agent Companion laptop is ready.");
  console.log(`Pairing code: ${registration.pairCode}`);
  console.log("Enter this code in the app to pair.");
  if (!quietLogs) {
    if (wakeMacAddress) {
      console.log(`Auto-wake MAC: ${wakeMacAddress}`);
    } else {
      console.log("Auto-wake: MAC not detected (set --wake-mac AA:BB:CC:DD:EE:FF)");
    }
  }
  if (!quietLogs && registration.pairingUrl) {
    console.log(`Pair URL: ${registration.pairingUrl}`);
  }
  console.log("");
}

function connectWebSocketOnce(laptopToken) {
  const wsUrl = buildLaptopWsUrl(relayBaseUrl, laptopToken);

  return new Promise((resolve) => {
    const socket = new WebSocket(wsUrl);
    websocket = socket;

    socket.on("open", () => {
      reconnectDelayMs = 1200;
      startSnapshotLoop(socket);
      void pushSnapshot(socket);
      if (!quietLogs) {
        console.log("[companion] connected to relay");
      }
    });

    socket.on("message", (chunk, isBinary) => {
      if (isBinary) return;
      let message;
      try {
        message = JSON.parse(chunk.toString());
      } catch {
        return;
      }
      if (!isObject(message)) return;
      if (message.type === "rpc_request" && typeof message.id === "string") {
        void handleRpcRequest(socket, message);
      }
    });

    socket.on("close", (code, reasonRaw) => {
      if (websocket === socket) {
        websocket = null;
      }
      stopSnapshotLoop();

      const reason = Buffer.isBuffer(reasonRaw) ? reasonRaw.toString("utf8") : String(reasonRaw || "");
      if (!quietLogs) {
        console.error(`[companion] websocket closed (${code})${reason ? ` ${reason}` : ""}`);
      } else if (!shuttingDown) {
        console.error("[companion] disconnected from relay, retrying...");
      }
      resolve();
    });

    socket.on("error", (error) => {
      if (!quietLogs) {
        console.error(`[companion] websocket error: ${String(error?.message || error)}`);
      }
    });
  });
}

async function handleRpcRequest(socket, message) {
  const id = String(message.id || "").trim();
  if (!id) return;

  const request = isObject(message.request) ? message.request : {};
  const method = normalizeMethod(request.method);
  const relayPath = normalizeRelayPath(request.path);
  const headers = sanitizeHeaders(request.headers);

  try {
    const rpcResult = await forwardToLocalBridge({
      method,
      path: relayPath,
      headers,
      body: request.body
    });

    sendWsJson(socket, {
      type: "rpc_response",
      id,
      ...rpcResult
    });
  } catch (error) {
    sendWsJson(socket, {
      type: "rpc_response",
      id,
      ok: false,
      status: 502,
      bodyType: "json",
      body: {
        ok: false,
        error: String(error?.message || error)
      },
      error: String(error?.message || error)
    });
  }
}

async function forwardToLocalBridge(input) {
  if (input.path.startsWith("/__relay/preview/proxy")) {
    return forwardPreviewTargetRequest(input);
  }

  const healthy = await ensureBridgeAvailable();
  if (!healthy) {
    return {
      ok: false,
      status: 503,
      bodyType: "json",
      body: {
        ok: false,
        error: "local bridge is unavailable"
      },
      error: "local bridge is unavailable"
    };
  }

  const headers = {
    Accept: "application/json",
    ...input.headers
  };

  if (bridgeToken && input.path.startsWith("/api/launcher")) {
    headers["x-bridge-token"] = bridgeToken;
  }

  let body = undefined;
  if (input.body !== undefined && input.body !== null && input.method !== "GET" && input.method !== "HEAD") {
    body = JSON.stringify(input.body);
    if (!hasHeader(headers, "content-type")) {
      headers["Content-Type"] = "application/json";
    }
  }

  const response = await fetchWithTimeout(
    `${bridgeBaseUrl}${input.path}`,
    {
      method: input.method,
      headers,
      body
    },
    rpcTimeoutMs
  );

  const parsed = await parseResponseBody(response);
  return {
    ok: response.ok,
    status: response.status,
    bodyType: parsed.bodyType,
    body: parsed.body,
    bodyEncoding: parsed.bodyEncoding || null,
    responseHeaders: parsed.responseHeaders || null,
    error: response.ok ? null : extractErrorMessage(parsed.body)
  };
}

async function forwardPreviewTargetRequest(input) {
  const relayPath = normalizeRelayPath(input.path);
  const parsedRelayPath = new URL(relayPath, "http://relay.local");
  const previewTarget = normalizePreviewTarget(parsedRelayPath.searchParams.get("target"));
  const forwardedPath = normalizePreviewRequestPath(parsedRelayPath.searchParams.get("path"));

  if (!previewTarget || !forwardedPath) {
    return {
      ok: false,
      status: 400,
      bodyType: "json",
      body: {
        ok: false,
        error: "invalid preview target"
      },
      error: "invalid preview target"
    };
  }

  const finalUrl = resolvePreviewFinalUrl(previewTarget, forwardedPath);
  if (!finalUrl) {
    return {
      ok: false,
      status: 400,
      bodyType: "json",
      body: {
        ok: false,
        error: "invalid preview path"
      },
      error: "invalid preview path"
    };
  }

  const headers = {
    Accept: "*/*",
    ...sanitizePreviewHeaders(input.headers)
  };

  let body = undefined;
  if (input.body !== undefined && input.body !== null && input.method !== "GET" && input.method !== "HEAD") {
    if (typeof input.body === "string" || input.body instanceof String) {
      body = String(input.body);
    } else {
      body = JSON.stringify(input.body);
      if (!hasHeader(headers, "content-type")) {
        headers["Content-Type"] = "application/json";
      }
    }
  }

  const response = await fetchWithTimeout(
    finalUrl,
    {
      method: input.method,
      headers,
      body
    },
    Math.max(15_000, rpcTimeoutMs)
  );

  const parsed = await parseResponseBody(response);
  return {
    ok: response.ok,
    status: response.status,
    bodyType: parsed.bodyType,
    body: parsed.body,
    bodyEncoding: parsed.bodyEncoding || null,
    responseHeaders: parsed.responseHeaders || null,
    error: response.ok ? null : extractErrorMessage(parsed.body)
  };
}

function startSnapshotLoop(socket) {
  stopSnapshotLoop();
  snapshotTimer = setInterval(() => {
    void pushSnapshot(socket);
  }, snapshotIntervalMs);
  snapshotTimer.unref?.();
}

function stopSnapshotLoop() {
  if (!snapshotTimer) return;
  clearInterval(snapshotTimer);
  snapshotTimer = null;
}

async function pushSnapshot(socket) {
  if (snapshotInFlight) return;
  if (!socket || socket.readyState !== WebSocket.OPEN) return;

  snapshotInFlight = true;
  try {
    const healthy = await ensureBridgeAvailable();
    if (!healthy) return;

    const response = await fetchWithTimeout(
      `${bridgeBaseUrl}/api/bootstrap`,
      {
        method: "GET",
        headers: { Accept: "application/json" }
      },
      Math.min(7000, rpcTimeoutMs)
    );

    if (!response.ok) return;
    const snapshot = await response.json().catch(() => null);
    if (!isObject(snapshot)) return;

    sendWsJson(socket, {
      type: "snapshot",
      snapshot
    });
  } catch {
    // periodic sync keeps retrying
  } finally {
    snapshotInFlight = false;
  }
}

async function ensureBridgeAvailable() {
  if (await isBridgeHealthy()) {
    return true;
  }

  if (ensureBridgePromise) {
    return ensureBridgePromise;
  }

  ensureBridgePromise = (async () => {
    const probeDeadline = Date.now() + bridgeProbeBeforeSpawnMs;
    while (Date.now() < probeDeadline) {
      if (await isBridgeHealthy()) return true;
      await sleep(250);
    }

    if (!(await isBridgeHealthy()) && shouldAutoStartLocalBridge(bridgeBaseUrl)) {
      startBridgeIfNeeded(bridgeBaseUrl);
    }

    const deadline = Date.now() + bridgeStartupTimeoutMs;
    while (Date.now() < deadline) {
      if (await isBridgeHealthy()) return true;
      await sleep(300);
    }

    return false;
  })();

  try {
    return await ensureBridgePromise;
  } finally {
    ensureBridgePromise = null;
  }
}

function startBridgeIfNeeded(targetBridgeUrl) {
  if (!fs.existsSync(bridgeScript)) {
    console.error(`[companion] cannot auto-start bridge: missing ${bridgeScript}`);
    return;
  }

  if (bridgeChild && bridgeChild.exitCode === null) {
    return;
  }

  const port = resolveBridgePort(targetBridgeUrl);
  if (!quietLogs) {
    console.log(`[companion] local bridge unreachable, starting bridge/server.mjs on port ${port}`);
  }

  const childEnv = {
    ...process.env,
    AGENT_BRIDGE_PORT: String(port)
  };

  if (bridgeToken && !childEnv.AGENT_BRIDGE_TOKEN) {
    childEnv.AGENT_BRIDGE_TOKEN = bridgeToken;
  }

  bridgeChild = spawn(process.execPath, [bridgeScript], {
    cwd: projectRoot,
    env: childEnv,
    stdio: ["ignore", "pipe", "pipe"]
  });
  bridgeStartedByCompanion = true;

  if (!quietLogs) {
    bridgeChild.stdout.on("data", (chunk) => {
      process.stdout.write(`[local-bridge] ${chunk}`);
    });

    bridgeChild.stderr.on("data", (chunk) => {
      process.stderr.write(`[local-bridge] ${chunk}`);
    });
  }

  bridgeChild.on("close", (code) => {
    if (shuttingDown) return;
    console.error(`[companion] local bridge process exited with code ${code}`);
  });
}

function shouldAutoStartLocalBridge(bridgeUrl) {
  try {
    const parsed = new URL(bridgeUrl);
    const host = String(parsed.hostname || "").toLowerCase();
    return host === "localhost" || host === "127.0.0.1" || host === "::1";
  } catch {
    return false;
  }
}

function resolveBridgePort(bridgeUrl) {
  try {
    const parsed = new URL(bridgeUrl);
    if (parsed.port) {
      const numeric = toInt(parsed.port, 8787);
      if (numeric > 0 && numeric < 65536) return numeric;
    }
    return parsed.protocol === "https:" ? 443 : 80;
  } catch {
    return toInt(process.env.AGENT_BRIDGE_PORT, 8787);
  }
}

async function isBridgeHealthy() {
  try {
    const response = await fetchWithTimeout(
      `${bridgeBaseUrl}/health`,
      {
        method: "GET",
        headers: { Accept: "application/json" }
      },
      1500
    );
    return response.ok;
  } catch {
    return false;
  }
}

function sendWsJson(socket, payload) {
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify(payload));
}

async function parseResponseBody(response) {
  const responseHeaders = extractResponseHeaders(response.headers);
  if (response.status === 204 || response.status === 205) {
    return { bodyType: "empty", body: null, responseHeaders };
  }

  const contentType = String(response.headers.get("content-type") || "").toLowerCase();
  const buffer = Buffer.from(await response.arrayBuffer());
  if (!buffer.length) {
    return { bodyType: "empty", body: null, responseHeaders };
  }

  if (shouldTreatAsText(contentType)) {
    const text = buffer.toString("utf8");
    if (contentType.includes("application/json")) {
      try {
        return { bodyType: "json", body: JSON.parse(text), responseHeaders };
      } catch {
        return { bodyType: "text", body: text, responseHeaders };
      }
    }

    try {
      return { bodyType: "json", body: JSON.parse(text), responseHeaders };
    } catch {
      return { bodyType: "text", body: text, responseHeaders };
    }
  }

  return {
    bodyType: "base64",
    bodyEncoding: "base64",
    body: buffer.toString("base64"),
    responseHeaders
  };
}

function shouldTreatAsText(contentType) {
  if (!contentType) return true;
  return (
    contentType.startsWith("text/") ||
    contentType.includes("application/json") ||
    contentType.includes("application/javascript") ||
    contentType.includes("application/xml") ||
    contentType.includes("application/xhtml+xml") ||
    contentType.includes("application/x-www-form-urlencoded") ||
    contentType.includes("application/graphql") ||
    contentType.includes("image/svg+xml")
  );
}

function extractResponseHeaders(headers) {
  const allowed = [
    "content-type",
    "cache-control",
    "etag",
    "last-modified",
    "expires",
    "vary",
    "pragma",
    "x-powered-by"
  ];
  const out = {};
  for (const name of allowed) {
    const value = headers.get(name);
    if (value) out[name] = value;
  }
  return out;
}

function normalizePreviewTarget(value) {
  const raw = safeText(value, 2000);
  if (!raw) return "";
  let parsed;
  try {
    parsed = new URL(raw);
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

function normalizePreviewRequestPath(value) {
  const path = safeText(value, 5000);
  if (!path) return "/";
  return path.startsWith("/") ? path : `/${path}`;
}

function resolvePreviewFinalUrl(previewTarget, requestPath) {
  try {
    const targetBase = new URL(previewTarget);
    const candidate = new URL(requestPath, `${targetBase.protocol}//${targetBase.host}`);
    if (candidate.protocol !== targetBase.protocol || candidate.host !== targetBase.host) {
      return "";
    }
    return candidate.toString();
  } catch {
    return "";
  }
}

function sanitizePreviewHeaders(input) {
  if (!isObject(input)) return {};
  const out = {};
  for (const [key, value] of Object.entries(input)) {
    if (typeof value !== "string") continue;
    const lower = key.toLowerCase();
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
    out[key] = value;
  }
  return out;
}

function buildLaptopWsUrl(baseUrl, laptopToken) {
  const parsed = new URL(baseUrl);
  parsed.protocol = parsed.protocol === "https:" ? "wss:" : "ws:";
  parsed.pathname = "/ws/laptop";
  parsed.search = "";
  parsed.searchParams.set("token", laptopToken);
  return parsed.toString();
}

function normalizeRelayPath(inputPath) {
  const asText = safeText(inputPath, 12_000) || "/";
  if (asText.startsWith("/")) return asText;
  return `/${asText}`;
}

function normalizeMethod(value) {
  const candidate = String(value || "GET")
    .trim()
    .toUpperCase();
  if (candidate === "POST" || candidate === "PUT" || candidate === "PATCH" || candidate === "DELETE" || candidate === "HEAD") {
    return candidate;
  }
  return "GET";
}

function sanitizeHeaders(input) {
  if (!isObject(input)) return {};
  const out = {};

  for (const [key, value] of Object.entries(input)) {
    if (typeof value !== "string") continue;
    const lower = key.toLowerCase();
    if (lower === "host" || lower === "content-length" || lower === "connection") continue;
    out[key] = value;
  }

  return out;
}

function hasHeader(headers, headerName) {
  const target = String(headerName || "").toLowerCase();
  return Object.keys(headers || {}).some((key) => key.toLowerCase() === target);
}

function extractErrorMessage(payload) {
  if (isObject(payload) && typeof payload.error === "string") {
    return payload.error;
  }
  if (typeof payload === "string") {
    return payload.slice(0, 500);
  }
  return "request failed";
}

async function safeParseJson(response) {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

function assertRegistrationShape(payload) {
  const requiredKeys = ["laptopId", "deviceId", "laptopToken", "pairCode", "pairingExpiresAt"];
  for (const key of requiredKeys) {
    if (!payload || payload[key] === undefined || payload[key] === null || payload[key] === "") {
      throw new Error(`register response missing "${key}"`);
    }
  }
}

function loadCompanionState() {
  try {
    if (!fs.existsSync(companionStateFile)) return null;
    const raw = JSON.parse(fs.readFileSync(companionStateFile, "utf8"));
    if (!isObject(raw)) return null;
    return {
      relayBaseUrl: trimTrailingSlash(raw.relayBaseUrl || ""),
      laptopId: safeText(raw.laptopId, 200),
      deviceId: safeText(raw.deviceId, 200),
      laptopToken: safeText(raw.laptopToken, 500),
      pairCode: safeText(raw.pairCode, 32) || null,
      pairingExpiresAt: raw.pairingExpiresAt ? toInt(raw.pairingExpiresAt, null) : null,
      pairingUrl: safeText(raw.pairingUrl, 2000) || null,
      updatedAt: raw.updatedAt ? toInt(raw.updatedAt, Date.now()) : Date.now()
    };
  } catch {
    return null;
  }
}

function persistCompanionState(next) {
  try {
    const payload = {
      relayBaseUrl: trimTrailingSlash(next?.relayBaseUrl || relayBaseUrl),
      laptopId: safeText(next?.laptopId, 200),
      deviceId: safeText(next?.deviceId, 200),
      laptopToken: safeText(next?.laptopToken, 500),
      pairCode: safeText(next?.pairCode, 32) || null,
      pairingExpiresAt: next?.pairingExpiresAt ? toInt(next.pairingExpiresAt, Date.now()) : null,
      pairingUrl: safeText(next?.pairingUrl, 2000) || null,
      wakeMac: wakeMacAddress || null,
      updatedAt: Date.now()
    };

    fs.mkdirSync(path.dirname(companionStateFile), { recursive: true });
    fs.writeFileSync(companionStateFile, JSON.stringify(payload, null, 2));
  } catch (error) {
    console.error(`[companion] failed to persist state: ${String(error?.message || error)}`);
  }
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal
    });
  } finally {
    clearTimeout(timer);
  }
}

function parseArgs(argsInput) {
  const out = {};

  for (let index = 0; index < argsInput.length; index += 1) {
    const arg = argsInput[index];
    if (!arg.startsWith("--")) continue;

    const key = arg.slice(2);
    const next = argsInput[index + 1];

    if (!next || next.startsWith("--")) {
      out[key] = "true";
      continue;
    }

    out[key] = next;
    index += 1;
  }

  return out;
}

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;

  if (!quietLogs) {
    console.log(`[companion] received ${signal}, shutting down`);
  }
  stopSnapshotLoop();

  if (websocket && websocket.readyState === WebSocket.OPEN) {
    websocket.close(1000, "shutdown");
  }

  if (bridgeStartedByCompanion && bridgeChild && bridgeChild.exitCode === null) {
    bridgeChild.kill("SIGTERM");
    setTimeout(() => {
      if (bridgeChild && bridgeChild.exitCode === null) {
        bridgeChild.kill("SIGKILL");
      }
    }, 1500).unref();
  }

  await sleep(100);
  process.exit(0);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
  return trimmed.length <= maxLength ? trimmed : trimmed.slice(0, maxLength);
}

function trimTrailingSlash(value) {
  const trimmed = String(value || "").trim();
  if (!trimmed) return "";
  return trimmed.replace(/\/+$/, "");
}

function detectPrimaryWakeMacAddress() {
  const interfaces = os.networkInterfaces();
  const preferredPrefix = [
    "en",
    "eth",
    "wlan",
    "wi-fi",
    "wifi",
    "wl",
    "thunderbolt"
  ];
  const candidates = [];

  for (const [ifaceName, entries] of Object.entries(interfaces || {})) {
    if (!Array.isArray(entries) || !entries.length) continue;
    const preferred = preferredPrefix.some((prefix) => ifaceName.toLowerCase().startsWith(prefix));

    for (const entry of entries) {
      if (!entry || entry.internal) continue;
      const normalizedMac = normalizeMacAddress(entry.mac);
      if (!normalizedMac) continue;
      candidates.push({
        ifaceName,
        normalizedMac,
        preferred
      });
      break;
    }
  }

  if (!candidates.length) return "";

  const preferredCandidate = candidates.find((item) => item.preferred);
  if (preferredCandidate) {
    return preferredCandidate.normalizedMac;
  }

  return candidates[0].normalizedMac;
}

function normalizeMacAddress(value) {
  const raw = String(value || "")
    .trim()
    .toUpperCase()
    .replace(/[^0-9A-F]/g, "");
  if (raw.length !== 12) return "";
  if (raw === "000000000000" || raw === "FFFFFFFFFFFF") return "";
  const chunks = raw.match(/.{1,2}/g);
  return chunks ? chunks.join(":") : "";
}
