# Better Petri agent guide

The human README is [README.md](README.md). The reusable agent instructions are in [skills/better-petri/SKILL.md](skills/better-petri/SKILL.md). This file gives setup and API details for agents running without Codex-specific packages.

The app uses only Python's standard library and browser JavaScript. Run `python3 -m review_room.server --port 8765` from the repository root. `OPENAI_API_KEY` is required only when a blue request is approved. `BETTER_PETRI_MODEL` seeds the first request; if absent, the human can enter a model in Raw view. The server listens on `127.0.0.1`. `CODEX_THREAD_ID` is optional and used only for `codex queue` notifications. Another agent can work by reading the session and using the HTTP endpoint below.

The active state is `review_room/data/session.json`. `review_room/data/events.jsonl` records edits and approvals. Both contain complete conversation data and are gitignored. Do not commit or publish them. The app does not execute the model's tool calls. Any tool output you add is either measured elsewhere or authored simulation, and you must tell the human which.

When a new gray response arrives, read the latest state and relevant events. The last approved blue request and latest gray response are authoritative. Compose a complete Responses API request, including the prior approved `input`, the latest gray `output`, and your proposed `function_call_output` items or user message. If the gray bubble was edited, omit opaque reasoning from its replay. The server checks that the approved history and current gray output are present in the new request.

Post the draft locally:

```http
POST http://127.0.0.1:8765/api/codex-draft
Content-Type: application/json

{"request": {"model": "...", "input": ["..."], "store": false}}
```

The example shows the shape, not a complete request. Preserve the actual request's settings and tools. This POST creates a blue draft and makes no model call. Do not call `/api/approve`; the human approves in the UI. The current blue editor JSON is sent on approval, after pending edits are saved. A stale draft must be refreshed. If the gray response already completes the user's final task or exit interview, report that to the human and do not invent another turn.

The app sends `store: false` and uses the visible `input` array rather than hidden conversation chaining. Edits to earlier bubbles are rebased into later blue requests; later gray responses remain recorded results and may need semantic review. ↶ deletes later bubbles in the single conversation.

Run `python3 -m unittest review_room.test_server -v` from the repository root to check the approval and edit boundary without an API call.
