# AGENTS Instructions (Project Local)

## UI Workflow (Use Claude Resume Thread)
- For UI/UX changes in this project, prefer using the dedicated Claude thread first.
- Resume command:
  - `claude --resume 9f359518-cae4-4da8-9e55-0ac7e261e85a`
- Delegated background command (preferred for this repo):
  - `npm run ui:delegate -- "<UI task prompt>"`
- If tool/permission prompts appear in Claude, approve them for the requested UI task.
- Unless explicitly asked, do not directly implement major UI redesigns from Codex in this repo.
- Do not ask the user to run the UI Claude step manually when the request is clear.
  Run the delegate command directly, then report job id + log path.

## Current UI Issues To Include In Prompt
- Replace blinking cursor while model is responding with a stable `Thinking...` state.
- Do not render intermediate thinking/tool-token fragments that later disappear.
- Keep response rendering stable: show final assistant response cleanly without flicker.
- Fix composer/input jump: input and cursor should not move up/down during polling/stream updates.
