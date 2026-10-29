# Metri

A local conversation room for reviewing a model's full requests and responses. Edit either side of the conversation. Every outgoing request waits for your ✓ before it reaches the model.

![Metri conversation overview](images/overview.png)

## Start

You need Python 3.10+, a browser, an OpenAI API key, and access to a model. No packages or build step are needed.

```sh
export OPENAI_API_KEY='your-key'
python3 -m metri.server --port 8765
```

Open <http://127.0.0.1:8765>. The first blue bubble needs a model and task. You can edit its full request in Raw view before sending. The app saves the conversation locally in `metri/data/`; that directory is excluded from git.

Use Raw to edit the full JSON or Rendered to read and edit message text. The pencil opens fields for editing. ✓ sends a blue draft, ↻ asks for a fresh draft, and ↶ returns to an earlier message. Tool results are supplied by you or your agent; this app does not run tools.

An agent prepares each next blue draft. The included [Metri skill](metri/skills/metri/SKILL.md) tells an agent how. Codex users can copy that skill folder into `~/.codex/skills/`; other agents can read the file directly. If your agent does not receive automatic notifications, point it to [AGENTS.md](AGENTS.md) for the manual drafting steps.

To replace the current gray response with GLM 5.3 and view its reasoning, set `OPENROUTER_API_KEY` before starting the server, turn Auto off, and use ⇄ on that bubble. The new response does not change what the original model sent; the original is retained in the local event log.

## Screenshots

An agent's debrief after a run:

![Gray agent response and pending blue draft](images/debrief.png)

Following up on an earlier message:

![Follow-up question and agent response](images/follow-up.png)

Editing an earlier agent message and tool call:

![Editable agent message and write_file arguments](images/edit-response.png)

Editing tool results before approval:

![Editable blue tool results](images/edit-tool-results.png)
