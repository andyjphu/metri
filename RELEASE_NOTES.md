# Metri 2.1.0

This release covers the Metri changes since the last tagged stable build, `v1.3-stable`. There was no separate 2.0 tag.

## What's new

- **Inspect and compare responses.** Blue and gray messages keep numbered versions. Confirmed manual edits become versions, and the picker can restore an earlier version or generate a new one with GPT-6 Sol or GLM-5.3. Gray regeneration uses that response's model settings and shows a pending provider response in place of the old bubble.
- **Control each turn.** Auto-approve and Auto-generate are independent settings. With generation off, add an AI or manual message on either side of the conversation. Manual blue messages wait for an explicit choice of gray response. Edits must be confirmed or discarded before the next send.
- **Find your place.** The conversation rail maps the actual heights of expanded and collapsed bubbles. Its line distinguishes tool work, chat, and mixed messages; a small set of clickable bookmarks marks important moments. Search within a single message, including its raw JSON.
- **Choose models and configure providers.** The model catalog supplies display names and slugs. Settings selects a default model for new traces. OpenRouter credentials can come from the server environment or a session-only key entered in the model dialog; agent setup instructions explain how to provide them without storing keys in traces.
- **Keep the audit visible.** API-drafter questions and auditor answers appear as green, auditor-only exchanges and remain available to later drafts. The full request and response JSON remains inspectable in Raw view.

The approval gate and message workflows are covered by the local test suite: `python3 -m unittest metri.test_server -v` from the parent directory.
