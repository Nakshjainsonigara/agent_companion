#!/usr/bin/env node
import process from "node:process";

const bridge = process.env.AGENT_BRIDGE_URL || "http://localhost:8787";

const response = await fetch(`${bridge}/api/reset`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json"
  },
  body: JSON.stringify({})
});

if (!response.ok) {
  console.error(await response.text());
  process.exit(1);
}

console.log("Bridge state reset to defaults.");
