from dotenv import load_dotenv

load_dotenv()

import json
import re
from typing import Any

from fastapi import Depends, FastAPI, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from db.models import Problem, TestCase
from db.session import get_db
from judge0_client import submit_and_wait

app = FastAPI(title="Interview Agent API")

FUNCTION_NAME_RE = re.compile(r"def\s+(\w+)\s*\(")


# --- schemas ---

class ProblemSummary(BaseModel):
    id: str
    title: str
    difficulty: str
    patterns: list[str]

    model_config = {"from_attributes": True}


class TestCaseOut(BaseModel):
    id: str
    input: Any
    expected_output: Any

    model_config = {"from_attributes": True}


class ProblemDetail(BaseModel):
    id: str
    title: str
    difficulty: str
    patterns: list[str]
    prompt: str
    starter_code: str
    test_cases: list[TestCaseOut]

    model_config = {"from_attributes": True}


class SubmitRequest(BaseModel):
    problem_id: str
    source_code: str


class TestCaseResult(BaseModel):
    test_case_id: str
    passed: bool
    stdout: str
    stderr: str
    is_hidden: bool


class SubmitResponse(BaseModel):
    problem_id: str
    results: list[TestCaseResult]
    all_passed: bool


# --- routes ---

@app.get("/health")
async def health():
    return {"status": "ok"}


@app.get("/problems", response_model=list[ProblemSummary])
def list_problems(db: Session = Depends(get_db)):
    problems = db.query(Problem).order_by(Problem.created_at).all()
    return [
        ProblemSummary(
            id=p.id,
            title=p.title,
            difficulty=p.difficulty.value,
            patterns=p.patterns,
        )
        for p in problems
    ]


@app.get("/problems/{problem_id}", response_model=ProblemDetail)
def get_problem(problem_id: str, db: Session = Depends(get_db)):
    problem = db.query(Problem).filter(Problem.id == problem_id).first()
    if not problem:
        raise HTTPException(status_code=404, detail="Problem not found")

    visible_cases = (
        db.query(TestCase)
        .filter(TestCase.problem_id == problem_id, TestCase.is_hidden == False)
        .all()
    )

    return ProblemDetail(
        id=problem.id,
        title=problem.title,
        difficulty=problem.difficulty.value,
        patterns=problem.patterns,
        prompt=problem.prompt,
        starter_code=problem.starter_code,
        test_cases=[
            TestCaseOut(id=tc.id, input=tc.input, expected_output=tc.expected_output)
            for tc in visible_cases
        ],
    )


def _build_harness(source_code: str, function_name: str) -> str:
    """Wrap a candidate's solution so it reads JSON kwargs from stdin, calls
    their function, and prints the JSON-encoded result to stdout."""
    return (
        f"{source_code}\n\n"
        "if __name__ == '__main__':\n"
        "    import json as _json, sys as _sys\n"
        "    _args = _json.loads(_sys.stdin.read())\n"
        f"    print(_json.dumps({function_name}(**_args)))\n"
    )


@app.post("/submit", response_model=SubmitResponse)
def submit(req: SubmitRequest, db: Session = Depends(get_db)):
    problem = db.query(Problem).filter(Problem.id == req.problem_id).first()
    if not problem:
        raise HTTPException(status_code=404, detail="Problem not found")

    match = FUNCTION_NAME_RE.search(problem.starter_code)
    if not match:
        raise HTTPException(
            status_code=500,
            detail="Could not determine function name from starter code",
        )
    function_name = match.group(1)
    harness = _build_harness(req.source_code, function_name)

    test_cases = db.query(TestCase).filter(TestCase.problem_id == req.problem_id).all()

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

    return SubmitResponse(problem_id=req.problem_id, results=results, all_passed=all_passed)
