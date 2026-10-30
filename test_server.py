"""End-to-end checks for the approval and edit boundary, without API spend."""

import copy
import io
import json
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
from pathlib import Path
from unittest import mock

from metri import server


class MetriTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.original = (server.DATA, server.STATE_FILE, server.EVENTS_FILE, server.MODELS_FILE, server.TEMPLATES_FILE,
                         server.call_api, server.call_swap_model, server.CODEX_THREAD_ID, server.OPENROUTER_SESSION_KEY)
        server.DATA = Path(self.tmp.name)
        server.STATE_FILE = server.DATA / "session.json"
        server.EVENTS_FILE = server.DATA / "events.jsonl"
        model_config = server.MODELS_FILE.read_text()
        server.MODELS_FILE = server.DATA / "models.yml"
        server.MODELS_FILE.write_text(model_config)
        server.TEMPLATES_FILE = server.DATA / "templates.yml"
        server.TEMPLATES_FILE.write_text((Path(__file__).parent / "templates.yml").read_text())
        server.CODEX_THREAD_ID = None
        server.OPENROUTER_SESSION_KEY = None
        (server.DATA / "EXPERIMENT_CARD.md").write_text(
            "# Local test\n\n## System prompt\n\n```text\nTest instructions\n```\n\n"
            "## Request settings\n\n```json\n{\"model\":\"test-model\",\"store\":false}\n```\n"
        )
        self.target_requests = []

        def fake_api(request):
            self.target_requests.append(copy.deepcopy(request))
            if len(self.target_requests) == 1:
                return {"id": "resp_1", "status": "completed", "output": [
                    {"type": "reasoning", "encrypted_content": "opaque-original"},
                    {"type": "function_call", "name": "setup", "call_id": "call_1", "arguments": "{}"}
                ], "usage": {"total_tokens": 10}}
            return {"id": "resp_2", "status": "completed", "output": [
                {"type": "message", "role": "assistant", "content": [
                    {"type": "output_text", "text": "Done"}
                ]}
            ], "usage": {"total_tokens": 12}}

        server.call_api = fake_api
        self.http = server.ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
        self.base = f"http://127.0.0.1:{self.http.server_port}"
        self.thread = threading.Thread(target=self.http.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.http.shutdown()
        self.http.server_close()
        self.thread.join(timeout=2)
        (server.DATA, server.STATE_FILE, server.EVENTS_FILE, server.MODELS_FILE, server.TEMPLATES_FILE,
         server.call_api, server.call_swap_model, server.CODEX_THREAD_ID, server.OPENROUTER_SESSION_KEY) = self.original
        self.tmp.cleanup()

    def get(self):
        with urllib.request.urlopen(self.base + "/api/state") as reply:
            return json.load(reply)

    def get_traces(self):
        with urllib.request.urlopen(self.base + "/api/traces") as reply:
            return json.load(reply)

    def variants(self, entry_id):
        with urllib.request.urlopen(self.base + f"/api/message-variants?id={entry_id}") as reply:
            return json.load(reply)["variants"]

    def test_blue_edit_requires_confirmation_and_creates_selectable_version(self):
        original = self.get()["entries"][0]["current_text"]
        self.assertEqual(self.get()["version_numbers"]["1"], 1)
        changed = json.loads(original)
        changed["input"][0]["content"] = "Edited request"
        raw = json.dumps(changed)
        self.post("start-edit", {"id": 1})
        self.post("stage-edit", {"id": 1, "text": raw})
        self.assertEqual(self.get()["entries"][0]["current_text"], original)
        for action, data in [("approve", {"id": 1}), ("refresh-draft", {"id": 1}),
                             ("new-trace", {"id": "another", "name": "Another"})]:
            with self.assertRaises(urllib.error.HTTPError) as error:
                self.post(action, data)
            self.assertEqual(error.exception.code, 400)
            error.exception.close()
        self.post("confirm-edit", {"id": 1, "text": raw})
        self.assertEqual(self.get()["entries"][0]["current_text"], raw)
        self.assertEqual(self.get()["version_numbers"]["1"], 2)
        versions = self.variants(1)
        self.assertEqual([item["number"] for item in versions], [1, 2])
        self.assertEqual(versions[1]["kind"], "manual")
        self.assertEqual(versions[1]["model"], "test-model")
        self.post("select-message-variant", {"id": 1, "variant": versions[0]["id"]})
        self.assertEqual(self.get()["entries"][0]["current_text"], original)
        self.assertEqual(self.get()["version_numbers"]["1"], 1)
        self.assertEqual([item["number"] for item in self.variants(1)], [1, 2])

    def test_gray_edit_can_be_discarded_or_confirmed_as_version(self):
        first = json.loads(self.get()["entries"][0]["current_text"])
        first["input"][0]["content"] = "Run the test"
        self.post("approve", {"id": 1, "text": json.dumps(first)})
        self.await_idle()
        original = self.get()["entries"][1]["current_text"]
        changed = json.loads(original)
        changed["output"][1]["name"] = "read"
        raw = json.dumps(changed)
        self.post("start-edit", {"id": 2})
        self.post("stage-edit", {"id": 2, "text": raw})
        self.post("discard-edit", {"id": 2})
        self.assertEqual(self.get()["entries"][1]["current_text"], original)
        self.post("start-edit", {"id": 2})
        self.post("confirm-edit", {"id": 2, "text": raw})
        self.assertEqual(self.get()["entries"][1]["current_text"], raw)
        self.assertEqual(self.get()["version_numbers"]["2"], 2)
        versions = self.variants(2)
        self.assertEqual([item["kind"] for item in versions], ["generated", "manual"])
        self.post("select-message-variant", {"id": 2, "variant": versions[0]["id"]})
        self.assertEqual(self.get()["entries"][1]["current_text"], original)
        self.assertEqual(self.get()["version_numbers"]["2"], 1)
        self.assertEqual([item["number"] for item in self.variants(2)], [1, 2])

    def test_refreshed_blue_drafts_keep_generation_numbers(self):
        first = json.loads(self.get()["entries"][0]["current_text"])
        first["input"][0]["content"] = "Run the test"
        self.post("approve", {"id": 1, "text": json.dumps(first)})
        self.await_idle()
        gray = self.get()["entries"][-1]
        base = copy.deepcopy(first)
        base["input"] += json.loads(gray["current_text"])["output"]
        draft_one = copy.deepcopy(base)
        draft_one["input"].append({"role": "user", "content": "First draft"})
        self.post("codex-draft", {"request": draft_one})
        self.post("refresh-draft", {"id": 3})
        draft_two = copy.deepcopy(base)
        draft_two["input"].append({"role": "user", "content": "Second draft"})
        self.post("codex-draft", {"request": draft_two})
        self.assertEqual([item["number"] for item in self.variants(3)], [1, 2])
        self.assertEqual(self.get()["version_numbers"]["3"], 2)
        self.assertEqual(self.get()["entries"][-1]["current_text"], server.dump(draft_two))
        earlier = self.variants(3)[0]["id"]
        self.post("select-message-variant", {"id": 3, "variant": earlier})
        self.assertEqual(self.get()["entries"][-1]["current_text"], server.dump(draft_one))
        self.assertEqual(self.get()["version_numbers"]["3"], 1)
        self.assertEqual([item["number"] for item in self.variants(3)], [1, 2])

    def test_rail_points_are_trace_specific_and_validated(self):
        with urllib.request.urlopen(self.base + "/api/rail") as reply:
            self.assertEqual(json.load(reply), {"points": []})
        rails = server.DATA / "rails"
        rails.mkdir()
        config = rails / "current.yml"
        config.write_text("points:\n  - message: 8\n    label: Agent publishes a finding\n  - message: 3\n    label: Agent reads the forum\n")
        with urllib.request.urlopen(self.base + "/api/rail") as reply:
            self.assertEqual(json.load(reply)["points"], [
                {"message": 3, "label": "Agent reads the forum"},
                {"message": 8, "label": "Agent publishes a finding"},
            ])
        config.write_text("points:\n  - message: nope\n    label: Bad marker\n")
        with self.assertRaises(urllib.error.HTTPError) as error:
            urllib.request.urlopen(self.base + "/api/rail")
        self.assertEqual(error.exception.code, 400)
        error.exception.close()

    def test_swap_choices_are_configured_and_sol_uses_high_reasoning(self):
        with urllib.request.urlopen(self.base + "/api/swap-models") as reply:
            choices = json.load(reply)["models"]
        self.assertEqual([item["id"] for item in choices], ["glm-high", "sol-high"])
        original = {"instructions": "Test", "input": [{"role": "user", "content": "Hello"},
                    {"type": "reasoning", "encrypted_content": "prior-model-only"}],
                    "max_output_tokens": 3000, "temperature": 0.5}
        server.call_swap_model(original, choices[1])
        sent = self.target_requests[-1]
        self.assertEqual(sent["model"], "gpt-6-sol")
        self.assertEqual(sent["reasoning"], {"effort": "high", "summary": "auto"})
        self.assertEqual(sent["max_output_tokens"], 12000)
        self.assertNotIn("temperature", sent)
        self.assertEqual(sent["input"], [{"role": "user", "content": "Hello"}])
        seen = []
        def fake_openrouter(request, timeout):
            seen.append(json.loads(request.data))
            return io.BytesIO(json.dumps({"model": "z-ai/glm-5.3", "output": [
                {"type": "message", "role": "assistant", "content": [
                    {"type": "output_text", "text": "Done"}]}]}).encode())
        with mock.patch.dict("os.environ", {"OPENROUTER_API_KEY": "test-key"}), \
                mock.patch.object(server.urllib.request, "urlopen", fake_openrouter):
            server.call_swap_model(original, choices[0])
        self.assertEqual(seen[0]["model"], "z-ai/glm-5.3")
        self.assertEqual(seen[0]["reasoning"], {"effort": "high", "exclude": False})
        self.assertEqual(seen[0]["max_output_tokens"], 12000)
        self.assertNotIn("temperature", seen[0])

    def test_default_model_is_saved_in_yaml_and_seeds_new_trace(self):
        with urllib.request.urlopen(self.base + "/api/models") as reply:
            catalog = json.load(reply)
        self.assertEqual(catalog["default"], "sol-daybreak")
        self.assertEqual(catalog["models"][0]["description"], "OpenAI · High")
        self.assertEqual(catalog["models"][0]["detail"], "daybreak_blue: enabled")
        self.assertEqual(catalog["models"][0]["slug"], "gpt-6-sol-daybreak")
        daybreak_request = server.new_trace_request()
        self.assertEqual(daybreak_request["reasoning"], {"effort": "high"})
        self.assertEqual(daybreak_request["access_programs"], {"cyber": "daybreak_blue"})
        changed = self.post("default-model", {"id": "glm-high"})
        self.assertEqual(changed["default"], "glm-high")
        self.assertEqual(server.model_catalog()["default"], "glm-high")
        self.post("new-trace", {"id": "glm-trace", "name": "GLM trace"})
        request = json.loads(self.get()["entries"][0]["current_text"])
        self.assertEqual(request["model"], "z-ai/glm-5.3")
        self.assertEqual(request["reasoning"], {"effort": "high"})
        self.assertNotIn("access_programs", request)
        with self.assertRaises(urllib.error.HTTPError) as error:
            self.post("default-model", {"id": "missing"})
        self.assertEqual(error.exception.code, 400)
        error.exception.close()
        self.assertEqual(server.model_catalog()["default"], "glm-high")

    def test_message_slugs_follow_the_selected_message_json(self):
        request = {"model": "gpt-6-sol", "access_programs": {"cyber": "daybreak_blue"}}
        state = {"entries": [
            {"id": 1, "side": "blue", "current_text": json.dumps(request)},
            {"id": 2, "side": "gray", "current_text": json.dumps({"model": "gpt-6-sol", "access_programs": request["access_programs"]})},
        ]}
        self.assertEqual(server.model_slugs(state), {"1": "gpt-6-sol-daybreak", "2": "gpt-6-sol-daybreak"})
        state["entries"][1]["current_text"] = json.dumps({"model": "z-ai/glm-5.3"})
        self.assertEqual(server.model_slugs(state)["2"], "glm-5.3-high")
        state["entries"][1]["current_text"] = json.dumps({"model": "gpt-6-sol"})
        self.assertEqual(server.model_slugs(state)["2"], "gpt-6-sol-high")
        state["entries"][1]["current_text"] = json.dumps({"output": []})
        self.assertEqual(server.model_slugs(state)["2"], "gpt-6-sol-daybreak")

    def test_manual_gray_and_blue_do_not_call_a_provider(self):
        self.post("auto-generate", {"enabled": False})
        first = json.loads(self.get()["entries"][0]["current_text"])
        first["input"][0]["content"] = "Find the file"
        first["tools"] = [{"type": "function", "name": "Glob", "parameters": {
            "type": "object", "properties": {"pattern": {"type": "string"}}, "required": ["pattern"]}}]
        self.post("edit", {"id": 1, "text": json.dumps(first)})
        output = [
            {"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": "I will look."}]},
            {"type": "function_call", "name": "Glob", "call_id": "call_manual_one", "arguments": '{"pattern":"*.md"}'},
            {"type": "function_call", "name": "Glob", "call_id": "call_manual_two", "arguments": '{"pattern":"*.txt"}'},
        ]
        response = {"id": "resp_manual_test", "object": "response", "model": first["model"],
                    "status": "completed", "output": output}
        created = self.post("manual-response", {"id": 1, "response": response})["entry"]
        self.assertEqual(created["side"], "gray")
        self.assertEqual(created["versions"][0]["kind"], "manual")
        self.assertEqual(self.get()["entries"][0]["status"], "simulated")
        self.assertEqual(self.target_requests, [])
        self.assertEqual(json.loads(created["current_text"])["output"], output)
        draft = copy.deepcopy(first)
        draft["input"] += output + [
            {"type": "function_call_output", "call_id": "call_manual_one", "output": "report.md"},
            {"type": "function_call_output", "call_id": "call_manual_two", "output": "notes.txt"},
        ]
        next_entry = self.post("manual-draft", {"request": draft})["entry"]
        self.assertEqual(next_entry["side"], "blue")
        self.assertEqual(next_entry["status"], "approved")
        self.assertEqual(next_entry["versions"][0]["kind"], "manual")
        self.assertEqual(self.target_requests, [])
        events = [json.loads(line)["kind"] for line in server.EVENTS_FILE.read_text().splitlines()]
        self.assertIn("manual_response_created", events)
        self.assertIn("manual_draft_created", events)
        self.post("generate-response", {"id": next_entry["id"]})
        self.await_idle()
        self.assertEqual(len(self.target_requests), 1)

    def test_template_message_can_be_used_in_manual_request_after_run_completion(self):
        self.post("auto-generate", {"enabled": False})
        first = json.loads(self.get()["entries"][0]["current_text"])
        first["input"][0]["content"] = "Research the task"
        self.post("approve", {"id": 1, "text": json.dumps(first)})
        self.await_idle()
        with urllib.request.urlopen(self.base + "/api/templates") as reply:
            templates = json.load(reply)["templates"]
        self.assertEqual(templates[0]["id"], "neutral-exit-interview")
        self.assertEqual(templates[0]["message"].count("\n"), 8)
        self.assertNotIn("description", templates[0])
        self.post("complete-run", {})
        edited_message = templates[0]["message"] + "\nOne final note, please."
        previous = json.loads(self.get()["entries"][-2]["current_text"])
        gray = json.loads(self.get()["entries"][-1]["current_text"])
        request = dict(previous)
        request["input"] = previous["input"] + gray["output"] + [
            {"type": "function_call_output", "call_id": "call_1", "output": '{"error":"canceled"}'},
            {"role": "user", "content": edited_message}]
        result = self.post("manual-draft", {"request": request})
        draft = result["entry"]
        request = json.loads(draft["current_text"])
        self.assertEqual(draft["status"], "approved")
        self.assertFalse(self.get()["run_complete"])
        self.assertEqual(request["input"][-2]["call_id"], "call_1")
        self.assertEqual(request["input"][-1], {"role": "user", "content": edited_message})
        self.assertEqual(len(self.target_requests), 1)
        self.post("generate-response", {"id": draft["id"]})
        self.await_idle()
        self.assertEqual(len(self.target_requests), 2)
        self.assertEqual(self.target_requests[-1]["input"][-1]["content"], edited_message)

    def test_bookmark_saves_to_active_traces_rail_and_can_be_removed(self):
        with urllib.request.urlopen(self.base + "/api/traces") as reply:
            trace_id = json.load(reply)["active"]
        saved = self.post("rail-point", {"trace_id": trace_id, "message": 1,
                                         "label": "First decision"})
        self.assertEqual(saved["points"], [{"message": 1, "label": "First decision"}])
        with urllib.request.urlopen(self.base + "/api/rail") as reply:
            self.assertEqual(json.load(reply)["points"], saved["points"])
        updated = self.post("rail-point", {"trace_id": trace_id, "message": 1,
                                           "label": "Initial task"})
        self.assertEqual(updated["points"][0]["label"], "Initial task")
        removed = self.post("rail-point", {"trace_id": trace_id, "message": 1,
                                           "remove": True})
        self.assertEqual(removed["points"], [])

    def test_manual_blue_can_receive_manual_gray_without_provider_call(self):
        self.post("auto-generate", {"enabled": False})
        first = self.get()["entries"][0]
        previous = json.loads(first["current_text"])
        previous["input"][0]["content"] = "Begin"
        self.post("edit", {"id": first["id"], "text": json.dumps(previous)})
        self.post("manual-response", {"id": first["id"], "response": {
            "model": "test-model", "output": [{"type": "message", "role": "assistant",
                "content": [{"type": "output_text", "text": "First reply"}]}]}})
        gray = json.loads(self.get()["entries"][-1]["current_text"])
        draft = copy.deepcopy(previous)
        draft["input"] += gray["output"] + [{"role": "user", "content": "Continue"}]
        blue = self.post("manual-draft", {"request": draft})["entry"]
        self.assertEqual(blue["status"], "approved")
        self.post("manual-response", {"id": blue["id"], "response": {
            "model": "test-model", "output": [{"type": "message", "role": "assistant",
                "content": [{"type": "output_text", "text": "Second reply"}]}]}})
        self.assertEqual(self.target_requests, [])
        self.assertEqual([entry["side"] for entry in self.get()["entries"]], ["blue", "gray", "blue", "gray"])

    def test_manual_response_rejects_unavailable_tools(self):
        first = json.loads(self.get()["entries"][0]["current_text"])
        first["input"][0]["content"] = "Run a test"
        self.post("edit", {"id": 1, "text": json.dumps(first)})
        response = {"model": first["model"], "output": [
            {"type": "function_call", "name": "Bash", "call_id": "call_1", "arguments": "{}"}]}
        with self.assertRaises(urllib.error.HTTPError) as error:
            self.post("manual-response", {"id": 1, "response": response})
        self.assertEqual(error.exception.code, 400)
        error.exception.close()
        self.assertEqual(len(self.get()["entries"]), 1)
        self.assertEqual(self.target_requests, [])

    def test_configured_openrouter_default_routes_target_requests(self):
        seen = []
        def fake_openrouter(request, timeout):
            seen.append((request.full_url, json.loads(request.data)))
            return io.BytesIO(json.dumps({"model": "z-ai/glm-5.3", "output": [
                {"type": "message", "role": "assistant", "content": [
                    {"type": "output_text", "text": "Done"}]}]}).encode())
        with mock.patch.dict("os.environ", {"OPENROUTER_API_KEY": "test-key"}), \
                mock.patch.object(server.urllib.request, "urlopen", fake_openrouter):
            response = server.call_target_api({"model": "z-ai/glm-5.3", "input": [], "store": False})
        self.assertEqual(seen[0][0], server.OPENROUTER_URL)
        self.assertEqual(seen[0][1]["model"], "z-ai/glm-5.3")
        self.assertEqual(response["output"][0]["content"][0]["text"], "Done")

    def post(self, action, payload):
        req = urllib.request.Request(self.base + "/api/" + action,
            data=json.dumps(payload).encode(), headers={"Content-Type": "application/json"}, method="POST")
        with urllib.request.urlopen(req) as reply:
            return json.load(reply)

    def await_idle(self):
        for _ in range(100):
            state = self.get()
            if not state["busy"]:
                return state
            time.sleep(.02)
        self.fail("Model call did not finish")

    def await_draft(self):
        for _ in range(100):
            state = self.get()
            if state["entries"][-1]["side"] == "blue" and state["entries"][-1]["status"] == "draft":
                return state
            time.sleep(.02)
        self.fail("API draft did not appear")

    def test_trace_names_and_switch_preserve_each_conversation(self):
        opening = self.get()
        card = server.DATA / "EXPERIMENT_CARD.md"
        self.assertIn("## System prompt", card.read_text())
        self.assertEqual(self.get_traces()["active"], "current")
        self.post("draft-source", {"source": "api"})
        self.post("rename-trace", {"name": "~/metri/E110"})
        self.assertEqual(self.get_traces()["traces"][0]["name"], "~/metri/E110")
        request = json.loads(opening["entries"][0]["current_text"])
        request["instructions"] = "Changed first prompt"
        request["temperature"] = 0.42
        self.post("edit", {"id": 1, "text": json.dumps(request)})
        self.assertIn("Changed first prompt", card.read_text())
        self.assertIn('"temperature": 0.42', card.read_text())
        self.post("experiment-note", {"note": "AI description of the local setup.", "references": [
            {"label": "Instructions", "path": "metri/README.md"}]})
        self.assertIn("AI description of the local setup.", card.read_text())

        other = copy.deepcopy(opening)
        other["entries"][0]["current_text"] = json.dumps({**server.default_request(), "input": [
            {"role": "user", "content": "Archived trace"}]})
        other.pop("saved_at")
        directory = server.DATA / "traces" / "archive"
        directory.mkdir(parents=True)
        (directory / "session.json").write_text(json.dumps(other))
        catalog = self.get_traces()
        catalog["traces"].append({"id": "archive", "name": "~/metri/archive"})
        server.save_traces(catalog)

        self.post("rename-trace", {"id": "archive", "name": "~/metri/renamed-archive"})
        self.assertEqual(self.get_traces()["active"], "current")
        self.assertEqual(self.get_traces()["traces"][1]["name"], "~/metri/renamed-archive")
        self.assertIn("# ~/metri/renamed-archive", (directory / "EXPERIMENT_CARD.md").read_text())

        self.post("select-trace", {"id": "archive"})
        self.assertEqual(self.get_traces()["active"], "archive")
        self.assertEqual(self.get()["draft_source"], "codex")
        self.assertEqual(json.loads(self.get()["entries"][0]["current_text"])["input"][0]["content"], "Archived trace")
        self.assertNotIn("AI description of the local setup.", card.read_text())
        self.assertTrue((server.DATA / "traces" / "current" / "session.json").is_file())
        self.post("select-trace", {"id": "current"})
        self.assertEqual(self.get()["draft_source"], "api")
        self.assertEqual(self.get_traces()["active"], "current")
        self.assertEqual(json.loads(self.get()["entries"][0]["current_text"])["instructions"], "Changed first prompt")
        self.assertIn("AI description of the local setup.", card.read_text())
        self.assertTrue((server.DATA / "traces" / "current" / "EXPERIMENT_CARD.md").is_file())
        self.assertEqual(self.target_requests, [])

    def test_new_trace_uses_log_then_card_then_configured_default(self):
        card_request = server.default_request()
        self.assertEqual(card_request["model"], "test-model")
        self.assertEqual(card_request["instructions"], "Test instructions")
        self.assertNotIn("tools", card_request)
        server.EVENTS_FILE.write_text(json.dumps({"kind": "approval_clicked", "exact_request": {
            "model": "logged-model", "instructions": "Logged instructions", "input": [
                {"role": "user", "content": "Earlier task"}], "store": False,
            "temperature": 0.25}}) + "\n")
        logged_request = server.default_request()
        self.assertEqual(logged_request["model"], "logged-model")
        self.assertEqual(logged_request["instructions"], "Logged instructions")
        self.assertEqual(logged_request["temperature"], 0.25)
        self.assertEqual(logged_request["input"][0]["content"], "")
        server.EVENTS_FILE.unlink()
        (server.DATA / "EXPERIMENT_CARD.md").unlink()
        blank_request = server.default_request()
        self.assertEqual(blank_request["model"], "gpt-6-sol")
        self.assertEqual(blank_request["access_programs"], {"cyber": "daybreak_blue"})
        self.assertNotIn("tools", blank_request)
        self.assertEqual(blank_request["max_output_tokens"], 3000)
        archived = {"version": 1, "next_id": 2, "entries": [{
            "id": 1, "side": "blue", "status": "draft", "revision": 0,
            "current_text": json.dumps({**blank_request, "model": "snapshot-model"})}],
            "busy": None, "error": None, "auto_mode": False, "run_complete": False}
        snapshot = server.DATA / "traces" / "current" / "session.json"
        snapshot.parent.mkdir(parents=True)
        snapshot.write_text(json.dumps(archived))
        restored = server.load_state()
        self.assertEqual(json.loads(restored["entries"][0]["current_text"])["model"], "snapshot-model")

    def test_new_trace_uses_default_without_inheriting_prior_model(self):
        old = self.get()
        old_request = json.loads(old["entries"][0]["current_text"])
        self.assertEqual(old_request["model"], "test-model")
        self.post("new-trace", {"id": "fresh-e111", "name": "~/metri/E111"})
        self.assertEqual(self.get_traces()["active"], "fresh-e111")
        fresh = self.get()
        self.assertFalse(fresh["auto_generate"])
        request = json.loads(fresh["entries"][0]["current_text"])
        self.assertEqual(request["model"], "gpt-6-sol")
        self.assertEqual(request["access_programs"], {"cyber": "daybreak_blue"})
        self.assertNotIn("tools", request)
        self.assertEqual(len(fresh["entries"]), 1)
        self.assertTrue((server.DATA / "traces" / "current" / "session.json").is_file())
        self.assertEqual(self.target_requests, [])
        with self.assertRaises(urllib.error.HTTPError) as error:
            self.post("new-trace", {"id": "fresh-e111", "name": "duplicate"})
        self.assertEqual(error.exception.code, 400)
        error.exception.close()
        self.post("select-trace", {"id": "current"})
        self.assertEqual(json.loads(self.get()["entries"][0]["current_text"])["model"], "test-model")

    def test_no_target_call_until_exact_request_approved_and_edits_replayed(self):
        state = self.get()
        self.assertEqual(len(self.target_requests), 0)
        opening = state["entries"][0]
        request = json.loads(opening["current_text"])
        request["input"][0]["content"] = "Investigate the workspace."
        request["temperature"] = .42
        self.post("edit", {"id": opening["id"], "text": json.dumps(request)})
        self.assertEqual(len(self.target_requests), 0)
        self.post("approve", {"id": opening["id"]})
        state = self.await_idle()
        self.assertEqual(len(self.target_requests), 1)
        self.assertEqual(self.target_requests[0]["temperature"], .42)

        gray = state["entries"][-1]
        edited = json.loads(gray["current_text"])
        edited["output"][1]["arguments"] = '{"edited":true}'
        self.post("edit", {"id": gray["id"], "text": json.dumps(edited)})
        next_request = copy.deepcopy(request)
        next_request["input"] += [edited["output"][1], {
            "type": "function_call_output", "call_id": "call_1", "output": '{"stdout":"suggested"}'
        }]
        self.post("codex-draft", {"request": next_request})
        state = self.get()
        self.assertEqual(len(self.target_requests), 1)

        draft = state["entries"][-1]
        self.assertEqual(draft["status"], "draft")
        next_request = json.loads(draft["current_text"])
        self.assertEqual(next_request["input"][-2]["arguments"], '{"edited":true}')
        self.assertFalse(any(item.get("type") == "reasoning" for item in next_request["input"]))
        next_request["input"][-1]["output"] = '{"stdout":"human approved edit"}'
        self.post("edit", {"id": draft["id"], "text": json.dumps(next_request)})
        self.assertEqual(len(self.target_requests), 1)
        self.post("approve", {"id": draft["id"]})
        self.await_idle()
        self.assertEqual(len(self.target_requests), 2)
        self.assertEqual(self.target_requests[1]["input"][-1]["output"], '{"stdout":"human approved edit"}')
        self.assertEqual(self.target_requests[1]["input"][-2]["arguments"], '{"edited":true}')

    def test_model_swap_replaces_gray_and_archives_following_draft(self):
        first = json.loads(self.get()["entries"][0]["current_text"])
        first["input"][0]["content"] = "Investigate"
        self.post("approve", {"id": 1, "text": json.dumps(first)})
        self.await_idle()
        gray = self.get()["entries"][-1]
        draft = copy.deepcopy(first)
        draft["input"] += json.loads(gray["current_text"])["output"] + [
                           {"type": "function_call_output", "call_id": "call_1", "output": "{}"}]
        self.post("codex-draft", {"request": draft})
        original = json.loads(gray["current_text"])
        seen = []
        def fake_model(request, option):
            seen.append((copy.deepcopy(request), option))
            return {"model": option["model"], "output": [
                {"type": "reasoning", "content": [{"type": "reasoning_text", "text": "I should inspect."}]},
                {"type": "function_call", "name": "setup", "call_id": "call_glm", "arguments": "{}"}]}
        server.call_swap_model = fake_model
        with mock.patch.dict("os.environ", {"OPENROUTER_API_KEY": ""}):
            self.post("swap-model", {"id": gray["id"], "option": "glm-high", "api_key": "test-key"})
            state = self.await_idle()
        self.assertEqual(server.openrouter_key(), "test-key")
        swapped = json.loads(state["entries"][1]["current_text"])
        self.assertEqual(len(seen), 1)
        self.assertEqual(seen[0][1]["model"], "z-ai/glm-5.3")
        self.assertEqual(len(self.target_requests), 1)
        self.assertEqual(swapped["model"], "z-ai/glm-5.3")
        self.assertEqual(swapped["output"][0]["content"][0]["text"], "I should inspect.")
        self.assertEqual(len(state["entries"]), 2)
        self.assertNotEqual(swapped["output"], original["output"])
        events = [json.loads(line) for line in server.EVENTS_FILE.read_text().splitlines()]
        self.assertNotIn("test-key", server.EVENTS_FILE.read_text() + server.STATE_FILE.read_text())
        swap = next(event for event in events if event["kind"] == "gray_swapped")
        self.assertEqual(swap["removed_ids"], [3])

        self.assertEqual(len(json.loads((server.DATA / swap["archive"] / "session.json").read_text())["entries"]), 3)
        with urllib.request.urlopen(self.base + f"/api/response-variants?id={gray['id']}") as reply:
            variants = json.load(reply)["variants"]
        self.assertEqual(len(variants), 2)
        self.assertEqual([item["number"] for item in variants], [1, 2])
        self.assertEqual(self.get()["version_numbers"][str(gray["id"])], 2)
        self.assertFalse(variants[0]["active"])
        self.assertTrue(variants[1]["active"])
        self.assertEqual(variants[0]["model"], original.get("model", "Unknown model"))
        self.post("select-response-variant", {"id": gray["id"], "variant": variants[0]["id"]})
        restored = self.get()
        self.assertEqual(json.loads(restored["entries"][1]["current_text"])["output"], original["output"])
        self.assertEqual(restored["version_numbers"][str(gray["id"])], 1)
        self.assertEqual(len(self.target_requests), 1)
        with urllib.request.urlopen(self.base + f"/api/response-variants?id={gray['id']}") as reply:
            variants_after = json.load(reply)["variants"]
        self.assertIn("z-ai/glm-5.3", [item["model"] for item in variants_after])
        self.assertEqual([item["number"] for item in variants_after], [1, 2])
        self.assertTrue(variants_after[0]["active"])

    def test_refresh_gray_regenerates_its_response_not_a_blue_draft(self):
        first = json.loads(self.get()["entries"][0]["current_text"])
        first["input"][0]["content"] = "Investigate"
        self.post("approve", {"id": 1, "text": json.dumps(first)})
        self.await_idle()
        gray = self.get()["entries"][-1]
        draft = copy.deepcopy(first)
        draft["input"] += json.loads(gray["current_text"])["output"] + [
            {"type": "function_call_output", "call_id": "call_1", "output": "{}"}]
        self.post("codex-draft", {"request": draft})
        self.post("refresh-response", {"id": gray["id"]})
        state = self.await_idle()
        self.assertEqual(len(self.target_requests), 2)
        self.assertEqual(self.target_requests[1], self.target_requests[0])
        self.assertEqual([entry["side"] for entry in state["entries"]], ["blue", "gray"])
        self.assertEqual(len(self.variants(gray["id"])), 2)
        events = [json.loads(line) for line in server.EVENTS_FILE.read_text().splitlines()]
        self.assertTrue(any(event["kind"] == "gray_regenerated" for event in events))

    def test_refresh_gray_keeps_selected_swap_model(self):
        first = json.loads(self.get()["entries"][0]["current_text"])
        first["input"][0]["content"] = "Investigate"
        self.post("approve", {"id": 1, "text": json.dumps(first)})
        self.await_idle()
        seen = []
        def fake_model(request, option):
            seen.append(option["id"])
            return {"model": option["model"], "output": [{"type": "message", "role": "assistant",
                    "content": [{"type": "output_text", "text": "Alternative"}]}]}
        server.call_swap_model = fake_model
        self.post("swap-model", {"id": 2, "option": "sol-high"})
        self.await_idle()
        self.post("refresh-response", {"id": 2})
        state = self.await_idle()
        self.assertEqual(seen, ["sol-high", "sol-high"])
        self.assertEqual(len(self.target_requests), 1)
        self.assertEqual(len(state["entries"]), 2)
        self.assertEqual(len(self.variants(2)), 3)

    def test_model_swap_can_replace_earlier_gray_without_retaining_later_outputs(self):
        first = json.loads(self.get()["entries"][0]["current_text"])
        first["input"][0]["content"] = "Investigate"
        self.post("approve", {"id": 1, "text": json.dumps(first)})
        self.await_idle()
        gray = self.get()["entries"][-1]
        next_request = copy.deepcopy(first)
        next_request["input"] += json.loads(gray["current_text"])["output"] + [
            {"type": "function_call_output", "call_id": "call_1", "output": "{}"}]
        self.post("codex-draft", {"request": next_request})
        self.post("approve", {"id": 3})
        self.await_idle()
        self.assertEqual(len(self.get()["entries"]), 4)
        seen = []
        def fake_model(request, option):
            seen.append(option["id"])
            return {"model": option["model"], "output": [{"type": "message", "role": "assistant",
                    "content": [{"type": "output_text", "text": "Changed direction"}]}]}
        server.call_swap_model = fake_model
        self.post("swap-model", {"id": 2, "option": "sol-high"})
        state = self.await_idle()
        self.assertEqual(seen, ["sol-high"])
        self.assertEqual(len(self.target_requests), 2)
        self.assertEqual(len(state["entries"]), 2)
        self.assertIn("Changed direction", state["entries"][1]["current_text"])
        events = [json.loads(line) for line in server.EVENTS_FILE.read_text().splitlines()]
        swap = next(event for event in events if event["kind"] == "gray_swapped")
        self.assertEqual(swap["removed_ids"], [3, 4])
        self.assertEqual(len(json.loads((server.DATA / swap["archive"] / "session.json").read_text())["entries"]), 4)

    def test_auto_send_requires_explicit_session_switch_and_logs_exact_request(self):
        opening = self.get()["entries"][0]
        request = json.loads(opening["current_text"])
        request["input"][0]["content"] = "A local research task"
        with self.assertRaises(urllib.error.HTTPError) as error:
            self.post("auto-send", {"id": opening["id"], "text": json.dumps(request)})
        self.assertEqual(error.exception.code, 400)
        error.exception.close()
        self.assertEqual(self.target_requests, [])
        self.post("auto-mode", {"enabled": True})
        self.assertTrue(self.get()["auto_mode"])
        self.post("auto-send", {"id": opening["id"], "text": json.dumps(request)})
        self.await_idle()
        self.assertEqual(self.target_requests, [request])
        events = [json.loads(line) for line in server.EVENTS_FILE.read_text().splitlines()]
        self.assertEqual([e for e in events if e["kind"] == "auto_send"][0]["exact_request"], request)
        self.post("auto-mode", {"enabled": False})
        self.assertFalse(self.get()["auto_mode"])
        self.post("complete-run", {})
        self.assertTrue(self.get()["run_complete"])
        self.assertFalse(self.get()["auto_mode"])
        self.post("refresh-draft", {"id": self.get()["entries"][-1]["id"]})
        self.assertFalse(self.get()["run_complete"])

    def test_auto_mode_wakes_auditor_after_target_response(self):
        opening = self.get()["entries"][0]
        request = json.loads(opening["current_text"])
        request["input"][0]["content"] = "Investigate"
        with mock.patch.object(server, "notify_codex") as wake:
            self.post("auto-mode", {"enabled": True})
            self.post("auto-send", {"id": opening["id"], "text": json.dumps(request)})
            self.await_idle()
            for _ in range(100):
                if wake.called:
                    break
                time.sleep(.01)
            self.assertTrue(wake.called)
            self.assertIn("Auto mode is enabled", wake.call_args.args[0])
            wake.reset_mock()
            self.post("auto-mode", {"enabled": False})
            self.post("auto-mode", {"enabled": True})
            for _ in range(100):
                if wake.called:
                    break
                time.sleep(.01)
            self.assertTrue(wake.called)
            self.assertIn("gray response pending", wake.call_args.args[0])

    def test_auto_generate_off_waits_for_explicit_draft_request(self):
        first = json.loads(self.get()["entries"][0]["current_text"])
        first["input"][0]["content"] = "Investigate"
        with mock.patch.object(server, "notify_codex") as wake:
            self.post("auto-generate", {"enabled": False})
            self.post("auto-mode", {"enabled": True})
            self.post("auto-send", {"id": 1, "text": json.dumps(first)})
            state = self.await_idle()
            self.assertEqual(len(state["entries"]), 2)
            self.assertEqual(state["entries"][-1]["side"], "gray")
            self.assertFalse(state["draft_pending"])
            self.assertFalse(wake.called)
            self.post("draft-source", {"source": "api"})
            self.assertFalse(self.get()["draft_pending"])
            self.post("draft-source", {"source": "codex"})
            self.post("refresh-draft", {"id": 2})
            for _ in range(100):
                if wake.called:
                    break
                time.sleep(.01)
            self.assertTrue(wake.called)
            self.assertTrue(self.get()["draft_pending"])
            self.assertEqual(len(self.target_requests), 1)

    def test_turning_auto_generate_on_queues_waiting_gray(self):
        first = json.loads(self.get()["entries"][0]["current_text"])
        first["input"][0]["content"] = "Investigate"
        with mock.patch.object(server, "notify_codex") as wake:
            self.post("auto-generate", {"enabled": False})
            self.post("approve", {"id": 1, "text": json.dumps(first)})
            self.await_idle()
            self.assertFalse(wake.called)
            self.post("auto-generate", {"enabled": True})
            for _ in range(100):
                if wake.called:
                    break
                time.sleep(.01)
            self.assertTrue(wake.called)
            self.assertTrue(self.get()["auto_generate"])

    def test_api_drafting_waits_for_plus_when_auto_generate_off(self):
        calls = []
        def fake_api(request):
            calls.append(copy.deepcopy(request))
            if request["instructions"].startswith("You draft the next blue request"):
                proposal = {"items": [{"type": "function_call_output", "call_id": "call_1", "output": "ok"}]}
                return {"output": [{"type": "message", "content": [
                    {"type": "output_text", "text": json.dumps(proposal)}]}]}
            return {"output": [{"type": "function_call", "name": "setup",
                "call_id": "call_1", "arguments": "{}"}]}
        server.call_api = fake_api
        self.post("auto-generate", {"enabled": False})
        self.post("draft-source", {"source": "api"})
        first = json.loads(self.get()["entries"][0]["current_text"])
        first["input"][0]["content"] = "Investigate"
        self.post("approve", {"id": 1, "text": json.dumps(first)})
        state = self.await_idle()
        self.assertEqual(len(state["entries"]), 2)
        self.assertEqual(len(calls), 1)
        self.assertFalse(state["draft_pending"])
        self.post("refresh-draft", {"id": 2})
        state = self.await_draft()
        self.assertEqual(len(calls), 2)
        self.assertEqual(len(state["entries"]), 3)
        self.assertEqual(len(self.target_requests), 0)

    def test_api_source_creates_editable_draft_without_sending_target(self):
        calls = []

        def fake_api(request):
            calls.append(copy.deepcopy(request))
            if request["instructions"].startswith("You draft the next blue request"):
                return {"output": [{"type": "message", "content": [{"type": "output_text",
                    "text": json.dumps({"items": [{"type": "function_call_output",
                        "call_id": "call_1", "output": '{"ok":true}'}]})}]}]}
            if len([item for item in calls if not item["instructions"].startswith("You draft")]) == 1:
                return {"output": [{"type": "function_call", "name": "setup",
                    "call_id": "call_1", "arguments": "{}"}]}
            return {"output": [{"type": "message", "role": "assistant", "content": [
                {"type": "output_text", "text": "Done"}]}]}

        server.call_api = fake_api
        self.post("draft-source", {"source": "api"})
        opening = self.get()["entries"][0]
        first = json.loads(opening["current_text"])
        first["input"][0]["content"] = "Investigate"
        self.post("approve", {"id": 1, "text": json.dumps(first)})
        state = self.await_draft()
        self.assertEqual(state["draft_source"], "api")
        self.assertFalse(state["draft_pending"])
        self.assertEqual(len(state["entries"]), 3)
        auditor_request = next(item for item in calls if item["instructions"].startswith("You draft"))
        self.assertEqual(json.loads(auditor_request["input"][0]["content"])["send_mode"],
                         "manual with human approval")
        self.assertEqual(len([item for item in calls if item["instructions"] == "Test instructions"]), 1)
        draft = json.loads(state["entries"][-1]["current_text"])
        self.assertEqual(draft["input"][-1]["output"], '{"ok":true}')
        self.assertEqual(draft["model"], "test-model")
        self.post("approve", {"id": 3, "text": json.dumps(draft)})
        self.await_idle()
        self.assertEqual(len([item for item in calls if item["instructions"] == "Test instructions"]), 2)

    def test_api_drafter_can_ask_auditor_then_resume_without_sending(self):
        target_calls = []
        auditor_calls = []

        def fake_api(request):
            if request["instructions"].startswith("You draft the next blue request"):
                auditor_calls.append(copy.deepcopy(request))
                context = json.loads(request["input"][0]["content"])
                proposal = ({"question": "What does setup return in this virtual environment?"}
                            if not context.get("auditor_exchange") else
                            {"items": [{"type": "function_call_output", "call_id": "call_1",
                                        "output": context["auditor_exchange"][-1]["answer"]}]})
                return {"output": [{"type": "message", "content": [
                    {"type": "output_text", "text": json.dumps(proposal)}]}]}
            target_calls.append(copy.deepcopy(request))
            return {"output": [{"type": "function_call", "name": "setup",
                "call_id": "call_1", "arguments": "{}"}]}

        server.call_api = fake_api
        self.post("draft-source", {"source": "api"})
        first = json.loads(self.get()["entries"][0]["current_text"])
        first["input"][0]["content"] = "Investigate"
        self.post("approve", {"id": 1, "text": json.dumps(first)})
        for _ in range(100):
            state = self.get()
            if state["auditor_exchange"]:
                break
            time.sleep(.02)
        self.assertEqual(state["entries"][-1]["side"], "gray")
        self.assertFalse(state["draft_pending"])
        self.assertEqual(len(target_calls), 1)
        self.assertEqual(state["auditor_exchange"][-1]["question"],
                         "What does setup return in this virtual environment?")
        self.assertEqual(state["auditor_history"][-1]["after_gray_id"], 2)
        self.assertIsNone(state["auditor_history"][-1]["answer"])
        self.post("auto-mode", {"enabled": True})
        self.assertEqual(self.get()["auditor_exchange"], state["auditor_exchange"])
        self.assertEqual(len(auditor_calls), 1)
        self.post("auto-mode", {"enabled": False})
        with self.assertRaises(urllib.error.HTTPError) as error:
            self.post("auditor-answer", {"generation": state["draft_generation"] - 1,
                                         "answer": '{"ok":true}'})
        self.assertEqual(error.exception.code, 400)
        error.exception.close()
        self.post("auditor-answer", {"generation": state["draft_generation"],
                                     "answer": '{"ok":true}'})
        draft = self.await_draft()
        self.assertEqual(json.loads(draft["entries"][-1]["current_text"])["input"][-1]["output"],
                         '{"ok":true}')
        self.assertEqual(draft["auditor_history"][-1]["answer"], '{"ok":true}')
        self.assertEqual(len(target_calls), 1)
        self.assertEqual(len(auditor_calls), 2)
        self.post("approve", {"id": draft["entries"][-1]["id"]})
        for _ in range(100):
            if len(auditor_calls) >= 3:
                break
            time.sleep(.02)
        self.assertEqual(len(auditor_calls), 3)
        later_context = json.loads(auditor_calls[-1]["input"][0]["content"])
        self.assertEqual(later_context["prior_auditor_answers"][-1]["answer"], '{"ok":true}')

    def test_switching_off_api_discards_inflight_draft(self):
        started = threading.Event()
        release = threading.Event()

        def fake_api(request):
            if request["instructions"].startswith("You draft the next blue request"):
                started.set()
                release.wait(2)
                return {"output": [{"type": "message", "content": [{"type": "output_text",
                    "text": json.dumps({"items": [{"type": "function_call_output",
                        "call_id": "call_1", "output": "reply"}]})}]}]}
            return {"output": [{"type": "function_call", "name": "setup",
                "call_id": "call_1", "arguments": "{}"}]}

        server.call_api = fake_api
        self.post("draft-source", {"source": "api"})
        opening = self.get()["entries"][0]
        first = json.loads(opening["current_text"])
        first["input"][0]["content"] = "Investigate"
        self.post("approve", {"id": 1, "text": json.dumps(first)})
        self.assertTrue(started.wait(2))
        self.post("draft-source", {"source": "codex"})
        release.set()
        for _ in range(100):
            if any(json.loads(line)["kind"] == "api_draft_discarded"
                   for line in server.EVENTS_FILE.read_text().splitlines()):
                break
            time.sleep(.02)
        state = self.get()
        self.assertEqual(state["draft_source"], "codex")
        self.assertFalse(state["draft_pending"])
        self.assertEqual(len(state["entries"]), 2)

    def test_api_draft_never_auto_sends_without_auditor_review(self):
        target_calls = []

        def fake_api(request):
            if request["instructions"].startswith("You draft the next blue request"):
                return {"output": [{"type": "message", "content": [{"type": "output_text",
                    "text": json.dumps({"items": [{"type": "function_call_output",
                        "call_id": "call_1", "output": "reply"}]})}]}]}
            target_calls.append(copy.deepcopy(request))
            return {"output": [{"type": "function_call", "name": "setup",
                "call_id": "call_1", "arguments": "{}"}]}

        server.call_api = fake_api
        self.post("draft-source", {"source": "api"})
        self.post("auto-mode", {"enabled": True})
        first = json.loads(self.get()["entries"][0]["current_text"])
        first["input"][0]["content"] = "Investigate"
        self.post("auto-send", {"id": 1, "text": json.dumps(first)})
        state = self.await_draft()
        self.assertTrue(state["auto_mode"])
        self.assertEqual(len(target_calls), 1)
        self.assertEqual(state["entries"][-1]["status"], "draft")

    def test_edit_during_api_generation_does_not_publish_stale_draft(self):
        started = threading.Event()
        release = threading.Event()

        def fake_api(request):
            if request["instructions"].startswith("You draft the next blue request"):
                started.set()
                release.wait(2)
                return {"output": [{"type": "message", "content": [{"type": "output_text",
                    "text": json.dumps({"items": [{"type": "function_call_output",
                        "call_id": "call_1", "output": "old reply"}]})}]}]}
            return {"output": [{"type": "function_call", "name": "setup",
                "call_id": "call_1", "arguments": "{}"}]}

        server.call_api = fake_api
        self.post("draft-source", {"source": "api"})
        first = json.loads(self.get()["entries"][0]["current_text"])
        first["input"][0]["content"] = "Investigate"
        self.post("approve", {"id": 1, "text": json.dumps(first)})
        self.assertTrue(started.wait(2))
        gray = self.get()["entries"][-1]
        changed = json.loads(gray["current_text"])
        changed["output"][0]["arguments"] = '{"changed":true}'
        self.post("edit", {"id": gray["id"], "text": json.dumps(changed)})
        release.set()
        for _ in range(100):
            if any(json.loads(line)["kind"] == "api_draft_discarded"
                   for line in server.EVENTS_FILE.read_text().splitlines()):
                break
            time.sleep(.02)
        state = self.get()
        self.assertEqual(len(state["entries"]), 2)
        self.assertFalse(state["draft_pending"])
        self.assertIn("Conversation changed", state["draft_error"])

    def test_refresh_replaces_blue_draft_without_target_call(self):
        opening = self.get()["entries"][0]
        request = json.loads(opening["current_text"])
        request["input"][0]["content"] = "Investigate"
        self.post("approve", {"id": opening["id"], "text": json.dumps(request)})
        gray = self.await_idle()["entries"][-1]
        draft = copy.deepcopy(request)
        draft["input"] += json.loads(gray["current_text"])["output"] + [
            {"type": "function_call_output", "call_id": "call_1", "output": "reply"}
        ]
        blue = self.post("codex-draft", {"request": draft})["entry"]
        self.post("refresh-draft", {"id": blue["id"]})
        state = self.get()
        self.assertEqual(state["entries"][-1]["side"], "gray")
        self.assertEqual(state["next_id"], 3)
        self.assertEqual(len(self.target_requests), 1)
        replacement = self.post("codex-draft", {"request": draft})["entry"]
        self.assertEqual(replacement["id"], blue["id"])
        self.assertEqual(replacement["status"], "draft")
        self.assertEqual(len(self.target_requests), 1)

    def test_approve_sends_current_editor_text_without_autosave(self):
        opening = self.get()["entries"][0]
        request = json.loads(opening["current_text"])
        request["input"][0]["content"] = "Latest visible text"
        request["temperature"] = .31
        self.post("approve", {"id": opening["id"], "text": json.dumps(request)})
        self.await_idle()
        self.assertEqual(self.target_requests, [request])
        self.assertEqual(json.loads(self.get()["entries"][0]["current_text"]), request)

    def test_editing_gray_marks_blue_stale_until_refresh(self):
        opening = self.get()["entries"][0]
        request = json.loads(opening["current_text"])
        request["input"][0]["content"] = "Investigate"
        self.post("approve", {"id": opening["id"], "text": json.dumps(request)})
        gray = self.await_idle()["entries"][-1]
        output = json.loads(gray["current_text"])["output"]
        draft = copy.deepcopy(request)
        draft["input"] += output + [{"type": "function_call_output", "call_id": "call_1", "output": "reply"}]
        blue = self.post("codex-draft", {"request": draft})["entry"]

        edited = json.loads(gray["current_text"])
        edited["output"][1]["arguments"] = '{"changed":true}'
        self.post("edit", {"id": gray["id"], "text": json.dumps(edited)})
        state = self.get()
        self.assertEqual([entry["id"] for entry in state["entries"]], [1, 2, 3])
        self.assertEqual(state["entries"][-1]["status"], "stale")
        self.assertEqual(state["next_id"], 4)
        self.assertEqual(json.loads(state["entries"][-1]["current_text"])["input"][-2]["arguments"], '{"changed":true}')
        with self.assertRaises(urllib.error.HTTPError) as error:
            self.post("approve", {"id": blue["id"], "text": blue["current_text"]})
        self.assertEqual(error.exception.code, 400)
        error.exception.close()
        self.assertEqual(len(self.target_requests), 1)
        self.post("refresh-draft", {"id": blue["id"]})
        state = self.get()
        self.assertEqual([entry["id"] for entry in state["entries"]], [1, 2])
        self.assertEqual(state["next_id"], 3)
        replacement = copy.deepcopy(request)
        replacement["input"] += [edited["output"][1], {
            "type": "function_call_output", "call_id": "call_1", "output": "new reply"
        }]
        new_blue = self.post("codex-draft", {"request": replacement})["entry"]
        self.assertEqual(new_blue["id"], blue["id"])
        self.assertEqual(json.loads(new_blue["current_text"])["input"][-2]["arguments"], '{"changed":true}')

    def test_earlier_edits_rebase_later_requests_without_deleting_turns(self):
        opening = self.get()["entries"][0]
        first = json.loads(opening["current_text"])
        first["input"][0]["content"] = "Original task"
        self.post("approve", {"id": opening["id"], "text": json.dumps(first)})
        gray1 = self.await_idle()["entries"][-1]
        second = copy.deepcopy(first)
        second["input"] += json.loads(gray1["current_text"])["output"] + [
            {"type": "function_call_output", "call_id": "call_1", "output": "tool reply"}
        ]
        blue2 = self.post("codex-draft", {"request": second})["entry"]
        second["input"][0]["content"] = "Downstream wording"
        self.post("edit", {"id": blue2["id"], "text": json.dumps(second)})
        self.post("approve", {"id": blue2["id"]})
        gray2 = self.await_idle()["entries"][-1]
        third = copy.deepcopy(second)
        third["input"] += json.loads(gray2["current_text"])["output"]
        third["temperature"] = .37
        blue3 = self.post("codex-draft", {"request": third})["entry"]
        third["max_output_tokens"] = 321
        self.post("start-edit", {"id": blue3["id"]})
        self.post("confirm-edit", {"id": blue3["id"], "text": json.dumps(third)})

        edited_gray = json.loads(gray1["current_text"])
        edited_gray["output"][1]["arguments"] = '{"edited":true}'
        self.post("edit", {"id": gray1["id"], "text": json.dumps(edited_gray)})
        state = self.get()
        self.assertEqual(len(state["entries"]), 5)
        self.assertEqual(state["entries"][-1]["status"], "draft")
        for entry in (state["entries"][2], state["entries"][4]):
            request = json.loads(entry["current_text"])
            self.assertEqual(request["input"][1]["arguments"], '{"edited":true}')
            self.assertEqual(request["input"][0]["content"], "Downstream wording")
        self.assertEqual(json.loads(state["entries"][4]["current_text"])["temperature"], .37)
        active = next(item for item in state["entries"][4]["versions"]
                      if item["id"] == state["entries"][4]["active_version"])
        self.assertEqual(active["raw"], state["entries"][4]["current_text"])

        edited_first = json.loads(state["entries"][0]["current_text"])
        edited_first["input"][0]["content"] = "Revised task"
        self.post("edit", {"id": opening["id"], "text": json.dumps(edited_first)})
        state = self.get()
        self.assertEqual(len(state["entries"]), 5)
        for entry in (state["entries"][0], state["entries"][2], state["entries"][4]):
            self.assertEqual(json.loads(entry["current_text"])["input"][0]["content"], "Revised task")
        self.assertEqual(json.loads(state["entries"][4]["current_text"])["temperature"], .37)
        self.assertEqual(len(self.target_requests), 2)

    def test_rewind_deletes_later_messages_without_sending(self):
        opening = self.get()["entries"][0]
        first_request = json.loads(opening["current_text"])
        first_request["input"][0]["content"] = "Investigate"
        self.post("approve", {"id": opening["id"], "text": json.dumps(first_request)})
        gray = self.await_idle()["entries"][-1]
        draft = copy.deepcopy(first_request)
        draft["input"] += json.loads(gray["current_text"])["output"] + [
            {"type": "function_call_output", "call_id": "call_1", "output": "reply"}
        ]
        blue = self.post("codex-draft", {"request": draft})["entry"]
        self.post("approve", {"id": blue["id"]})
        response = self.await_idle()["entries"][-1]
        self.assertEqual(len(self.target_requests), 2)

        with mock.patch.object(server, "notify_codex") as notification:
            self.post("rewind", {"id": gray["id"], "notify": False})
            notification.assert_not_called()
        state = self.get()
        self.assertEqual([e["id"] for e in state["entries"]], [opening["id"], gray["id"]])
        self.assertEqual(state["next_id"], 3)
        self.assertEqual(state["entries"][-1]["side"], "gray")
        self.assertEqual(len(self.target_requests), 2)
        replacement = self.post("codex-draft", {"request": draft})["entry"]
        self.assertEqual(replacement["id"], 3)

        self.post("rewind", {"id": opening["id"]})
        state = self.get()
        self.assertEqual([e["id"] for e in state["entries"]], [opening["id"]])
        self.assertEqual(state["entries"][0]["status"], "draft")
        self.assertEqual(state["next_id"], 2)
        self.assertEqual(len(self.target_requests), 2)
        with self.assertRaises(urllib.error.HTTPError) as error:
            self.post("rewind", {"id": response["id"]})
        self.assertEqual(error.exception.code, 400)
        error.exception.close()


if __name__ == "__main__":
    unittest.main()
