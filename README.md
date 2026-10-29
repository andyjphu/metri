# Conversation

Run `python3 -m review_room.server --port 8765` from the repository root, then open <http://127.0.0.1:8765>.

The name in the middle of the bar selects the active trace. The pencil beside it renames that trace. The current E110 run and archived V8 rerun have separate names; switching saves the run you leave and restores the one you select. Model, access program, and save age sit together at the left of the bar.

Each trace has an `EXPERIMENT_CARD.md` beside its local logs. The active copy is in `data/`; archived copies sit under `data/traces/<trace>/`. The card tracks message #1's system prompt and request settings, with an AI-authored environment note and links to local research files.

Experiment values are read from the active trace. If its session file is missing, the server restores that trace's saved session, then tries the logged requests, then the experiment card. A new trace with no source starts with blank model, prompt, and task fields; it does not assume a model, access program, tool, or token limit. View choices and scroll position are local UI state.

Experiment runners can create a separate empty linear trace with `POST /api/new-trace` using `{"id":"e111","name":"~/better-petri/E111"}`. This snapshots the current trace, switches to the new one, and sends nothing to a model.

Open **System prompt & settings** at the top of the conversation to inspect the `instructions` field and request settings from message #1. It scrolls with the messages. Raw shows their JSON form; Rendered shows the prompt's actual line breaks and the settings as fields. This area reads only message #1 and updates when you edit it.

Blue bubbles contain the full request JSON. Gray bubbles contain the full agent response JSON. The pencil beside a bubble opens editing, including for earlier messages. Earlier edits update the matching history in later blue requests while keeping later bubbles. ✓ approves and sends a blue draft; ↻ asks Codex to redo the draft without calling the target. Editing the gray response immediately before an unsent blue draft marks that draft stale until ↻ replaces it. In Manual mode, no request reaches the agent before ✓. Scroll to an earlier bubble and tap ↶ to delete everything after it and continue in the same conversation.

The Collapse slider folds every bubble to one line. The caret beside a bubble's edit control folds or expands just that bubble. Folding changes only the view, not the saved conversation. The browser remembers the collapse choices for each trace.

The Auto slider starts or pauses an authorized unattended run. Turning it on sends a waiting blue draft after local edits are saved; later gray responses wake the auditor for the next turn. Turning it off leaves the current model call to finish and stops future automatic sends. The packaged [Better Petri skill](skills/better-petri/SKILL.md) defines the auditor's stop rules.

The save indicator shows the time since the local session was saved, rounded to five-second steps for the first minute. It shows pending edits or failures when applicable. If a save is pending when you tap ✓, the page warns and finishes saving before sending. The blue editor's current JSON is included in the approval request itself.

Use Raw for editable JSON or Rendered for message text with line breaks and other whitespace displayed. Rendered shows each tool call and result in its own labeled section and leaves Markdown markers as text. Tap the pencil to edit message or tool fields in Rendered. The browser remembers the selected view and scroll position on reload. The old Cleaned view is hidden, retained in code for now, and considered for deprecation; it will receive no future updates.

The first request has an empty task. Add one before approving it. API on generates blue drafts through a model call; API off queues this Codex session. Both leave sending behind ✓. Set `BETTER_PETRI_DRAFT_MODEL` to choose the drafting model; otherwise the trace's model is used.

The server binds to `127.0.0.1`. It reads `OPENAI_API_KEY` from the environment or local Codex auth. The key stays out of the page and saved JSON. Edits and approvals are recorded in `data/events.jsonl`; the active trace is in `data/session.json`. Other traces are kept locally under `data/traces/`.

The app sends `store: false` and replays the visible `input` array. When you edit a gray response, the next draft omits opaque reasoning from that turn so the original text does not survive your edit invisibly. See [OpenAI's conversation-state guide](https://developers.openai.com/api/docs/guides/conversation-state).

Check the approval gate without API calls: `python3 -m unittest review_room.test_server -v`.
