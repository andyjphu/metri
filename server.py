"""Local, approval-gated Responses API conversation room."""

from __future__ import annotations

import hashlib
import json
import os
import copy
import re
import shutil
import subprocess
import threading
import urllib.error
import urllib.request
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse


HERE = Path(__file__).resolve().parent
DATA = HERE / "data"
STATE_FILE = DATA / "session.json"
EVENTS_FILE = DATA / "events.jsonl"
LOCK = threading.RLock()
API_URL = "https://api.openai.com/v1/responses"
CODEX_THREAD_ID = os.environ.get("REVIEW_ROOM_CODEX_THREAD_ID") or os.environ.get("CODEX_THREAD_ID")


def now():
    return datetime.now(timezone.utc).isoformat()


def dump(value):
    return json.dumps(value, ensure_ascii=False, indent=2)


def sha(text):
    return hashlib.sha256(text.encode()).hexdigest()


def save_state(state):
    DATA.mkdir(parents=True, exist_ok=True)
    tmp = STATE_FILE.with_suffix(".tmp")
    tmp.write_text(dump(state) + "\n")
    os.replace(tmp, STATE_FILE)
    sync_active_experiment_card(state)


def event(kind, **details):
    DATA.mkdir(parents=True, exist_ok=True)
    with EVENTS_FILE.open("a") as out:
        out.write(json.dumps({"at": now(), "kind": kind, **details}, ensure_ascii=False) + "\n")


def card_section(card, heading):
    """Read one fenced value from our generated experiment card."""
    marker = f"## {heading}\n"
    if marker not in card:
        return None
    lines = card.split(marker, 1)[1].splitlines()
    for index, line in enumerate(lines):
        if re.fullmatch(r"`{3,}(?:json|text)?", line):
            fence = line[:len(line) - len(line.lstrip("`"))]
            try:
                end = lines.index(fence, index + 1)
            except ValueError:
                return None
            return "\n".join(lines[index + 1:end])
        if line.startswith("## "):
            break
    return None


def request_from_card(path):
    if not path.is_file():
        return None
    card = path.read_text()
    settings_text = card_section(card, "Request settings")
    if settings_text is None:
        return None
    try:
        settings = json.loads(settings_text)
    except (ValueError, TypeError):
        return None
    if not isinstance(settings, dict):
        return None
    prompt = card_section(card, "System prompt")
    request = {**settings, "instructions": prompt or "", "input": [{"role": "user", "content": ""}]}
    request["store"] = False
    return request


def request_from_events(path):
    if not path.is_file():
        return None
    for line in reversed(path.read_text().splitlines()):
        try:
            event_data = json.loads(line)
        except ValueError:
            continue
        request = event_data.get("exact_request")
        if isinstance(request, dict) and isinstance(request.get("input"), list):
            return copy.deepcopy(request)
    return None


def blank_request():
    return {"model": "", "instructions": "", "input": [{"role": "user", "content": ""}], "store": False}


def default_request():
    """Recover experiment details from logs, then the card; otherwise leave them blank."""
    from_events = request_from_events(EVENTS_FILE)
    if from_events:
        request = {key: value for key, value in from_events.items()
                   if key not in {"input", "previous_response_id", "conversation"}}
        request["input"] = [{"role": "user", "content": ""}]
        request["store"] = False
        return request
    from_card = request_from_card(DATA / "EXPERIMENT_CARD.md")
    if from_card:
        return from_card
    return blank_request()


def make_entry(state, side, value, status):
    entry = {
        "id": state["next_id"], "side": side, "status": status,
        "current_text": dump(value), "revision": 0,
    }
    state["next_id"] += 1
    state["entries"].append(entry)
    return entry


def compact_ids(state):
    """Keep storage IDs equal to positions in the single active conversation."""
    mapping = {}
    for position, entry in enumerate(state["entries"], 1):
        mapping[entry["id"]] = position
        entry["id"] = position
    state["next_id"] = len(state["entries"]) + 1
    return mapping


def load_state():
    if STATE_FILE.exists():
        state = json.loads(STATE_FILE.read_text())
        state.setdefault("auto_mode", False)
        state.setdefault("run_complete", False)
        return state
    catalog = load_traces()
    snapshot = DATA / "traces" / catalog["active"] / "session.json"
    if snapshot.is_file():
        state = json.loads(snapshot.read_text())
        state.setdefault("auto_mode", False)
        state.setdefault("run_complete", False)
        save_state(state)
        return state
    state = {"version": 1, "next_id": 1, "entries": [], "busy": None, "error": None, "auto_mode": False, "run_complete": False}
    make_entry(state, "blue", default_request(), "draft")
    save_state(state)
    event("session_created", entry_id=1)
    return state


def save_traces(catalog):
    DATA.mkdir(parents=True, exist_ok=True)
    target = DATA / "traces.json"
    temporary = DATA / "traces.tmp"
    temporary.write_text(dump(catalog) + "\n")
    os.replace(temporary, target)


def load_traces():
    target = DATA / "traces.json"
    if target.exists():
        return json.loads(target.read_text())
    catalog = {"active": "current", "traces": [{"id": "current", "name": str(STATE_FILE)}]}
    save_traces(catalog)
    return catalog


def fenced(value, language=""):
    text = value if isinstance(value, str) else dump(value)
    runs = re.findall(r"`{3,}", text)
    fence = "`" * (max((len(run) for run in runs), default=2) + 1)
    return f"{fence}{language}\n{text}\n{fence}"


def experiment_card(state, trace, directory):
    first = state["entries"][0]
    try:
        request = json.loads(first["current_text"])
        if not isinstance(request, dict):
            raise ValueError("Message #1 is not a request object.")
        prompt = request.get("instructions", "")
        settings = {key: value for key, value in request.items() if key not in {"instructions", "input"}}
        prompt_block = fenced(prompt, "text")
        settings_block = fenced(settings, "json")
    except (ValueError, TypeError, json.JSONDecodeError):
        prompt_block = "Message #1 does not contain valid request JSON."
        settings_block = "Message #1 does not contain valid request JSON."
    parts = [f"# {trace['name']}", "Source: message #1 of this trace.",
             "## System prompt", prompt_block, "## Request settings", settings_block]
    note = trace.get("environment_note", "")
    if note:
        parts.extend(["## Environment note (AI-authored)", note])
    references = trace.get("references", [])
    if references:
        parts.append("## Related files")
        for reference in references:
            target = HERE.parent / reference["path"]
            relative = os.path.relpath(target, directory)
            parts.append(f"- [{reference['label']}]({relative})")
    return "\n\n".join(parts) + "\n"


def write_if_changed(path, content):
    if path.exists() and path.read_text() == content:
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(".tmp")
    temporary.write_text(content)
    os.replace(temporary, path)


def sync_active_experiment_card(state, catalog=None):
    catalog = catalog or load_traces()
    trace = next(item for item in catalog["traces"] if item["id"] == catalog["active"])
    for directory in (DATA, DATA / "traces" / trace["id"]):
        write_if_changed(directory / "EXPERIMENT_CARD.md", experiment_card(state, trace, directory))


def sync_all_experiment_cards():
    catalog = load_traces()
    for trace in catalog["traces"]:
        active = trace["id"] == catalog["active"]
        source = STATE_FILE if active else DATA / "traces" / trace["id"] / "session.json"
        if source.exists():
            state = json.loads(source.read_text())
            directory = DATA / "traces" / trace["id"]
            write_if_changed(directory / "EXPERIMENT_CARD.md", experiment_card(state, trace, directory))
            if active:
                write_if_changed(DATA / "EXPERIMENT_CARD.md", experiment_card(state, trace, DATA))


def snapshot_active_trace(catalog):
    directory = DATA / "traces" / catalog["active"]
    directory.mkdir(parents=True, exist_ok=True)
    shutil.copy2(STATE_FILE, directory / "session.json")
    if EVENTS_FILE.exists():
        shutil.copy2(EVENTS_FILE, directory / "events.jsonl")


def replace_from_trace(directory):
    source = directory / "session.json"
    if not source.exists():
        raise ValueError("The selected trace has no saved session.")
    json.loads(source.read_text())
    for source_file, target in ((source, STATE_FILE), (directory / "events.jsonl", EVENTS_FILE)):
        temporary = target.with_suffix(target.suffix + ".trace-tmp")
        if source_file.exists():
            shutil.copy2(source_file, temporary)
            os.replace(temporary, target)
        else:
            target.unlink(missing_ok=True)


def current_entry(state, entry_id):
    return next((entry for entry in state["entries"] if entry["id"] == entry_id), None)


def parsed(entry):
    return json.loads(entry["current_text"])


def api_key():
    key = os.environ.get("OPENAI_API_KEY")
    if key:
        return key
    path = Path.home() / ".codex" / "auth.json"
    if path.exists():
        auth = json.loads(path.read_text())
        return auth.get("OPENAI_API_KEY")
    return None


def call_api(payload):
    key = api_key()
    if not key:
        raise RuntimeError("No OpenAI API key found in OPENAI_API_KEY or local Codex auth.")
    req = urllib.request.Request(
        API_URL, data=json.dumps(payload).encode(), method="POST",
        headers={"Authorization": "Bearer " + key, "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=180) as response:
            return json.load(response)
    except urllib.error.HTTPError as exc:
        body = exc.read().decode(errors="replace")
        raise RuntimeError(f"OpenAI HTTP {exc.code}: {body[:2500]}") from exc


def notify_codex(message):
    """Best-effort local wake-up; the session ledger remains authoritative."""
    if not CODEX_THREAD_ID:
        return
    try:
        result = subprocess.run(
            ["codex", "queue", "--thread", CODEX_THREAD_ID, "--message", message],
            capture_output=True, text=True, timeout=10, check=False,
        )
        event("codex_notification", ok=result.returncode == 0,
              detail=(result.stderr or result.stdout)[-600:])
    except (OSError, subprocess.TimeoutExpired) as exc:
        event("codex_notification", ok=False, detail=str(exc))


def validate_request(value):
    if not isinstance(value, dict):
        raise ValueError("The outgoing request must be a JSON object.")
    if not isinstance(value.get("input"), list):
        raise ValueError("The outgoing request needs an input array.")
    if not isinstance(value.get("model"), str) or not value["model"]:
        raise ValueError("The outgoing request needs a model name.")
    if not any(item.get("role") == "user" and item.get("content") for item in value["input"] if isinstance(item, dict)):
        raise ValueError("Add a nonempty user task to input before approving the first request.")
    if value.get("store") is not False:
        raise ValueError("Set store to false for this editable local ledger.")
    if "previous_response_id" in value or "conversation" in value:
        raise ValueError("Use the visible input array; hidden conversation chaining is disabled.")


def validate_target(value):
    if not isinstance(value, dict) or not isinstance(value.get("output"), list):
        raise ValueError("The target response must be a JSON object with an output array.")
    ids = [item.get("call_id") for item in value["output"] if item.get("type") == "function_call"]
    if None in ids or len(ids) != len(set(ids)):
        raise ValueError("Function calls need unique call_id values.")


def replay_output(target):
    """Edited visible output must not carry opaque reasoning from the original turn."""
    output = parsed(target)["output"]
    if target["revision"]:
        return [item for item in output if item.get("type") != "reasoning"]
    return output


def replay_items(value, revision):
    output = value["output"]
    return [item for item in output if item.get("type") != "reasoning"] if revision else output


def merge_change(old, new, current):
    """Apply an earlier edit while retaining independent later edits."""
    if old == new:
        return current
    if isinstance(old, list) and isinstance(new, list) and isinstance(current, list) and len(old) == len(current) and len(new) < len(old):
        new_ids = {item["id"] for item in new if isinstance(item, dict) and item.get("id") is not None}
        keep = [index for index, item in enumerate(old)
                if not (isinstance(item, dict) and item.get("type") == "reasoning"
                        and item.get("id") not in new_ids)]
        if len(keep) == len(new):
            return merge_change([old[index] for index in keep], new, [current[index] for index in keep])
    if isinstance(old, dict) and isinstance(new, dict) and isinstance(current, dict):
        result = copy.deepcopy(current)
        for key in old.keys() | new.keys():
            if key not in new:
                result.pop(key, None)
            elif key not in old:
                result[key] = copy.deepcopy(new[key])
            else:
                result[key] = merge_change(old[key], new[key], result.get(key))
        return result
    if isinstance(old, list) and isinstance(new, list) and isinstance(current, list) and len(old) == len(new) == len(current):
        return [merge_change(a, b, c) for a, b, c in zip(old, new, current)]
    return copy.deepcopy(new)


def propagate_edit(state, edited_index, old_values, new_values, old_revisions):
    """Rebase every later blue request on the edited visible history."""
    entries = state["entries"]
    changes = []
    for index in range(edited_index + 1, len(entries)):
        entry = entries[index]
        if entry["side"] != "blue":
            continue
        if index < 2 or entries[index - 1]["side"] != "gray" or entries[index - 2]["side"] != "blue":
            raise ValueError("Cannot replay this conversation shape after the edit.")
        previous_blue, previous_gray = entries[index - 2:index]
        old_prefix = old_values[previous_blue["id"]]["input"] + replay_items(
            old_values[previous_gray["id"]], old_revisions[previous_gray["id"]]
        )
        new_prefix = new_values[previous_blue["id"]]["input"] + replay_items(
            new_values[previous_gray["id"]], previous_gray["revision"]
        )
        old_request = old_values[entry["id"]]
        old_input = old_request["input"]
        if len(old_input) < len(old_prefix):
            raise ValueError("A later request is shorter than its preceding conversation.")
        request = copy.deepcopy(old_request)
        request["input"] = merge_change(old_prefix, new_prefix, old_input[:len(old_prefix)]) + old_input[len(old_prefix):]
        new_values[entry["id"]] = request
        if request != old_request:
            changes.append((entry, request))
    events = []
    for entry, request in changes:
        before = entry["current_text"]
        entry["current_text"] = dump(request)
        entry["revision"] += 1
        events.append((entry, before))
    return events


def update_entry(state, entry_id, raw):
    entry = current_entry(state, entry_id)
    if not entry:
        raise ValueError("Unknown bubble.")
    old = entry["current_text"]
    if old == raw:
        return entry
    edited_index = state["entries"].index(entry)
    if entry["side"] == "blue" and entry["status"] == "stale":
        raise ValueError("Refresh the stale draft before editing it.")
    has_later = edited_index < len(state["entries"]) - 1
    if has_later:
        new_value = json.loads(raw)
        if entry["side"] == "blue":
            validate_request(new_value)
        else:
            validate_target(new_value)
        old_values = {item["id"]: parsed(item) for item in state["entries"]}
        new_values = dict(old_values)
        new_values[entry_id] = new_value
        old_revisions = {item["id"]: item["revision"] for item in state["entries"]}
    entry["current_text"] = raw
    entry["revision"] += 1
    rebased = []
    if has_later:
        rebased = propagate_edit(state, edited_index, old_values, new_values, old_revisions)
    if entry["side"] == "gray" and edited_index == len(state["entries"]) - 2:
        draft = state["entries"][-1]
        if draft["side"] == "blue" and draft["status"] != "stale":
            draft["status"] = "stale"
            event("draft_invalidated", entry_id=draft["id"], reason="target edited")
    event("edited", entry_id=entry_id, revision=entry["revision"], before_sha256=sha(old),
          after_sha256=sha(raw), before=old, after=raw)
    for later, before in rebased:
        event("history_rebased", source_id=entry_id, entry_id=later["id"], revision=later["revision"],
              before_sha256=sha(before), after_sha256=sha(later["current_text"]),
              before=before, after=later["current_text"])
    return entry


def run_approved(entry_id):
    try:
        with LOCK:
            state = load_state()
            entry = current_entry(state, entry_id)
            request = parsed(entry)
        response = call_api(request)
        with LOCK:
            state = load_state()
            entry = current_entry(state, entry_id)
            entry["status"] = "approved"
            target = make_entry(state, "gray", response, "received")
            state["busy"] = None
            state["error"] = None
            save_state(state)
            event("request_delivered", entry_id=entry_id, request=request, response_entry_id=target["id"])
        with LOCK:
            auto_mode = load_state()["auto_mode"]
        if auto_mode:
            notify_codex(
                f"Target response is ready in {STATE_FILE}. Auto mode is enabled. Read the latest gray bubble, "
                "the run's authorization and stop condition, and all current edits. Draft the next full request "
                "via POST /api/codex-draft. Use /api/auto-send only if Auto is still enabled and the run remains "
                "within its authorization. This is a local UI notification, not a new task."
            )
        else:
            notify_codex(
                f"Target response is ready in {STATE_FILE}. Read the latest gray bubble and "
                "draft the next full outgoing request via POST /api/codex-draft. Do not send it to the target; "
                "the human must approve the blue bubble. This is a local UI notification, not a new task."
            )
    except Exception as exc:
        with LOCK:
            state = load_state()
            state["busy"] = None
            state["error"] = str(exc)
            save_state(state)
            event("request_failed", entry_id=entry_id, error=str(exc))


class Handler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        if not (self.command == "GET" and self.path == "/api/state"):
            print("[conversation]", format % args)

    def send(self, status, value):
        body = json.dumps(value, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        path = urlparse(self.path).path
        if path == "/api/traces":
            with LOCK:
                self.send(200, load_traces())
            return
        if path == "/api/state":
            with LOCK:
                state = load_state()
                saved_at = datetime.fromtimestamp(STATE_FILE.stat().st_mtime, timezone.utc).isoformat()
                self.send(200, {**state, "saved_at": saved_at})
            return
        if path == "/api/events":
            records = [json.loads(line) for line in EVENTS_FILE.read_text().splitlines()] if EVENTS_FILE.exists() else []
            self.send(200, {"events": records})
            return
        asset = {"/": "index.html", "/index.html": "index.html", "/app.js": "app.js", "/styles.css": "styles.css"}.get(path)
        if not asset:
            self.send(404, {"error": "Not found"})
            return
        data = (HERE / asset).read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", {"index.html": "text/html", "app.js": "text/javascript", "styles.css": "text/css"}[asset] + "; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def do_POST(self):
        origin = self.headers.get("Origin")
        if origin and origin not in {f"http://{self.headers.get('Host')}", f"https://{self.headers.get('Host')}"}:
            self.send(403, {"error": "Cross-origin mutation rejected."})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if length > 10_000_000:
                raise ValueError("Request too large.")
            data = json.loads(self.rfile.read(length) or b"{}")
            path = urlparse(self.path).path
            with LOCK:
                state = load_state()
                if path == "/api/auto-mode":
                    enabled = data.get("enabled")
                    if not isinstance(enabled, bool):
                        raise ValueError("enabled must be a boolean.")
                    state["auto_mode"] = enabled
                    save_state(state)
                    event("auto_mode_changed", enabled=enabled)
                    self.send(200, {"auto_mode": enabled})
                    if enabled and state["entries"][-1]["side"] == "gray":
                        threading.Thread(target=notify_codex, args=(
                            f"Auto mode was enabled with a gray response pending in {STATE_FILE}. "
                            "Read the run's authorization and stop condition, then draft the next full request "
                            "via POST /api/codex-draft. Use /api/auto-send only while Auto remains enabled. "
                            "This is a local UI notification, not a new task.",
                        ), daemon=True).start()
                    return
                if path == "/api/complete-run":
                    if state["busy"]:
                        raise ValueError("Wait for the current model call to finish.")
                    state["auto_mode"] = False
                    state["run_complete"] = True
                    save_state(state)
                    event("run_completed", last_entry_id=state["entries"][-1]["id"])
                    self.send(200, {"run_complete": True})
                    return
                if state["busy"]:
                    raise ValueError("A model call is still running.")
                if path == "/api/rename-trace":
                    name = data.get("name")
                    if not isinstance(name, str) or not name.strip() or len(name) > 160 or "\n" in name:
                        raise ValueError("Trace name must be a single line of 1 to 160 characters.")
                    catalog = load_traces()
                    trace = next(item for item in catalog["traces"] if item["id"] == catalog["active"])
                    trace["name"] = name.strip()
                    save_traces(catalog)
                    sync_active_experiment_card(state, catalog)
                    event("trace_renamed", trace_id=trace["id"], name=trace["name"])
                    self.send(200, catalog)
                    return
                if path == "/api/experiment-note":
                    note = data.get("note")
                    references = data.get("references", [])
                    if not isinstance(note, str) or len(note) > 20_000:
                        raise ValueError("note must be text under 20,000 characters.")
                    if not isinstance(references, list) or len(references) > 20:
                        raise ValueError("references must be a list of at most 20 files.")
                    for reference in references:
                        if not isinstance(reference, dict) or not isinstance(reference.get("label"), str) or not isinstance(reference.get("path"), str):
                            raise ValueError("Each reference needs a label and repository-relative path.")
                        target = (HERE.parent / reference["path"]).resolve()
                        if not target.is_relative_to(HERE.parent) or not target.is_file():
                            raise ValueError("Each reference must be an existing file in this repository.")
                    catalog = load_traces()
                    trace = next(item for item in catalog["traces"] if item["id"] == catalog["active"])
                    trace["environment_note"] = note
                    trace["references"] = references
                    save_traces(catalog)
                    sync_active_experiment_card(state, catalog)
                    event("experiment_note_updated", trace_id=trace["id"], note=note, references=references)
                    self.send(200, {"ok": True})
                    return
                if path == "/api/select-trace":
                    catalog = load_traces()
                    trace_id = data.get("id")
                    if not isinstance(trace_id, str) or trace_id not in {item["id"] for item in catalog["traces"]}:
                        raise ValueError("Unknown trace.")
                    if trace_id != catalog["active"]:
                        target = DATA / "traces" / trace_id
                        if not (target / "session.json").is_file():
                            raise ValueError("The selected trace has no saved session.")
                        previous = catalog["active"]
                        snapshot_active_trace(catalog)
                        replace_from_trace(target)
                        catalog["active"] = trace_id
                        save_traces(catalog)
                        sync_active_experiment_card(load_state(), catalog)
                        event("trace_selected", from_id=previous, to_id=trace_id)
                    self.send(200, catalog)
                    return
                if path == "/api/new-trace":
                    trace_id = data.get("id")
                    name = data.get("name")
                    if not isinstance(trace_id, str) or not re.fullmatch(r"[a-z0-9][a-z0-9_-]{0,63}", trace_id):
                        raise ValueError("Trace id must use lowercase letters, numbers, hyphens, or underscores.")
                    if not isinstance(name, str) or not name.strip() or len(name) > 160 or "\n" in name:
                        raise ValueError("Trace name must be a single line of 1 to 160 characters.")
                    catalog = load_traces()
                    if trace_id in {item["id"] for item in catalog["traces"]} or (DATA / "traces" / trace_id).exists():
                        raise ValueError("A trace with that id already exists.")
                    snapshot_active_trace(catalog)
                    fresh = {"version": 1, "next_id": 1, "entries": [], "busy": None, "error": None,
                             "auto_mode": False, "run_complete": False}
                    make_entry(fresh, "blue", blank_request(), "draft")
                    catalog["traces"].append({"id": trace_id, "name": name.strip()})
                    catalog["active"] = trace_id
                    save_traces(catalog)
                    EVENTS_FILE.write_text("")
                    save_state(fresh)
                    event("trace_created", trace_id=trace_id, name=name.strip())
                    self.send(200, catalog)
                    return
                if path == "/api/edit":
                    entry = update_entry(state, int(data["id"]), data["text"])
                    state["error"] = None
                    save_state(state)
                    self.send(200, {"entry": entry})
                    return
                if path in {"/api/approve", "/api/auto-send"}:
                    if state["run_complete"]:
                        raise ValueError("This run is complete. Rewind to continue it.")
                    automatic = path == "/api/auto-send"
                    if automatic and not state["auto_mode"]:
                        raise ValueError("Auto mode is off.")
                    entry = current_entry(state, int(data["id"]))
                    if entry != state["entries"][-1] or entry["side"] != "blue" or entry["status"] != "draft":
                        raise ValueError("Only the latest blue draft can be approved.")
                    if "text" in data:
                        if not isinstance(data["text"], str):
                            raise ValueError("The approved request text must be a string.")
                        update_entry(state, entry["id"], data["text"])
                    value = parsed(entry)
                    validate_request(value)
                    state["busy"] = {"kind": "target", "entry_id": entry["id"]}
                    state["error"] = None
                    save_state(state)
                    event("auto_send" if automatic else "approval_clicked", entry_id=entry["id"], revision=entry["revision"], exact_request=value)
                    threading.Thread(target=run_approved, args=(entry["id"],), daemon=True).start()
                    self.send(202, {"ok": True})
                    return
                if path == "/api/refresh-draft":
                    entry = current_entry(state, int(data["id"]))
                    if entry != state["entries"][-1]:
                        raise ValueError("Only the latest draft or gray response can be refreshed.")
                    if entry["side"] == "blue" and entry["status"] in {"draft", "stale"}:
                        if len(state["entries"]) < 2 or state["entries"][-2]["side"] != "gray":
                            raise ValueError("This draft has no gray response to refresh from.")
                        target = state["entries"][-2]
                        validate_target(parsed(target))
                        removed = state["entries"].pop()
                        compact_ids(state)
                        event("draft_refresh_requested", target_id=target["id"], discarded_id=removed["id"])
                    elif entry["side"] == "gray":
                        target = entry
                        validate_target(parsed(target))
                        event("draft_refresh_requested", target_id=target["id"])
                    else:
                        raise ValueError("Only the latest draft or gray response can be refreshed.")
                    state["run_complete"] = False
                    state["error"] = None
                    save_state(state)
                    self.send(200, {"ok": True})
                    threading.Thread(target=notify_codex, args=(
                        f"Refresh the blue draft after gray bubble {target['id']} in {STATE_FILE}. "
                        "Read all current edits and POST a new full outgoing request to /api/codex-draft. "
                        "Do not call the target; the human must approve the blue bubble. "
                        "This is a local UI notification, not a new task.",
                    ), daemon=True).start()
                    return
                if path == "/api/rewind":
                    target = current_entry(state, int(data["id"]))
                    if not target:
                        raise ValueError("Unknown bubble.")
                    idx = state["entries"].index(target)
                    if idx == len(state["entries"]) - 1:
                        raise ValueError("Choose an earlier bubble to return to.")
                    removed = [item["id"] for item in state["entries"][idx + 1:]]
                    state["entries"] = state["entries"][:idx + 1]
                    compact_ids(state)
                    if target["side"] == "blue":
                        target["status"] = "draft"
                    state["run_complete"] = False
                    state["error"] = None
                    save_state(state)
                    event("rewound", target_id=target["id"], removed_ids=removed)
                    self.send(200, {"ok": True})
                    if target["side"] == "gray" and data.get("notify", True) is not False:
                        threading.Thread(target=notify_codex, args=(
                            f"The local conversation was rewound to gray bubble {target['id']} in {STATE_FILE}. "
                            "Read all current edits and POST the next full outgoing request to /api/codex-draft. "
                            "Do not call the target; the human must approve the blue bubble. "
                            "This is a local UI notification, not a new task.",
                        ), daemon=True).start()
                    return
                if path == "/api/codex-draft":
                    target = state["entries"][-1]
                    if target["side"] != "gray":
                        raise ValueError("A gray target bubble must be latest before drafting.")
                    validate_target(parsed(target))
                    value = data.get("request")
                    validate_request(value)
                    expected = parsed(state["entries"][-2])["input"] + replay_output(target)
                    if value["input"][:len(expected)] != expected:
                        raise ValueError("Draft must replay the approved request and current agent response.")
                    draft = make_entry(state, "blue", value, "draft")
                    state["error"] = None
                    save_state(state)
                    event("codex_draft_created", target_id=target["id"], entry_id=draft["id"], exact_request=value)
                    self.send(200, {"entry": draft})
                    return
            self.send(404, {"error": "Unknown API action."})
        except (ValueError, KeyError, TypeError, json.JSONDecodeError) as exc:
            self.send(400, {"error": str(exc)})


def main():
    import argparse
    parser = argparse.ArgumentParser(description="Run the local review room.")
    parser.add_argument("--port", type=int, default=8765)
    args = parser.parse_args()
    with LOCK:
        load_state()
        sync_all_experiment_cards()
    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    print(f"Review room: http://127.0.0.1:{args.port}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
