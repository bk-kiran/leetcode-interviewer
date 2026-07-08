import json
import re

from sqlalchemy.orm import Session as OrmSession

from db.models import Problem, TestCase
from judge0_client import submit_and_wait
from schemas import TestCaseResult

FUNCTION_NAME_RE = re.compile(r"def\s+(\w+)\s*\(")


def build_harness(source_code: str, function_name: str) -> str:
    """Wrap a candidate's solution so it reads JSON kwargs from stdin, calls
    their function, and prints the JSON-encoded result to stdout."""
    return (
        f"{source_code}\n\n"
        "if __name__ == '__main__':\n"
        "    import json as _json, sys as _sys\n"
        "    _args = _json.loads(_sys.stdin.read())\n"
        f"    print(_json.dumps({function_name}(**_args)))\n"
    )


def run_submission(
    db: OrmSession, problem: Problem, source_code: str
) -> tuple[list[TestCaseResult], bool]:
    match = FUNCTION_NAME_RE.search(problem.starter_code)
    if not match:
        raise ValueError("Could not determine function name from starter code")
    function_name = match.group(1)
    harness = build_harness(source_code, function_name)

    test_cases = db.query(TestCase).filter(TestCase.problem_id == problem.id).all()

    results = []
    all_passed = True
    for tc in test_cases:
        outcome = submit_and_wait(
            source_code=harness,
            stdin=json.dumps(tc.input),
            expected_output=json.dumps(tc.expected_output),
        )
        all_passed = all_passed and outcome["passed"]
        results.append(
            TestCaseResult(
                test_case_id=tc.id,
                passed=outcome["passed"],
                stdout=outcome["stdout"],
                stderr=outcome["stderr"],
                is_hidden=tc.is_hidden,
            )
        )

    return results, all_passed
