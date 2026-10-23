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
import math
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
STATE_VERSION = 2
FAILURE_THRESHOLD = 2
RECOVERY_THRESHOLD = 2
RECOVERY_STABLE_SECONDS = 300
MIN_SAMPLE_SECONDS = 45
MAX_SAMPLE_GAP_SECONDS = 180
MAX_AGE_SECONDS = 180
CLOCK_SKEW_SECONDS = 30
HTTP_TIMEOUT_SECONDS = 10
SMTP_TIMEOUT_SECONDS = 15
PROCESS_TIMEOUT_SECONDS = 45
MAX_RESPONSE_BYTES = 512 * 1024
MAX_PRIVATE_BYTES = 64 * 1024
MAX_STATE_BYTES = 1024 * 1024
INCIDENT_RETENTION_DAYS = 90
MAX_CLOSED_INCIDENTS = 128
DAILY_RETENTION_DAYS = 90
MAX_DAILY_REASONS = 32
SECONDS_PER_DAY = 86400
MAX_LOG_BYTES = 256 * 1024
LOG_BACKUPS = 3
REMINDER_SECONDS = 3600
HEARTBEAT_SECONDS = 86400
UTC = datetime.timezone.utc
REASONS = frozenset(("fresh", "monitor-disabled", "delivery-disabled", "run-unobserved", "run-clock-invalid",
                     "response-clock-invalid", "run-cadence-invalid", "run-stale", "run-disabled", "no-targets",
                     "configuration-not-observed", "monitor-phase-error", "monitor-delivery-error", "status-schema-invalid",
                     "status-credential-invalid", "status-media-type-invalid", "status-response-too-large", "http-timeout",
                     "http-network-error", "dns-error", "tls-error", "status-json-invalid", "unknown-error"))
OBSERVATION_NUMBERS = ("ageSeconds", "schedulerDelayMilliseconds", "durationMilliseconds", "configurationRevision",
                       "phaseErrors", "deliveriesFailed", "targetCount", "failedProbes", "httpStatus",
                       "httpElapsedMilliseconds", "dnsMilliseconds", "tcpMilliseconds", "tlsMilliseconds",
                       "responseHeadersMilliseconds", "bodyReadMilliseconds")
OBSERVATION_TIMES = ("scheduledAt", "startedAt", "completedAt", "freshUntil")
EVIDENCE_KEYS = frozenset(("lastHealthy", "firstFailure", "worstFailure", "latestFailure", "latestObservation", "recovery"))
INCIDENT_FIELDS = frozenset(("id", "openedAt", "reason", "problemSentAt", "lastAlertAt", "recoveredAt"))
DAILY_COUNTERS = ("samples", "healthy", "unhealthy", "skipped", "notificationsAccepted", "notificationsFailed")
DAILY_MAXIMA = ("maximumAgeSeconds", "maximumSchedulerDelayMilliseconds", "maximumSampleGapSeconds")


def finite_number(value, maximum=1e12):
    return type(value) in (int, float) and math.isfinite(value) and 0 <= value <= maximum


def safe_observation(value):
    reason = value.get("reason")
    reason = reason if isinstance(reason, str) and (reason in REASONS or re.fullmatch(r"http-[1-5][0-9]{2}", reason)) else "unknown-error"
    result = {"healthy": value.get("healthy") is True, "reason": reason}
    for key in OBSERVATION_NUMBERS:
        if finite_number(value.get(key)):
            result[key] = value[key]
    for key in OBSERVATION_TIMES:
        try:
            timestamp(value.get(key))
        except (ValueError, TypeError, OverflowError):
            continue
        result[key] = value[key]
    for key, pattern in (("runId", r"[a-fA-F0-9-]{32,36}"), ("cfRay", r"[a-fA-F0-9]{16,32}-[A-Za-z]{2,5}"),
                         ("configFingerprint", r"sha256:[a-f0-9]{64}"), ("errorType", r"[A-Za-z][A-Za-z0-9]{0,63}")):
        if isinstance(value.get(key), str) and re.fullmatch(pattern, value[key]):
            result[key] = value[key]
    return result


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
    encoded = json.dumps(value, sort_keys=True, allow_nan=False) + "\n"
    if len(encoded.encode("utf-8")) > MAX_STATE_BYTES:
        raise WatchdogError("state-size-limit")
    with tempfile.NamedTemporaryFile(mode="w", dir=directory, prefix=".state-", delete=False) as output:
        temporary = output.name
        try:
            output.write(encoded)
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
        details = safe_observation(dict(run, healthy=True, reason="fresh", freshUntil=execution["freshUntil"],
                                        ageSeconds=round(max(0, now - scheduled), 3),
                                        schedulerDelayMilliseconds=round((started - scheduled) * 1000, 3),
                                        durationMilliseconds=round((completed - started) * 1000, 3)))
        details.pop("healthy")
        details.pop("reason")
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


class TimedHTTPSConnection(http.client.HTTPSConnection):
    def __init__(self, host, diagnostics, **kwargs):
        super().__init__(host, **kwargs)
        self.diagnostics = diagnostics
        self._create_connection = self.connect_socket

    def connect_socket(self, address, timeout=HTTP_TIMEOUT_SECONDS, source_address=None):
        started = time.monotonic()
        try:
            addresses = socket.getaddrinfo(address[0], address[1], 0, socket.SOCK_STREAM)
        finally:
            self.diagnostics["dnsMilliseconds"] = round((time.monotonic() - started) * 1000, 3)
        connecting = time.monotonic()
        last_error = None
        try:
            for family, kind, protocol, _, destination in addresses:
                remaining = timeout - (time.monotonic() - started)
                if remaining <= 0:
                    raise socket.timeout()
                sock = socket.socket(family, kind, protocol)
                try:
                    sock.settimeout(remaining)
                    if source_address:
                        sock.bind(source_address)
                    sock.connect(destination)
                    return sock
                except OSError as error:
                    last_error = error
                    sock.close()
            if last_error:
                raise last_error
            raise OSError("no-addresses")
        finally:
            self.diagnostics["tcpMilliseconds"] = round((time.monotonic() - connecting) * 1000, 3)

    def connect(self):
        http.client.HTTPConnection.connect(self)
        started = time.monotonic()
        try:
            self.sock = self._context.wrap_socket(self.sock, server_hostname=self._tunnel_host or self.host)
        except BaseException:
            self.sock.close()
            raise
        finally:
            self.diagnostics["tlsMilliseconds"] = round((time.monotonic() - started) * 1000, 3)


class TimedHTTPSHandler(urllib.request.HTTPSHandler):
    def __init__(self, diagnostics):
        super().__init__(context=ssl.create_default_context())
        self.diagnostics = diagnostics

    def https_open(self, request):
        def connection(host, **kwargs):
            return TimedHTTPSConnection(host, self.diagnostics, **kwargs)
        return self.do_open(connection, request, context=self._context)


def network_reason(error):
    cause = error.reason if isinstance(error, urllib.error.URLError) else error
    if isinstance(cause, socket.gaierror):
        return "dns-error"
    if isinstance(cause, ssl.SSLError):
        return "tls-error"
    if isinstance(cause, (socket.timeout, TimeoutError)):
        return "http-timeout"
    return "http-network-error"


def probe(config, clock=time.time, opener=None):
    started = time.monotonic()
    diagnostics = {}

    def result(healthy, reason, **details):
        return safe_observation(dict(details, healthy=healthy, reason=reason, **diagnostics,
                                     httpElapsedMilliseconds=round((time.monotonic() - started) * 1000, 3)))

    try:
        token = private_read(config["status_token_file"], 4096).strip()
        if not re.fullmatch(r"[A-Za-z0-9_-]{32,4096}", token):
            raise WatchdogError("credential-format")
    except (OSError, UnicodeError, WatchdogError):
        return result(False, "status-credential-invalid")
    request = urllib.request.Request(config["status_url"], headers={
        "Authorization": "Bearer " + token,
        "Accept": "application/json",
        "Cache-Control": "no-cache",
        "User-Agent": APP + "/1",
    })
    opener = opener or urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect(), TimedHTTPSHandler(diagnostics))
    try:
        with opener.open(request, timeout=HTTP_TIMEOUT_SECONDS) as response:
            diagnostics["responseHeadersMilliseconds"] = round((time.monotonic() - started) * 1000, 3)
            diagnostics["httpStatus"] = response.status
            ray = response.headers.get("CF-Ray")
            if ray:
                diagnostics["cfRay"] = ray
            if response.status != 200:
                return result(False, "http-" + str(response.status))
            if response.headers.get_content_type() != "application/json":
                return result(False, "status-media-type-invalid")
            body_started = time.monotonic()
            body = response.read(MAX_RESPONSE_BYTES + 1)
            diagnostics["bodyReadMilliseconds"] = round((time.monotonic() - body_started) * 1000, 3)
        if len(body) > MAX_RESPONSE_BYTES:
            return result(False, "status-response-too-large")
        evaluated = evaluate(json.loads(body.decode("utf-8")), clock())
        return result(**evaluated)
    except urllib.error.HTTPError as error:
        try:
            diagnostics["httpStatus"] = error.code
            diagnostics["cfRay"] = error.headers.get("CF-Ray")
            return result(False, "http-" + str(error.code))
        finally:
            error.close()
    except (urllib.error.URLError, ssl.SSLError, OSError, http.client.HTTPException):
        error = sys.exc_info()[1]
        return result(False, network_reason(error), errorType=type(error.reason if isinstance(error, urllib.error.URLError) else error).__name__)
    except (ValueError, UnicodeError, RecursionError):
        return result(False, "status-json-invalid")


def initial_state():
    return {"version": STATE_VERSION, "lastCheckAt": None, "failures": 0, "successes": 0, "firstFailureAt": None,
            "incident": None, "pending": None, "lastHeartbeatAt": None, "lastObservation": None,
            "healthySince": None, "firstFailureObservation": None, "lastHealthyObservation": None,
            "incidents": [], "daily": []}


def validate_observation(value, dated=False):
    if value is None:
        return
    if not isinstance(value, dict):
        raise WatchdogError("state-invalid")
    fields = dict(value)
    if dated:
        at = fields.pop("at", None)
        try:
            if not isinstance(at, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z", at):
                raise ValueError()
            datetime.datetime.strptime(at, "%Y-%m-%dT%H:%M:%S.%fZ" if "." in at else "%Y-%m-%dT%H:%M:%SZ")
        except ValueError:
            raise WatchdogError("state-invalid")
    if safe_observation(fields) != fields:
        raise WatchdogError("state-invalid")


def validate_incident(value, closed=False):
    if value is None and not closed:
        return
    optional = {"closedAt", "failureSamples", "evidence"}
    if not isinstance(value, dict) or not INCIDENT_FIELDS <= set(value) or set(value) - INCIDENT_FIELDS - optional:
        raise WatchdogError("state-invalid")
    if not isinstance(value["id"], str) or not re.fullmatch(r"[a-f0-9]{32}", value["id"]):
        raise WatchdogError("state-invalid")
    if value["reason"] != safe_observation(value)["reason"]:
        raise WatchdogError("state-invalid")
    for key in ("openedAt", "problemSentAt", "lastAlertAt", "recoveredAt", "closedAt"):
        number = value.get(key)
        if number is not None and not finite_number(number, 1e11):
            raise WatchdogError("state-invalid")
    if value["openedAt"] is None or closed and (value.get("closedAt") is None or value["recoveredAt"] is None):
        raise WatchdogError("state-invalid")
    if "failureSamples" in value and (type(value["failureSamples"]) is not int or not 0 <= value["failureSamples"] <= 1e12):
        raise WatchdogError("state-invalid")
    evidence = value.get("evidence", {})
    if not isinstance(evidence, dict) or set(evidence) - EVIDENCE_KEYS:
        raise WatchdogError("state-invalid")
    for sample in evidence.values():
        validate_observation(sample, dated=True)


def validate_daily(row):
    if set(row) != {"date", "reasons"} | set(DAILY_COUNTERS) | set(DAILY_MAXIMA):
        raise WatchdogError("state-invalid")
    try:
        datetime.datetime.strptime(row["date"], "%Y-%m-%d")
    except (ValueError, TypeError):
        raise WatchdogError("state-invalid")
    for key in DAILY_COUNTERS:
        if type(row[key]) is not int or not 0 <= row[key] <= 1e12:
            raise WatchdogError("state-invalid")
    for key in DAILY_MAXIMA:
        if not finite_number(row[key]):
            raise WatchdogError("state-invalid")
    reasons = row["reasons"]
    if row["healthy"] + row["unhealthy"] != row["samples"] or not isinstance(reasons, dict) or len(reasons) > MAX_DAILY_REASONS:
        raise WatchdogError("state-invalid")
    for reason, count in reasons.items():
        if reason != "other" and reason != safe_observation({"reason": reason})["reason"]:
            raise WatchdogError("state-invalid")
        if type(count) is not int or not 0 <= count <= 1e12:
            raise WatchdogError("state-invalid")


def load_state(path):
    try:
        value = json.loads(private_read(path, MAX_STATE_BYTES))
    except FileNotFoundError:
        return initial_state()
    if not isinstance(value, dict) or type(value.get("version")) is not int or value["version"] not in (1, STATE_VERSION):
        raise WatchdogError("state-invalid")
    if value["version"] == 1:
        legacy = {"version", "lastCheckAt", "failures", "successes", "firstFailureAt", "incident", "pending", "lastHeartbeatAt", "lastObservation"}
        if set(value) != legacy:
            raise WatchdogError("state-invalid")
        value = dict(initial_state(), **value)
        value["version"] = STATE_VERSION
        observations = [value["lastObservation"]]
        if isinstance(value["pending"], dict):
            observations.append(value["pending"].get("observation"))
        for sample in observations:
            if isinstance(sample, dict) and type(sample.get("ageSeconds")) in (int, float) and -CLOCK_SKEW_SECONDS <= sample["ageSeconds"] < 0:
                sample["ageSeconds"] = 0
        if isinstance(value["incident"], dict):
            value["incident"].setdefault("evidence", {"firstFailure": None})
    if set(value) != set(initial_state()):
        raise WatchdogError("state-invalid")
    for key in ("failures", "successes"):
        if type(value[key]) is not int or not 0 <= value[key] <= max(FAILURE_THRESHOLD, RECOVERY_THRESHOLD):
            raise WatchdogError("state-invalid")
    for key in ("lastCheckAt", "firstFailureAt", "lastHeartbeatAt", "healthySince"):
        if value[key] is not None and not finite_number(value[key], 1e11):
            raise WatchdogError("state-invalid")
    for key in ("incident", "pending", "lastObservation", "firstFailureObservation", "lastHealthyObservation"):
        if value[key] is not None and not isinstance(value[key], dict):
            raise WatchdogError("state-invalid")
    for key, maximum in (("incidents", MAX_CLOSED_INCIDENTS), ("daily", DAILY_RETENTION_DAYS)):
        if not isinstance(value[key], list) or len(value[key]) > maximum or any(not isinstance(row, dict) for row in value[key]):
            raise WatchdogError("state-invalid")
    for key in ("lastObservation", "firstFailureObservation", "lastHealthyObservation"):
        validate_observation(value[key], dated=key != "lastObservation")
    validate_incident(value["incident"])
    for incident in value["incidents"]:
        validate_incident(incident, closed=True)
    for row in value["daily"]:
        validate_daily(row)
    pending = value["pending"]
    if pending is not None:
        if set(pending) != {"id", "kind", "createdAt", "incident", "observation"}:
            raise WatchdogError("state-invalid")
        if not isinstance(pending["id"], str) or not re.fullmatch(r"[a-f0-9]{32}", pending["id"]):
            raise WatchdogError("state-invalid")
        if pending["kind"] not in ("HEARTBEAT", "PROBLEM", "RECOVERY", "REMINDER") or not finite_number(pending["createdAt"], 1e11):
            raise WatchdogError("state-invalid")
        validate_incident(pending["incident"])
        validate_observation(pending["observation"])
    return value


def evidence_at(result, now):
    return dict(safe_observation(result), at=utc(now))


def prune_history(state, now):
    oldest = now - INCIDENT_RETENTION_DAYS * SECONDS_PER_DAY
    state["incidents"] = [row for row in state["incidents"] if finite_number(row.get("closedAt"), 1e11)
                          and row["closedAt"] >= oldest][-MAX_CLOSED_INCIDENTS:]
    first_day = utc(now - (DAILY_RETENTION_DAYS - 1) * SECONDS_PER_DAY)[:10]
    state["daily"] = [row for row in state["daily"] if isinstance(row.get("date"), str)
                      and first_day <= row["date"] <= utc(now)[:10]][-DAILY_RETENTION_DAYS:]


def daily_entry(state, now):
    prune_history(state, now)
    day = utc(now)[:10]
    for row in state["daily"]:
        if row["date"] == day:
            return row
    row = {"date": day, "samples": 0, "healthy": 0, "unhealthy": 0, "skipped": 0,
           "notificationsAccepted": 0, "notificationsFailed": 0, "maximumAgeSeconds": 0,
           "maximumSchedulerDelayMilliseconds": 0, "maximumSampleGapSeconds": 0, "reasons": {}}
    state["daily"].append(row)
    return row


def record_sample(state, result, now, gap):
    row = daily_entry(state, now)
    row["samples"] += 1
    row["healthy" if result["healthy"] else "unhealthy"] += 1
    reason = result["reason"]
    if reason not in row["reasons"] and len(row["reasons"]) >= MAX_DAILY_REASONS - 1:
        reason = "other"
    row["reasons"][reason] = row["reasons"].get(reason, 0) + 1
    for output, key in (("maximumAgeSeconds", "ageSeconds"),
                        ("maximumSchedulerDelayMilliseconds", "schedulerDelayMilliseconds")):
        row[output] = max(row[output], result.get(key, 0))
    row["maximumSampleGapSeconds"] = max(row["maximumSampleGapSeconds"], gap or 0)


def failure_weight(result):
    if not isinstance(result, dict):
        return 0, 0
    return result.get("ageSeconds", 0), result.get("httpElapsedMilliseconds", 0)


def update_evidence(incident, result, now):
    evidence = incident.setdefault("evidence", {})
    sample = evidence_at(result, now)
    evidence["latestObservation"] = sample
    if not result["healthy"]:
        evidence.setdefault("firstFailure", sample)
        evidence["latestFailure"] = sample
        if failure_weight(sample) >= failure_weight(evidence.get("worstFailure", {})):
            evidence["worstFailure"] = sample
        incident["failureSamples"] = incident.get("failureSamples", 0) + 1


def public_incident(incident):
    if incident is None:
        return None
    result = {key: incident[key] for key in ("id", "openedAt", "problemSentAt", "lastAlertAt", "recoveredAt", "closedAt", "failureSamples") if key in incident}
    result["reason"] = safe_observation(incident)["reason"]
    result["evidence"] = {}
    for key in ("lastHealthy", "firstFailure", "worstFailure", "latestFailure", "latestObservation", "recovery"):
        sample = incident.get("evidence", {}).get(key)
        if sample is None and key in incident.get("evidence", {}):
            result["evidence"][key] = None
        if isinstance(sample, dict):
            result["evidence"][key] = safe_observation(sample)
            if isinstance(sample.get("at"), str) and re.fullmatch(r"[0-9TZ:.+-]{20,35}", sample["at"]):
                result["evidence"][key]["at"] = sample["at"]
    return result


def read_diagnostics(directory, now=None):
    entry = os.lstat(directory)
    if not stat.S_ISDIR(entry.st_mode) or entry.st_uid != os.getuid() or entry.st_mode & 0o077:
        raise WatchdogError("private-directory-required")
    path = os.path.join(directory, "state.json")
    if not os.path.exists(path):
        raise WatchdogError("state-unobserved")
    state = load_state(path)
    now = time.time() if now is None else now
    prune_history(state, now)
    pending = state["pending"]
    return {"schemaVersion": 1, "stateVersion": STATE_VERSION, "readAt": utc(now),
            "lastCheckAt": state["lastCheckAt"],
            "lastObservation": safe_observation(state["lastObservation"]) if state["lastObservation"] else None,
            "incident": public_incident(state["incident"]),
            "pendingNotification": {key: pending[key] for key in ("id", "kind", "createdAt")} if pending else None,
            "incidents": [public_incident(row) for row in reversed(state["incidents"])], "daily": state["daily"],
            "retention": {"incidentDays": INCIDENT_RETENTION_DAYS, "maximumClosedIncidents": MAX_CLOSED_INCIDENTS,
                          "dailyDays": DAILY_RETENTION_DAYS, "maximumStateBytes": MAX_STATE_BYTES,
                          "recoveryStableSeconds": RECOVERY_STABLE_SECONDS}}


def advance(previous, result, now):
    state = copy.deepcopy(previous)
    result = safe_observation(result)
    last = state["lastCheckAt"]
    if last is not None and now < last:
        raise WatchdogError("watchdog-clock-regressed")
    if last is not None and now - last < MIN_SAMPLE_SECONDS:
        return state, False
    if last is not None and now - last > MAX_SAMPLE_GAP_SECONDS:
        state.update(failures=0, successes=0, firstFailureAt=None, firstFailureObservation=None, healthySince=None)
        if state["incident"]:
            state["incident"]["recoveredAt"] = None
            state["incident"].setdefault("evidence", {}).pop("recovery", None)
        if state["pending"] and state["pending"]["kind"] == "RECOVERY":
            state["pending"] = None
    record_sample(state, result, now, now - last if last is not None else None)
    state["lastCheckAt"] = now
    state["lastObservation"] = result
    incident = state["incident"]
    pending = state["pending"]
    if result["healthy"]:
        state["successes"] = min(RECOVERY_THRESHOLD, state["successes"] + 1)
        state["failures"] = 0
        state["firstFailureAt"] = None
        state["firstFailureObservation"] = None
        state["lastHealthyObservation"] = evidence_at(result, now)
        if state["healthySince"] is None:
            state["healthySince"] = now
        if incident:
            update_evidence(incident, result, now)
        if incident and state["successes"] >= RECOVERY_THRESHOLD and now - state["healthySince"] >= RECOVERY_STABLE_SECONDS:
            if incident["recoveredAt"] is None:
                incident["recoveredAt"] = now
                incident["evidence"]["recovery"] = evidence_at(result, now)
            if pending and pending["kind"] != "RECOVERY":
                state["pending"] = None
    else:
        state["failures"] = min(FAILURE_THRESHOLD, state["failures"] + 1)
        state["successes"] = 0
        state["healthySince"] = None
        state["firstFailureAt"] = state["firstFailureAt"] if state["firstFailureAt"] is not None else now
        if state["firstFailureObservation"] is None and state["firstFailureAt"] == now:
            state["firstFailureObservation"] = evidence_at(result, now)
        if pending and pending["kind"] in ("HEARTBEAT", "RECOVERY"):
            state["pending"] = None
        if incident:
            incident["recoveredAt"] = None
            incident["reason"] = result["reason"]
            incident.setdefault("evidence", {}).pop("recovery", None)
            update_evidence(incident, result, now)
        elif state["failures"] >= FAILURE_THRESHOLD:
            incident = {"id": uuid.uuid4().hex, "openedAt": state["firstFailureAt"], "reason": result["reason"],
                        "problemSentAt": None, "lastAlertAt": None, "recoveredAt": None,
                        "failureSamples": 1, "evidence": {"firstFailure": state["firstFailureObservation"],
                        "worstFailure": state["firstFailureObservation"], "lastHealthy": state["lastHealthyObservation"]}}
            update_evidence(incident, result, now)
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
        closed = copy.deepcopy(state["incident"])
        closed["closedAt"] = now
        state["incidents"].append(closed)
        prune_history(state, now)
        state["incident"] = None
    else:
        if state["incident"]["problemSentAt"] is None:
            state["incident"]["problemSentAt"] = now
        state["incident"]["lastAlertAt"] = now
    state["pending"] = None
    daily_entry(state, now)["notificationsAccepted"] += 1


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
    for key in ("scheduledAt", "startedAt", "completedAt", "freshUntil", "ageSeconds", "schedulerDelayMilliseconds",
                "durationMilliseconds", "runId", "configurationRevision", "httpStatus", "httpElapsedMilliseconds", "cfRay"):
        if key in event["observation"]:
            lines.append(key + ": " + str(event["observation"][key]))
    if event["incident"]:
        incident = event["incident"]
        worst = incident.get("evidence", {}).get("worstFailure") or {}
        lines.append("Recorded failing samples in this episode: " + str(incident.get("failureSamples", 0)))
        if "ageSeconds" in worst:
            lines.append("Worst recorded run age (seconds): " + str(worst["ageSeconds"]))
    lines += ["", "This observer checks monitor execution and delivery errors; it does not repeat individual target alerts.",
              "Recovery requires five minutes of stable observed health. Healthy heartbeats are sent daily.",
              "A missing heartbeat can indicate a watchdog, hosting, or mail failure.",
              "Event ID: " + event["id"]]
    message.set_content("\n".join(lines) + "\n")
    return message


def send_mail(config, event):
    started = time.monotonic()
    password = "".join(private_read(config["smtp_password_file"], 128).split())
    if not re.fullmatch(r"[A-Za-z0-9]{16}", password):
        raise WatchdogError("gmail-credential-invalid")
    client = smtplib.SMTP_SSL("smtp.gmail.com", 465, timeout=SMTP_TIMEOUT_SECONDS, context=ssl.create_default_context())
    connected = time.monotonic()
    try:
        client.login(config["sender"], password)
        authenticated = time.monotonic()
        rejected = client.send_message(mail_message(config, event), from_addr=config["sender"], to_addrs=[config["recipient"]])
        if rejected:
            raise WatchdogError("smtp-recipient-rejected")
        return {"smtpConnectMilliseconds": round((connected - started) * 1000, 3),
                "smtpAuthenticationMilliseconds": round((authenticated - connected) * 1000, 3),
                "smtpSubmissionMilliseconds": round((time.monotonic() - authenticated) * 1000, 3)}
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
            emit(log, run_id, "overlap-skipped")
            return {"event": "overlap-skipped"}, 0
        state_path = os.path.join(directory, "state.json")
        state = load_state(state_path)
        result = observe(config)
        sampled_at = clock()
        gap = sampled_at - state["lastCheckAt"] if state["lastCheckAt"] is not None else None
        state, changed = advance(state, result, sampled_at)
        if not changed:
            daily_entry(state, clock())["skipped"] += 1
            atomic_save(state_path, state)
            emit(log, run_id, "check-skipped", reason="minimum-sample-spacing", sampleGapSeconds=gap)
            return {"event": "check-skipped"}, 0
        atomic_save(state_path, state)
        event = state["pending"]
        mail_failed = False
        if event:
            submission_started = time.monotonic()
            try:
                mail_timings = notify(config, event)
            except ProcessDeadline:
                raise
            except Exception as error:
                mail_failed = True
                daily_entry(state, clock())["notificationsFailed"] += 1
                atomic_save(state_path, state)
                emit(log, run_id, "notification-failed", kind=event["kind"], eventId=event["id"],
                     notificationElapsedMilliseconds=round((time.monotonic() - submission_started) * 1000, 3),
                     smtpCode=getattr(error, "smtp_code", None), **failure_details(error))
            else:
                acknowledge(state, event, clock())
                atomic_save(state_path, state)
                timings = {key: mail_timings[key] for key in ("smtpConnectMilliseconds", "smtpAuthenticationMilliseconds", "smtpSubmissionMilliseconds")
                           if isinstance(mail_timings, dict) and finite_number(mail_timings.get(key))}
                emit(log, run_id, "notification-accepted", kind=event["kind"], eventId=event["id"],
                     notificationElapsedMilliseconds=round((time.monotonic() - submission_started) * 1000, 3), **timings)
        summary = {"event": "check-completed", "healthy": result["healthy"], "reason": result["reason"],
                   "failures": state["failures"], "successes": state["successes"], "notificationPending": state["pending"] is not None,
                   "elapsedMs": round((time.monotonic() - started) * 1000), "sampleGapSeconds": gap,
                   "sampleGapExceeded": gap is not None and gap > MAX_SAMPLE_GAP_SECONDS,
                   "incidentId": state["incident"]["id"] if state["incident"] else None, "observation": safe_observation(result)}
        emit(log, run_id, **summary)
        return summary, 0 if result["healthy"] and not mail_failed else 1


def default_path(variable, fallback):
    return os.path.join(os.environ.get(variable) or os.path.expanduser(fallback), APP)


def deadline(signum, frame):
    raise ProcessDeadline("process-deadline")


def main(argv=None):
    parser = argparse.ArgumentParser(description="Check Endpoint Monitor from independent Unix hosting and send Gmail alerts.", epilog="Requires Python 3.6+ with SSL and Unix flock, SIGALRM, and cron for run/check. Config is private JSON: label, status_url (HTTPS), status_token_file, sender, recipient (plain ASCII email addresses), smtp_password_file. Credential paths must be absolute or start with ~. Prefer native Gmail addresses for provider independence. run stores private state and rotating JSON logs; check makes no durable writes and sends no mail. report reads bounded private state without configuration, credentials, network, logs, or state writes: up to 128 closed incidents and 90 daily aggregates retained for 90 days. Exit: 0 healthy/skipped/report success, 1 unhealthy/runtime/delivery/report failure, 2 invalid configuration/usage, 3 missing platform dependency. See watchdog/README.md for installation and timing.")
    parser.add_argument("command", choices=("check", "run", "report"))
    parser.add_argument("-c", "--config", default=os.path.join(default_path("XDG_CONFIG_HOME", "~/.config"), "config.json"), help="private configuration JSON path")
    parser.add_argument("-s", "--state-dir", default=default_path("XDG_STATE_HOME", "~/.local/state"), help="private state/log directory for run")
    args = parser.parse_args(argv)
    if not args.config or not args.state_dir:
        parser.error("paths must not be empty")
    if args.command == "report":
        try:
            print(json.dumps(read_diagnostics(os.path.abspath(os.path.expanduser(args.state_dir))), sort_keys=True))
            return 0
        except Exception as error:
            print("watchdog: report unavailable " + json.dumps(failure_details(error)), file=sys.stderr)
            return 1
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
