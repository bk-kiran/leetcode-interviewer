import argparse
import select
import sys
import time

from dotenv import load_dotenv

load_dotenv()

from agent.cli import fetch_random_easy_problem  # noqa: E402
from agent.interview_graph import DEFAULT_CHECK_IN_THRESHOLD_SECONDS, build_interview_graph  # noqa: E402
from db.session import SessionLocal  # noqa: E402

POLL_INTERVAL_SECONDS = 1.0


def run_turn(app, state: dict) -> dict:
    """Runs one graph invocation via app.stream(), printing node transitions
    as they happen (same visibility style as Normal mode's CLI)."""
    prev_node = None
    final_state = state
    for step in app.stream(state):
        for node_name, node_state in step.items():
            if prev_node is not None:
                print(f"[{prev_node} -> {node_name}]")
            prev_node = node_name
            final_state = node_state
    return final_state


def read_line_with_ticks(app, state: dict) -> tuple[str, dict]:
    """Blocks until the candidate submits a line of input, but polls stdin on
    a short interval so the agent can proactively interject (a "tick") if the
    silence threshold has been crossed while we wait."""
    print("> ", end="", flush=True)
    while True:
        ready, _, _ = select.select([sys.stdin], [], [], POLL_INTERVAL_SECONDS)
        if ready:
            line = sys.stdin.readline()
            if line == "":  # EOF
                return "quit", state
            return line.rstrip("\n"), state

        state = {**state, "event": "tick"}
        state = run_turn(app, state)
        if state["last_response"]:
            print(f"\n\nInterviewer: {state['last_response']}\n")
            print("> ", end="", flush=True)


def run_cli(check_in_threshold: float) -> None:
    db = SessionLocal()
    problem = fetch_random_easy_problem(db)

    print(f"\n=== Interview Mode: {problem.title} ({problem.difficulty.value}) ===")
    print(f"(proactive check-in after {check_in_threshold:.0f}s of silence)")
    print("Commands: type a question/statement, 'code: <code>' to update your code, "
          "'submit' to submit for evaluation, 'quit' to exit.\n")

    start_ts = time.monotonic()
    app = build_interview_graph(db, problem, start_ts)

    state = {
        "problem": {"title": problem.title, "prompt": problem.prompt, "starter_code": problem.starter_code},
        "messages": [],
        "current_code": "",
        "last_activity_ts": start_ts,
        "check_in_threshold_seconds": check_in_threshold,
        "hint_count": 0,
        "probed_topics": [],
        "phase": "problem_intro",
        "event": "start",
        "user_input": "",
        "last_response": "",
        "submission_result": None,
        "debrief": None,
    }

    state = run_turn(app, state)
    print(f"\nInterviewer: {state['last_response']}\n")

    try:
        while True:
            raw, state = read_line_with_ticks(app, state)
            raw = raw.strip()
            if not raw:
                continue

            if raw.lower() == "quit":
                print("Goodbye.")
                break

            if raw.lower().startswith("code:"):
                new_code = raw[len("code:"):].strip()
                if new_code != state["current_code"]:
                    state = {**state, "current_code": new_code, "last_activity_ts": time.monotonic()}
                    print("(code updated)\n")
                continue

            if raw.lower() == "submit":
                state = {**state, "event": "submit"}
                state = run_turn(app, state)
                summary = state["submission_result"]["summary"] if state["submission_result"] else "(no result)"
                print(f"\nTest results: {summary}\n")
                print(f"=== Debrief ===\n{state['debrief']}\n")
                break

            state = {**state, "event": "message", "user_input": raw}
            state = run_turn(app, state)
            print(f"\nInterviewer (hints given: {state['hint_count']}): {state['last_response']}\n")
    finally:
        db.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--threshold",
        type=float,
        default=DEFAULT_CHECK_IN_THRESHOLD_SECONDS,
        help="Seconds of silence (no code change or message) before the agent proactively checks in.",
    )
    args = parser.parse_args()
    run_cli(args.threshold)
