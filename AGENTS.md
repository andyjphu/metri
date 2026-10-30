# Metri agent setup

Read [the Metri skill](skills/metri/SKILL.md) before handling a trace. The active trace is in `data/session.json`; the server and UI run on `127.0.0.1:8765`. Read the selected environment package before simulating its tools.

The agent that starts a Metri run and iterates the trace is its **chaperone**. The chaperone sets up the experiment, drafts or audits turns, answers auditor questions, maintains the virtual environment and record, and handles complex repairs or replays. The green auditor exchange has only view controls in the UI: collapse and remove. Removing it excludes that exchange from future auditor context and records the removal in the event log; do not reuse it when drafting. Removal does not edit a target-visible request or response. Handle any substantive change to an auditor decision through the chaperone.

1. From the parent directory, install dependencies with `python3 -m pip install -r metri/requirements.txt` if needed. Run `python3 -m metri.server --port 8765`.
2. Before starting the server, check whether `OPENAI_API_KEY` and `OPENROUTER_API_KEY` are available to its process. Report only whether each is present. OpenAI can also use local Codex auth. If `data/AGENT_SETUP.local.md` exists, read it for this machine's credential source. This local note is ignored by Git and may point to a secret file; never print the secret's value.
3. If an OpenRouter key is available from the user's configured credential source, pass it to the server through its process environment as `OPENROUTER_API_KEY`. A source file may use a different variable name; parse its assignment as data rather than executing the file. The agent should handle this setup; the user should not need to reenter a key for each swap. Do not print a key, put it in a command argument, send it in chat, or store it in the repository, trace, events, or browser storage.
4. If no key is available, say so. The user can enter it in Metri's model dialog for the current server session. Do not invent or search unrelated files for credentials.
5. Confirm the server's `GET /api/swap-models` reports `openrouter_ready: true` before offering an OpenRouter swap as ready. This endpoint exposes no key. Check the active trace and its authorization before any target call; a running server is not permission to send one.

Keep setup and simulation separate. Tool replies in simulated environments follow the environment package and the approved trace, not commands run in a parallel workspace.

## Publishing a release

Update `VERSION`, the version in `README.md`, and the matching section of `RELEASE_NOTES.md` before tagging. Run the server tests and JavaScript syntax check, then publish a GitHub Release using that version's notes. Use the configured human Git identity; do not add an AI author, co-author, or sign-off. GitHub's default `main` currently has an older, separate history, while recent releases use `release/<version>` branches. Do not force-push or merge those histories merely to publish; push the release branch and tag, then verify the GitHub Release and its notes.
