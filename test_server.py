"""End-to-end checks for the approval and edit boundary, without API spend."""

import copy
import json
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
from pathlib import Path
from unittest import mock

from review_room import server


class ReviewRoomTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.original = (server.DATA, server.STATE_FILE, server.EVENTS_FILE, server.call_api, server.CODEX_THREAD_ID)
        server.DATA = Path(self.tmp.name)
        server.STATE_FILE = server.DATA / "session.json"
        server.EVENTS_FILE = server.DATA / "events.jsonl"
        server.CODEX_THREAD_ID = None
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
        server.DATA, server.STATE_FILE, server.EVENTS_FILE, server.call_api, server.CODEX_THREAD_ID = self.original
        self.tmp.cleanup()

    def get(self):
        with urllib.request.urlopen(self.base + "/api/state") as reply:
            return json.load(reply)

    def get_traces(self):
        with urllib.request.urlopen(self.base + "/api/traces") as reply:
            return json.load(reply)

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

    def test_trace_names_and_switch_preserve_each_conversation(self):
        opening = self.get()
        card = server.DATA / "EXPERIMENT_CARD.md"
        self.assertIn("## System prompt", card.read_text())
        self.assertEqual(self.get_traces()["active"], "current")
        self.post("rename-trace", {"name": "~/better-petri/E110"})
        self.assertEqual(self.get_traces()["traces"][0]["name"], "~/better-petri/E110")
        request = json.loads(opening["entries"][0]["current_text"])
        request["instructions"] = "Changed first prompt"
        request["temperature"] = 0.42
        self.post("edit", {"id": 1, "text": json.dumps(request)})
        self.assertIn("Changed first prompt", card.read_text())
        self.assertIn('"temperature": 0.42', card.read_text())
        self.post("experiment-note", {"note": "AI description of the local setup.", "references": [
            {"label": "Instructions", "path": "review_room/README.md"}]})
        self.assertIn("AI description of the local setup.", card.read_text())

        other = copy.deepcopy(opening)
        other["entries"][0]["current_text"] = json.dumps({**server.default_request(), "input": [
            {"role": "user", "content": "Archived trace"}]})
        other.pop("saved_at")
        directory = server.DATA / "traces" / "archive"
        directory.mkdir(parents=True)
        (directory / "session.json").write_text(json.dumps(other))
        catalog = self.get_traces()
        catalog["traces"].append({"id": "archive", "name": "~/better-petri/archive"})
        server.save_traces(catalog)

        self.post("select-trace", {"id": "archive"})
        self.assertEqual(self.get_traces()["active"], "archive")
        self.assertEqual(json.loads(self.get()["entries"][0]["current_text"])["input"][0]["content"], "Archived trace")
        self.assertNotIn("AI description of the local setup.", card.read_text())
        self.assertTrue((server.DATA / "traces" / "current" / "session.json").is_file())
        self.post("select-trace", {"id": "current"})
        self.assertEqual(self.get_traces()["active"], "current")
        self.assertEqual(json.loads(self.get()["entries"][0]["current_text"])["instructions"], "Changed first prompt")
        self.assertIn("AI description of the local setup.", card.read_text())
        self.assertTrue((server.DATA / "traces" / "current" / "EXPERIMENT_CARD.md").is_file())
        self.assertEqual(self.target_requests, [])

    def test_new_trace_uses_log_then_card_then_blank_request(self):
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
        self.assertEqual(blank_request["model"], "")
        self.assertNotIn("access_programs", blank_request)
        self.assertNotIn("tools", blank_request)
        self.assertNotIn("max_output_tokens", blank_request)
        archived = {"version": 1, "next_id": 2, "entries": [{
            "id": 1, "side": "blue", "status": "draft", "revision": 0,
            "current_text": json.dumps({**blank_request, "model": "snapshot-model"})}],
            "busy": None, "error": None, "auto_mode": False, "run_complete": False}
        snapshot = server.DATA / "traces" / "current" / "session.json"
        snapshot.parent.mkdir(parents=True)
        snapshot.write_text(json.dumps(archived))
        restored = server.load_state()
        self.assertEqual(json.loads(restored["entries"][0]["current_text"])["model"], "snapshot-model")

    def test_new_trace_starts_blank_without_inheriting_prior_model(self):
        old = self.get()
        old_request = json.loads(old["entries"][0]["current_text"])
        self.assertEqual(old_request["model"], "test-model")
        self.post("new-trace", {"id": "fresh-e111", "name": "~/better-petri/E111"})
        self.assertEqual(self.get_traces()["active"], "fresh-e111")
        fresh = self.get()
        request = json.loads(fresh["entries"][0]["current_text"])
        self.assertEqual(request["model"], "")
        self.assertNotIn("access_programs", request)
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
