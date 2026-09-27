import email.message
import http.server
import io
import json
import logging
import os
import pathlib
import socket
import subprocess
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch

import endpoint_monitor_watchdog as w

NOW = 1800000000
FINGERPRINT = "sha256:" + "a" * 64
GOOD = w.observation(True, "fresh")
BAD = w.observation(False, "http-network-error")


def timestamp(value):
    return w.datetime.datetime.fromtimestamp(value, w.UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def payload(now=NOW):
    return {"enabled": True, "deliveryEnabled": True, "readAt": timestamp(now), "configurationRevision": 1,
            "configurationFingerprint": FINGERPRINT,
            "execution": {"state": "fresh", "freshUntil": timestamp(now + 120), "expectedIntervalSeconds": 60,
                          "lastRun": {"enabled": True, "scheduledAt": timestamp(now - 60), "startedAt": timestamp(now - 50),
                                      "completedAt": timestamp(now - 49), "targetCount": 20, "phaseErrors": 0, "deliveriesFailed": 0,
                                      "configurationRevision": 1, "configFingerprint": FINGERPRINT, "failedProbes": 3}}}


class EvaluationTests(unittest.TestCase):
    def test_target_failures_do_not_mean_scheduler_failure(self):
        self.assertTrue(w.evaluate(payload(), NOW)["healthy"])

    def test_local_clock_ages_a_response_claiming_fresh(self):
        data = payload()
        data["readAt"] = timestamp(NOW + 120)
        self.assertEqual(w.evaluate(data, NOW + 120)["reason"], "run-stale")

    def test_disabled_errors_clocks_and_configuration(self):
        cases = [(["enabled"], False, "monitor-disabled"), (["deliveryEnabled"], False, "delivery-disabled"),
                 (["execution", "lastRun", "phaseErrors"], 1, "monitor-phase-error"),
                 (["execution", "lastRun", "deliveriesFailed"], 1, "monitor-delivery-error"),
                 (["execution", "lastRun", "completedAt"], timestamp(NOW + 31), "run-clock-invalid"),
                 (["readAt"], timestamp(NOW - 31), "response-clock-invalid"),
                 (["execution", "freshUntil"], timestamp(NOW + 999), "run-cadence-invalid"),
                 (["execution", "lastRun", "targetCount"], 0, "no-targets"),
                 (["configurationRevision"], 2, "configuration-not-observed"),
                 (["configurationFingerprint"], "sha256:" + "b" * 64, "configuration-not-observed"),
                 (["execution", "lastRun"], None, "run-unobserved")]
        for keys, value, reason in cases:
            data = payload()
            target = data
            for key in keys[:-1]:
                target = target[key]
            target[keys[-1]] = value
            with self.subTest(keys=keys):
                self.assertEqual(w.evaluate(data, NOW)["reason"], reason)

    def test_malformed_json_shapes_fail_closed(self):
        for data in (None, [], {}, {"enabled": True, "deliveryEnabled": True}, {"enabled": True, "deliveryEnabled": True, "readAt": "today"}):
            with self.subTest(data=data):
                self.assertFalse(w.evaluate(data, NOW)["healthy"])
        data = payload()
        data["execution"]["lastRun"]["phaseErrors"] = False
        self.assertEqual(w.evaluate(data, NOW)["reason"], "status-schema-invalid")
        data = payload()
        data["configurationFingerprint"] = None
        data["execution"]["lastRun"]["configFingerprint"] = None
        self.assertEqual(w.evaluate(data, NOW)["reason"], "status-schema-invalid")


class StateTests(unittest.TestCase):
    def advance(self, state, result, at):
        return w.advance(state, result, at)[0]

    def test_failure_recovery_deduplication_and_stable_retry_id(self):
        state = self.advance(w.initial_state(), BAD, NOW)
        self.assertIsNone(state["pending"])
        state = self.advance(state, BAD, NOW + 60)
        event = state["pending"]
        self.assertEqual(event["kind"], "PROBLEM")
        state = self.advance(state, BAD, NOW + 120)
        self.assertEqual(state["pending"]["id"], event["id"])
        w.acknowledge(state, event, NOW + 120)
        state = self.advance(state, BAD, NOW + 180)
        self.assertIsNone(state["pending"])
        state = self.advance(state, GOOD, NOW + 240)
        self.assertIsNone(state["pending"])
        state = self.advance(state, GOOD, NOW + 300)
        self.assertEqual(state["pending"]["kind"], "RECOVERY")
        w.acknowledge(state, state["pending"], NOW + 300)
        self.assertIsNone(state["incident"])

    def test_recovery_before_delivery_becomes_one_outage_summary(self):
        state = self.advance(w.initial_state(), BAD, NOW)
        state = self.advance(state, BAD, NOW + 60)
        state = self.advance(state, GOOD, NOW + 120)
        state = self.advance(state, GOOD, NOW + 180)
        self.assertEqual(state["pending"]["kind"], "RECOVERY")
        self.assertIsNone(state["pending"]["incident"]["problemSentAt"])
        self.assertIn("outage summary", w.mail_message(config(), state["pending"]).get_content())

    def test_rapid_manual_runs_do_not_cross_threshold_and_gaps_reset_counts(self):
        state = self.advance(w.initial_state(), BAD, NOW)
        unchanged, changed = w.advance(state, BAD, NOW + 5)
        self.assertFalse(changed)
        self.assertEqual(unchanged, state)
        state = self.advance(state, BAD, NOW + 181)
        self.assertEqual(state["failures"], 1)
        self.assertIsNone(state["incident"])
        with self.assertRaises(w.WatchdogError):
            w.advance(state, GOOD, NOW)

    def test_hourly_reminders_and_daily_heartbeats(self):
        state = self.advance(w.initial_state(), BAD, NOW)
        state = self.advance(state, BAD, NOW + 60)
        w.acknowledge(state, state["pending"], NOW + 60)
        state = self.advance(state, BAD, NOW + 3600)
        self.assertIsNone(state["pending"])
        state = self.advance(state, BAD, NOW + 3660)
        self.assertEqual(state["pending"]["kind"], "REMINDER")
        state = self.advance(w.initial_state(), GOOD, NOW)
        state = self.advance(state, GOOD, NOW + 60)
        self.assertEqual(state["pending"]["kind"], "HEARTBEAT")
        w.acknowledge(state, state["pending"], NOW + 60)
        state = self.advance(state, GOOD, NOW + 86400)
        self.assertIsNone(state["pending"])
        state = self.advance(state, GOOD, NOW + 86460)
        self.assertEqual(state["pending"]["kind"], "HEARTBEAT")

    def test_new_failure_cancels_pending_recovery(self):
        state = self.advance(w.initial_state(), BAD, NOW)
        state = self.advance(state, BAD, NOW + 60)
        w.acknowledge(state, state["pending"], NOW + 60)
        state = self.advance(state, GOOD, NOW + 120)
        state = self.advance(state, GOOD, NOW + 180)
        state = self.advance(state, BAD, NOW + 240)
        self.assertIsNone(state["pending"])
        self.assertIsNone(state["incident"]["recoveredAt"])


def config():
    return {"label": "Example watchdog", "status_url": "https://monitor.example.com/api/status", "status_token_file": "/unused/status-token",
            "sender": "sender@example.com", "recipient": "recipient@example.com", "smtp_password_file": "/unused/password"}


class RuntimeTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.directory = self.temporary.name
        self.token_path = os.path.join(self.directory, "status-token")
        pathlib.Path(self.token_path).write_text("x" * 43)
        os.chmod(self.token_path, 0o600)
        self.config = config()
        self.config["status_token_file"] = self.token_path
        self.stream = io.StringIO()
        self.log = logging.Logger("test")
        self.log.addHandler(logging.StreamHandler(self.stream))

    def tearDown(self):
        self.temporary.cleanup()

    def test_retry_survives_process_state_reload_and_logs_no_secret(self):
        delivered = []
        def send_failure(configuration, event):
            raise RuntimeError("secret-value-must-never-appear")
        for at in (NOW, NOW + 60):
            w.run_once(self.config, self.directory, self.log, clock=lambda: at, observe=lambda _: BAD, notify=send_failure)
        pending = w.load_state(os.path.join(self.directory, "state.json"))["pending"]
        result, code = w.run_once(self.config, self.directory, self.log, clock=lambda: NOW + 120, observe=lambda _: BAD, notify=lambda c, e: delivered.append(e))
        self.assertEqual(delivered[0]["id"], pending["id"])
        self.assertFalse(result["notificationPending"])
        self.assertEqual(code, 1)
        self.assertNotIn("secret-value", self.stream.getvalue())
        self.assertNotIn("example.com", self.stream.getvalue())
        self.assertEqual(os.stat(os.path.join(self.directory, "state.json")).st_mode & 0o777, 0o600)

    def test_lock_prevents_overlapping_probe_or_email(self):
        with w.state_lock(self.directory) as acquired:
            self.assertTrue(acquired)
            def forbidden(_):
                self.fail("overlapping run reached network")
            result, code = w.run_once(self.config, self.directory, self.log, observe=forbidden)
            self.assertEqual(result["event"], "overlap-skipped")
            self.assertEqual(code, 0)

    def test_private_file_permissions_symlinks_and_corrupt_state(self):
        os.chmod(self.token_path, 0o644)
        self.assertEqual(w.probe(self.config)["reason"], "status-credential-invalid")
        os.chmod(self.token_path, 0o600)
        link = os.path.join(self.directory, "link")
        os.symlink(self.token_path, link)
        with self.assertRaises(OSError):
            w.private_read(link)
        fifo = os.path.join(self.directory, "fifo")
        os.mkfifo(fifo, 0o600)
        with self.assertRaises(w.WatchdogError):
            w.private_read(fifo)
        state = os.path.join(self.directory, "state.json")
        pathlib.Path(state).write_text("{}")
        os.chmod(state, 0o600)
        with self.assertRaises(w.WatchdogError):
            w.load_state(state)

    def test_formatted_app_password_and_smtp_rejection(self):
        path = os.path.join(self.directory, "password")
        pathlib.Path(path).write_text("abcd efgh ijkl mnop\n")
        os.chmod(path, 0o600)
        self.config["smtp_password_file"] = path
        state, _ = w.advance(w.initial_state(), GOOD, NOW)
        state, _ = w.advance(state, GOOD, NOW + 60)
        with patch.object(w.smtplib, "SMTP_SSL") as connection:
            client = connection.return_value
            client.send_message.return_value = {self.config["recipient"]: (550, b"rejected")}
            with self.assertRaises(w.WatchdogError):
                w.send_mail(self.config, state["pending"])
            client.login.assert_called_once_with(self.config["sender"], "abcdefghijklmnop")
            self.assertEqual(connection.call_args[1]["context"].verify_mode, w.ssl.CERT_REQUIRED)
            self.assertTrue(connection.call_args[1]["context"].check_hostname)
            client.close.assert_called_once()

    def test_http_redirect_never_forwards_bearer(self):
        paths = []
        class Handler(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                paths.append(self.path)
                self.send_response(302)
                self.send_header("Location", "/unexpected-target")
                self.end_headers()
            def log_message(self, *args):
                pass
        server = http.server.HTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever)
        thread.start()
        try:
            self.config["status_url"] = "http://127.0.0.1:" + str(server.server_port) + "/api/status"
            result = w.probe(self.config)
            self.assertEqual(result["reason"], "http-302")
            self.assertEqual(paths, ["/api/status"])
        finally:
            server.shutdown()
            server.server_close()
            thread.join()

    def test_bounded_body_and_timeout(self):
        class Response:
            status = 200
            headers = email.message.Message()
            headers["Content-Type"] = "application/json"
            def __enter__(self):
                return self
            def __exit__(self, *args):
                pass
            def read(self, size):
                self.requested = size
                return b"x" * size
        response = Response()
        class Opener:
            def open(self, request, timeout):
                return response
        self.assertEqual(w.probe(self.config, opener=Opener())["reason"], "status-response-too-large")
        self.assertEqual(response.requested, w.MAX_RESPONSE_BYTES + 1)
        class TimeoutOpener:
            def open(self, request, timeout):
                raise socket.timeout()
        self.assertEqual(w.probe(self.config, opener=TimeoutOpener())["reason"], "http-timeout")

    def test_cli_help_options_and_configuration_errors(self):
        script = str(pathlib.Path(w.__file__))
        for option in ("-h", "--help"):
            result = subprocess.run([sys.executable, "-B", script, option], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            self.assertEqual(result.returncode, 0)
            self.assertIn(b"Exit:", result.stdout)
            self.assertEqual(result.stderr, b"")
        for options in (("check", "--bad"), ("check", "-c"), ("check", "--config="), ("check", "--state-dir=")):
            result = subprocess.run([sys.executable, "-B", script] + list(options), stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            self.assertEqual(result.returncode, 2)
        path = os.path.join(self.directory, "config.json")
        pathlib.Path(path).write_text(json.dumps(self.config))
        os.chmod(path, 0o600)
        os.unlink(self.token_path)
        for options in (("check", "-c", path), ("-c" + path, "check"), ("--config=" + path, "--", "check")):
            result = subprocess.run([sys.executable, "-B", script] + list(options), stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            self.assertEqual(result.returncode, 1)
            self.assertIn(b"status-credential-invalid", result.stdout)
            self.assertFalse(os.path.exists(os.path.join(self.directory, "state.json")))


if __name__ == "__main__":
    unittest.main()
