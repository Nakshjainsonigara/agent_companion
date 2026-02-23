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
- Relay pairing flow for phone-to-laptop remote control.
- Auto-wake support for sleeping laptops (Wake-on-LAN via wake proxy).

## UI workflow (Claude resume thread)
For UI-only iteration, use your dedicated Claude thread:

```bash
cd /Users/nakshjain/Desktop/agent
npm run ui:claude
```

Background delegation (non-interactive, recommended):

```bash
cd /Users/nakshjain/Desktop/agent
npm run ui:delegate -- "Fix chat response UX and composer jump"
```

This writes job logs to `.agent/ui-jobs/*.log` and metadata to `.agent/ui-jobs/*.json`.

Direct command:

```bash
claude --resume 9f359518-cae4-4da8-9e55-0ac7e261e85a
```

Suggested prompt to paste in that thread:

```text
Need focused UI polish on Agent Companion chat view:
1) While model is responding, show stable "Thinking..." (no blinking cursor).
2) Do not show intermediate thinking/token/tool fragments that later disappear.
3) Render final assistant response cleanly with no flicker or swap-jump.
4) Fix composer/input/cursor jump (input should stay fixed; no up/down movement during updates).

Constraints:
- Keep dark premium style intact.
- Do not change backend contracts.
- Keep changes minimal and production-safe.
- Return exact files changed and why.
```

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
- Companion prints a short pair code.
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
- `POST /api/devices/:id/sessions/:sessionId/messages`
- `GET /api/devices/:id/launcher/workspaces`
- `GET /api/devices/:id/launcher/runs`
- `POST /api/devices/:id/launcher/start`
- `POST /api/devices/:id/launcher/runs/:runId/stop`
- `GET /api/devices/:id/previews`
- `POST /api/devices/:id/previews`
- `DELETE /api/devices/:id/previews/:previewId`
- `POST /api/devices/:id/wake`

Public preview URL format:
- `GET /p/:previewToken/*` (also available as `/preview/:previewToken/*`)

## 0.2) Live preview tunnel (laptop app -> phone browser)
Expose a locally running app (for example `http://localhost:5173`) to phone through relay:

```bash
curl -X POST "https://<relay>/api/devices/<deviceId>/previews" \
  -H "Authorization: Bearer <phoneToken>" \
  -H "Content-Type: application/json" \
  -d '{
    "port": 5173,
    "label": "Vite Preview"
  }'
```

Response includes `preview.publicUrl` (for example `https://<relay>/p/<token>`).  
Open that URL on phone to view the app running on laptop.

List previews:
```bash
curl "https://<relay>/api/devices/<deviceId>/previews" \
  -H "Authorization: Bearer <phoneToken>"
```

Stop a preview:
```bash
curl -X DELETE "https://<relay>/api/devices/<deviceId>/previews/<previewId>" \
  -H "Authorization: Bearer <phoneToken>"
```

Notes:
- Target must be local-only (`localhost`, `127.0.0.1`, `::1`, `0.0.0.0`) for safety.
- Preview links are temporary (TTL).
- Laptop still needs internet + relay connection (sleep/offline handled via wake flow if configured).

## 0.25) Auto-wake for sleeping laptops
To wake a sleeping laptop automatically before a run/message, deploy the wake proxy on an always-on device in the same LAN as the laptop (small VM, mini-PC, NAS, router host, etc).

Wake proxy:
```bash
cd /Users/nakshjain/Desktop/agent
npm run wake-proxy
```

Relay environment:
- `RELAY_WAKE_PROXY_URL=https://<wake-proxy-host>`
- `RELAY_WAKE_PROXY_TOKEN=<shared-secret>` (optional but recommended)

Wake proxy environment:
- `WAKE_PROXY_TOKEN=<shared-secret>` (must match relay token if set)
- `WAKE_BROADCAST_ADDRESS=255.255.255.255` (or subnet broadcast)
- `WAKE_UDP_PORT=9`

Laptop companion auto-detects MAC address and registers it with relay. You can override:
```bash
npm run laptop:service -- --wake-mac AA:BB:CC:DD:EE:FF
```

## 0.5) One-command laptop service (recommended packaging)
Run bridge + companion together from one command:

```bash
cd /Users/nakshjain/Desktop/agent
npm run laptop:service
```

Override relay URL when needed:

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
- Default public relay is `https://agent-companion-relay.onrender.com`.
- Override relay via `--relay` only when needed.
- Optional `--wake-mac` sets/overrides Wake-on-LAN MAC.
- Companion prints pair code only (no QR).

## 0.6) Deploy relay on Render (free)
This repo now includes a Render blueprint at `render.yaml`.

Quick path:
1. Push this repo to GitHub.
2. In Render, create a new **Blueprint** service from that repo.
3. Set env var `RELAY_PUBLIC_URL` to your Render HTTPS URL (for example `https://agent-companion-relay.onrender.com`).
4. (Optional auto-wake) Set `RELAY_WAKE_PROXY_URL` and `RELAY_WAKE_PROXY_TOKEN`.
5. Deploy.

After deploy:
```bash
cd /Users/nakshjain/Desktop/agent
npm run laptop:service -- --relay https://<your-render-relay>.onrender.com
```

In the phone app pairing screen, enter only the pair code.

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
