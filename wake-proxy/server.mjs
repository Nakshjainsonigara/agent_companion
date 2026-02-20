#!/usr/bin/env node
import cors from "cors";
import dgram from "node:dgram";
import express from "express";

const app = express();

const WAKE_PROXY_PORT = clamp(toInt(process.env.PORT || process.env.WAKE_PROXY_PORT, 9898), 1, 65535);
const WAKE_PROXY_TOKEN = safeText(process.env.WAKE_PROXY_TOKEN, 500);
const WAKE_BROADCAST_ADDRESS = safeText(process.env.WAKE_BROADCAST_ADDRESS, 120) || "255.255.255.255";
const WAKE_UDP_PORT = clamp(toInt(process.env.WAKE_UDP_PORT, 9), 1, 65535);
const WAKE_PACKET_REPEAT = clamp(toInt(process.env.WAKE_PACKET_REPEAT, 3), 1, 12);
const WAKE_PACKET_DELAY_MS = clamp(toInt(process.env.WAKE_PACKET_DELAY_MS, 120), 0, 5000);

app.use(cors());
app.use(express.json({ limit: "64kb" }));

app.get("/health", (_req, res) => {
  return res.json({
    ok: true,
    service: "wake-proxy",
    udpPort: WAKE_UDP_PORT,
    broadcastAddress: WAKE_BROADCAST_ADDRESS,
    tokenRequired: Boolean(WAKE_PROXY_TOKEN)
  });
});

app.post("/api/wake", async (req, res) => {
  if (WAKE_PROXY_TOKEN) {
    const authHeader = String(req.header("authorization") || "").trim();
    const bearer = authHeader.toLowerCase().startsWith("bearer ") ? authHeader.slice(7).trim() : "";
    const fromHeader = safeText(req.header("x-wake-proxy-token"), 500);
    const token = bearer || fromHeader;
    if (!token || token !== WAKE_PROXY_TOKEN) {
      return res.status(401).json({
        ok: false,
        error: "wake proxy token missing or invalid"
      });
    }
  }

  const macAddress = normalizeMacAddress(
    req.body?.macAddress || req.body?.wakeMac || req.body?.mac || req.body?.address
  );
  if (!macAddress) {
    return res.status(400).json({
      ok: false,
      error: "macAddress is required"
    });
  }

  try {
    await sendWakePacket(macAddress, {
      udpPort: WAKE_UDP_PORT,
      broadcastAddress: WAKE_BROADCAST_ADDRESS,
      repeat: WAKE_PACKET_REPEAT,
      delayMs: WAKE_PACKET_DELAY_MS
    });

    return res.json({
      ok: true,
      macAddress,
      sentAt: Date.now(),
      repeats: WAKE_PACKET_REPEAT
    });
  } catch (error) {
    return res.status(502).json({
      ok: false,
      error: String(error?.message || error)
    });
  }
});

app.listen(WAKE_PROXY_PORT, () => {
  console.log(`[wake-proxy] listening on http://localhost:${WAKE_PROXY_PORT}`);
  console.log(`[wake-proxy] udp target: ${WAKE_BROADCAST_ADDRESS}:${WAKE_UDP_PORT}`);
  if (WAKE_PROXY_TOKEN) {
    console.log("[wake-proxy] auth token: enabled");
  }
});

async function sendWakePacket(macAddress, options) {
  const macBytes = macAddress.split(":").map((part) => Number.parseInt(part, 16));
  if (macBytes.length !== 6 || macBytes.some((item) => !Number.isFinite(item))) {
    throw new Error("invalid MAC address");
  }

  const packet = Buffer.alloc(6 + 16 * 6, 0xff);
  for (let i = 0; i < 16; i += 1) {
    for (let j = 0; j < 6; j += 1) {
      packet[6 + i * 6 + j] = macBytes[j];
    }
  }

  const socket = dgram.createSocket("udp4");

  try {
    await new Promise((resolve, reject) => {
      socket.once("error", reject);
      socket.bind(0, () => {
        try {
          socket.setBroadcast(true);
          resolve();
        } catch (error) {
          reject(error);
        }
      });
    });

    for (let attempt = 0; attempt < options.repeat; attempt += 1) {
      await new Promise((resolve, reject) => {
        socket.send(packet, 0, packet.length, options.udpPort, options.broadcastAddress, (error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });

      if (attempt < options.repeat - 1 && options.delayMs > 0) {
        await sleep(options.delayMs);
      }
    }
  } finally {
    socket.close();
  }
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

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
