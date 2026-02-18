# Agent Companion (PWA)

Premium dark **web/PWA** for monitoring Codex + Claude Code sessions from phone.

## Included
- Live status for Codex + Claude Code sessions.
- Session states: `RUNNING`, `WAITING_INPUT`, `COMPLETED`, `FAILED`, `CANCELLED`.
- Pending input actions: `Approve`, `Reject`, `Text Reply`.
- Timeline and token stats (total + per-agent).
- Bridge mode for real laptop sessions.
- Direct monitoring of local Codex and Claude Code history files (no wrapper required).
- Phone-triggered local task launcher (no GitHub required).
- Relay + QR pairing flow for phone-to-laptop remote control.

## 0) Full remote pairing flow (phone + laptop)
This is the end-to-end path when users are not on the same local network.

Terminal A (relay):
```bash
cd /Users/nakshjain/Desktop/agent
npm install
npm run relay
```

Terminal B (laptop companion):
```bash
cd /Users/nakshjain/Desktop/agent
npm run laptop:companion -- --relay http://localhost:9797 --bridge http://localhost:8787
```

What happens:
- Companion registers laptop with relay.
- Companion prints a short pair code + QR.
- Phone app claims pair code via relay.
- Relay stores phone token and proxies requests to connected laptop bridge.

Useful relay endpoints:
```bash
curl http://localhost:9797/health
curl http://localhost:9797/pair?code=<PAIR_CODE>
```

Phone-side API contract (with `Authorization: Bearer <phoneToken>`):
- `GET /api/devices/:id/status`
- `GET /api/devices/:id/bootstrap`
- `POST /api/devices/:id/actions`
- `GET /api/devices/:id/launcher/workspaces`
- `GET /api/devices/:id/launcher/runs`
- `POST /api/devices/:id/launcher/start`
- `POST /api/devices/:id/launcher/runs/:runId/stop`

## 0.5) One-command laptop service (recommended packaging)
Run bridge + companion together from one command:

```bash
cd /Users/nakshjain/Desktop/agent
npm run laptop:service -- --relay https://<your-public-relay-url>
```

All-in-one local test mode (starts relay too):

```bash
cd /Users/nakshjain/Desktop/agent
npm run laptop:service -- --with-local-relay
```

Notes:
- `--with-local-relay` is for local/dev only unless you expose relay publicly.
- For internet pairing, pass a public relay URL via `--relay`.
- The companion still prints pair code + QR in both modes.

## 0.6) Deploy relay on Render (free)
This repo now includes a Render blueprint at `render.yaml`.

Quick path:
1. Push this repo to GitHub.
2. In Render, create a new **Blueprint** service from that repo.
3. Set env var `RELAY_PUBLIC_URL` to your Render HTTPS URL (for example `https://agent-companion-relay.onrender.com`).
4. Deploy.

After deploy:
```bash
cd /Users/nakshjain/Desktop/agent
npm run laptop:service -- --relay https://<your-render-relay>.onrender.com
```

In the phone app pairing screen, use the same relay URL.

Note: Render free tier can sleep when idle; first request/pair may take a short warm-up.

## 1) Start the app + local bridge
Open two terminals:

Terminal A (bridge API)
```bash
cd /Users/nakshjain/Desktop/agent
npm install
npm run bridge
```

Terminal B (web app)
```bash
cd /Users/nakshjain/Desktop/agent
npm run dev -- --host 0.0.0.0 --port 5173
```

On your laptop open: [http://localhost:5173](http://localhost:5173)

On your phone (same Wi-Fi) open: `http://<your-laptop-ip>:5173`

One-command alternative:
```bash
cd /Users/nakshjain/Desktop/agent
npm install
npm run stack:start
```

## 2) Use Codex/Claude directly (recommended)
With bridge running, direct CLI sessions are auto-ingested from local history:

```bash
# direct Codex
codex exec "Implement feature X"

# direct Claude Code
claude -p "Implement feature Y"
```

These will appear in the app automatically.

## 3) Launch local workspace tasks from phone/API (no GitHub)
The bridge can start agent runs directly on your laptop workspace via REST.

Discover candidate workspaces:
```bash
curl http://localhost:8787/api/launcher/workspaces
```

Start a Codex task in a local folder:
```bash
curl -X POST http://localhost:8787/api/launcher/start \\
  -H 'Content-Type: application/json' \\
  -d '{
    "agentType":"CODEX",
    "workspacePath":"/absolute/path/to/local/project",
    "title":"Phone task",
    "prompt":"Implement auth middleware and tests"
  }'
```

Optional CLI helper:
```bash
cd /Users/nakshjain/Desktop/agent
npm run task:start -- --agent CODEX --workspace /absolute/path/to/local/project --prompt "Implement auth middleware and tests"
```

Track runs:
```bash
curl http://localhost:8787/api/launcher/runs
```

For Codex runs, the bridge timeline now records a resume hint like:
```bash
codex exec resume <thread-id>
```
Use that on your laptop to continue the same Codex thread later.

Launcher-created Codex runs are also promoted to CLI resume metadata so they appear in the Codex `/resume` picker.
This promotion is applied after run completion with atomic file writes for safety.

Optional controls:
- `AGENT_ENABLE_CODEX_RESUME_PROMOTION=false` to disable rollout metadata promotion.
- `AGENT_ENABLE_CODEX_THREAD_INDEX=false` to disable thread title indexing in `~/.codex/.codex-global-state.json`.

If your task was launched in another workspace, use:
```bash
codex resume --all
```
The default `codex resume` picker is workspace-scoped.

Backfill repair for older launcher sessions:
```bash
cd /Users/nakshjain/Desktop/agent
npm run resume:repair
```

Stop a run:
```bash
curl -X POST http://localhost:8787/api/launcher/runs/<run-id>/stop
```

If you set `AGENT_BRIDGE_TOKEN`, include header `x-bridge-token` on `/api/launcher/*` calls.
You can also lock workspaces with:
- `AGENT_BRIDGE_ALLOW_ANY_WORKSPACE=false`
- `AGENT_BRIDGE_WORKSPACE_ROOTS=/path/one,/path/two`

## 4) Optional wrapper mode
You can still run via wrapper for explicit session IDs and custom metadata.

Codex example:
```bash
cd /Users/nakshjain/Desktop/agent
npm run run:agent -- --agent CODEX --title "Fix auth middleware" -- codex exec "Fix auth middleware"
```

Claude Code example:
```bash
cd /Users/nakshjain/Desktop/agent
npm run run:agent -- --agent CLAUDE --title "Improve retry logic" -- claude -p "Improve retry logic"
```

When the command runs, the session appears in the PWA. When it exits, state updates to completed/failed.
If you type `codex run ...`, the wrapper auto-converts it to `codex exec ...`.
For Codex commands, the wrapper also injects `--skip-git-repo-check` automatically.

## 5) Test pending input flow
```bash
cd /Users/nakshjain/Desktop/agent
npm run pending:add -- --session s_codex_live_01 --priority HIGH --prompt "Approve migration plan?"
```

Then use `Approve`, `Reject`, or `Text Reply` in the phone UI.

## Useful commands
```bash
npm run bridge:reset   # reset bridge to default sample sessions
npm run build          # production build
npm run preview        # preview production build
```

## Notes
- Bridge mode is local-first (`http://localhost:8787` by default).
- The app can still run in mock mode (toggle in Settings).
- Token stats are exact only if your CLI output includes token values; otherwise they remain estimated/last-known.
- Relay defaults to `http://localhost:9797`; set `RELAY_PUBLIC_URL` when hosting remotely.
- Companion persists laptop identity at `~/.agent-companion/companion.json` (override with `AGENT_COMPANION_STATE_FILE`).
- Protect bridge launcher routes with `AGENT_BRIDGE_TOKEN` and send `x-bridge-token` from trusted callers.
