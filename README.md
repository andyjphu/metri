# Conversation

Run `python3 -m review_room.server --port 8765` from the repository root, then open <http://127.0.0.1:8765>.

The name in the middle of the bar selects the active trace. The pencil beside it renames that trace. The current E110 run and archived V8 rerun have separate names; switching saves the run you leave and restores the one you select. Model, access program, and save age sit together at the left of the bar.

Open **System prompt & settings** above the divider to inspect the `instructions` field and request settings from message #1. Raw shows their JSON form; Rendered shows the prompt's actual line breaks and the settings as fields. This area reads only message #1 and updates when you edit it.

Blue bubbles contain the full request JSON. Gray bubbles contain the full agent response JSON. The pencil beside a bubble opens editing, including for earlier messages. Earlier edits update the matching history in later blue requests while keeping later bubbles. ✓ approves and sends a blue draft; ↻ asks Codex to redo the draft without calling the target. Editing the gray response immediately before an unsent blue draft marks that draft stale until ↻ replaces it. In Manual mode, no request reaches the agent before ✓. Scroll to an earlier bubble and tap ↶ to delete everything after it and continue in the same conversation.

The Collapse slider folds every bubble to one line. The caret beside a bubble's edit control folds or expands just that bubble. Folding changes only the view, not the saved conversation.

For an unattended run, ask the auditor to use autonomous mode. Its setting and the harness calls are in the packaged [Better Petri skill](skills/better-petri/SKILL.md); there is no Auto control in the page.

The save indicator shows the time since the local session was saved, rounded to five-second steps for the first minute. It shows pending edits or failures when applicable. If a save is pending when you tap ✓, the page warns and finishes saving before sending. The blue editor's current JSON is included in the approval request itself.

Use Raw for editable JSON or Rendered for message text with line breaks and other whitespace displayed. Rendered shows each tool call and result in its own labeled section and leaves Markdown markers as text. Tap the pencil to edit message or tool fields in Rendered. Switching views keeps the current message selected. The old Cleaned view is hidden, retained in code for now, and considered for deprecation; it will receive no future updates.

The first request has an empty task. Add one before approving it. After the agent responds, the server queues this Codex thread to write the next blue draft. Queue delivery is best-effort; if no draft appears, return to this chat. No separate auditor model runs in the app.

The server binds to `127.0.0.1`. It reads `OPENAI_API_KEY` from the environment or local Codex auth. The key stays out of the page and saved JSON. Edits and approvals are recorded in `data/events.jsonl`; the active trace is in `data/session.json`. Other traces are kept locally under `data/traces/`.

The app sends `store: false` and replays the visible `input` array. When you edit a gray response, the next draft omits opaque reasoning from that turn so the original text does not survive your edit invisibly. See [OpenAI's conversation-state guide](https://developers.openai.com/api/docs/guides/conversation-state).

Check the approval gate without API calls: `python3 -m unittest review_room.test_server -v`.
