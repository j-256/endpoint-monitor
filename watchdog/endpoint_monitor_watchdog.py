#!/usr/bin/env python3
"""Independent cron observer for Endpoint Monitor, using only Python's standard library"""

import argparse
import copy
import datetime
import email.message
import email.utils
import http.client
import json
import logging
import logging.handlers
import os
import re
import signal
import smtplib
import socket
import ssl
import stat
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from contextlib import contextmanager

try:
    import fcntl
except ImportError:
    fcntl = None

APP = "endpoint-monitor-watchdog"
STATE_VERSION = 1
FAILURE_THRESHOLD = 2
RECOVERY_THRESHOLD = 2
MIN_SAMPLE_SECONDS = 45
MAX_SAMPLE_GAP_SECONDS = 180
MAX_AGE_SECONDS = 180
CLOCK_SKEW_SECONDS = 30
HTTP_TIMEOUT_SECONDS = 10
SMTP_TIMEOUT_SECONDS = 15
PROCESS_TIMEOUT_SECONDS = 45
MAX_RESPONSE_BYTES = 512 * 1024
MAX_PRIVATE_BYTES = 64 * 1024
MAX_LOG_BYTES = 256 * 1024
LOG_BACKUPS = 3
REMINDER_SECONDS = 3600
HEARTBEAT_SECONDS = 86400
UTC = datetime.timezone.utc


class WatchdogError(Exception):
    pass


class ProcessDeadline(WatchdogError):
    pass


def utc(value):
    return datetime.datetime.fromtimestamp(value, UTC).isoformat().replace("+00:00", "Z")


def timestamp(value):
    if not isinstance(value, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z", value):
        raise ValueError("timestamp")
    return datetime.datetime.strptime(value, "%Y-%m-%dT%H:%M:%S.%fZ").replace(tzinfo=UTC).timestamp()


def private_directory(path):
    os.makedirs(path, mode=0o700, exist_ok=True)
    entry = os.lstat(path)
    if not stat.S_ISDIR(entry.st_mode) or entry.st_uid != os.getuid() or entry.st_mode & 0o077:
        raise WatchdogError("private-directory-required")


def private_read(path, limit=MAX_PRIVATE_BYTES):
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(descriptor, "rb") as source:
        entry = os.fstat(source.fileno())
        if not stat.S_ISREG(entry.st_mode) or entry.st_uid != os.getuid() or entry.st_mode & 0o077:
            raise WatchdogError("private-file-required")
        data = source.read(limit + 1)
        if len(data) > limit:
            raise WatchdogError("private-file-too-large")
        return data.decode("utf-8")


def atomic_save(path, value):
    directory = os.path.dirname(path)
    with tempfile.NamedTemporaryFile(mode="w", dir=directory, prefix=".state-", delete=False) as output:
        temporary = output.name
        try:
            json.dump(value, output, sort_keys=True, allow_nan=False)
            output.write("\n")
            output.flush()
            os.fsync(output.fileno())
            os.replace(temporary, path)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)


def load_config(path):
    value = json.loads(private_read(path))
    required = {"label", "status_url", "status_token_file", "sender", "recipient", "smtp_password_file"}
    if not isinstance(value, dict) or set(value) != required:
        raise WatchdogError("configuration-fields-invalid")
    if not all(isinstance(item, str) and item for item in value.values()):
        raise WatchdogError("configuration-values-invalid")
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9 .:_\[\]-]{0,79}", value["label"]):
        raise WatchdogError("configuration-label-invalid")
    url = urllib.parse.urlsplit(value["status_url"])
    if url.scheme != "https" or not url.hostname or url.username or url.password or url.fragment or any(ord(c) < 33 for c in value["status_url"]):
        raise WatchdogError("configuration-url-invalid")
    for key in ("sender", "recipient"):
        if not re.fullmatch(r"[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,63}", value[key]):
            raise WatchdogError("email-address-invalid")
    for key in ("status_token_file", "smtp_password_file"):
        value[key] = os.path.expanduser(value[key])
        if not os.path.isabs(value[key]):
            raise WatchdogError("absolute-credential-path-required")
    return value


def observation(healthy, reason, **details):
    return dict(healthy=healthy, reason=reason, **details)


def evaluate(payload, now):
    try:
        if not isinstance(payload, dict):
            raise ValueError("object")
        if payload.get("enabled") is not True:
            return observation(False, "monitor-disabled")
        if payload.get("deliveryEnabled") is not True:
            return observation(False, "delivery-disabled")
        read_at = timestamp(payload["readAt"])
        execution = payload["execution"]
        run = execution["lastRun"]
        if run is None or execution["state"] == "unobserved":
            return observation(False, "run-unobserved")
        scheduled = timestamp(run["scheduledAt"])
        started = timestamp(run["startedAt"])
        completed = timestamp(run["completedAt"])
        deadline = timestamp(execution["freshUntil"])
        if not scheduled <= started <= completed or completed > now + CLOCK_SKEW_SECONDS:
            return observation(False, "run-clock-invalid")
        if abs(read_at - now) > CLOCK_SKEW_SECONDS:
            return observation(False, "response-clock-invalid")
        if type(execution["expectedIntervalSeconds"]) is not int or execution["expectedIntervalSeconds"] != 60 or deadline != scheduled + MAX_AGE_SECONDS:
            return observation(False, "run-cadence-invalid")
        details = {"scheduledAt": run["scheduledAt"], "completedAt": run["completedAt"], "ageSeconds": round(now - scheduled, 3)}
        if execution["state"] != "fresh" or now >= deadline:
            return observation(False, "run-stale", **details)
        if run["enabled"] is not True:
            return observation(False, "run-disabled", **details)
        for key in ("phaseErrors", "deliveriesFailed", "targetCount", "configurationRevision"):
            if type(run[key]) is not int or run[key] < 0:
                raise ValueError("count")
        if run["targetCount"] == 0:
            return observation(False, "no-targets", **details)
        if type(payload["configurationRevision"]) is not int or payload["configurationRevision"] < 1:
            raise ValueError("revision")
        if not isinstance(payload["configurationFingerprint"], str) or not re.fullmatch(r"sha256:[a-f0-9]{64}", payload["configurationFingerprint"]):
            raise ValueError("fingerprint")
        if run["configurationRevision"] != payload["configurationRevision"] or run["configFingerprint"] != payload["configurationFingerprint"]:
            return observation(False, "configuration-not-observed", **details)
        if run["phaseErrors"]:
            return observation(False, "monitor-phase-error", **details)
        if run["deliveriesFailed"]:
            return observation(False, "monitor-delivery-error", **details)
        return observation(True, "fresh", **details)
    except (KeyError, TypeError, ValueError, OverflowError):
        return observation(False, "status-schema-invalid")


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, message, headers, new_url):
        return None


def probe(config, clock=time.time, opener=None):
    try:
        token = private_read(config["status_token_file"], 4096).strip()
        if not re.fullmatch(r"[A-Za-z0-9_-]{32,4096}", token):
            raise WatchdogError("credential-format")
    except (OSError, UnicodeError, WatchdogError):
        return observation(False, "status-credential-invalid")
    request = urllib.request.Request(config["status_url"], headers={
        "Authorization": "Bearer " + token,
        "Accept": "application/json",
        "Cache-Control": "no-cache",
        "User-Agent": APP + "/1",
    })
    opener = opener or urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect(), urllib.request.HTTPSHandler(context=ssl.create_default_context()))
    try:
        with opener.open(request, timeout=HTTP_TIMEOUT_SECONDS) as response:
            if response.status != 200:
                return observation(False, "http-" + str(response.status))
            if response.headers.get_content_type() != "application/json":
                return observation(False, "status-media-type-invalid")
            body = response.read(MAX_RESPONSE_BYTES + 1)
        if len(body) > MAX_RESPONSE_BYTES:
            return observation(False, "status-response-too-large")
        return evaluate(json.loads(body.decode("utf-8")), clock())
    except urllib.error.HTTPError as error:
        return observation(False, "http-" + str(error.code))
    except (socket.timeout, TimeoutError):
        return observation(False, "http-timeout")
    except (urllib.error.URLError, ssl.SSLError, OSError, http.client.HTTPException):
        return observation(False, "http-network-error")
    except (ValueError, UnicodeError, RecursionError):
        return observation(False, "status-json-invalid")


def initial_state():
    return {"version": STATE_VERSION, "lastCheckAt": None, "failures": 0, "successes": 0, "firstFailureAt": None,
            "incident": None, "pending": None, "lastHeartbeatAt": None, "lastObservation": None}


def load_state(path):
    try:
        value = json.loads(private_read(path))
    except FileNotFoundError:
        return initial_state()
    if not isinstance(value, dict) or set(value) != set(initial_state()) or value["version"] != STATE_VERSION:
        raise WatchdogError("state-invalid")
    for key in ("failures", "successes"):
        if type(value[key]) is not int or not 0 <= value[key] <= max(FAILURE_THRESHOLD, RECOVERY_THRESHOLD):
            raise WatchdogError("state-invalid")
    for key in ("lastCheckAt", "firstFailureAt", "lastHeartbeatAt"):
        if value[key] is not None and (type(value[key]) not in (int, float) or not 0 <= value[key] < 1e11):
            raise WatchdogError("state-invalid")
    for key in ("incident", "pending", "lastObservation"):
        if value[key] is not None and not isinstance(value[key], dict):
            raise WatchdogError("state-invalid")
    return value


def advance(previous, result, now):
    state = copy.deepcopy(previous)
    last = state["lastCheckAt"]
    if last is not None and now < last:
        raise WatchdogError("watchdog-clock-regressed")
    if last is not None and now - last < MIN_SAMPLE_SECONDS:
        return state, False
    if last is not None and now - last > MAX_SAMPLE_GAP_SECONDS:
        state.update(failures=0, successes=0, firstFailureAt=None)
    state["lastCheckAt"] = now
    state["lastObservation"] = result
    incident = state["incident"]
    pending = state["pending"]
    if result["healthy"]:
        state["successes"] = min(RECOVERY_THRESHOLD, state["successes"] + 1)
        state["failures"] = 0
        state["firstFailureAt"] = None
        if incident and state["successes"] >= RECOVERY_THRESHOLD:
            if incident["recoveredAt"] is None:
                incident["recoveredAt"] = now
            if pending and pending["kind"] != "RECOVERY":
                state["pending"] = None
    else:
        state["failures"] = min(FAILURE_THRESHOLD, state["failures"] + 1)
        state["successes"] = 0
        state["firstFailureAt"] = state["firstFailureAt"] if state["firstFailureAt"] is not None else now
        if pending and pending["kind"] in ("HEARTBEAT", "RECOVERY"):
            state["pending"] = None
        if incident:
            incident["recoveredAt"] = None
            incident["reason"] = result["reason"]
        elif state["failures"] >= FAILURE_THRESHOLD:
            incident = {"id": uuid.uuid4().hex, "openedAt": state["firstFailureAt"], "reason": result["reason"],
                        "problemSentAt": None, "lastAlertAt": None, "recoveredAt": None}
            state["incident"] = incident
    kind = None
    if incident:
        if incident["recoveredAt"] is not None:
            kind = "RECOVERY"
        elif incident["problemSentAt"] is None:
            kind = "PROBLEM"
        elif not result["healthy"] and now - incident["lastAlertAt"] >= REMINDER_SECONDS:
            kind = "REMINDER"
    elif state["successes"] >= RECOVERY_THRESHOLD and (state["lastHeartbeatAt"] is None or now - state["lastHeartbeatAt"] >= HEARTBEAT_SECONDS):
        kind = "HEARTBEAT"
    if state["pending"] is None and kind:
        state["pending"] = {"id": uuid.uuid4().hex, "kind": kind, "createdAt": now,
                            "incident": copy.deepcopy(incident), "observation": result}
    return state, True


def acknowledge(state, event, now):
    if state["pending"]["id"] != event["id"]:
        raise WatchdogError("notification-state-conflict")
    if event["kind"] == "HEARTBEAT":
        state["lastHeartbeatAt"] = now
    elif event["kind"] == "RECOVERY":
        state["incident"] = None
    else:
        if state["incident"]["problemSentAt"] is None:
            state["incident"]["problemSentAt"] = now
        state["incident"]["lastAlertAt"] = now
    state["pending"] = None


def mail_message(config, event):
    message = email.message.EmailMessage()
    message["From"] = "Monitor Watchdog <" + config["sender"] + ">"
    message["To"] = config["recipient"]
    message["Date"] = email.utils.format_datetime(datetime.datetime.fromtimestamp(event["createdAt"], UTC))
    message["Message-ID"] = "<watchdog-" + event["id"] + "@gmail.com>"
    message["Subject"] = "[" + config["label"] + "] " + event["kind"]
    lines = ["Independent Endpoint Monitor watchdog", "Event: " + event["kind"], "Observed: " + utc(event["createdAt"])]
    if event["incident"]:
        incident = event["incident"]
        lines += ["Incident: " + incident["id"], "First failure: " + utc(incident["openedAt"]), "Reason: " + incident["reason"]]
        if incident["recoveredAt"] is not None:
            lines.append("Recovered: " + utc(incident["recoveredAt"]))
            if incident["problemSentAt"] is None:
                lines.append("Recovered before an outage email was acknowledged; this is the outage summary.")
    else:
        lines.append("The watchdog is running and the monitor has fresh completed-run evidence.")
    for key in ("scheduledAt", "completedAt"):
        if key in event["observation"]:
            lines.append(key + ": " + event["observation"][key])
    lines += ["", "This observer checks monitor execution and delivery errors; it does not repeat individual target alerts.",
              "Healthy heartbeats are sent daily. A missing heartbeat can indicate a watchdog, hosting, or mail failure.",
              "Event ID: " + event["id"]]
    message.set_content("\n".join(lines) + "\n")
    return message


def send_mail(config, event):
    password = "".join(private_read(config["smtp_password_file"], 128).split())
    if not re.fullmatch(r"[A-Za-z0-9]{16}", password):
        raise WatchdogError("gmail-credential-invalid")
    client = smtplib.SMTP_SSL("smtp.gmail.com", 465, timeout=SMTP_TIMEOUT_SECONDS, context=ssl.create_default_context())
    try:
        client.login(config["sender"], password)
        rejected = client.send_message(mail_message(config, event), from_addr=config["sender"], to_addrs=[config["recipient"]])
        if rejected:
            raise WatchdogError("smtp-recipient-rejected")
    finally:
        # DATA acknowledgment establishes acceptance; QUIT failure must not undo it
        client.close()


@contextmanager
def state_lock(directory):
    descriptor = os.open(os.path.join(directory, "state.lock"), os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    with os.fdopen(descriptor, "w") as lock:
        try:
            fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            yield False
            return
        yield True


def logger(directory):
    private_directory(directory)
    result = logging.getLogger(APP + ":" + directory)
    result.setLevel(logging.INFO)
    if not result.handlers:
        handler = logging.handlers.RotatingFileHandler(os.path.join(directory, "watchdog.jsonl"), maxBytes=MAX_LOG_BYTES, backupCount=LOG_BACKUPS)
        handler.setFormatter(logging.Formatter("%(message)s"))
        result.addHandler(handler)
    return result


def emit(log, run_id, event, **fields):
    record = dict(at=utc(time.time()), runId=run_id, event=event, **fields)
    log.info(json.dumps(record, sort_keys=True))


def failure_details(error):
    result = {"errorType": type(error).__name__}
    if isinstance(error, WatchdogError):
        result["errorCode"] = str(error)
    return result


def run_once(config, directory, log, clock=time.time, observe=probe, notify=send_mail):
    run_id = uuid.uuid4().hex
    started = time.monotonic()
    with state_lock(directory) as acquired:
        if not acquired:
            return {"event": "overlap-skipped"}, 0
        state_path = os.path.join(directory, "state.json")
        state = load_state(state_path)
        result = observe(config)
        state, changed = advance(state, result, clock())
        if not changed:
            emit(log, run_id, "check-skipped", reason="minimum-sample-spacing")
            return {"event": "check-skipped"}, 0
        atomic_save(state_path, state)
        event = state["pending"]
        mail_failed = False
        if event:
            try:
                notify(config, event)
            except ProcessDeadline:
                raise
            except Exception as error:
                mail_failed = True
                emit(log, run_id, "notification-failed", kind=event["kind"], eventId=event["id"], smtpCode=getattr(error, "smtp_code", None), **failure_details(error))
            else:
                acknowledge(state, event, clock())
                atomic_save(state_path, state)
                emit(log, run_id, "notification-accepted", kind=event["kind"], eventId=event["id"])
        summary = {"event": "check-completed", "healthy": result["healthy"], "reason": result["reason"],
                   "failures": state["failures"], "successes": state["successes"], "notificationPending": state["pending"] is not None,
                   "elapsedMs": round((time.monotonic() - started) * 1000)}
        emit(log, run_id, **summary)
        return summary, 0 if result["healthy"] and not mail_failed else 1


def default_path(variable, fallback):
    return os.path.join(os.environ.get(variable) or os.path.expanduser(fallback), APP)


def deadline(signum, frame):
    raise ProcessDeadline("process-deadline")


def main(argv=None):
    parser = argparse.ArgumentParser(description="Check Endpoint Monitor from independent Unix hosting and send Gmail alerts.", epilog="Requires Python 3.6+ with SSL and Unix flock, SIGALRM, and cron. Config is private JSON: label, status_url (HTTPS), status_token_file, sender, recipient (plain ASCII email addresses), smtp_password_file. Credential paths must be absolute or start with ~. Prefer native Gmail addresses for provider independence. run stores private state and rotating JSON logs; check makes no durable writes and sends no mail. Exit: 0 healthy/skipped, 1 unhealthy/runtime/delivery failure, 2 invalid configuration/usage, 3 missing platform dependency. See watchdog/README.md for installation and timing.")
    parser.add_argument("command", choices=("check", "run"))
    parser.add_argument("-c", "--config", default=os.path.join(default_path("XDG_CONFIG_HOME", "~/.config"), "config.json"), help="private configuration JSON path")
    parser.add_argument("-s", "--state-dir", default=default_path("XDG_STATE_HOME", "~/.local/state"), help="private state/log directory for run")
    args = parser.parse_args(argv)
    if not args.config or not args.state_dir:
        parser.error("paths must not be empty")
    if fcntl is None or not hasattr(os, "O_NOFOLLOW") or not hasattr(signal, "SIGALRM"):
        print("watchdog: Unix flock, O_NOFOLLOW, and SIGALRM are required", file=sys.stderr)
        return 3
    os.umask(0o077)
    log = None
    try:
        if args.command == "run":
            log = logger(os.path.abspath(os.path.expanduser(args.state_dir)))
        config = load_config(os.path.expanduser(args.config))
    except Exception as error:
        if log:
            emit(log, uuid.uuid4().hex, "configuration-failed", **failure_details(error))
        print("watchdog: configuration unavailable or invalid " + json.dumps(failure_details(error)), file=sys.stderr)
        return 2
    signal.signal(signal.SIGALRM, deadline)
    signal.alarm(PROCESS_TIMEOUT_SECONDS)
    try:
        if args.command == "check":
            result = probe(config)
            code = 0 if result["healthy"] else 1
        else:
            result, code = run_once(config, os.path.abspath(os.path.expanduser(args.state_dir)), log)
        print(json.dumps(result, sort_keys=True))
        return code
    except Exception as error:
        if log:
            emit(log, uuid.uuid4().hex, "watchdog-failed", **failure_details(error))
        print("watchdog: runtime failure " + json.dumps(failure_details(error)), file=sys.stderr)
        return 1
    finally:
        signal.alarm(0)


if __name__ == "__main__":
    sys.exit(main())
