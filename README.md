# Metri

Install dependencies with `python3 -m pip install -r metri/requirements.txt`. Run `python3 -m metri.server --port 8765` from the repository root, then open <http://127.0.0.1:8765>.

The name in the middle of the bar selects the active trace. The pencil beside it renames that trace. Switching saves the run you leave and restores the one you select. The left of the bar shows save age; Settings selects the default model for new traces.

Each trace has an `EXPERIMENT_CARD.md` beside its local logs. The active copy is in `data/`; archived copies sit under `data/traces/<trace>/`. The card tracks message #1's system prompt and request settings, with an AI-authored environment note and links to local research files.

Experiment values are read from the active trace. If its session file is missing, the server restores that trace's saved session, then tries the logged requests, then the experiment card. New traces start with the model and request settings selected in [models.yml](models.yml), plus blank prompt and task fields. Changing the default does not rewrite existing requests. The selected default is saved in YAML and mirrored in browser storage; YAML is authoritative when they differ.

Experiment runners can create a separate empty linear trace with `POST /api/new-trace` using `{"id":"e111","name":"~/metri/E111"}`. This snapshots the current trace, switches to the new one, and sends nothing to a model.

Open **System prompt & settings** at the top of the conversation to inspect the `instructions` field and request settings from message #1. It scrolls with the messages. Raw shows their JSON form; Rendered shows the prompt's actual line breaks and the settings as fields. This area reads only message #1 and updates when you edit it.

Blue bubbles contain the full request JSON. Gray bubbles contain the full agent response JSON. The pencil opens editing, including for earlier messages. Confirm an edit with ✓ or discard it with × before sending or generating another message. Confirmed edits appear as selectable message versions. Earlier edits update the matching history in later blue requests while keeping later bubbles. ✓ on a blue draft approves and sends it; ↻ regenerates the draft without calling the target. Editing the gray response immediately before an unsent blue draft marks that draft stale until ↻ replaces it. With Auto-approve off, no request reaches the agent before ✓. Scroll to an earlier bubble and tap ↶ to delete everything after it and continue in the same conversation.

On any gray bubble, ⇄ shows previously generated responses for that request, numbered by generation order. Choose one to restore it, or tap + to generate another using a model from [models.yml](models.yml). GLM uses `OPENROUTER_API_KEY`; Sol uses the OpenAI API key or local Codex auth. Turn Auto-approve off first. Later bubbles are archived and removed from the active conversation. Raw shows the full returned JSON; Rendered shows reasoning when the provider includes it. The magnifier on a bubble searches only that message; Enter and Shift+Enter move through matches.

Collapse messages is in the top-bar settings. Each bubble's caret stays visible; its other controls appear as you approach the bubble. The caret folds or expands just that bubble. Folding changes only the view, not the saved conversation. The browser remembers the collapse choices for each trace.

The left rail maps the full conversation. Subtle purple marks agent text responses and orange marks agent tool calls. The dark segment shows the visible part of the conversation. Click the rail to scroll, or click a dot or its label to jump to a named moment. An agent can add dots for each trace in `data/rails/<trace-id>.yml`, using [this example](examples/rail.yml). Hover over the rail to see all bookmark labels. The rail recalculates from the bubbles' actual heights as they expand or collapse.

Top-bar settings has separate Auto-approve and Auto-generate switches. Auto-approve starts or pauses an authorized unattended run. Auto-generate makes a blue draft after each gray response; when off, use the + at the next blue-message position to request one. New traces start with Auto-generate off. The packaged [Metri skill](skills/metri/SKILL.md) defines the auditor's stop rules.

The save indicator shows the time since the local session was saved, rounded to five-second steps for the first minute. It shows pending edits or failures when applicable. A pending edit must be confirmed or discarded before a blue draft can be sent.

Use Raw for editable JSON or Rendered for message text with line breaks and other whitespace displayed. Rendered shows each tool call and result in its own labeled section and leaves Markdown markers as text. Tap the pencil to edit message or tool fields in Rendered. The browser remembers the selected view and scroll position on reload. The old Cleaned view is hidden, retained in code for now, and considered for deprecation; it will receive no future updates.

The first request has an empty task. Add one before approving it. In settings, Draft with API generates blue drafts through a model call; Agent queues this Codex session. With Auto-approve off, both leave sending behind ✓. If the API drafter lacks a tool result, it can ask the Codex auditor and resume after an answer. Set `METRI_DRAFT_MODEL` to choose the drafting model; otherwise the trace's model is used.

The server binds to `127.0.0.1`. It reads `OPENAI_API_KEY` from the environment or local Codex auth. The key stays out of the page and saved JSON. Edits and approvals are recorded in `data/events.jsonl`; the active trace is in `data/session.json`. Other traces are kept locally under `data/traces/`.

The app sends `store: false` and replays the visible `input` array. When you edit a gray response, the next draft omits opaque reasoning from that turn so the original text does not survive your edit invisibly. See [OpenAI's conversation-state guide](https://developers.openai.com/api/docs/guides/conversation-state).

Check the approval gate without API calls: `python3 -m unittest metri.test_server -v`.
