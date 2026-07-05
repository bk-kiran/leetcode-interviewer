"""Thin client for the hosted Judge0 CE API on RapidAPI."""

import os
import time

import requests

JUDGE0_URL = os.environ["JUDGE0_URL"]
JUDGE0_API_KEY = os.environ["JUDGE0_API_KEY"]

_HEADERS = {
    "X-RapidAPI-Key": JUDGE0_API_KEY,
    "X-RapidAPI-Host": "judge0-ce.p.rapidapi.com",
}

# Judge0 CE language table id for "Python (3.8.1)".
PYTHON_LANGUAGE_ID = 71

_STATUS_IN_QUEUE = 1
_STATUS_PROCESSING = 2

_POLL_INTERVAL_SECONDS = 0.5
_POLL_TIMEOUT_SECONDS = 15.0


def _submit(source_code: str, stdin: str) -> str:
    resp = requests.post(
        f"{JUDGE0_URL}/submissions",
        params={"base64_encoded": "false", "wait": "false"},
        json={
            "source_code": source_code,
            "language_id": PYTHON_LANGUAGE_ID,
            "stdin": stdin,
        },
        headers=_HEADERS,
        timeout=10,
    )
    resp.raise_for_status()
    return resp.json()["token"]


def _poll(token: str) -> dict:
    deadline = time.monotonic() + _POLL_TIMEOUT_SECONDS
    while True:
        resp = requests.get(
            f"{JUDGE0_URL}/submissions/{token}",
            params={"base64_encoded": "false"},
            headers=_HEADERS,
            timeout=10,
        )
        resp.raise_for_status()
        result = resp.json()

        status_id = result["status"]["id"]
        if status_id not in (_STATUS_IN_QUEUE, _STATUS_PROCESSING):
            return result

        if time.monotonic() >= deadline:
            raise TimeoutError(f"Judge0 submission {token} did not finish in time")

        time.sleep(_POLL_INTERVAL_SECONDS)


def submit_and_wait(source_code: str, stdin: str, expected_output: str) -> dict:
    """Submit source_code to Judge0, wait for the result, and compare against
    expected_output (an exact string match against trimmed stdout)."""
    token = _submit(source_code, stdin)
    result = _poll(token)

    stdout = (result.get("stdout") or "").strip()
    stderr = (
        (result.get("stderr") or "").strip()
        or (result.get("compile_output") or "").strip()
        or (result.get("message") or "").strip()
    )
    status = result["status"]["description"]

    passed = status == "Accepted" and stdout == expected_output.strip()

    return {
        "status": status,
        "stdout": stdout,
        "stderr": stderr,
        "passed": passed,
    }
