from dotenv import load_dotenv

load_dotenv()

from sqlalchemy import func  # noqa: E402
from sqlalchemy.orm import Session  # noqa: E402

from agent.graph import build_graph  # noqa: E402
from db.models import Difficulty, Problem  # noqa: E402
from db.session import SessionLocal  # noqa: E402


def fetch_random_easy_problem(db: Session) -> Problem:
    problem = (
        db.query(Problem)
        .filter(Problem.difficulty == Difficulty.Easy)
        .order_by(func.random())
        .first()
    )
    if not problem:
        raise RuntimeError("No Easy problems found in DB. Run seed.py first.")
    return problem


def run_cli() -> None:
    db = SessionLocal()
    try:
        problem = fetch_random_easy_problem(db)
    finally:
        db.close()

    print(f"\n=== {problem.title} ({problem.difficulty.value}) ===")
    print(problem.prompt)
    print("\nCommands: type a question, 'hint' for a hint, 'code: <code>' to submit code, 'quit' to exit.\n")

    app = build_graph()

    state = {
        "problem": {"title": problem.title, "prompt": problem.prompt},
        "messages": [],
        "current_code": "",
        "hint_count": 0,
        "user_input": "",
        "last_response": "",
    }

    while True:
        raw = input("> ").strip()
        if not raw:
            continue
        if raw.lower() == "quit":
            print("Goodbye.")
            break

        if raw.lower().startswith("code:"):
            state["current_code"] = raw[len("code:"):].strip()
            print("(code updated)\n")
            continue

        if raw.lower() == "hint":
            state["hint_count"] += 1
            state["user_input"] = "Please give me a hint."
        else:
            state["user_input"] = raw

        prev_node = None
        final_state = state
        for step in app.stream(state):
            for node_name, node_state in step.items():
                if prev_node is not None:
                    print(f"[{prev_node} -> {node_name}]")
                prev_node = node_name
                final_state = node_state

        state = final_state
        print(f"\nAgent (hints used: {state['hint_count']}): {state['last_response']}\n")


if __name__ == "__main__":
    run_cli()
