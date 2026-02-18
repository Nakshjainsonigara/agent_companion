#!/usr/bin/env node
import process from "node:process";

const args = process.argv.slice(2);
const options = parseOptions(args);

const sessionId = options.session;
const prompt = options.prompt;
const priority = options.priority || "MEDIUM";
const bridge = options.bridge || process.env.AGENT_BRIDGE_URL || "http://localhost:8787";

if (!sessionId || !prompt) {
  console.log("Usage: node scripts/add-pending.mjs --session <id> --prompt \"message\" [--priority HIGH|MEDIUM|LOW]");
  process.exit(1);
}

const response = await fetch(`${bridge}/api/pending/add`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json"
  },
  body: JSON.stringify({ sessionId, prompt, priority, requestedAt: Date.now() })
});

if (!response.ok) {
  console.error(await response.text());
  process.exit(1);
}

console.log(`Pending input pushed for session ${sessionId}`);

function parseOptions(values) {
  const out = {};

  for (let i = 0; i < values.length; i += 1) {
    const current = values[i];
    if (!current.startsWith("--")) continue;

    const key = current.slice(2);
    const next = values[i + 1];
    if (!next || next.startsWith("--")) {
      out[key] = "true";
      continue;
    }

    out[key] = next;
    i += 1;
  }

  return out;
}
