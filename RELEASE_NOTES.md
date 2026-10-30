# Metri 2.2.4

- Remove the duplicate ✓ from an unedited blue draft. + AI sends it to the evaluated model; + Manual accepts it for a locally authored response. ✓ remains available to confirm a text edit.
- Remove the green pending bubble shown during a target call. The top bar reports that the response is pending, and the completed gray bubble appears when it arrives.
- Show the divider inside an auditor exchange only while its pending controls are visible.

Validation: `python3 -m unittest metri.test_server`, `node --check app.js`, and `git diff --check`.

# Metri 2.2.3

- Green auditor exchanges now use the same hover controls as other bubbles, with a caret to collapse and a trash control to remove one exchange from the active view and future auditor context. Removal records the exchange in the event log; removing one during a pending draft cancels that draft and pauses automatic continuation.
- Name the agent that starts and iterates a run the chaperone in setup instructions and the Metri skill. Substantive auditor changes belong to that agent.
- Balance the settings panel's top and bottom padding.

Validation: `python3 -m unittest metri.test_server`, `node --check app.js`, and `git diff --check`.

# Metri 2.2.2

- Show pending auditor work inside the green bubble, below a subtle rule, with Cancel and Force API response controls. Other UI-only pending statuses are green too, so blue and gray message content remains the evaluated agent's exact request and response JSON.
- Force API response asks the API drafter to resolve remaining virtual-environment gaps and produce a blue draft. It never calls the evaluated agent; the blue draft still needs approval.
- Cancel closes an unanswered auditor question. Cancelled Agent generations remain invalid, and an auditor exchange stays visible when its later blue draft is deleted.

Validation: `python3 -m unittest metri.test_server` (42 tests), `node --check app.js`, and `git diff --check`.

# Metri 2.2.1

- Cancel a pending blue draft. The placeholder disappears, automatic continuation pauses, and a late API or agent result cannot restore the cancelled draft. The next draft can be started with + AI.
- Remember Agent/API draft mode per trace across reloads and trace switches; browser storage mirrors the trace's saved setting. Per-message collapse choices remain in browser storage, while model configuration remains in YAML.
- Balance the settings panel's bottom spacing and clarify when to contact your agent about a draft that has been pending for two minutes.
- Consolidate draft invalidation and older-trace setting defaults in the server.

Validation: `python3 -m unittest metri.test_server` (40 tests), `node --check app.js`, and `git diff --check`.

# Metri 2.2.0

- Remove a message and all later messages from the active conversation with the bubble's trash control. Metri archives the full pre-removal trace and pauses automatic continuation so you can choose the next message.
- Bookmarks stay with numbered message slots after removal. A replacement appears as the next version, such as `#11.2`, with the earlier version still available.
- Create a new blue request from the message-version picker. The manual composer has a styled template selector and warns about unanswered tool calls without blocking the draft.
- Rendered view shows a user message alongside tool results even when the user message precedes them in the request JSON. The rail has a compact color key, and error notices can be dismissed.

Validation: `python3 -m unittest metri.test_server` (38 tests), `node --check app.js`, and `git diff --check`.

# Metri 2.1.0

This release covers the Metri changes since the last tagged stable build, `v1.3-stable`. There was no separate 2.0 tag.

## What's new

- **Inspect and compare responses.** Blue and gray messages keep numbered versions. Confirmed manual edits become versions, and the picker can restore an earlier version or generate a new one with GPT-6 Sol or GLM-5.3. Gray regeneration uses that response's model settings and shows a pending provider response in place of the old bubble.
- **Control each turn.** Auto-approve and Auto-generate are independent settings. With generation off, add an AI or manual message on either side of the conversation. Manual blue messages wait for an explicit choice of gray response. Edits must be confirmed or discarded before the next send.
- **Find your place.** The conversation rail maps the actual heights of expanded and collapsed bubbles. Its line distinguishes tool work, chat, and mixed messages; a small set of clickable bookmarks marks important moments. Search within a single message, including its raw JSON.
- **Choose models and configure providers.** The model catalog supplies display names and slugs. Settings selects a default model for new traces. OpenRouter credentials can come from the server environment or a session-only key entered in the model dialog; agent setup instructions explain how to provide them without storing keys in traces.
- **Keep the audit visible.** API-drafter questions and auditor answers appear as green, auditor-only exchanges and remain available to later drafts. The full request and response JSON remains inspectable in Raw view.

The approval gate and message workflows are covered by the local test suite: `python3 -m unittest metri.test_server -v` from the parent directory.
